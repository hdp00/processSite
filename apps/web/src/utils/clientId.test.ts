import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientUuid } from "./clientId";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => vi.unstubAllGlobals());

describe("createClientUuid", () => {
  it("uses the native UUID implementation when available", () => {
    const nativeUuid = "123e4567-e89b-42d3-a456-426614174000";
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => nativeUuid) });
    expect(createClientUuid()).toBe(nativeUuid);
  });

  it("builds a UUID v4 with getRandomValues on an HTTP-compatible path", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => { bytes[index] = index; });
        return bytes;
      },
    });
    expect(createClientUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still creates distinct UUIDs when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    const first = createClientUuid();
    const second = createClientUuid();
    expect(first).toMatch(UUID_V4_PATTERN);
    expect(second).toMatch(UUID_V4_PATTERN);
    expect(second).not.toBe(first);
  });
});
