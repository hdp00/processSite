import type { ApiProblemDetails } from "./contracts";
import { createClientUuid } from "../utils/clientId";

type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean> | Record<string, unknown>;

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
    super(toUserFacingApiMessage(problem));
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const pendingRequestControllers = new Set<AbortController>();

export const abortPendingApiRequests = () => {
  pendingRequestControllers.forEach((controller) => controller.abort());
  pendingRequestControllers.clear();
};

const statusMessage = (status: number) => {
  if (status === 0 || status === 502 || status === 503) {
    return "无法连接后端服务，请确认后端已启动，或稍后重试。";
  }
  if (status === 408 || status === 504) return "后端服务响应超时，请稍后重试。";
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "当前账号没有执行此操作的权限。";
  if (status === 404) return "请求的数据或功能不存在，请刷新页面后重试。";
  if (status === 409 || status === 412) return "数据已发生变化，请刷新后重试。";
  if (status === 428) return "页面数据缺少最新版本信息，请刷新后重试。";
  if (status === 429) return "操作过于频繁，请稍后重试。";
  if (status >= 500) return "服务器处理请求时发生错误，请稍后重试。";
  if (status >= 400) return "请求未能完成，请检查输入后重试。";
  return "操作失败，请稍后重试。";
};

const toUserFacingApiMessage = (problem: ApiProblemDetails) => {
  if (problem.code === "NETWORK_ERROR") return statusMessage(0);
  if (problem.code === "REQUEST_TIMEOUT") return statusMessage(408);
  if (problem.status >= 500 || problem.code === "HTTP_ERROR") return statusMessage(problem.status);

  // 业务 Problem Details 的中文 detail 对用户通常比统一状态文案更有帮助。
  // 原始 problem 仍完整保留在 ApiError.problem 中，便于调试和按 traceId 排查。
  const detail = problem.detail?.trim();
  if (detail) return detail;
  const title = problem.title?.trim();
  return title || statusMessage(problem.status);
};

const apiBaseUrl = () => (import.meta.env.VITE_API_BASE_URL || "/api/flowpilot/v1").replace(/\/$/, "");

export const createIdempotencyKey = () =>
  `idempotency-${createClientUuid()}`;

const requestUrl = (path: string, query?: object) => {
  const url = new URL(`${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`, window.location.origin);
  Object.entries(query ?? {}).forEach(([key, rawValue]) => {
    const raw = rawValue as QueryValue;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      Object.entries(raw).forEach(([nestedKey, nestedValue]) => {
        if (nestedValue !== undefined && nestedValue !== null && nestedValue !== "") {
          url.searchParams.append(`${key}[${nestedKey}]`, String(nestedValue));
        }
      });
      return;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    values.forEach((value) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
    });
  });
  return url.toString();
};

const fallbackProblem = (response: Response, requestId: string): ApiProblemDetails => ({
  type: "about:blank",
  title: "请求失败",
  status: response.status,
  detail: statusMessage(response.status),
  instance: response.url,
  code: "HTTP_ERROR",
  traceId: requestId,
});

const responseProblem = async (response: Response, requestId: string) => {
  const fallback = fallbackProblem(response, requestId);
  if (!response.headers.get("content-type")?.includes("json")) return fallback;

  try {
    const value = await response.json() as Partial<ApiProblemDetails> | null;
    if (!value || typeof value !== "object") return fallback;
    return {
      ...fallback,
      type: typeof value.type === "string" ? value.type : fallback.type,
      title: typeof value.title === "string" ? value.title : fallback.title,
      detail: typeof value.detail === "string" ? value.detail : fallback.detail,
      code: typeof value.code === "string" ? value.code : fallback.code,
      traceId: typeof value.traceId === "string" ? value.traceId : fallback.traceId,
      errors: Array.isArray(value.errors) ? value.errors : undefined,
      currentEtag: typeof value.currentEtag === "string" ? value.currentEtag : undefined,
    } satisfies ApiProblemDetails;
  } catch {
    return fallback;
  }
};

const connectionProblem = (path: string, requestId: string): ApiProblemDetails => ({
  type: "https://flowpilot.local/problems/network-error",
  title: "无法连接后端服务",
  status: 0,
  detail: statusMessage(0),
  instance: path,
  code: "NETWORK_ERROR",
  traceId: requestId,
});

const timeoutProblem = (path: string, requestId: string): ApiProblemDetails => ({
  type: "https://flowpilot.local/problems/request-timeout",
  title: "请求超时",
  status: 408,
  detail: statusMessage(408),
  instance: path,
  code: "REQUEST_TIMEOUT",
  traceId: requestId,
});

export interface ApiResourceResult<T> {
  data: T;
  etag?: string;
  requestId: string;
}

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
  pendingRequestControllers.add(controller);
  const requestId = `request-${createClientUuid()}`;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("REST API 请求超时", "TimeoutError"));
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const headers = new Headers(customHeaders);
  headers.set("Accept", "application/json");
  headers.set("X-Request-Id", requestId);
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
      throw new ApiError(await responseProblem(response, requestId));
    }
    if (response.status === 204) return {
      data: undefined as T,
      etag: response.headers.get("ETag") ?? undefined,
      requestId: response.headers.get("X-Request-Id") ?? requestId,
    };
    const payload = await response.json() as T;
    return {
      data: payload,
      etag: response.headers.get("ETag") ?? undefined,
      requestId: response.headers.get("X-Request-Id") ?? requestId,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) {
      throw new ApiError(timeoutProblem(path, requestId));
    }
    if (controller.signal.aborted) throw error;
    throw new ApiError(connectionProblem(path, requestId));
  } finally {
    pendingRequestControllers.delete(controller);
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
  const {
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idempotencyKey,
    ifMatch,
    headers: customHeaders,
    signal,
    ...requestInit
  } = options;
  const controller = new AbortController();
  pendingRequestControllers.add(controller);
  const requestId = `request-${createClientUuid()}`;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("REST API 请求超时", "TimeoutError"));
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const headers = new Headers(customHeaders);
  headers.set("X-Request-Id", requestId);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (ifMatch) headers.set("If-Match", ifMatch);

  try {
    const response = await fetch(requestUrl(path, query), {
      ...requestInit,
      headers,
      body: undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiError(await responseProblem(response, response.headers.get("X-Request-Id") ?? requestId));
    }
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const encodedFileName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? "download.bin";
    let fileName = encodedFileName;
    try {
      fileName = decodeURIComponent(encodedFileName);
    } catch {
      // Keep the server-provided text when percent encoding is malformed.
    }
    return { blob: await response.blob(), fileName };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError(timeoutProblem(path, requestId));
    if (controller.signal.aborted) throw error;
    throw new ApiError(connectionProblem(path, requestId));
  } finally {
    pendingRequestControllers.delete(controller);
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
