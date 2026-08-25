import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DOMAIN_AUTHENTICATION_PROVIDER,
  type DomainAuthenticationHealthStatus,
  type DomainAuthenticationProvider
} from "../auth/domain-authentication.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  DatabaseReadinessError,
  FlowPilotDataSourceManager,
  UnsupportedLocalDbDriverError
} from "../database/index.js";
import { SmtpMailGateway, type SmtpVerificationResult } from "../mail/index.js";

export interface ReadinessDto {
  status: "ok" | "unavailable";
  checkedAt: string;
  version: string;
  code?: string;
}

export interface OperationalHealthCheckDto {
  name: "database" | "schema" | "domain-auth" | "smtp" | "attachment-storage" | "attachment-cleanup" | "email-outbox" | "scheduler";
  status: "ok" | "degraded" | "unavailable";
  checkedAt: string;
  code?: string;
  message?: string;
  metrics?: Record<string, string | number | boolean | null>;
}

export interface OperationalHealthDto {
  status: "ok" | "degraded" | "unavailable";
  checkedAt: string;
  version: string;
  checks: OperationalHealthCheckDto[];
}

const readinessCode = (error: unknown): string => {
  if (error instanceof UnsupportedLocalDbDriverError) return error.code;
  if (error instanceof DatabaseReadinessError) return error.code;
  return "DATABASE_UNAVAILABLE";
};

const databaseOperationalChecks = (
  result: Awaited<ReturnType<FlowPilotDataSourceManager["inspectReadiness"]>>,
  checkedAt: string
): OperationalHealthCheckDto[] => [
  {
    name: "database",
    status: "ok",
    checkedAt,
    metrics: {
      serverVersion: result.productVersion,
      serviceLevel: result.productLevel,
      compatibilityLevel: result.compatibilityLevel,
      collation: result.collation
    }
  },
  {
    name: "schema",
    status: "ok",
    checkedAt,
    metrics: { pendingMigrations: result.pendingMigrations }
  }
];

const domainOperationalCheck = (
  status: DomainAuthenticationHealthStatus,
  checkedAt: string
): OperationalHealthCheckDto => {
  switch (status) {
    case "reachable":
      return { name: "domain-auth", status: "ok", checkedAt };
    case "disabled":
      return {
        name: "domain-auth",
        status: "degraded",
        checkedAt,
        code: "DOMAIN_AUTH_DISABLED",
        message: "域认证当前未启用。"
      };
    case "unknown":
      return {
        name: "domain-auth",
        status: "degraded",
        checkedAt,
        code: "DOMAIN_AUTH_NOT_CHECKED",
        message: "服务启动后尚未发生域认证调用，当前只确认配置已通过校验。"
      };
    case "unavailable":
      return {
        name: "domain-auth",
        status: "unavailable",
        checkedAt,
        code: "DOMAIN_AUTHENTICATION_UNAVAILABLE",
        message: "当前探测未能连接任何已配置的域服务。"
      };
  }
};

const smtpOperationalCheck = (
  result: SmtpVerificationResult,
  checkedAt: string
): OperationalHealthCheckDto => {
  if (result.available) return { name: "smtp", status: "ok", checkedAt };
  return result.code === "SMTP_DISABLED"
    ? {
      name: "smtp",
      status: "degraded",
      checkedAt,
      code: result.code,
      message: "SMTP 邮件发送当前未启用。"
    }
    : {
      name: "smtp",
      status: "unavailable",
      checkedAt,
      code: result.code,
      message: "SMTP 连接或认证验证失败。"
    };
};

const overallOperationalStatus = (checks: readonly OperationalHealthCheckDto[]): OperationalHealthDto["status"] => {
  if (checks.some((check) => (
    (check.name === "database" || check.name === "schema") && check.status === "unavailable"
  ))) return "unavailable";
  return checks.some((check) => check.status !== "ok") ? "degraded" : "ok";
};

@Injectable()
export class ReadinessService {
  constructor(
    private readonly database: FlowPilotDataSourceManager,
    private readonly config: ConfigService<AppEnvironment, true>,
    @Inject(DOMAIN_AUTHENTICATION_PROVIDER)
    private readonly domainAuthentication: DomainAuthenticationProvider,
    private readonly smtp: SmtpMailGateway
  ) {}

  async getReadiness(): Promise<ReadinessDto> {
    const checkedAt = new Date().toISOString();
    try {
      await this.database.inspectReadiness();
      return {
        status: "ok",
        checkedAt,
        version: this.config.get("APP_VERSION", { infer: true })
      };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        version: this.config.get("APP_VERSION", { infer: true }),
        code: readinessCode(error)
      };
    }
  }

  async getOperationalDetails(): Promise<OperationalHealthDto> {
    const checkedAt = new Date().toISOString();
    const [databaseResult, domainResult, smtpResult] = await Promise.allSettled([
      this.database.inspectReadiness(),
      this.domainAuthentication.probeAvailability(),
      this.smtp.verify()
    ]);
    const checks: OperationalHealthCheckDto[] = databaseResult.status === "fulfilled"
      ? databaseOperationalChecks(databaseResult.value, checkedAt)
      : [{
        name: "database",
        status: "unavailable",
        checkedAt,
        code: readinessCode(databaseResult.reason)
      }];
    const domainStatus: DomainAuthenticationHealthStatus = domainResult.status === "fulfilled"
      ? domainResult.value
      : "unavailable";
    checks.push(domainOperationalCheck(domainStatus, checkedAt));
    checks.push(smtpOperationalCheck(
      smtpResult.status === "fulfilled"
        ? smtpResult.value
        : { available: false, code: "SMTP_UNAVAILABLE" },
      checkedAt
    ));
    return {
      status: overallOperationalStatus(checks),
      checkedAt,
      version: this.config.get("APP_VERSION", { infer: true }),
      checks
    };
  }
}
