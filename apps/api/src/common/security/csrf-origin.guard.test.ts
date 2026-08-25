import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { AppEnvironment } from "../../config/environment.js";
import { ProblemException } from "../http/problem-details.js";
import { CsrfOriginGuard } from "./csrf-origin.guard.js";

const guard = () => new CsrfOriginGuard(new ConfigService<AppEnvironment, true>({
  FLOWPILOT_PUBLIC_BASE_URL: "http://flowpilot.internal/flowpilot"
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

  it("rejects a mutation from an untrusted origin", () => {
    expect(() => guard().canActivate(contextFor({
      method: "POST",
      header: (name) => name === "Origin" ? "http://other.internal" : undefined
    }))).toThrow(ProblemException);
  });
});
