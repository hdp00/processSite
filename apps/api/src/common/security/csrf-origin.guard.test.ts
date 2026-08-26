import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { ProblemException } from "../http/problem-details.js";
import { CsrfOriginGuard, getRequestPublicBaseUrl } from "./csrf-origin.guard.js";

const guard = () => new CsrfOriginGuard();

type RequestStub = {
  method: string;
  protocol?: string;
  host?: string;
  header(name: string): string | undefined;
};

const contextFor = (request: RequestStub) => ({
  switchToHttp: () => ({ getRequest: () => request })
}) as ExecutionContext;

const mutationRequest = ({
  origin,
  referer,
  protocol = "http",
  host = "flowpilot.internal",
  forwardedHost,
  forwardedProto
}: {
  origin?: string;
  referer?: string;
  protocol?: string;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}) => ({
  method: "POST",
  protocol,
  host,
  header: (name: string) => {
    if (name === "Origin") return origin;
    if (name === "Referer") return referer;
    if (name === "X-Forwarded-Host") return forwardedHost;
    if (name === "X-Forwarded-Proto") return forwardedProto;
    return undefined;
  }
});

describe("CsrfOriginGuard", () => {
  it("allows safe reads without an Origin header", () => {
    expect(guard().canActivate(contextFor({ method: "GET", header: () => undefined }))).toBe(true);
  });

  it("allows a same-origin mutation", () => {
    expect(guard().canActivate(contextFor(mutationRequest({
      origin: "http://flowpilot.internal"
    })))).toBe(true);
  });

  it("derives the public base URL from the current external entry", () => {
    const request = mutationRequest({
      origin: "http://203.0.113.10:8080",
      host: "203.0.113.10:8080"
    });

    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(getRequestPublicBaseUrl(request as Request)).toBe("http://203.0.113.10:8080/flowpilot");
  });

  it("derives an HTTPS public base URL from trusted proxy request properties", () => {
    const request = mutationRequest({
      origin: "https://flowpilot.example.test",
      protocol: "https",
      host: "flowpilot.example.test"
    });

    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(getRequestPublicBaseUrl(request as Request)).toBe("https://flowpilot.example.test/flowpilot");
  });

  it("uses a same-origin Referer when Origin is absent", () => {
    const request = mutationRequest({
      referer: "http://flowpilot.external/flowpilot/processes/example",
      host: "flowpilot.external"
    });

    expect(guard().canActivate(contextFor(request))).toBe(true);
    expect(getRequestPublicBaseUrl(request as Request)).toBe("http://flowpilot.external/flowpilot");
  });

  it("rejects a mutation whose browser origin differs from the request entry", () => {
    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "http://other.internal"
    })))).toThrow(ProblemException);
  });

  it("does not fall back to Referer when Origin is present but invalid", () => {
    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "null",
      referer: "http://flowpilot.internal/flowpilot/tasks"
    })))).toThrow(ProblemException);
  });

  it("rejects malformed or multi-value request hosts", () => {
    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "http://flowpilot.internal",
      host: "flowpilot.internal,attacker.example"
    })))).toThrow(ProblemException);

    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "http://flowpilot.internal",
      forwardedHost: "flowpilot.internal,attacker.example"
    })))).toThrow(ProblemException);

    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "http://flowpilot.internal",
      forwardedProto: "http,https"
    })))).toThrow(ProblemException);
  });

  it("rejects a protocol mismatch or missing request host", () => {
    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "https://flowpilot.internal"
    })))).toThrow(ProblemException);

    expect(() => guard().canActivate(contextFor(mutationRequest({
      origin: "http://flowpilot.internal",
      host: ""
    })))).toThrow(ProblemException);
  });
});
