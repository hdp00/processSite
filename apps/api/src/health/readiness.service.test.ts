import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import {
  DatabaseReadinessError,
  UnsupportedLocalDbDriverError
} from "../database/index.js";
import { ReadinessService } from "./readiness.service.js";

const config = new ConfigService<AppEnvironment, true>({ APP_VERSION: "0.1.0" });
const domainAuthentication = (status: "disabled" | "unknown" | "reachable" | "unavailable" = "reachable") => ({
  getHealthStatus: vi.fn(() => status),
  probeAvailability: vi.fn(() => Promise.resolve(status === "unknown" ? "unavailable" : status))
});
const smtp = (result: { available: true; code: "SMTP_OK" } | { available: false; code: "SMTP_DISABLED" | "SMTP_UNAVAILABLE" } = {
  available: true,
  code: "SMTP_OK"
}) => ({ verify: vi.fn().mockResolvedValue(result) });

describe("ReadinessService", () => {
  it("returns ok only after the database and schema checks pass", async () => {
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockResolvedValue({
        compatibilityLevel: 130,
        collation: "Chinese_PRC_CI_AS",
        schemaExists: true,
        pendingMigrations: false
      })
    } as never, config, domainAuthentication() as never, smtp() as never);

    await expect(service.getReadiness()).resolves.toMatchObject({ status: "ok", version: "0.1.0" });
  });

  it("returns a stable LocalDB diagnostic without leaking connection settings", async () => {
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockRejectedValue(new UnsupportedLocalDbDriverError())
    } as never, config, domainAuthentication() as never, smtp() as never);

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: "unavailable",
      code: "UNSUPPORTED_LOCALDB_DRIVER"
    });
  });

  it("preserves the stable unsupported SQL Server version diagnostic", async () => {
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockRejectedValue(new DatabaseReadinessError(
        "DATABASE_SERVER_VERSION_MISMATCH",
        "unsupported database platform"
      ))
    } as never, config, domainAuthentication() as never, smtp() as never);

    await expect(service.getReadiness()).resolves.toMatchObject({
      status: "unavailable",
      code: "DATABASE_SERVER_VERSION_MISMATCH"
    });
  });

  it("reports database, domain authentication, and SMTP independently", async () => {
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockResolvedValue({
        productVersion: "16.0.1000.6",
        productLevel: "RTM",
        compatibilityLevel: 160,
        collation: "Chinese_PRC_CI_AS",
        schemaExists: true,
        migrationLedgerExists: true,
        migrationChecksumsValid: true,
        pendingMigrations: false,
        builtinSuperAdminCount: 1,
        seedVersion: "test"
      })
    } as never, config, domainAuthentication("disabled") as never, smtp({
      available: false,
      code: "SMTP_UNAVAILABLE"
    }) as never);

    await expect(service.getOperationalDetails()).resolves.toMatchObject({
      status: "degraded",
      checks: [
        { name: "database", status: "ok", metrics: { compatibilityLevel: 160 } },
        { name: "schema", status: "ok" },
        { name: "domain-auth", status: "degraded", code: "DOMAIN_AUTH_DISABLED" },
        { name: "smtp", status: "unavailable", code: "SMTP_UNAVAILABLE" }
      ]
    });
  });

  it("keeps infrastructure details available when the database is unavailable", async () => {
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockRejectedValue(new Error("secret connection failure"))
    } as never, config, domainAuthentication("reachable") as never, smtp({
      available: false,
      code: "SMTP_DISABLED"
    }) as never);

    const result = await service.getOperationalDetails();
    expect(result.status).toBe("unavailable");
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "database", code: "DATABASE_UNAVAILABLE" }),
      expect.objectContaining({ name: "domain-auth", status: "ok" }),
      expect.objectContaining({ name: "smtp", code: "SMTP_DISABLED" })
    ]));
    expect(JSON.stringify(result)).not.toContain("secret connection failure");
  });

  it("actively probes domain availability and sanitizes probe failures", async () => {
    const domain = domainAuthentication();
    domain.probeAvailability.mockRejectedValueOnce(new Error("internal LDAP endpoint detail"));
    const service = new ReadinessService({
      inspectReadiness: vi.fn().mockResolvedValue({
        productVersion: "16.0.1000.6",
        productLevel: "RTM",
        compatibilityLevel: 160,
        collation: "Chinese_PRC_CI_AS",
        schemaExists: true,
        migrationLedgerExists: true,
        migrationChecksumsValid: true,
        pendingMigrations: false,
        builtinSuperAdminCount: 1,
        seedVersion: "test"
      })
    } as never, config, domain as never, smtp() as never);

    const result = await service.getOperationalDetails();

    expect(domain.probeAvailability).toHaveBeenCalledOnce();
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "domain-auth",
      status: "unavailable",
      code: "DOMAIN_AUTHENTICATION_UNAVAILABLE"
    }));
    expect(JSON.stringify(result)).not.toContain("internal LDAP endpoint detail");
  });
});
