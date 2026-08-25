import { Logger, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ProblemDetailsFilter, describeHttpException } from "./problem-details.filter.js";

describe("describeHttpException", () => {
  it("maps malformed and oversized JSON bodies without reporting a server failure", () => {
    const malformed = Object.assign(new SyntaxError("redacted parser detail"), {
      type: "entity.parse.failed",
      status: 400
    });
    const oversized = Object.assign(new Error("redacted parser detail"), {
      type: "entity.too.large",
      status: 413
    });

    expect(describeHttpException(malformed)).toMatchObject({
      status: 400,
      code: "BAD_REQUEST"
    });
    expect(describeHttpException(oversized)).toMatchObject({
      status: 413,
      code: "BAD_REQUEST"
    });
  });

  it("does not trust arbitrary status-like fields from unknown exceptions", () => {
    expect(describeHttpException(Object.assign(new Error("failure"), { status: 400 })))
      .toMatchObject({ status: 500, code: "INTERNAL_SERVER_ERROR" });
  });

  it("logs only stable classifications for unexpected failures", () => {
    const logger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(),
      type: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ traceId: "trace-1", originalUrl: "/api/flowpilot/v1/test" }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new ProblemDetailsFilter().catch(
      new Error("Server=internal;User Id=test;Password=do-not-log"),
      host,
    );

    const logged = JSON.stringify(logger.mock.calls);
    expect(logged).toContain("INTERNAL_SERVER_ERROR");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("internal");
    expect(logged).not.toContain("do-not-log");
  });
});
