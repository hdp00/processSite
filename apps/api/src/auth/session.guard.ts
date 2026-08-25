import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedSession } from "./auth.types.js";

export const SESSION_COOKIE_NAME = "flowpilot_session";

export type SessionRequest = Request & {
  flowPilotSession?: AuthenticatedSession;
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const rawToken = cookies?.[SESSION_COOKIE_NAME];
    request.flowPilotSession = await this.authService.authenticate(
      typeof rawToken === "string" ? rawToken : undefined,
    );
    return true;
  }
}
