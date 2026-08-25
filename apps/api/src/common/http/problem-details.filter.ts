import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import type { TraceRequest } from "./request-context.middleware.js";
import { ProblemException, problemType, type ProblemCode, type ProblemDescriptor, type ProblemDetails } from "./problem-details.js";

const bodyParserFailures: Readonly<Record<string, { status: number; title: string }>> = {
  "entity.parse.failed": { status: 400, title: "请求正文不是有效的 JSON" },
  "entity.too.large": { status: 413, title: "请求正文超过大小限制" },
  "encoding.unsupported": { status: 415, title: "请求正文编码不受支持" },
  "charset.unsupported": { status: 415, title: "请求正文字符集不受支持" },
  "request.aborted": { status: 400, title: "请求正文未完整传输" },
  "request.size.invalid": { status: 400, title: "请求正文长度不正确" }
};

const bodyParserDescriptor = (exception: unknown): ProblemDescriptor | undefined => {
  if (!(exception instanceof Error) || !("type" in exception)) return undefined;
  const type = (exception as Error & { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  const mapped = bodyParserFailures[type];
  if (!mapped) return undefined;
  return {
    ...mapped,
    code: "BAD_REQUEST",
    detail: "请检查请求正文后重试。"
  };
};

export const describeHttpException = (exception: unknown): ProblemDescriptor => {
  if (exception instanceof ProblemException) return exception.problem;
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const mapping: Partial<Record<number, { code: ProblemCode; title: string }>> = {
      400: { code: "BAD_REQUEST", title: "请求参数不正确" },
      401: { code: "AUTHENTICATION_REQUIRED", title: "需要登录" },
      403: { code: "PERMISSION_DENIED", title: "没有操作权限" },
      404: { code: "RESOURCE_NOT_FOUND", title: "资源不存在" },
      429: { code: "RATE_LIMITED", title: "请求过于频繁" }
    };
    const mapped = mapping[status] ?? { code: "INTERNAL_SERVER_ERROR" as const, title: "服务暂时不可用" };
    return { status, ...mapped };
  }
  const parserFailure = bodyParserDescriptor(exception);
  if (parserFailure) return parserFailure;
  return {
    status: 500,
    code: "INTERNAL_SERVER_ERROR",
    title: "服务暂时不可用",
    detail: "服务器未能完成请求，请稍后重试。"
  };
};

const safeExceptionType = (exception: unknown): "ProblemException" | "HttpException" | "Error" | "Unknown" => {
  if (exception instanceof ProblemException) return "ProblemException";
  if (exception instanceof HttpException) return "HttpException";
  if (exception instanceof Error) return "Error";
  return "Unknown";
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<TraceRequest>();
    const response = context.getResponse<Response>();
    const descriptor = describeHttpException(exception);
    const body: ProblemDetails = {
      ...descriptor,
      type: problemType(descriptor.code),
      traceId: request.traceId,
      instance: request.originalUrl
    };

    if (descriptor.status >= 500) {
      this.logger.error({
        traceId: request.traceId,
        code: descriptor.code,
        errorType: safeExceptionType(exception),
      });
    }

    if (descriptor.retryAfterSeconds !== undefined) {
      response.setHeader("Retry-After", descriptor.retryAfterSeconds);
    }
    response.status(descriptor.status).type("application/problem+json").json(body);
  }
}
