import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const positiveInteger = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);
const nonNegativeInteger = (defaultValue: number) => z.coerce.number().int().nonnegative().default(defaultValue);

const publicBaseUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol))) {
    context.addIssue({ code: "custom", message: "必须使用 HTTP 或 HTTPS 协议" });
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "不能包含用户信息、查询参数或片段" });
  }
  if (url.pathname !== "/flowpilot" || value.endsWith("/")) {
    context.addIssue({ code: "custom", message: "路径必须以 /flowpilot 结束且不能有末尾斜杠" });
  }
});

const domainAuthUrls = z.string().trim().min(1).superRefine((value, context) => {
  const urls = value.split(/[;,]/u).map((item) => item.trim()).filter(Boolean);
  if (urls.length === 0) {
    context.addIssue({ code: "custom", message: "至少配置一个 LDAP 或 LDAPS 地址" });
    return;
  }
  urls.forEach((item) => {
    try {
      const url = new URL(item);
      if (!(url.protocol === "ldap:" || url.protocol === "ldaps:")) {
        context.addIssue({ code: "custom", message: "只允许 ldap:// 或 ldaps:// 地址" });
      }
      if (url.username || url.password || url.search || url.hash || !url.hostname) {
        context.addIssue({ code: "custom", message: "LDAP 地址不能包含凭据、查询参数或片段" });
      }
      if (!(url.pathname === "" || url.pathname === "/")) {
        context.addIssue({ code: "custom", message: "LDAP 地址不能包含路径；搜索根请使用 DOMAIN_AUTH_BASE_DN" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "LDAP 地址格式无效" });
    }
  });
});

const smtpHost = z.string().trim().min(1).regex(/^[^\s\u0000-\u001f\u007f]+$/u, "SMTP 主机格式无效");
const optionalEmailAddress = z.string().trim().email().optional();

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_VERSION: z.string().min(1).default("0.1.0"),
  HTTP_JSON_LIMIT_BYTES: positiveInteger(1_048_576),
  FLOWPILOT_PUBLIC_BASE_URL: publicBaseUrl,
  FLOWPILOT_BUSINESS_TIME_ZONE: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
  FLOWPILOT_COOKIE_SECURE: booleanFromEnvironment.default(false),
  AUTH_LOGIN_FAILURE_WINDOW_MS: positiveInteger(15 * 60 * 1_000),
  AUTH_LOGIN_BLOCK_DURATION_MS: positiveInteger(15 * 60 * 1_000),
  AUTH_LOGIN_ACCOUNT_IP_FAILURE_LIMIT: positiveInteger(5),
  AUTH_LOGIN_IP_FAILURE_LIMIT: positiveInteger(100),
  AUTH_LOGIN_UNAVAILABLE_WINDOW_MS: positiveInteger(60 * 1_000),
  AUTH_LOGIN_UNAVAILABLE_BLOCK_DURATION_MS: positiveInteger(60 * 1_000),
  AUTH_LOGIN_UNAVAILABLE_IP_LIMIT: positiveInteger(60),
  AUTH_LOGIN_GLOBAL_IN_FLIGHT_LIMIT: positiveInteger(4),
  AUTH_LOGIN_IP_IN_FLIGHT_LIMIT: positiveInteger(2),
  MSSQL_SERVER: z.string().trim().min(1),
  MSSQL_PORT: z.coerce.number().int().min(1).max(65_535).default(1433),
  MSSQL_DATABASE: z.string().trim().min(1),
  MSSQL_SCHEMA: z.literal("flowpilot").default("flowpilot"),
  MSSQL_USER: z.string().trim().min(1),
  MSSQL_PASSWORD: z.string().min(1),
  MSSQL_ENCRYPT: booleanFromEnvironment.default(true),
  MSSQL_TRUST_SERVER_CERTIFICATE: booleanFromEnvironment.default(false),
  MSSQL_EXPECTED_COMPATIBILITY_LEVEL: z.coerce.number().int().refine((value) => value === 130, {
    message: "最低 SQL Server 兼容级别门槛固定为 130"
  }).default(130),
  MSSQL_EXPECTED_COLLATION: z.string().trim().min(1),
  MSSQL_POOL_MIN: nonNegativeInteger(0),
  MSSQL_POOL_MAX: positiveInteger(20),
  MSSQL_CONNECT_TIMEOUT_MS: positiveInteger(5_000),
  MSSQL_REQUEST_TIMEOUT_MS: positiveInteger(30_000),
  MSSQL_DEADLOCK_RETRY_COUNT: nonNegativeInteger(3),
  DOMAIN_AUTH_ENABLED: booleanFromEnvironment.default(true),
  DOMAIN_AUTH_URLS: domainAuthUrls.optional(),
  DOMAIN_AUTH_BASE_DN: z.string().trim().optional(),
  DOMAIN_AUTH_UPN_SUFFIX: z.string().trim().optional(),
  DOMAIN_AUTH_NETBIOS_NAME: z.string().trim().optional(),
  DOMAIN_AUTH_ACCOUNT_ATTRIBUTE: z.literal("sAMAccountName").default("sAMAccountName"),
  DOMAIN_AUTH_ALLOW_PLAINTEXT: booleanFromEnvironment.default(false),
  DOMAIN_AUTH_CONNECT_TIMEOUT_MS: positiveInteger(3_000),
  DOMAIN_AUTH_OPERATION_TIMEOUT_MS: positiveInteger(5_000),
  DOMAIN_AUTH_TLS_REJECT_UNAUTHORIZED: booleanFromEnvironment.default(true),
  SMTP_ENABLED: booleanFromEnvironment.default(false),
  SMTP_HOST: smtpHost.optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(25),
  SMTP_SECURE: booleanFromEnvironment.default(false),
  SMTP_REQUIRE_TLS: booleanFromEnvironment.default(true),
  SMTP_IGNORE_TLS: booleanFromEnvironment.default(false),
  SMTP_TLS_REJECT_UNAUTHORIZED: booleanFromEnvironment.default(true),
  SMTP_TLS_SERVERNAME: z.string().trim().min(1).optional(),
  SMTP_USER: z.string().trim().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: optionalEmailAddress,
  SMTP_REPLY_TO: optionalEmailAddress,
  SMTP_CONNECTION_TIMEOUT_MS: positiveInteger(5_000),
  SMTP_GREETING_TIMEOUT_MS: positiveInteger(5_000),
  SMTP_SOCKET_TIMEOUT_MS: positiveInteger(15_000),
  SMTP_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(5).default(5),
  FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).max(200).optional()
}).superRefine((value, context) => {
  if (new URL(value.FLOWPILOT_PUBLIC_BASE_URL).protocol === "https:" && !value.FLOWPILOT_COOKIE_SECURE) {
    context.addIssue({
      code: "custom",
      path: ["FLOWPILOT_COOKIE_SECURE"],
      message: "HTTPS 部署必须启用 Secure Cookie"
    });
  }
  if (value.MSSQL_POOL_MAX < value.MSSQL_POOL_MIN) {
    context.addIssue({
      code: "custom",
      path: ["MSSQL_POOL_MAX"],
      message: "必须大于或等于 MSSQL_POOL_MIN"
    });
  }
  if (value.AUTH_LOGIN_IP_IN_FLIGHT_LIMIT > value.AUTH_LOGIN_GLOBAL_IN_FLIGHT_LIMIT) {
    context.addIssue({
      code: "custom",
      path: ["AUTH_LOGIN_IP_IN_FLIGHT_LIMIT"],
      message: "必须小于或等于 AUTH_LOGIN_GLOBAL_IN_FLIGHT_LIMIT"
    });
  }
  if (value.DOMAIN_AUTH_ENABLED) {
    (["DOMAIN_AUTH_URLS", "DOMAIN_AUTH_BASE_DN", "DOMAIN_AUTH_UPN_SUFFIX"] as const).forEach((key) => {
      if (!value[key]) {
        context.addIssue({ code: "custom", path: [key], message: "启用域认证时必填" });
      }
    });
    if (
      value.DOMAIN_AUTH_URLS
      && !value.DOMAIN_AUTH_ALLOW_PLAINTEXT
      && value.DOMAIN_AUTH_URLS.split(/[;,]/u).some((item) => {
        try {
          return new URL(item.trim()).protocol === "ldap:";
        } catch {
          return false;
        }
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["DOMAIN_AUTH_ALLOW_PLAINTEXT"],
        message: "ldap:// 会明文传输域密码；必须改用 ldaps://，或显式接受明文风险",
      });
    }
  }
  if (value.SMTP_ENABLED) {
    (["SMTP_HOST", "SMTP_FROM"] as const).forEach((key) => {
      if (!value[key]) {
        context.addIssue({ code: "custom", path: [key], message: "启用 SMTP 时必填" });
      }
    });
  }
  if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
    context.addIssue({
      code: "custom",
      path: [value.SMTP_USER ? "SMTP_PASSWORD" : "SMTP_USER"],
      message: "SMTP 用户名和密码必须同时配置"
    });
  }
  if (value.SMTP_REQUIRE_TLS && value.SMTP_IGNORE_TLS) {
    context.addIssue({
      code: "custom",
      path: ["SMTP_IGNORE_TLS"],
      message: "不能与 SMTP_REQUIRE_TLS 同时启用"
    });
  }
  if (value.SMTP_SECURE && value.SMTP_IGNORE_TLS) {
    context.addIssue({
      code: "custom",
      path: ["SMTP_IGNORE_TLS"],
      message: "不能在 SMTP_SECURE 启用时忽略 TLS"
    });
  }
  if (value.SMTP_ENABLED && !value.SMTP_SECURE && !value.SMTP_REQUIRE_TLS && !value.SMTP_IGNORE_TLS) {
    context.addIssue({
      code: "custom",
      path: ["SMTP_REQUIRE_TLS"],
      message: "必须要求 STARTTLS，或通过 SMTP_IGNORE_TLS 明确接受明文 SMTP 风险"
    });
  }
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export class EnvironmentValidationError extends Error {
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }));
    super(`FlowPilot 配置无效：${issues.map((issue) => `${issue.path}: ${issue.message}`).join("；")}`);
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

export function validateEnvironment(input: Record<string, unknown>): AppEnvironment {
  const result = environmentSchema.safeParse(input);
  if (!result.success) throw new EnvironmentValidationError(result.error);
  return result.data;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export function resolveFlowPilotAppDirectory(): string {
  if (process.env.FLOWPILOT_APP_DIR) return resolve(process.env.FLOWPILOT_APP_DIR);
  return resolve(moduleDirectory, "..", "..");
}

export function resolveFlowPilotHome(): string {
  if (process.env.FLOWPILOT_HOME) return resolve(process.env.FLOWPILOT_HOME);
  return dirname(resolveFlowPilotAppDirectory());
}

export function resolveEnvironmentFilePaths(): string[] {
  const flowPilotHome = resolveFlowPilotHome();
  return [
    process.env.FLOWPILOT_SECRETS_FILE
      ? resolve(process.env.FLOWPILOT_SECRETS_FILE)
      : resolve(flowPilotHome, "Secrets", "production.env"),
    process.env.FLOWPILOT_CONFIG_FILE
      ? resolve(process.env.FLOWPILOT_CONFIG_FILE)
      : resolve(flowPilotHome, "Config", "application.env")
  ];
}

export function isUnsupportedLocalDbServer(server: string): boolean {
  return /^\(localdb\)\\/i.test(server.trim());
}
