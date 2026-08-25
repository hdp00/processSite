import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import type { AppEnvironment } from "../config/environment.js";
import {
  createDataSourceOptions,
  readDatabaseEnvironment,
  type DatabaseEnvironment
} from "./database-options.js";
import { EXPECTED_SCHEMA_MIGRATIONS } from "./migrations/index.js";
import {
  BUILTIN_IDS,
  BUILTIN_PERMISSION_SEEDS,
  BUILTIN_SEED_VERSION
} from "./seed/builtin-catalog.js";

export interface DatabasePlatformSnapshot {
  readonly productVersion: string;
  readonly productLevel: string;
  readonly compatibilityLevel: number;
  readonly collation: string;
}

export interface DatabaseStructureReadinessSnapshot extends DatabasePlatformSnapshot {
  readonly schemaExists: boolean;
  readonly migrationLedgerExists: boolean;
  readonly migrationChecksumsValid: boolean;
  readonly pendingMigrations: boolean;
}

export interface DatabaseReadinessSnapshot extends DatabaseStructureReadinessSnapshot {
  readonly builtinSuperAdminCount: number;
  readonly seedVersion: string | null;
}

export class DatabaseReadinessError extends Error {
  constructor(
    readonly code:
      | "DATABASE_SERVER_VERSION_MISMATCH"
      | "DATABASE_SERVER_SERVICE_LEVEL_MISMATCH"
      | "DATABASE_COMPATIBILITY_LEVEL_MISMATCH"
      | "DATABASE_COLLATION_MISMATCH"
      | "DATABASE_SCHEMA_MISSING"
      | "DATABASE_MIGRATION_LEDGER_MISSING"
      | "DATABASE_MIGRATION_CHECKSUM_MISMATCH"
      | "DATABASE_MIGRATIONS_PENDING"
      | "DATABASE_SEED_MISSING"
      | "DATABASE_SEED_VERSION_MISMATCH"
      | "DATABASE_SEED_CATALOG_MISMATCH"
      | "DATABASE_BUILTIN_SUPER_ADMIN_INVALID",
    message: string
  ) {
    super(message);
    this.name = "DatabaseReadinessError";
  }
}

/**
 * Owns a retryable, lazy DataSource. Importing DatabaseModule never opens a
 * socket, so liveness remains available while SQL Server is unavailable.
 */
@Injectable()
export class FlowPilotDataSourceManager implements OnApplicationShutdown {
  private dataSource: DataSource | undefined;
  private initialization: Promise<DataSource> | undefined;
  private shuttingDown = false;

  constructor(private readonly config: ConfigService<AppEnvironment, true>) {}

  get isInitialized(): boolean {
    return this.dataSource?.isInitialized === true;
  }

  async ensureInitialized(): Promise<DataSource> {
    if (this.shuttingDown) throw new Error("数据库连接管理器正在关闭");
    if (this.dataSource?.isInitialized) return this.dataSource;
    if (this.initialization) return this.initialization;

    const environment = readDatabaseEnvironment(this.config);
    const candidate = this.createDataSource(environment);
    this.dataSource = candidate;
    this.initialization = candidate.initialize()
      .then(() => candidate)
      .catch(async (error: unknown) => {
        this.dataSource = undefined;
        if (candidate.isInitialized) await candidate.destroy().catch(() => undefined);
        throw error;
      })
      .finally(() => {
        this.initialization = undefined;
      });

    return this.initialization;
  }

  /** Validates immutable platform prerequisites without reading or changing application tables. */
  async inspectPlatform(): Promise<DatabasePlatformSnapshot> {
    const environment = readDatabaseEnvironment(this.config);
    const dataSource = await this.ensureInitialized();
    const rows = await dataSource.query<Array<{
      product_version: string | null;
      product_level: string | null;
      compatibility_level: number;
      collation_name: string;
    }>>(`
      SELECT
        CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')) AS [product_version],
        CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductLevel')) AS [product_level],
        CONVERT(int, [compatibility_level]) AS [compatibility_level],
        CONVERT(nvarchar(128), [collation_name]) AS [collation_name]
      FROM sys.databases
      WHERE [name] = DB_NAME()
    `);
    const row = rows[0];
    if (!row) throw new Error("当前数据库元数据不可用");
    const snapshot: DatabasePlatformSnapshot = {
      productVersion: row.product_version ?? "",
      productLevel: row.product_level ?? "",
      compatibilityLevel: row.compatibility_level,
      collation: row.collation_name
    };
    this.assertPlatform(snapshot, environment);
    return snapshot;
  }

  async inspectSchemaReadiness(): Promise<DatabaseStructureReadinessSnapshot> {
    const environment = readDatabaseEnvironment(this.config);
    const dataSource = await this.ensureInitialized();
    const rows = await dataSource.query<Array<{
      product_version: string | null;
      product_level: string | null;
      compatibility_level: number;
      collation_name: string;
      schema_exists: number;
      migration_ledger_exists: number;
    }>>(`
      SELECT
        CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')) AS [product_version],
        CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductLevel')) AS [product_level],
        CONVERT(int, [compatibility_level]) AS [compatibility_level],
        CONVERT(nvarchar(128), [collation_name]) AS [collation_name],
        CASE WHEN SCHEMA_ID(N'flowpilot') IS NULL THEN 0 ELSE 1 END AS [schema_exists],
        CASE WHEN OBJECT_ID(N'[flowpilot].[schema_migrations]', N'U') IS NULL
          THEN 0 ELSE 1 END AS [migration_ledger_exists]
      FROM sys.databases
      WHERE [name] = DB_NAME()
    `);
    const row = rows[0];
    if (!row) throw new Error("当前数据库元数据不可用");

    const ledgerRows = row.migration_ledger_exists === 1
      ? await dataSource.query<Array<{
          migration_id: string;
          checksum: string;
          result: string;
        }>>(`
          SELECT [migration_id], [checksum], [result]
          FROM [flowpilot].[schema_migrations]
        `)
      : [];
    const ledgerById = new Map(ledgerRows.map((entry) => [entry.migration_id, entry]));

    const snapshot: DatabaseStructureReadinessSnapshot = {
      productVersion: row.product_version ?? "",
      productLevel: row.product_level ?? "",
      compatibilityLevel: row.compatibility_level,
      collation: row.collation_name,
      schemaExists: row.schema_exists === 1,
      migrationLedgerExists: row.migration_ledger_exists === 1,
      migrationChecksumsValid: EXPECTED_SCHEMA_MIGRATIONS.every((migration) => (
        ledgerById.get(migration.id)?.checksum === migration.checksum
      )),
      pendingMigrations: EXPECTED_SCHEMA_MIGRATIONS.some((migration) => (
        ledgerById.get(migration.id)?.result !== "succeeded"
      ))
    };
    this.assertStructureReady(snapshot, environment);
    return snapshot;
  }

  async inspectReadiness(): Promise<DatabaseReadinessSnapshot> {
    const structure = await this.inspectSchemaReadiness();
    const dataSource = await this.ensureInitialized();
    const rows = await dataSource.query<Array<{
      builtin_super_admin_count: number;
      seed_state_json: string | null;
    }>>(`
      SELECT
        CONVERT(int, (
          SELECT COUNT_BIG(1)
          FROM [flowpilot].[users]
          WHERE [is_builtin_super_admin] = 1
        )) AS [builtin_super_admin_count],
        (
          SELECT [value_json]
          FROM [flowpilot].[system_state]
          WHERE [state_key] = N'builtin-seed'
        ) AS [seed_state_json]
    `);
    const row = rows[0];
    if (!row) throw new Error("数据库种子状态不可用");
    let seedVersion: string | null = null;
    if (row.seed_state_json !== null) {
      try {
        const parsed = JSON.parse(row.seed_state_json) as unknown;
        if (
          typeof parsed === "object"
          && parsed !== null
          && "version" in parsed
          && typeof (parsed as { version?: unknown }).version === "string"
        ) {
          seedVersion = (parsed as { version: string }).version;
        }
      } catch {
        seedVersion = null;
      }
    }
    if (row.seed_state_json === null || row.builtin_super_admin_count === 0) {
      throw new DatabaseReadinessError("DATABASE_SEED_MISSING", "数据库尚未完成内置种子初始化");
    }
    if (seedVersion !== BUILTIN_SEED_VERSION) {
      throw new DatabaseReadinessError(
        "DATABASE_SEED_VERSION_MISMATCH",
        "数据库内置种子版本与当前构建不一致"
      );
    }
    if (row.builtin_super_admin_count !== 1) {
      throw new DatabaseReadinessError(
        "DATABASE_BUILTIN_SUPER_ADMIN_INVALID",
        "数据库必须且只能存在一个内置超级管理员"
      );
    }

    const permissionRows = await dataSource.query<Array<{
      code: string;
      resource: string;
      action: string;
      name: string;
      sort_order: number;
      is_builtin: boolean | number;
    }>>(`
      SELECT [code], [resource], [action], [name], [sort_order], [is_builtin]
      FROM [flowpilot].[permissions]
      WHERE [is_builtin] = 1
      ORDER BY [code]
    `);
    const expectedPermissions = [...BUILTIN_PERMISSION_SEEDS].sort((left, right) => (
      left.code.localeCompare(right.code)
    ));
    const actualPermissions = [...permissionRows].sort((left, right) => (
      left.code.localeCompare(right.code)
    ));
    const catalogMatches = actualPermissions.length === expectedPermissions.length
      && expectedPermissions.every((expected, index) => {
        const actual = actualPermissions[index];
        return actual?.code === expected.code
          && actual.resource === expected.resource
          && actual.action === expected.action
          && actual.name === expected.name
          && actual.sort_order === expected.sortOrder
          && (actual.is_builtin === true || actual.is_builtin === 1);
      });

    const superAdminPermissionRows = await dataSource.query<Array<{
      permission_code: string;
    }>>(`
      SELECT [permission_code]
      FROM [flowpilot].[role_permissions]
      WHERE [role_id] = @0
      ORDER BY [permission_code]
    `, [BUILTIN_IDS.superAdminRole]);
    const superAdminPermissionCodes = new Set(
      superAdminPermissionRows.map((permission) => permission.permission_code)
    );
    const superAdminCatalogComplete = BUILTIN_PERMISSION_SEEDS.every((permission) => (
      superAdminPermissionCodes.has(permission.code)
    ));
    if (!catalogMatches || !superAdminCatalogComplete) {
      throw new DatabaseReadinessError(
        "DATABASE_SEED_CATALOG_MISMATCH",
        "数据库内置权限目录或超级管理员授权与当前构建不一致"
      );
    }
    return {
      ...structure,
      builtinSuperAdminCount: row.builtin_super_admin_count,
      seedVersion
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.initialization?.catch(() => undefined);
    const dataSource = this.dataSource;
    this.dataSource = undefined;
    if (dataSource?.isInitialized) await dataSource.destroy();
  }

  protected createDataSource(environment: DatabaseEnvironment): DataSource {
    return new DataSource(createDataSourceOptions(environment));
  }

  private assertStructureReady(
    snapshot: DatabaseStructureReadinessSnapshot,
    environment: DatabaseEnvironment
  ): void {
    this.assertPlatform(snapshot, environment);
    if (!snapshot.schemaExists) {
      throw new DatabaseReadinessError("DATABASE_SCHEMA_MISSING", "flowpilot schema 尚未创建");
    }
    if (!snapshot.migrationLedgerExists) {
      throw new DatabaseReadinessError(
        "DATABASE_MIGRATION_LEDGER_MISSING",
        "数据库迁移记录表尚未创建"
      );
    }
    if (!snapshot.migrationChecksumsValid) {
      throw new DatabaseReadinessError(
        "DATABASE_MIGRATION_CHECKSUM_MISMATCH",
        "数据库迁移校验和与当前构建不一致"
      );
    }
    if (snapshot.pendingMigrations) {
      throw new DatabaseReadinessError("DATABASE_MIGRATIONS_PENDING", "数据库结构版本落后");
    }
  }

  private assertPlatform(
    snapshot: DatabasePlatformSnapshot,
    environment: DatabaseEnvironment
  ): void {
    const serverMajorVersion = Number.parseInt(snapshot.productVersion.split(".")[0] ?? "", 10);
    if (!Number.isInteger(serverMajorVersion) || serverMajorVersion < 13) {
      throw new DatabaseReadinessError(
        "DATABASE_SERVER_VERSION_MISMATCH",
        "SQL Server 必须为 2016（13.x）SP2/SP3 或更高版本"
      );
    }
    const productLevel = snapshot.productLevel.trim().toUpperCase();
    if (serverMajorVersion === 13 && productLevel !== "SP2" && productLevel !== "SP3") {
      throw new DatabaseReadinessError(
        "DATABASE_SERVER_SERVICE_LEVEL_MISMATCH",
        "SQL Server 2016 必须至少安装 SP2（允许 SP2 或 SP3）"
      );
    }
    if (snapshot.compatibilityLevel < environment.MSSQL_EXPECTED_COMPATIBILITY_LEVEL) {
      throw new DatabaseReadinessError(
        "DATABASE_COMPATIBILITY_LEVEL_MISMATCH",
        `数据库兼容级别不得低于 ${environment.MSSQL_EXPECTED_COMPATIBILITY_LEVEL}`
      );
    }
    if (snapshot.collation.toLowerCase() !== environment.MSSQL_EXPECTED_COLLATION.toLowerCase()) {
      throw new DatabaseReadinessError(
        "DATABASE_COLLATION_MISMATCH",
        "数据库排序规则与部署配置不一致"
      );
    }
  }
}
