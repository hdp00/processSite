import { describe, expect, it } from "vitest";
import { resolveTraceId } from "./request-context.middleware.js";

describe("resolveTraceId", () => {
  it("keeps the logger and Problem Details trace identifier aligned", () => {
    expect(resolveTraceId("client-request-1", "logger-request-1")).toBe("logger-request-1");
    expect(resolveTraceId("client-request-1")).toBe("client-request-1");
  });

  it("rejects request identifiers containing log-control characters", () => {
    const generated = resolveTraceId("unsafe\r\nheader");

    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });
});
