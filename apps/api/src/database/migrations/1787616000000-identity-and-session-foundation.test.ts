import { createHash } from "node:crypto";
import type { QueryRunner } from "typeorm";
import { describe, expect, it, vi } from "vitest";
import {
  IDENTITY_AND_SESSION_MIGRATION_CHECKSUM,
  IDENTITY_AND_SESSION_SCHEMA_FINGERPRINT_SOURCE,
  IDENTITY_AND_SESSION_SCHEMA_STATEMENTS,
  normalizeMigrationSchemaStatement,
  IdentityAndSessionFoundation1787616000000
} from "./1787616000000-identity-and-session-foundation.js";

describe("identity and session foundation migration", () => {
  it("emits reviewed SQL Server 2016-compatible DDL without batch separators", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await new IdentityAndSessionFoundation1787616000000().up({ query } as unknown as QueryRunner);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");

    expect(sql).toContain("CREATE SCHEMA [flowpilot]");
    expect(sql).toContain("CREATE TABLE [flowpilot].[users]");
    expect(sql).toContain("[department_id] uniqueidentifier NOT NULL");
    expect(sql).toContain("[position_id] uniqueidentifier NOT NULL");
    expect(sql).toContain("CREATE TABLE [flowpilot].[sessions]");
    expect(sql).toContain("CREATE TABLE [flowpilot].[schema_migrations]");
    expect(sql).toContain("ON DELETE NO ACTION ON UPDATE NO ACTION");
    expect(sql).toContain("ISJSON([value_json]) = 1");
    expect(sql).toContain("WHERE [is_builtin_super_admin] = 1");
    expect(sql).toContain("CREATE UNIQUE INDEX [ux_positions_normalized_name]");
    expect(sql).toContain("CREATE UNIQUE INDEX [ux_roles_normalized_name]");
    expect(sql).toContain(IDENTITY_AND_SESSION_MIGRATION_CHECKSUM);
    expect(sql).not.toMatch(/(^|\r?\n)\s*GO\s*(\r?\n|$)/i);
    expect(sql).not.toMatch(/STRING_AGG|TRANSLATE|CREATE\s+OR\s+ALTER/i);
  });

  it("derives a lowercase SHA-256 checksum from normalized schema DDL", () => {
    const fingerprintSource = JSON.stringify(
      IDENTITY_AND_SESSION_SCHEMA_STATEMENTS.map(normalizeMigrationSchemaStatement)
    );
    const independentlyCalculatedChecksum = createHash("sha256")
      .update(fingerprintSource, "utf8")
      .digest("hex");

    expect(IDENTITY_AND_SESSION_SCHEMA_FINGERPRINT_SOURCE).toBe(fingerprintSource);
    expect(IDENTITY_AND_SESSION_MIGRATION_CHECKSUM).toBe(independentlyCalculatedChecksum);
    expect(IDENTITY_AND_SESSION_MIGRATION_CHECKSUM).toMatch(/^[0-9a-f]{64}$/);
    expect(IDENTITY_AND_SESSION_SCHEMA_FINGERPRINT_SOURCE).not.toContain(
      IDENTITY_AND_SESSION_MIGRATION_CHECKSUM
    );
  });

  it("drops dependent tables before the schema", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await new IdentityAndSessionFoundation1787616000000().down({ query } as unknown as QueryRunner);
    const statements = query.mock.calls.map(([statement]) => String(statement).trim());

    expect(statements[0]).toBe("DROP TABLE IF EXISTS [flowpilot].[audit_events]");
    expect(statements.at(-1)).toBe("IF SCHEMA_ID(N'flowpilot') IS NOT NULL DROP SCHEMA [flowpilot]");
  });
});
