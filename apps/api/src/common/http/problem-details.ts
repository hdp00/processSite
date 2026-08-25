import { HttpException } from "@nestjs/common";

export type ProblemCode =
  | "BAD_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "CSRF_VALIDATION_FAILED"
  | "PERMISSION_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED"
  | "DOMAIN_AUTHENTICATION_UNAVAILABLE"
  | "INTERNAL_SERVER_ERROR";

export interface ValidationIssue {
  path?: string;
  code: string;
  message: string;
  severity?: "error" | "warning";
}

export interface ProblemDescriptor {
  status: number;
  code: ProblemCode;
  title: string;
  detail?: string;
  errors?: ValidationIssue[];
  retryAfterSeconds?: number;
}

export interface ProblemDetails extends ProblemDescriptor {
  type: string;
  traceId: string;
  instance: string;
}

export class ProblemException extends HttpException {
  readonly problem: ProblemDescriptor;

  constructor(problem: ProblemDescriptor) {
    super(problem, problem.status);
    this.problem = problem;
  }
}

export function problemType(code: string): string {
  return `/problems/${code.toLowerCase().replaceAll("_", "-")}`;
}
