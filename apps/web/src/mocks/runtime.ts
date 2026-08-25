import { delay, HttpResponse } from "msw";
import type {
  ApiEnvelope,
  ApiProblemDetails,
  AuditEvent,
  MockApiSettings,
  MockScenario,
  PageResult,
} from "../api/contracts";
import type { DomainUser } from "../state/useIdentityStore";
import { findIdentityUser } from "../state/useIdentityStore";
import { hasUserPermission } from "../state/permissionEngine";
import { createClientUuid } from "../utils/clientId";
import { usePrototypeStore } from "../state/usePrototypeStore";
import {
  LOCAL_AUDIT_STORAGE_KEY,
  readLocalAuditEvents,
  writeLocalAuditEvents,
} from "../utils/localAuditRepository";

const SETTINGS_KEY = "flowpilot-mock-api-settings-v1";
const IDEMPOTENCY_KEY = "flowpilot-mock-api-idempotency-v1";
const MAX_IDEMPOTENCY_RECORDS = 100;
const MAX_AUDIT_RECORDS = 500;

interface StoredIdempotencyRecord {
  scope: string;
  key: string;
  bodyHash: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  createdAt: string;
}

const integerEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const defaultSettings = (): MockApiSettings => ({
  scenario: "normal",
  readDelayMs: integerEnv(import.meta.env.VITE_MOCK_API_READ_DELAY_MS, 120),
  writeDelayMs: integerEnv(import.meta.env.VITE_MOCK_API_WRITE_DELAY_MS, 360),
});

export const readMockApiSettings = (): MockApiSettings => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<MockApiSettings>;
    const defaults = defaultSettings();
    return {
      scenario: stored.scenario ?? defaults.scenario,
      readDelayMs: Number.isInteger(stored.readDelayMs) && Number(stored.readDelayMs) >= 0 ? Number(stored.readDelayMs) : defaults.readDelayMs,
      writeDelayMs: Number.isInteger(stored.writeDelayMs) && Number(stored.writeDelayMs) >= 0 ? Number(stored.writeDelayMs) : defaults.writeDelayMs,
    };
  } catch {
    return defaultSettings();
  }
};

export const writeMockApiSettings = (patch: Partial<MockApiSettings>) => {
  const current = readMockApiSettings();
  const next: MockApiSettings = {
    scenario: patch.scenario ?? current.scenario,
    readDelayMs: Number.isInteger(patch.readDelayMs) && Number(patch.readDelayMs) >= 0 ? Number(patch.readDelayMs) : current.readDelayMs,
    writeDelayMs: Number.isInteger(patch.writeDelayMs) && Number(patch.writeDelayMs) >= 0 ? Number(patch.writeDelayMs) : current.writeDelayMs,
  };
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
};

export const resetMockApiRuntime = () => {
  window.localStorage.removeItem(SETTINGS_KEY);
  window.localStorage.removeItem(IDEMPOTENCY_KEY);
  window.localStorage.removeItem(LOCAL_AUDIT_STORAGE_KEY);
  window.localStorage.removeItem("flowpilot-role-permissions-v1");
  window.localStorage.removeItem("flowpilot-role-permissions-v2");
  window.localStorage.removeItem("flowpilot-role-permissions-v3");
  window.localStorage.removeItem("flowpilot-mock-email-outbox-v1");
  const resetPrefixes = [
    "flowpilot-form-designer-draft-v2-",
    "flowpilot-flow-designer-v2-",
    "flowpilot-system-list-fields-v1:",
    "flowpilot-task-center-flow-v1:",
  ];
  Object.keys(window.localStorage)
    .filter((key) => resetPrefixes.some((prefix) => key.startsWith(prefix)))
    .forEach((key) => window.localStorage.removeItem(key));
};

export const requestIdOf = (request: Request) =>
  request.headers.get("X-Request-Id") || `trace-${createClientUuid()}`;

export const apiOk = <T>(request: Request, data: T, init: ResponseInit = {}) => {
  const requestId = requestIdOf(request);
  const envelope: ApiEnvelope<T> = { data, meta: { requestId, timestamp: new Date().toISOString() } };
  const headers = new Headers(init.headers);
  headers.set("X-Request-Id", requestId);
  headers.set("Cache-Control", "no-store");
  return HttpResponse.json(envelope, { ...init, headers });
};

export const apiNoContent = (request: Request, headers?: HeadersInit) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("X-Request-Id", requestIdOf(request));
  responseHeaders.set("Cache-Control", "no-store");
  return new HttpResponse(null, { status: 204, headers: responseHeaders });
};

export const apiProblem = (
  request: Request,
  status: number,
  code: string,
  title: string,
  detail: string,
  extra: Pick<ApiProblemDetails, "errors" | "currentEtag"> = {},
) => {
  const traceId = requestIdOf(request);
  const problem: ApiProblemDetails = {
    type: `https://flowpilot.local/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    detail,
    instance: new URL(request.url).pathname,
    code,
    traceId,
    ...extra,
  };
  return HttpResponse.json(problem, {
    status,
    headers: { "Content-Type": "application/problem+json", "X-Request-Id": traceId, "Cache-Control": "no-store" },
  });
};

const isScenario = (value: string | null): value is MockScenario =>
  ["normal", "slow", "offline", "server-error", "conflict", "mail-fail", "upload-fail"].includes(value ?? "");

export const applyMockScenario = async (request: Request, write = false) => {
  const settings = readMockApiSettings();
  const headerScenario = request.headers.get("X-Mock-Scenario");
  const urlScenario = new URL(request.url).searchParams.get("mockScenario");
  const scenario = isScenario(headerScenario) ? headerScenario : isScenario(urlScenario) ? urlScenario : settings.scenario;
  const explicitDelay = Number(request.headers.get("X-Mock-Delay-Ms"));
  const baseDelay = Number.isFinite(explicitDelay) && explicitDelay >= 0
    ? explicitDelay
    : write ? settings.writeDelayMs : settings.readDelayMs;
  await delay(scenario === "slow" ? Math.max(baseDelay, write ? 1_200 : 800) : baseDelay);
  if (scenario === "offline") return HttpResponse.error();
  if (scenario === "server-error") return apiProblem(request, 500, "MOCK_SERVER_ERROR", "模拟服务异常", "Mock 场景已配置为返回服务器错误。");
  if (scenario === "conflict" && write) return apiProblem(request, 409, "MOCK_CONFLICT", "模拟并发冲突", "Mock 场景已配置为返回资源冲突。");
  return undefined;
};

const bearerActorId = (request: Request) => {
  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token?.startsWith("mock:") ? token.slice(5) : request.headers.get("X-Actor-Id") ?? undefined;
};

export type AuthResult = { actor: DomainUser; operator: DomainUser; response?: never } | { actor?: never; operator?: never; response: Response };

export const requireActor = (request: Request): AuthResult => {
  const actorId = bearerActorId(request);
  if (!actorId) return { response: apiProblem(request, 401, "AUTHENTICATION_REQUIRED", "需要登录", "请先登录后再访问该接口。") };
  const operator = findIdentityUser(actorId);
  if (!operator || operator.status !== "启用") return { response: apiProblem(request, 401, "SESSION_INVALID", "会话无效", "当前账号不存在、已停用或会话已经失效。") };
  const session = usePrototypeStore.getState();
  const effectiveId = session.impersonation && session.operatorUserId === operator.id
    ? session.personaId
    : operator.id;
  const actor = findIdentityUser(effectiveId);
  if (!actor || actor.status !== "启用") return { response: apiProblem(request, 401, "SESSION_INVALID", "会话无效", "当前模拟用户不存在、已停用或会话已经失效。") };
  return { actor, operator };
};

export const requirePermission = (request: Request, permission: string): AuthResult => {
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated;
  if (!hasUserPermission(authenticated.actor.id, permission)) {
    return { response: apiProblem(request, 403, "PERMISSION_DENIED", "没有操作权限", `当前账号缺少 ${permission} 权限。`) };
  }
  return authenticated;
};

export const entityEtag = (entity: unknown) => {
  const value = JSON.stringify(entity);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `"${(hash >>> 0).toString(16)}"`;
};

export const checkIfMatch = (request: Request, entity: unknown, required = false) => {
  const currentEtag = entityEtag(entity);
  const supplied = request.headers.get("If-Match");
  if (!supplied && required) return apiProblem(request, 428, "IF_MATCH_REQUIRED", "缺少并发版本", "该写操作必须提供 If-Match 请求头。", { currentEtag });
  if (supplied && supplied !== currentEtag && supplied !== "*") {
    return apiProblem(request, 412, "REVISION_MISMATCH", "数据已被其他用户修改", "请重新获取资源后再提交。", { currentEtag });
  }
  return undefined;
};

export const parseJsonBody = async <T>(request: Request): Promise<T | Response> => {
  try {
    return await request.json() as T;
  } catch {
    return apiProblem(request, 400, "INVALID_JSON", "请求内容无效", "请求体必须是合法 JSON。 ");
  }
};

export const pageQuery = (request: Request, defaultSize = 20) => {
  const url = new URL(request.url);
  const number = Number(url.searchParams.get("page") ?? 1);
  const size = Number(url.searchParams.get("pageSize") ?? defaultSize);
  if (!Number.isInteger(number) || number < 1 || !Number.isInteger(size) || size < 1 || size > 100) {
    return { response: apiProblem(request, 400, "INVALID_PAGINATION", "分页参数无效", "page 必须大于等于 1，pageSize 必须介于 1 和 100。") } as const;
  }
  return { number, size } as const;
};

export const paginate = <T>(items: T[], number: number, size: number): PageResult<T> => ({
  items: items.slice((number - 1) * size, number * size),
  page: {
    number,
    size,
    totalElements: items.length,
    totalPages: items.length ? Math.ceil(items.length / size) : 0,
  },
});

const readIdempotencyRecords = () => {
  try {
    return JSON.parse(window.localStorage.getItem(IDEMPOTENCY_KEY) ?? "[]") as StoredIdempotencyRecord[];
  } catch {
    return [];
  }
};

const bodyHash = async (request: Request) => {
  const text = await request.clone().text();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(31, hash) + text.charCodeAt(index) | 0;
  return String(hash >>> 0);
};

export const withIdempotency = async (request: Request, operation: () => Promise<Response | undefined> | Response | undefined) => {
  const key = request.headers.get("Idempotency-Key");
  if (!key) return apiProblem(request, 400, "IDEMPOTENCY_KEY_REQUIRED", "缺少幂等键", "该命令必须提供 Idempotency-Key 请求头。 ");
  const scope = `${request.method} ${new URL(request.url).pathname}`;
  const hash = await bodyHash(request);
  const records = readIdempotencyRecords();
  const existing = records.find((item) => item.scope === scope && item.key === key);
  if (existing) {
    if (existing.bodyHash !== hash) return apiProblem(request, 409, "IDEMPOTENCY_KEY_REUSED", "幂等键已用于其他请求", "请为不同请求生成新的 Idempotency-Key。 ");
    return new HttpResponse(existing.body, {
      status: existing.status,
      statusText: existing.statusText,
      headers: existing.headers,
    });
  }
  const response = await operation() ?? apiProblem(request, 500, "MOCK_HANDLER_EMPTY_RESPONSE", "Mock 接口没有返回结果", "请检查对应 Mock handler 的所有代码分支。 ");
  if (response.status < 500) {
    const record: StoredIdempotencyRecord = {
      scope,
      key,
      bodyHash: hash,
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers.entries()),
      body: await response.clone().text(),
      createdAt: new Date().toISOString(),
    };
    const latestRecords = readIdempotencyRecords().filter((item) => !(item.scope === scope && item.key === key));
    window.localStorage.setItem(IDEMPOTENCY_KEY, JSON.stringify([record, ...latestRecords].slice(0, MAX_IDEMPOTENCY_RECORDS)));
  }
  return response;
};

export const appendAuditEvent = (event: Omit<AuditEvent, "id" | "occurredAt"> & { occurredAt?: string }) => {
  const current = readLocalAuditEvents();
  const session = usePrototypeStore.getState();
  const operator = session.impersonation ? findIdentityUser(session.operatorUserId) : undefined;
  const next: AuditEvent = {
    ...event,
    ...(session.impersonation && event.actorId === session.personaId ? {
      operatorId: operator?.id,
      operatorName: operator?.name,
      impersonationId: session.impersonation.id,
    } : {}),
    id: createClientUuid(),
    occurredAt: event.occurredAt ?? new Date().toISOString(),
  };
  writeLocalAuditEvents([next, ...current].slice(0, MAX_AUDIT_RECORDS));
  return next;
};

export const readAuditEvents = readLocalAuditEvents;
