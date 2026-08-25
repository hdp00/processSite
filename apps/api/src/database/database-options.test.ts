import { describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import {
  UNSUPPORTED_LOCALDB_DRIVER,
  UnsupportedLocalDbDriverError,
  createDataSourceOptions,
  type DatabaseEnvironment
} from "./database-options.js";
import { UserEntity } from "./entities/index.js";

const environment = (server = "sql.internal.example"): DatabaseEnvironment => ({
  MSSQL_SERVER: server,
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
});

describe("database options", () => {
  it("uses reviewed TypeORM MSSQL settings without automatic schema changes", () => {
    const options = createDataSourceOptions(environment());

    expect(options).toMatchObject({
      type: "mssql",
      schema: "dbo",
      synchronize: false,
      migrationsRun: false,
      migrationsTransactionMode: "all",
      migrationsTableName: "flowpilot_typeorm_migrations",
      connectionTimeout: 5_000,
      requestTimeout: 30_000
    });
    expect(options.entities).not.toHaveLength(0);
    expect(options.migrations).toHaveLength(1);
    expect("driver" in options).toBe(false);
  });

  it("builds explicit flowpilot Entity metadata without opening a connection", async () => {
    const dataSource = new DataSource(createDataSourceOptions(environment()));
    await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

    expect(dataSource.isInitialized).toBe(false);
    expect(dataSource.entityMetadatas).not.toHaveLength(0);
    expect(new Set(dataSource.entityMetadatas.map((metadata) => metadata.schema)))
      .toEqual(new Set(["flowpilot"]));
    const userMetadata = dataSource.getMetadata(UserEntity);
    expect(userMetadata.findColumnWithPropertyName("departmentId")?.isNullable).toBe(false);
    expect(userMetadata.findColumnWithPropertyName("positionId")?.isNullable).toBe(false);
    expect(userMetadata.relations.find((relation) => relation.propertyName === "department")?.isNullable)
      .toBe(false);
    expect(userMetadata.relations.find((relation) => relation.propertyName === "position")?.isNullable)
      .toBe(false);
  });

  it("rejects LocalDB before constructing a network DataSource", () => {
    expect(() => createDataSourceOptions(environment("(localdb)\\MSSQLLocalDB")))
      .toThrowError(UnsupportedLocalDbDriverError);
    try {
      createDataSourceOptions(environment("(LOCALDB)\\anything"));
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: UNSUPPORTED_LOCALDB_DRIVER });
      expect(String(error)).not.toContain("unit-test-secret");
    }
  });
});
