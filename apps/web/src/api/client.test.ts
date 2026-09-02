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

  it("将反向代理 502 转换为用户可理解的后端未启动提示", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad Gateway", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    })));

    await expect(apiRequest("/auth/login", { method: "POST", body: {} }))
      .rejects.toThrow("无法连接后端服务，请确认后端已启动，或稍后重试。");
  });

  it.each([
    [401, "登录状态已失效，请重新登录。"],
    [409, "数据已发生变化，请刷新后重试。"],
    [412, "数据已发生变化，请刷新后重试。"],
    [428, "页面数据缺少最新版本信息，请刷新后重试。"],
  ])("将无 Problem Details 的 HTTP %i 转换为可操作提示", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));

    await expect(apiRequest("/test")).rejects.toThrow(expected);
  });
});
