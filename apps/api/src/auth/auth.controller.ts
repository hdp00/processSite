import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { ZodBodyPipe } from "../common/http/zod-body.pipe.js";
import type { AppEnvironment } from "../config/environment.js";
import { loginRequestSchema, type LoginRequest } from "./auth.schemas.js";
import { AuthService, SESSION_ABSOLUTE_DURATION_MS } from "./auth.service.js";
import type { SessionDto } from "./auth.types.js";
import { SESSION_COOKIE_NAME, SessionGuard, type SessionRequest } from "./session.guard.js";

const COOKIE_PATH = "/api/flowpilot";

const requiredSession = (request: SessionRequest) => {
  if (!request.flowPilotSession) throw new Error("SessionGuard did not attach an authenticated session");
  return request.flowPilotSession;
};

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodBodyPipe(loginRequestSchema)) input: LoginRequest,
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const result = await this.authService.login(input, request.ip || request.socket.remoteAddress || "unknown");
    response.cookie(SESSION_COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.get("FLOWPILOT_COOKIE_SECURE", { infer: true }),
      path: COOKIE_PATH,
      maxAge: SESSION_ABSOLUTE_DURATION_MS,
    });
    return result.dto;
  }

  @Get("me")
  @UseGuards(SessionGuard)
  me(@Req() request: SessionRequest): SessionDto {
    return requiredSession(request).dto;
  }

  @Post("logout")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(requiredSession(request).principal);
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.get("FLOWPILOT_COOKIE_SECURE", { infer: true }),
      path: COOKIE_PATH,
    });
  }
}
