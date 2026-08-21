import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { installMemoryBrowserStorage, type MemoryStorage } from "../test/memoryStorage";

let localStorage: MemoryStorage;
let sessionStorage: MemoryStorage;
let server: ReturnType<typeof setupServer>;
let apiModule: typeof import("../api/flowPilotApi");
let clientModule: typeof import("../api/client");
let identityModule: typeof import("../state/useIdentityStore");
let definitionModule: typeof import("../state/useProcessDefinitionStore");
let prototypeModule: typeof import("../state/usePrototypeStore");
let attachmentRepository: typeof import("./attachmentRepository");

const API = "http://flowpilot.test/api/v1";
const bearer = (actorId: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer mock:${actorId}`,
  ...extra,
});
const basic = (name: string) => ({
  name,
  type: "free" as const,
  code: "保存后自动生成",
  instancePrefix: "API",
  description: "API 边界测试",
  starterGroups: [],
  closeGroups: [],
  assigneeGroups: [],
  visibleRoles: [],
  visibleUsers: [],
});
const multipart = (fileName: string, content: string, fields: Record<string, string> = {}) => {
  const boundary = "flowpilot-contract-boundary";
  const fieldParts = Object.entries(fields).map(([name, value]) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    "",
    value,
  ].join("\r\n"));
  const filePart = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    "Content-Type: application/octet-stream",
    "",
    content,
  ].join("\r\n");
  return {
    body: [...fieldParts, filePart, `--${boundary}--`, ""].join("\r\n"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

beforeAll(async () => {
  ({ localStorage, sessionStorage } = installMemoryBrowserStorage());
  const fileProbe = multipart("probe.txt", "probe");
  const parsedProbe = await new Request("http://flowpilot.test/probe", {
    method: "POST",
    headers: { "Content-Type": fileProbe.contentType },
    body: fileProbe.body,
  }).formData();
  const parsedFile = parsedProbe.get("file");
  if (parsedFile) Object.defineProperty(globalThis, "File", { configurable: true, value: parsedFile.constructor });
  const { handlers } = await import("./handlers");
  apiModule = await import("../api/flowPilotApi");
  clientModule = await import("../api/client");
  identityModule = await import("../state/useIdentityStore");
  definitionModule = await import("../state/useProcessDefinitionStore");
  prototypeModule = await import("../state/usePrototypeStore");
  attachmentRepository = await import("./attachmentRepository");
  server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: "error" });
});

afterAll(() => server.close());

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  prototypeModule.usePrototypeStore.getState().resetDemo();
  await attachmentRepository.clearAttachments();
  localStorage.setItem("flowpilot-mock-api-settings-v1", JSON.stringify({
    scenario: "normal",
    readDelayMs: 0,
    writeDelayMs: 0,
  }));
  await apiModule.flowPilotApi.auth.login("admin", "1");
});

describe("Mock REST API 通用契约", () => {
  it("演示数据重置只允许真实登录的内置超级管理员，模拟切换不能提升权限", async () => {
    const initialDefinitionCount = definitionModule.useProcessDefinitionStore.getState().definitions.length;

    await expect(apiModule.flowPilotApi.system.resetDemo()).rejects.toMatchObject({
      status: 403,
      problem: { code: "DEMO_RESET_NOT_ALLOWED" },
    });

    prototypeModule.usePrototypeStore.getState().switchPersona("superadmin");
    await expect(apiModule.flowPilotApi.system.resetDemo()).rejects.toMatchObject({
      status: 403,
      problem: { code: "DEMO_RESET_NOT_ALLOWED" },
    });

    prototypeModule.usePrototypeStore.getState().logout();
    clientModule.writeApiAccessToken();
    await expect(apiModule.flowPilotApi.system.resetDemo()).rejects.toMatchObject({
      status: 401,
      problem: { code: "AUTHENTICATION_REQUIRED" },
    });

    await apiModule.flowPilotApi.auth.login("superadmin", "1");
    prototypeModule.usePrototypeStore.getState().switchPersona("lina");
    definitionModule.useProcessDefinitionStore.setState(({ definitions }) => ({
      definitions: definitions.slice(1),
    }));

    await expect(apiModule.flowPilotApi.system.resetDemo()).resolves.toEqual({ reset: true });
    expect(definitionModule.useProcessDefinitionStore.getState().definitions).toHaveLength(initialDefinitionCount);
    expect(prototypeModule.usePrototypeStore.getState()).toMatchObject({
      authenticated: true,
      personaId: "lina",
      operatorUserId: "superadmin",
      operatorSuperAdmin: true,
    });
  });

  it("分页响应返回完整元数据，非法分页返回可追踪 Problem Details", async () => {
    const page = await fetch(`${API}/users?page=2&pageSize=5`, {
      headers: bearer("admin", { "X-Request-Id": "page-success" }),
    });
    const envelope = await page.json() as {
      data: { items: unknown[]; page: { number: number; size: number; totalElements: number; totalPages: number } };
      meta: { requestId: string; timestamp: string };
    };
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(envelope.meta.requestId).toBe("page-success");
    expect(Number.isNaN(Date.parse(envelope.meta.timestamp))).toBe(false);
    expect(envelope.data.items).toHaveLength(5);
    expect(envelope.data.page).toMatchObject({ number: 2, size: 5 });
    expect(envelope.data.page.totalElements).toBeGreaterThan(10);
    expect(envelope.data.page.totalPages).toBe(Math.ceil(envelope.data.page.totalElements / 5));

    const invalid = await fetch(`${API}/users?page=0&pageSize=101`, {
      headers: bearer("admin", { "X-Request-Id": "page-invalid" }),
    });
    const problem = await invalid.json() as Record<string, unknown>;
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/problem+json");
    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(problem).toMatchObject({
      type: "https://flowpilot.local/problems/invalid-pagination",
      status: 400,
      code: "INVALID_PAGINATION",
      traceId: "page-invalid",
      instance: "/api/v1/users",
    });
  });

  it("写资源强制 If-Match，并在冲突时返回当前 ETag", async () => {
    const resource = await clientModule.apiResource<unknown>("/process-definitions/pdf-review", {
      headers: bearer("admin"),
    });
    expect(resource.etag).toMatch(/^"[0-9a-f]+"$/);

    await expect(clientModule.apiRequest("/process-definitions/pdf-review", {
      method: "PATCH",
      headers: bearer("admin"),
      body: { disabled: true },
    })).rejects.toMatchObject({
      status: 428,
      problem: { code: "IF_MATCH_REQUIRED", currentEtag: resource.etag },
    });
    await expect(clientModule.apiRequest("/process-definitions/pdf-review", {
      method: "PATCH",
      headers: bearer("admin"),
      body: { disabled: true },
      ifMatch: '"stale"',
    })).rejects.toMatchObject({
      status: 412,
      problem: { code: "REVISION_MISMATCH", currentEtag: resource.etag },
    });

    const updated = await clientModule.apiResource<{ disabled: boolean }>("/process-definitions/pdf-review", {
      method: "PATCH",
      headers: bearer("admin"),
      body: { disabled: true },
      ifMatch: resource.etag,
    });
    expect(updated.data.disabled).toBe(true);
    expect(updated.etag).not.toBe(resource.etag);
  });

  it("相同幂等键和请求体只创建一次，不同请求体复用时返回冲突", async () => {
    const idempotencyKey = "contract-definition-create";
    const request = (name: string) => fetch(`${API}/process-definitions`, {
      method: "POST",
      headers: bearer("admin", {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Request-Id": "create-idempotency-contract",
      }),
      body: JSON.stringify({ basic: basic(name) }),
    });

    const first = await request("幂等合约流程");
    const second = await request("幂等合约流程");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(definitionModule.useProcessDefinitionStore.getState().definitions.filter((item) => item.name === "幂等合约流程"))
      .toHaveLength(1);

    const reused = await request("另一个流程");
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("命令缺少幂等键时被拒绝且不产生业务数据", async () => {
    const before = definitionModule.useProcessDefinitionStore.getState().definitions.length;
    const response = await fetch(`${API}/process-definitions`, {
      method: "POST",
      headers: bearer("admin", { "Content-Type": "application/json" }),
      body: JSON.stringify({ basic: basic("缺少幂等键") }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(definitionModule.useProcessDefinitionStore.getState().definitions).toHaveLength(before);
  });
});

describe("目录权限组和附件 API 边界", () => {
  it("有效成员分页去重并标明直接成员与角色来源，未授权用户无法读取", async () => {
    const groupId = "PDF审核_研发_流程权限组";
    const result = await apiModule.flowPilotApi.organization.groupEffectiveMembers(groupId, { page: 1, pageSize: 100 });
    const ids = result.items.map((user) => user.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.page.totalElements).toBe(ids.length);
    expect(result.items.find((user) => user.id === "zhangwei")?.sources).toEqual(expect.arrayContaining([
      "direct",
      "role:研发审核员",
    ]));

    const forbidden = await fetch(`${API}/workflow-permission-groups/${encodeURIComponent(groupId)}/effective-members`, {
      headers: bearer("hejing"),
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("附件上传校验范围、危险扩展名和可执行文件签名，失败前不触碰存储", async () => {
    const incomplete = multipart("notes.txt", "plain text", { instanceId: "proc-42" });
    const incompleteResponse = await fetch(`${API}/attachments`, {
      method: "POST",
      headers: bearer("wangmin", {
        "Content-Type": incomplete.contentType,
        "Idempotency-Key": "attachment-incomplete",
      }),
      body: incomplete.body,
    });
    expect(incompleteResponse.status).toBe(422);
    await expect(incompleteResponse.json()).resolves.toMatchObject({
      code: "ATTACHMENT_SCOPE_INCOMPLETE",
      errors: [{ path: "instanceId/fieldId", code: "PAIR_REQUIRED" }],
    });

    const executable = multipart("masked.txt", "MZ\0\0");
    const executableResponse = await fetch(`${API}/attachments`, {
      method: "POST",
      headers: bearer("wangmin", {
        "Content-Type": executable.contentType,
        "Idempotency-Key": "attachment-signature",
      }),
      body: executable.body,
    });
    expect(executableResponse.status).toBe(415);
    await expect(executableResponse.json()).resolves.toMatchObject({ code: "DANGEROUS_ATTACHMENT_SIGNATURE" });

    const dangerous = multipart("script.cmd", "echo unsafe");
    const dangerousResponse = await fetch(`${API}/attachments`, {
      method: "POST",
      headers: bearer("wangmin", {
        "Content-Type": dangerous.contentType,
        "Idempotency-Key": "attachment-extension",
      }),
      body: dangerous.body,
    });
    expect(dangerousResponse.status).toBe(415);
    await expect(dangerousResponse.json()).resolves.toMatchObject({
      code: "DANGEROUS_ATTACHMENT_TYPE",
      errors: [{ path: "file", code: "DANGEROUS_TYPE" }],
    });
  });

  it("临时附件支持幂等上传、元数据和内容读取，并限制非上传人删除", async () => {
    const upload = multipart("contract-note.txt", "attachment contract content");
    const uploadRequest = () => fetch(`${API}/attachments`, {
      method: "POST",
      headers: bearer("wangmin", {
        "Content-Type": upload.contentType,
        "Idempotency-Key": "attachment-lifecycle",
      }),
      body: upload.body,
    });

    const first = await uploadRequest();
    const replay = await uploadRequest();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstEnvelope = await first.json() as { data: { id: string; name: string; uploadedById: string; lifecycle: string } };
    const replayEnvelope = await replay.json() as typeof firstEnvelope;
    expect(replayEnvelope).toEqual(firstEnvelope);
    expect(firstEnvelope.data).toMatchObject({
      name: "contract-note.txt",
      uploadedById: "wangmin",
      lifecycle: "temporary",
    });
    expect(await attachmentRepository.getAttachmentRecords()).toHaveLength(1);

    const metadata = await fetch(`${API}/attachments/${firstEnvelope.data.id}`, { headers: bearer("wangmin") });
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
    await expect(metadata.json()).resolves.toMatchObject({ data: { id: firstEnvelope.data.id } });

    const content = await fetch(`${API}/attachments/${firstEnvelope.data.id}/content`, { headers: bearer("wangmin") });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("contract-note.txt");
    await expect(content.text()).resolves.toBe("attachment contract content");

    const forbiddenDelete = await fetch(`${API}/attachments/${firstEnvelope.data.id}`, {
      method: "DELETE",
      headers: bearer("lina"),
    });
    expect(forbiddenDelete.status).toBe(403);
    await expect(forbiddenDelete.json()).resolves.toMatchObject({ code: "ATTACHMENT_DELETE_FORBIDDEN" });

    const removed = await fetch(`${API}/attachments/${firstEnvelope.data.id}`, {
      method: "DELETE",
      headers: bearer("wangmin"),
    });
    expect(removed.status).toBe(204);
    expect(await attachmentRepository.getAttachmentRecords()).toEqual([]);
  });
});
