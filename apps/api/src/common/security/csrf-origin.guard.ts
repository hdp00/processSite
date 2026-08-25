import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { parsePublicBaseUrls, type AppEnvironment } from "../../config/environment.js";
import { ProblemException } from "../http/problem-details.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const publicBaseUrlRequestContext = Symbol("flowpilot.publicBaseUrl");

type RequestWithPublicBaseUrl = Request & {
  [publicBaseUrlRequestContext]?: string;
};

export function getRequestPublicBaseUrl(request: Request): string | undefined {
  return (request as RequestWithPublicBaseUrl)[publicBaseUrlRequestContext];
}

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  private readonly trustedBaseUrlsByOrigin: ReadonlyMap<string, string>;

  constructor(config: ConfigService<AppEnvironment, true>) {
    this.trustedBaseUrlsByOrigin = new Map(
      parsePublicBaseUrls(config.get("FLOWPILOT_PUBLIC_BASE_URLS", { infer: true }))
        .map((item) => [new URL(item).origin, item] as const)
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (safeMethods.has(request.method.toUpperCase())) return true;

    const origin = request.header("Origin");
    const referer = request.header("Referer");
    const requestBaseUrl = this.resolveTrustedBaseUrl(origin ?? referer);
    if (requestBaseUrl && (origin || referer)) {
      (request as RequestWithPublicBaseUrl)[publicBaseUrlRequestContext] = requestBaseUrl;
      return true;
    }

    throw new ProblemException({
      status: 403,
      code: "CSRF_VALIDATION_FAILED",
      title: "请求来源校验失败",
      detail: "请从 FlowPilot 页面重新发起此操作。"
    });
  }

  private resolveTrustedBaseUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      return this.trustedBaseUrlsByOrigin.get(new URL(value).origin);
    } catch {
      return undefined;
    }
  }
}
