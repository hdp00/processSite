import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { AppEnvironment } from "../../config/environment.js";
import { ProblemException } from "../http/problem-details.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  private readonly trustedOrigin: string;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.trustedOrigin = new URL(config.get("FLOWPILOT_PUBLIC_BASE_URL", { infer: true })).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (safeMethods.has(request.method.toUpperCase())) return true;

    const origin = request.header("Origin");
    const referer = request.header("Referer");
    if ((origin && this.hasTrustedOrigin(origin)) || (!origin && referer && this.hasTrustedOrigin(referer))) {
      return true;
    }

    throw new ProblemException({
      status: 403,
      code: "CSRF_VALIDATION_FAILED",
      title: "请求来源校验失败",
      detail: "请从 FlowPilot 页面重新发起此操作。"
    });
  }

  private hasTrustedOrigin(value: string): boolean {
    try {
      return new URL(value).origin === this.trustedOrigin;
    } catch {
      return false;
    }
  }
}
