import type { ConfigService } from "@nestjs/config";
import type { DataSourceOptions } from "typeorm";
import type { AppEnvironment } from "../config/environment.js";
import { isUnsupportedLocalDbServer } from "../config/environment.js";
import { FLOWPILOT_ENTITIES } from "./entities/index.js";
import { FLOWPILOT_MIGRATIONS } from "./migrations/index.js";

export const UNSUPPORTED_LOCALDB_DRIVER = "UNSUPPORTED_LOCALDB_DRIVER";

export type DatabaseEnvironment = Pick<
  AppEnvironment,
  | "MSSQL_SERVER"
  | "MSSQL_PORT"
  | "MSSQL_DATABASE"
  | "MSSQL_SCHEMA"
  | "MSSQL_USER"
  | "MSSQL_PASSWORD"
  | "MSSQL_ENCRYPT"
  | "MSSQL_TRUST_SERVER_CERTIFICATE"
  | "MSSQL_EXPECTED_COMPATIBILITY_LEVEL"
  | "MSSQL_EXPECTED_COLLATION"
  | "MSSQL_POOL_MIN"
  | "MSSQL_POOL_MAX"
  | "MSSQL_CONNECT_TIMEOUT_MS"
  | "MSSQL_REQUEST_TIMEOUT_MS"
  | "MSSQL_DEADLOCK_RETRY_COUNT"
>;

export class UnsupportedLocalDbDriverError extends Error {
  readonly code = UNSUPPORTED_LOCALDB_DRIVER;

  constructor() {
    super(
      "当前后端固定使用 mssql 的纯 JavaScript tedious 驱动；该驱动要求 TCP/IP，"
        + "不支持 (localdb)\\... LocalDB 连接。请改用启用 TCP/IP 和 SQL 账号认证的 SQL Server 实例。"
    );
    this.name = "UnsupportedLocalDbDriverError";
  }
}

export function assertSupportedMssqlServer(server: string): void {
  if (isUnsupportedLocalDbServer(server)) throw new UnsupportedLocalDbDriverError();
}

export function readDatabaseEnvironment(
  config: ConfigService<AppEnvironment, true>
): DatabaseEnvironment {
  return {
    MSSQL_SERVER: config.getOrThrow<string>("MSSQL_SERVER"),
    MSSQL_PORT: config.getOrThrow<number>("MSSQL_PORT"),
    MSSQL_DATABASE: config.getOrThrow<string>("MSSQL_DATABASE"),
    MSSQL_SCHEMA: config.getOrThrow<"flowpilot">("MSSQL_SCHEMA"),
    MSSQL_USER: config.getOrThrow<string>("MSSQL_USER"),
    MSSQL_PASSWORD: config.getOrThrow<string>("MSSQL_PASSWORD"),
    MSSQL_ENCRYPT: config.getOrThrow<boolean>("MSSQL_ENCRYPT"),
    MSSQL_TRUST_SERVER_CERTIFICATE: config.getOrThrow<boolean>("MSSQL_TRUST_SERVER_CERTIFICATE"),
    MSSQL_EXPECTED_COMPATIBILITY_LEVEL: config.getOrThrow<130>("MSSQL_EXPECTED_COMPATIBILITY_LEVEL"),
    MSSQL_EXPECTED_COLLATION: config.getOrThrow<string>("MSSQL_EXPECTED_COLLATION"),
    MSSQL_POOL_MIN: config.getOrThrow<number>("MSSQL_POOL_MIN"),
    MSSQL_POOL_MAX: config.getOrThrow<number>("MSSQL_POOL_MAX"),
    MSSQL_CONNECT_TIMEOUT_MS: config.getOrThrow<number>("MSSQL_CONNECT_TIMEOUT_MS"),
    MSSQL_REQUEST_TIMEOUT_MS: config.getOrThrow<number>("MSSQL_REQUEST_TIMEOUT_MS"),
    MSSQL_DEADLOCK_RETRY_COUNT: config.getOrThrow<number>("MSSQL_DEADLOCK_RETRY_COUNT")
  };
}

export function createDataSourceOptions(environment: DatabaseEnvironment): DataSourceOptions {
  assertSupportedMssqlServer(environment.MSSQL_SERVER);

  return {
    type: "mssql",
    host: environment.MSSQL_SERVER,
    port: environment.MSSQL_PORT,
    username: environment.MSSQL_USER,
    password: environment.MSSQL_PASSWORD,
    database: environment.MSSQL_DATABASE,
    // Every business Entity declares flowpilot explicitly. Keeping TypeORM's
    // technical migration ledger in dbo lets the first migration create the
    // flowpilot schema itself on an empty database.
    schema: "dbo",
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: "all",
    migrationsTableName: "flowpilot_typeorm_migrations",
    entities: [...FLOWPILOT_ENTITIES],
    migrations: [...FLOWPILOT_MIGRATIONS],
    logging: false,
    connectionTimeout: environment.MSSQL_CONNECT_TIMEOUT_MS,
    requestTimeout: environment.MSSQL_REQUEST_TIMEOUT_MS,
    options: {
      encrypt: environment.MSSQL_ENCRYPT,
      trustServerCertificate: environment.MSSQL_TRUST_SERVER_CERTIFICATE,
      enableArithAbort: true,
      useUTC: true
    },
    pool: {
      min: environment.MSSQL_POOL_MIN,
      max: environment.MSSQL_POOL_MAX
    }
  };
}
