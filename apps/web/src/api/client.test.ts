// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { abortPendingApiRequests, apiRequest } from "./client";

afterEach(() => {
  abortPendingApiRequests();
  vi.unstubAllGlobals();
});

describe("统一 REST 客户端", () => {
  it("只依赖同源 Cookie，不发送浏览器访问令牌", async () => {
    const request = vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", request);

    await apiRequest("/health");

    const headers = new Headers(request.mock.calls[0][1]?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(request.mock.calls[0][1]?.credentials).toBeUndefined();
  });

  it("退出登录前可以取消仍在进行的业务请求", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
    })));

    const pending = apiRequest("/me/workflow-tasks");
    abortPendingApiRequests();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
