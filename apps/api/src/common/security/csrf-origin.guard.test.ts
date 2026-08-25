import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { ProblemException } from "../http/problem-details.js";
import { CsrfOriginGuard, getRequestPublicBaseUrl } from "./csrf-origin.guard.js";

const guard = () => new CsrfOriginGuard(new ConfigService<AppEnvironment, true>({
  FLOWPILOT_PUBLIC_BASE_URLS: "http://flowpilot.internal/flowpilot;http://flowpilot.external/flowpilot"
}));

const contextFor = (request: { method: string; header(name: string): string | undefined }) => ({
  switchToHttp: () => ({ getRequest: () => request })
}) as ExecutionContext;

describe("CsrfOriginGuard", () => {
  it("allows safe reads without an Origin header", () => {
    expect(guard().canActivate(contextFor({ method: "GET", header: () => undefined }))).toBe(true);
  });

  it("allows a same-origin mutation", () => {
    expect(guard().canActivate(contextFor({
      method: "POST",
      header: (name) => name === "Origin" ? "http://flowpilot.internal" : undefined
    }))).toBe(true);
  });

  it("allows a mutation from every configured site origin", () => {
    const request = {
      method: "POST",
      header: (name: string) => name === "Origin" ? "http://flowpilot.external" : undefined
    };

    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(getRequestPublicBaseUrl(request as Request)).toBe("http://flowpilot.external/flowpilot");
  });

  it("maps a trusted Referer to its configured site when Origin is absent", () => {
    const request = {
      method: "POST",
      header: (name: string) => name === "Referer"
        ? "http://flowpilot.external/flowpilot/processes/example"
        : undefined
    };

    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(getRequestPublicBaseUrl(request as Request)).toBe("http://flowpilot.external/flowpilot");
  });

  it("rejects a mutation from an untrusted origin", () => {
    expect(() => guard().canActivate(contextFor({
      method: "POST",
      header: (name) => name === "Origin" ? "http://other.internal" : undefined
    }))).toThrow(ProblemException);
  });
});
