import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const localStorage = new MemoryStorage();
const sessionStorage = new MemoryStorage();
let server: ReturnType<typeof setupServer>;

beforeAll(async () => {
  const location = new URL("http://flowpilot.test/");
  Object.assign(globalThis, {
    localStorage,
    sessionStorage,
    location,
    window: {
      localStorage,
      sessionStorage,
      location,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  localStorage.setItem("flowpilot-mock-api-settings-v1", JSON.stringify({ scenario: "normal", readDelayMs: 0, writeDelayMs: 0 }));
  const { handlers } = await import("./handlers");
  server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => server.close());

describe("REST API contract boundary", () => {
  const basic = (name: string, type: "approval" | "free") => ({
    name,
    type,
    code: "保存后自动生成",
    instancePrefix: "API",
    description: "API 合约测试",
    starterGroups: [],
    closeGroups: [],
    assigneeGroups: type === "free" ? [] : undefined,
    visibleRoles: [],
    visibleUsers: [],
  });
  it("returns RFC 9457 style problem details for an unauthenticated request", async () => {
    const response = await fetch("http://flowpilot.test/api/v1/auth/me");
    const problem = await response.json() as { code: string; traceId: string; status: number };
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(problem).toMatchObject({ code: "AUTHENTICATION_REQUIRED", status: 401 });
    expect(problem.traceId).toBeTruthy();
  });

  it("synchronizes the authenticated application session and rejects an invalid topology at the API boundary", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const { usePrototypeStore } = await import("../state/usePrototypeStore");
    const session = await flowPilotApi.auth.login("admin", "1");
    expect(session.user.id).toBe("admin");
    expect(usePrototypeStore.getState()).toMatchObject({ authenticated: true, personaId: "admin" });

    const created = await flowPilotApi.definitions.create({ basic: basic("API 非法拓扑验证", "approval") });
    const resource = await flowPilotApi.definitions.versionResource(created.definition.id, created.version.id);
    await expect(flowPilotApi.definitions.publish(created.definition.id, created.version.id, "不应发布", resource.etag))
      .rejects.toMatchObject({ status: 422, problem: { code: "VALIDATION_FAILED" } });
  });

  it("enforces the independent irreversible-delete permission", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const adminSession = await flowPilotApi.auth.login("admin", "1");
    expect(adminSession.user.id).toBe("admin");
    const created = await flowPilotApi.definitions.create({ basic: basic("删除权限边界", "free") });

    await flowPilotApi.auth.login("lina", "1");
    await expect(flowPilotApi.definitions.remove(created.definition.id))
      .rejects.toMatchObject({ status: 403, problem: { code: "PERMISSION_DENIED" } });
  });
});
