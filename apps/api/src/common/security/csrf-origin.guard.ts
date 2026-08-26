import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { ProblemException } from "../http/problem-details.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const appBasePath = "/flowpilot";
const supportedProtocols = new Set(["http", "https"]);
const validHost = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/iu;
const publicBaseUrlRequestContext = Symbol("flowpilot.publicBaseUrl");

type RequestWithPublicBaseUrl = Request & {
  [publicBaseUrlRequestContext]?: string;
};

export function getRequestPublicBaseUrl(request: Request): string | undefined {
  return (request as RequestWithPublicBaseUrl)[publicBaseUrlRequestContext];
}

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (safeMethods.has(request.method.toUpperCase())) return true;

    const origin = request.header("Origin");
    const referer = request.header("Referer");
    const browserOrigin = this.resolveBrowserOrigin(origin ?? referer, origin !== undefined);
    const requestOrigin = this.hasMultipleForwardedAuthorityValues(request)
      ? undefined
      : this.resolveRequestOrigin(request);
    if (browserOrigin && requestOrigin && browserOrigin === requestOrigin) {
      (request as RequestWithPublicBaseUrl)[publicBaseUrlRequestContext] = `${requestOrigin}${appBasePath}`;
      return true;
    }

    throw new ProblemException({
      status: 403,
      code: "CSRF_VALIDATION_FAILED",
      title: "请求来源校验失败",
      detail: "请从 FlowPilot 页面重新发起此操作。"
    });
  }

  private hasMultipleForwardedAuthorityValues(request: Request): boolean {
    return ["X-Forwarded-Host", "X-Forwarded-Proto"].some((name) => (
      request.header(name)?.includes(",") ?? false
    ));
  }

  private resolveBrowserOrigin(value: string | undefined, originHeader: boolean): string | undefined {
    if (!value || value !== value.trim()) return undefined;
    try {
      const url = new URL(value);
      if (
        !supportedProtocols.has(url.protocol.slice(0, -1))
        || !validHost.test(url.host)
        || url.username
        || url.password
        || (originHeader && (url.pathname !== "/" || url.search || url.hash))
      ) {
        return undefined;
      }
      return url.origin;
    } catch {
      return undefined;
    }
  }

  private resolveRequestOrigin(request: Request): string | undefined {
    // Express only uses forwarded protocol/host here because main.ts trusts loopback;
    // IIS must overwrite both headers before proxying the request.
    const protocol = request.protocol.toLowerCase();
    const host = request.host;
    if (
      !supportedProtocols.has(protocol)
      || !host
      || host !== host.trim()
      || !validHost.test(host)
    ) {
      return undefined;
    }

    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      return undefined;
    }
  }
}
