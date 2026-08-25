import { randomUUID } from "node:crypto";
import type { NestMiddleware } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

export interface TraceRequest extends Request {
  traceId: string;
}

const validRequestId = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveTraceId(requestedId: unknown, existingTraceId?: unknown): string {
  if (typeof existingTraceId === "string" && validRequestId.test(existingTraceId)) {
    return existingTraceId;
  }
  if (typeof requestedId === "string") {
    const normalized = requestedId.trim();
    if (validRequestId.test(normalized)) return normalized;
  }
  return randomUUID();
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: TraceRequest, response: Response, next: NextFunction): void {
    request.traceId = resolveTraceId(request.header("X-Request-Id"), request.traceId);
    response.setHeader("X-Request-Id", request.traceId);
    next();
  }
}
