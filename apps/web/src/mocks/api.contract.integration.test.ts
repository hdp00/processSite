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

  it("uses the process definition ETag when cancelling the current publication", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const { getPublishedVersion } = await import("../state/useProcessDefinitionStore");
    await flowPilotApi.auth.login("superadmin", "1");
    const definitionResource = await flowPilotApi.definitions.getResource("pdf-review");
    const publishedVersion = getPublishedVersion(definitionResource.data)!;
    const versionResource = await flowPilotApi.definitions.versionResource("pdf-review", publishedVersion.id);

    await expect(flowPilotApi.definitions.unpublish(
      "pdf-review",
      publishedVersion.id,
      "错误使用版本并发标识",
      versionResource.etag,
    )).rejects.toMatchObject({ status: 412, problem: { code: "REVISION_MISMATCH" } });

    const unpublished = await flowPilotApi.definitions.unpublish(
      "pdf-review",
      publishedVersion.id,
      "验证定义并发标识",
      definitionResource.etag,
    );
    expect(unpublished.definition.publishedVersionId).toBeUndefined();
    expect(unpublished.version.validation).toMatchObject({ status: "通过", issues: [] });

    const refreshedVersion = await flowPilotApi.definitions.versionResource("pdf-review", publishedVersion.id);
    const republished = await flowPilotApi.definitions.publish(
      "pdf-review",
      publishedVersion.id,
      "恢复合约测试发布状态",
      refreshedVersion.etag,
    );
    expect(republished.definition.publishedVersionId).toBe(publishedVersion.id);
  });

  it("revalidates an instance-bound readonly version without editing its snapshot", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const { getPublishedVersion, useProcessDefinitionStore } = await import("../state/useProcessDefinitionStore");
    await flowPilotApi.auth.login("superadmin", "1");
    const definitionResource = await flowPilotApi.definitions.getResource("pdf-review");
    const publishedVersion = getPublishedVersion(definitionResource.data)!;
    const unpublished = await flowPilotApi.definitions.unpublish(
      "pdf-review",
      publishedVersion.id,
      "验证只读版本重新校验",
      definitionResource.etag,
    );
    useProcessDefinitionStore.setState((state) => ({
      definitions: state.definitions.map((definition) => definition.id === "pdf-review" ? {
        ...definition,
        versions: definition.versions.map((version) => version.id === publishedVersion.id
          ? { ...version, validation: { status: "未通过", checkedAt: "权限组修复前", issues: ["权限组没有有效成员"] } }
          : version),
      } : definition),
    }));
    const before = structuredClone(unpublished.version.snapshot);
    const resource = await flowPilotApi.definitions.versionResource("pdf-review", publishedVersion.id);

    const checked = await flowPilotApi.definitions.validate("pdf-review", publishedVersion.id, resource.etag);

    expect(checked.instanceCount).toBeGreaterThan(0);
    expect(checked.snapshot).toEqual(before);
    expect(checked.validation).toMatchObject({ status: "通过", issues: [] });
    const checkedResource = await flowPilotApi.definitions.versionResource("pdf-review", publishedVersion.id);
    const republished = await flowPilotApi.definitions.publish(
      "pdf-review",
      publishedVersion.id,
      "权限组修复后重新发布",
      checkedResource.etag,
    );
    expect(republished.definition.publishedVersionId).toBe(publishedVersion.id);
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

  it("imports a complete process definition through the REST transaction boundary", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const { useIdentityStore } = await import("../state/useIdentityStore");
    const { useProcessDefinitionStore } = await import("../state/useProcessDefinitionStore");
    const { createProcessDefinitionExport } = await import("../utils/processDefinitionTransfer");
    await flowPilotApi.auth.login("superadmin", "1");
    const source = useProcessDefinitionStore.getState().definitions[0];
    const identities = useIdentityStore.getState();

    const imported = await flowPilotApi.definitions.import(createProcessDefinitionExport(source, identities));

    expect(imported.id).not.toBe(source.id);
    expect(imported.name).toContain(source.name);
    expect(imported.versions).toHaveLength(source.versions.length);
    expect(useProcessDefinitionStore.getState().definitions.some((item) => item.id === imported.id)).toBe(true);
  });

  it("keeps the real super administrator while authorizing as the impersonated user", async () => {
    const { flowPilotApi } = await import("../api/flowPilotApi");
    const { usePrototypeStore } = await import("../state/usePrototypeStore");
    await flowPilotApi.auth.login("superadmin", "1");

    const candidates = await flowPilotApi.auth.impersonationCandidates({ page: 1, pageSize: 100 });
    expect(candidates.items.some((user) => user.id === "lina")).toBe(true);
    expect(candidates.items.some((user) => user.id === "superadmin")).toBe(false);

    const impersonated = await flowPilotApi.auth.startImpersonation("lina", "验证质量审核人数据范围");
    expect(impersonated).toMatchObject({
      user: { id: "lina" },
      operatorUser: { id: "superadmin" },
      operatorSuperAdmin: true,
      superAdmin: false,
    });
    expect(impersonated.permissions).not.toContain("org-user:编辑");
    expect(usePrototypeStore.getState()).toMatchObject({
      personaId: "lina",
      operatorUserId: "superadmin",
      operatorSuperAdmin: true,
    });

    await expect(flowPilotApi.directory.users()).rejects.toMatchObject({
      status: 403,
      problem: { code: "PERMISSION_DENIED" },
    });

    const restored = await flowPilotApi.auth.stopImpersonation();
    expect(restored.user.id).toBe("superadmin");
    expect(usePrototypeStore.getState().impersonation).toBeUndefined();
  });
});
