import { ConfigService } from "@nestjs/config";
import type { DataSource } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import type { DatabaseEnvironment } from "./database-options.js";
import {
  DatabaseReadinessError,
  FlowPilotDataSourceManager
} from "./flowpilot-data-source.manager.js";
import {
  IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
  IDENTITY_AND_SESSION_MIGRATION_ID
} from "./migrations/index.js";
import {
  BUILTIN_PERMISSION_SEEDS,
  BUILTIN_SEED_VERSION
} from "./seed/builtin-catalog.js";

const builtinPermissionRows = () => BUILTIN_PERMISSION_SEEDS.map((permission) => ({
  code: permission.code,
  resource: permission.resource,
  action: permission.action,
  name: permission.name,
  sort_order: permission.sortOrder,
  is_builtin: true
}));

const superAdminPermissionRows = () => BUILTIN_PERMISSION_SEEDS.map((permission) => ({
  permission_code: permission.code
}));

const configuration = new ConfigService({
  MSSQL_SERVER: "sql.internal.example",
  MSSQL_PORT: 1433,
  MSSQL_DATABASE: "flowpilot",
  MSSQL_SCHEMA: "flowpilot",
  MSSQL_USER: "flowpilot_app",
  MSSQL_PASSWORD: "unit-test-secret",
  MSSQL_ENCRYPT: false,
  MSSQL_TRUST_SERVER_CERTIFICATE: true,
  MSSQL_EXPECTED_COMPATIBILITY_LEVEL: 130,
  MSSQL_EXPECTED_COLLATION: "Chinese_PRC_CI_AS",
  MSSQL_POOL_MIN: 0,
  MSSQL_POOL_MAX: 20,
  MSSQL_CONNECT_TIMEOUT_MS: 5_000,
  MSSQL_REQUEST_TIMEOUT_MS: 30_000,
  MSSQL_DEADLOCK_RETRY_COUNT: 3
}) as ConfigService<AppEnvironment, true>;

interface FakeDataSource {
  isInitialized: boolean;
  initialize: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  showMigrations: ReturnType<typeof vi.fn>;
}

const successfulDataSource = (): FakeDataSource => {
  const candidate: FakeDataSource = {
    isInitialized: false,
    initialize: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    showMigrations: vi.fn(() => {
      throw new Error("readiness must not call showMigrations");
    })
  };
  candidate.initialize.mockImplementation(async () => {
    candidate.isInitialized = true;
    return candidate;
  });
  return candidate;
};

class TestDataSourceManager extends FlowPilotDataSourceManager {
  readonly createDataSourceCalls = vi.fn();

  constructor(private readonly candidates: FakeDataSource[]) {
    super(configuration);
  }

  protected override createDataSource(_environment: DatabaseEnvironment): DataSource {
    this.createDataSourceCalls();
    const candidate = this.candidates.shift();
    if (!candidate) throw new Error("missing fake DataSource");
    return candidate as unknown as DataSource;
  }
}

describe("FlowPilotDataSourceManager", () => {
  it("does not connect during construction and retries after an initialization failure", async () => {
    const failure = new Error("database unavailable");
    const first = successfulDataSource();
    first.initialize.mockRejectedValue(failure);
    const second = successfulDataSource();
    const manager = new TestDataSourceManager([first, second]);

    expect(manager.isInitialized).toBe(false);
    expect(manager.createDataSourceCalls).not.toHaveBeenCalled();
    await expect(manager.ensureInitialized()).rejects.toBe(failure);
    await expect(manager.ensureInitialized()).resolves.toBe(second);
    expect(manager.createDataSourceCalls).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight initialization and destroys the connection during shutdown", async () => {
    let finishInitialization: (() => void) | undefined;
    const candidate = successfulDataSource();
    candidate.initialize.mockImplementation(() => new Promise<FakeDataSource>((resolve) => {
      finishInitialization = () => {
        candidate.isInitialized = true;
        resolve(candidate);
      };
    }));
    const manager = new TestDataSourceManager([candidate]);

    const initialization = manager.ensureInitialized();
    const shutdown = manager.onApplicationShutdown();
    await expect(manager.ensureInitialized()).rejects.toThrow("数据库连接管理器正在关闭");
    expect(candidate.destroy).not.toHaveBeenCalled();

    finishInitialization?.();
    await expect(initialization).resolves.toBe(candidate);
    await shutdown;

    expect(candidate.destroy).toHaveBeenCalledTimes(1);
    expect(manager.isInitialized).toBe(false);
  });

  it.each(["SP2", "SP3"])("accepts SQL Server 2016 %s", async (productLevel) => {
    const candidate = successfulDataSource();
    candidate.query.mockResolvedValueOnce([{
      product_version: "13.0.6435.1",
      product_level: productLevel,
      compatibility_level: 130,
      collation_name: "Chinese_PRC_CI_AS"
    }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectPlatform()).resolves.toMatchObject({
      productVersion: "13.0.6435.1",
      productLevel
    });
  });

  it.each([
    { productVersion: "14.0.1000.169", productLevel: "RTM", compatibilityLevel: 140 },
    { productVersion: "15.0.2000.5", productLevel: "RTM", compatibilityLevel: 150 },
    { productVersion: "16.0.1000.6", productLevel: "RTM", compatibilityLevel: 160 },
    { productVersion: "16.0.4215.2", productLevel: "CU", compatibilityLevel: 160 },
    { productVersion: "16.0.4215.2", productLevel: "", compatibilityLevel: 130 },
    { productVersion: "17.0.100.1", productLevel: "PREVIEW", compatibilityLevel: 160 }
  ])("accepts SQL Server 2017 and later regardless of service level metadata ($productVersion)", async ({
    productVersion,
    productLevel,
    compatibilityLevel
  }) => {
    const candidate = successfulDataSource();
    candidate.query.mockResolvedValueOnce([{
      product_version: productVersion,
      product_level: productLevel,
      compatibility_level: compatibilityLevel,
      collation_name: "Chinese_PRC_CI_AS"
    }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectPlatform()).resolves.toMatchObject({
      productVersion,
      productLevel,
      compatibilityLevel
    });
  });

  it.each([
    {
      productVersion: "12.0.6024.0",
      productLevel: "SP3",
      code: "DATABASE_SERVER_VERSION_MISMATCH"
    },
    {
      productVersion: "13.0.4001.0",
      productLevel: "SP1",
      code: "DATABASE_SERVER_SERVICE_LEVEL_MISMATCH"
    }
  ] as const)("rejects an unsupported database platform with $code", async ({
    productVersion,
    productLevel,
    code
  }) => {
    const candidate = successfulDataSource();
    candidate.query.mockResolvedValueOnce([{
      product_version: productVersion,
      product_level: productLevel,
      compatibility_level: 130,
      collation_name: "Chinese_PRC_CI_AS"
    }]);
    const manager = new TestDataSourceManager([candidate]);

    try {
      await manager.inspectPlatform();
      throw new Error("expected inspectPlatform to reject");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code } satisfies Partial<DatabaseReadinessError>);
      expect(String(error)).not.toContain("sql.internal.example");
      expect(String(error)).not.toContain("unit-test-secret");
    }
  });

  it("rejects a database compatibility level below 130 on a newer SQL Server", async () => {
    const candidate = successfulDataSource();
    candidate.query.mockResolvedValueOnce([{
      product_version: "16.0.4215.2",
      product_level: "RTM",
      compatibility_level: 120,
      collation_name: "Chinese_PRC_CI_AS"
    }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectPlatform()).rejects.toMatchObject({
      code: "DATABASE_COMPATIBILITY_LEVEL_MISMATCH"
    } satisfies Partial<DatabaseReadinessError>);
  });

  it("checks the custom checksum ledger without TypeORM readiness DDL", async () => {
    const candidate = successfulDataSource();
    candidate.query
      .mockResolvedValueOnce([{
        product_version: "13.0.6435.1",
        product_level: "SP2",
        compatibility_level: 130,
        collation_name: "Chinese_PRC_CI_AS",
        schema_exists: 1,
        migration_ledger_exists: 1
      }])
      .mockResolvedValueOnce([{
        migration_id: IDENTITY_AND_SESSION_MIGRATION_ID,
        checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
        result: "succeeded"
      }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectSchemaReadiness()).resolves.toMatchObject({
      schemaExists: true,
      migrationLedgerExists: true,
      migrationChecksumsValid: true,
      pendingMigrations: false
    });
    expect(candidate.showMigrations).not.toHaveBeenCalled();
  });

  it("requires the current seed version and exactly one built-in superadmin", async () => {
    const candidate = successfulDataSource();
    candidate.query
      .mockResolvedValueOnce([{
        product_version: "13.0.6435.1",
        product_level: "SP2",
        compatibility_level: 130,
        collation_name: "Chinese_PRC_CI_AS",
        schema_exists: 1,
        migration_ledger_exists: 1
      }])
      .mockResolvedValueOnce([{
        migration_id: IDENTITY_AND_SESSION_MIGRATION_ID,
        checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
        result: "succeeded"
      }])
      .mockResolvedValueOnce([{
        builtin_super_admin_count: 1,
        seed_state_json: JSON.stringify({ version: "outdated" })
      }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectReadiness()).rejects.toMatchObject({
      code: "DATABASE_SEED_VERSION_MISMATCH"
    } satisfies Partial<DatabaseReadinessError>);
  });

  it("reports readiness after both structure and current seed checks pass", async () => {
    const candidate = successfulDataSource();
    candidate.query
      .mockResolvedValueOnce([{
        product_version: "13.0.6435.1",
        product_level: "SP2",
        compatibility_level: 130,
        collation_name: "Chinese_PRC_CI_AS",
        schema_exists: 1,
        migration_ledger_exists: 1
      }])
      .mockResolvedValueOnce([{
        migration_id: IDENTITY_AND_SESSION_MIGRATION_ID,
        checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
        result: "succeeded"
      }])
      .mockResolvedValueOnce([{
        builtin_super_admin_count: 1,
        seed_state_json: JSON.stringify({ version: BUILTIN_SEED_VERSION })
      }])
      .mockResolvedValueOnce(builtinPermissionRows())
      .mockResolvedValueOnce(superAdminPermissionRows());
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectReadiness()).resolves.toMatchObject({
      pendingMigrations: false,
      builtinSuperAdminCount: 1,
      seedVersion: BUILTIN_SEED_VERSION
    });
  });

  it("reports an unseeded migrated database with a stable readiness code", async () => {
    const candidate = successfulDataSource();
    candidate.query
      .mockResolvedValueOnce([{
        product_version: "13.0.6435.1",
        product_level: "SP2",
        compatibility_level: 130,
        collation_name: "Chinese_PRC_CI_AS",
        schema_exists: 1,
        migration_ledger_exists: 1
      }])
      .mockResolvedValueOnce([{
        migration_id: IDENTITY_AND_SESSION_MIGRATION_ID,
        checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
        result: "succeeded"
      }])
      .mockResolvedValueOnce([{
        builtin_super_admin_count: 0,
        seed_state_json: null
      }]);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectReadiness()).rejects.toMatchObject({
      code: "DATABASE_SEED_MISSING"
    } satisfies Partial<DatabaseReadinessError>);
  });

  it.each([
    {
      name: "drifted built-in permission metadata",
      permissions: builtinPermissionRows().map((permission, index) => (
        index === 0 ? { ...permission, name: "drifted" } : permission
      )),
      rolePermissions: superAdminPermissionRows()
    },
    {
      name: "missing superadmin role grant",
      permissions: builtinPermissionRows(),
      rolePermissions: superAdminPermissionRows().slice(1)
    }
  ])("rejects $name even when the seed version marker is current", async ({
    permissions,
    rolePermissions
  }) => {
    const candidate = successfulDataSource();
    candidate.query
      .mockResolvedValueOnce([{
        product_version: "13.0.6435.1",
        product_level: "SP2",
        compatibility_level: 130,
        collation_name: "Chinese_PRC_CI_AS",
        schema_exists: 1,
        migration_ledger_exists: 1
      }])
      .mockResolvedValueOnce([{
        migration_id: IDENTITY_AND_SESSION_MIGRATION_ID,
        checksum: IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
        result: "succeeded"
      }])
      .mockResolvedValueOnce([{
        builtin_super_admin_count: 1,
        seed_state_json: JSON.stringify({ version: BUILTIN_SEED_VERSION })
      }])
      .mockResolvedValueOnce(permissions)
      .mockResolvedValueOnce(rolePermissions);
    const manager = new TestDataSourceManager([candidate]);

    await expect(manager.inspectReadiness()).rejects.toMatchObject({
      code: "DATABASE_SEED_CATALOG_MISMATCH"
    } satisfies Partial<DatabaseReadinessError>);
  });
});
