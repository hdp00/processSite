import type { ApiEnvelope, ApiProblemDetails } from "./contracts";
import { createClientUuid } from "../utils/clientId";

type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

export interface ApiRequestOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: unknown;
  headers?: HeadersInit;
  query?: object;
  timeoutMs?: number;
  idempotencyKey?: string;
  ifMatch?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ApiProblemDetails;

  constructor(problem: ApiProblemDetails) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }
}

const API_TOKEN_KEY = "flowpilot-api-access-token";
const DEFAULT_TIMEOUT_MS = 15_000;

const apiBaseUrl = () => (import.meta.env.VITE_API_BASE_URL || "/api/v1").replace(/\/$/, "");

const storedMockSession = () => {
  try {
    const raw = window.localStorage.getItem("flowpilot-prototype-v5");
    const parsed = raw ? JSON.parse(raw) as { state?: { authenticated?: boolean; personaId?: string; operatorUserId?: string; impersonation?: unknown } } : undefined;
    return parsed?.state?.authenticated ? parsed.state : undefined;
  } catch {
    return undefined;
  }
};

export const readApiAccessToken = () => {
  const token = window.sessionStorage.getItem(API_TOKEN_KEY);
  if (import.meta.env.VITE_API_MODE === "remote") return token ?? undefined;
  const session = storedMockSession();
  const personaId = session?.personaId;
  if (session?.impersonation && session.operatorUserId) return `mock:${session.operatorUserId}`;
  if (token?.startsWith("mock:") && personaId && token !== `mock:${personaId}`) return `mock:${personaId}`;
  if (token) return token;
  return personaId ? `mock:${personaId}` : undefined;
};

export const writeApiAccessToken = (token?: string) => {
  if (token) window.sessionStorage.setItem(API_TOKEN_KEY, token);
  else window.sessionStorage.removeItem(API_TOKEN_KEY);
};

export const createIdempotencyKey = () =>
  `idempotency-${createClientUuid()}`;

const requestUrl = (path: string, query?: object) => {
  const url = new URL(`${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`, window.location.origin);
  Object.entries(query ?? {}).forEach(([key, rawValue]) => {
    const raw = rawValue as QueryValue;
    const values = Array.isArray(raw) ? raw : [raw];
    values.forEach((value) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
    });
  });
  return url.toString();
};

const fallbackProblem = (response: Response, requestId: string): ApiProblemDetails => ({
  type: "about:blank",
  title: response.statusText || "请求失败",
  status: response.status,
  detail: `REST API 返回 HTTP ${response.status}`,
  instance: response.url,
  code: "HTTP_ERROR",
  traceId: requestId,
});

export interface ApiResourceResult<T> {
  data: T;
  etag?: string;
  requestId: string;
}

const isApiEnvelope = <T>(value: unknown): value is ApiEnvelope<T> => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiEnvelope<T>>;
  return "data" in candidate
    && Boolean(candidate.meta)
    && typeof candidate.meta?.requestId === "string";
};

async function performApiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResourceResult<T>> {
  const {
    body,
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idempotencyKey,
    ifMatch,
    headers: customHeaders,
    signal,
    ...requestInit
  } = options;
  const controller = new AbortController();
  const requestId = `request-${createClientUuid()}`;
  const timeout = window.setTimeout(() => controller.abort(new DOMException("REST API 请求超时", "TimeoutError")), timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const headers = new Headers(customHeaders);
  headers.set("Accept", "application/json");
  headers.set("X-Request-Id", requestId);
  const token = readApiAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (ifMatch) headers.set("If-Match", ifMatch);

  let serializedBody: BodyInit | undefined;
  if (body instanceof FormData || body instanceof Blob || typeof body === "string") {
    serializedBody = body;
  } else if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    serializedBody = JSON.stringify(body);
  }

  try {
    const response = await fetch(requestUrl(path, query), {
      ...requestInit,
      headers,
      body: serializedBody,
      signal: controller.signal,
    });
    if (!response.ok) {
      const problem = response.headers.get("content-type")?.includes("json")
        ? await response.json() as ApiProblemDetails
        : fallbackProblem(response, requestId);
      throw new ApiError(problem);
    }
    if (response.status === 204) return {
      data: undefined as T,
      etag: response.headers.get("ETag") ?? undefined,
      requestId: response.headers.get("X-Request-Id") ?? requestId,
    };
    const payload = await response.json() as T | ApiEnvelope<T>;
    const envelope = isApiEnvelope<T>(payload) ? payload : undefined;
    return {
      // Debug Mock historically uses an envelope while the formal OpenAPI
      // contract returns the response DTO directly. Supporting both here keeps
      // transport compatibility out of page components.
      data: envelope ? envelope.data : payload as T,
      etag: response.headers.get("ETag") ?? undefined,
      requestId: envelope?.meta.requestId ?? response.headers.get("X-Request-Id") ?? requestId,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) {
      throw new ApiError({
        type: "https://flowpilot.local/problems/request-timeout",
        title: "请求超时",
        status: 408,
        detail: "REST API 请求超时，请稍后重试。",
        instance: path,
        code: "REQUEST_TIMEOUT",
        traceId: requestId,
      });
    }
    throw new ApiError({
      type: "https://flowpilot.local/problems/network-error",
      title: "网络连接失败",
      status: 0,
      detail: error instanceof Error ? error.message : "无法连接 REST API。",
      instance: path,
      code: "NETWORK_ERROR",
      traceId: requestId,
    });
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return (await performApiRequest<T>(path, options)).data;
}

export const apiResource = <T>(path: string, options: ApiRequestOptions = {}) =>
  performApiRequest<T>(path, options);

export async function apiDownload(path: string, options: ApiRequestOptions = {}) {
  const headers = new Headers(options.headers);
  const token = readApiAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(requestUrl(path, options.query), { ...options, headers, body: undefined });
  if (!response.ok) {
    const problem = response.headers.get("content-type")?.includes("json")
      ? await response.json() as ApiProblemDetails
      : fallbackProblem(response, response.headers.get("X-Request-Id") ?? "download");
    throw new ApiError(problem);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const fileName = decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? "download.bin");
  return { blob: await response.blob(), fileName };
}
