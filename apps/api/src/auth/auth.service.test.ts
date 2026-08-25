import { scrypt } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ProblemException } from "../common/http/problem-details.js";
import type { AuthPersistence, CreateSessionRecord } from "./auth.persistence.js";
import { AuthService, SESSION_ABSOLUTE_DURATION_MS, SESSION_IDLE_DURATION_MS } from "./auth.service.js";
import type { AuthUserRecord, StoredSessionRecord } from "./auth.types.js";
import {
  normalizeConfiguredLoginName,
  type DomainAuthenticationHealthStatus,
  type DomainAuthenticationProvider,
  type DomainAuthenticationResult,
} from "./domain-authentication.js";
import { LoginRateLimiter, type LoginRateLimitOptions } from "./login-rate-limiter.js";
import { hashPassword } from "./password-codec.js";
import { hashSessionToken } from "./session-token.js";

class FakeAuthPersistence implements AuthPersistence {
  readonly users = new Map<string, AuthUserRecord>();
  readonly usersByLogin = new Map<string, AuthUserRecord>();
  readonly sessionsByHash = new Map<string, StoredSessionRecord>();
  readonly touches: Array<{ sessionId: string; idleExpiresAt: Date }> = [];
  readonly revocations: Array<{ sessionId: string; reason: string }> = [];
  readonly passwordReplacements: Array<{ userId: string; replacementPasswordHash: string }> = [];

  addUser(user: AuthUserRecord): void {
    this.users.set(user.id, user);
    this.usersByLogin.set(user.normalizedLoginName, user);
  }

  findUserByNormalizedLoginName(normalizedLoginName: string): Promise<AuthUserRecord | undefined> {
    return Promise.resolve(this.usersByLogin.get(normalizedLoginName));
  }

  findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    return Promise.resolve(this.users.get(userId));
  }

  replacePasswordHashIfUnchanged(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.passwordHash !== expectedPasswordHash) return Promise.resolve(false);
    const replacement = { ...user, passwordHash: replacementPasswordHash };
    this.users.set(userId, replacement);
    this.usersByLogin.set(replacement.normalizedLoginName, replacement);
    this.passwordReplacements.push({ userId, replacementPasswordHash });
    return Promise.resolve(true);
  }

  createSession(input: CreateSessionRecord): Promise<StoredSessionRecord> {
    const session: StoredSessionRecord = { ...input };
    this.sessionsByHash.set(session.tokenHash, session);
    return Promise.resolve(session);
  }

  findSessionByTokenHash(tokenHash: string): Promise<StoredSessionRecord | undefined> {
    return Promise.resolve(this.sessionsByHash.get(tokenHash));
  }

  touchSession(sessionId: string, _lastAccessedAt: Date, idleExpiresAt: Date): Promise<void> {
    this.touches.push({ sessionId, idleExpiresAt });
    return Promise.resolve();
  }

  revokeSession(sessionId: string, _revokedAt: Date, reason: string): Promise<void> {
    this.revocations.push({ sessionId, reason });
    return Promise.resolve();
  }
}

class TimingObservableAuthService extends AuthService {
  readonly timingEqualizer = vi.fn((_password: string) => Promise.resolve());

  protected override equalizePasswordVerificationTiming(password: string): Promise<void> {
    return this.timingEqualizer(password);
  }
}

const limiter = (overrides: Partial<LoginRateLimitOptions> = {}) => new LoginRateLimiter({
  windowMs: 15 * 60_000,
  blockMs: 15 * 60_000,
  accountIpFailureLimit: 5,
  ipFailureLimit: 100,
  unavailableWindowMs: 60_000,
  unavailableBlockMs: 60_000,
  unavailableIpLimit: 60,
  globalInFlightLimit: 4,
  ipInFlightLimit: 2,
  ...overrides,
});

const domainProvider = (
  result: DomainAuthenticationResult = "unavailable",
  availability: Exclude<DomainAuthenticationHealthStatus, "unknown"> = "reachable",
): DomainAuthenticationProvider => ({
  normalizeLoginName: vi.fn((loginName: string) => normalizeConfiguredLoginName(loginName, {
    upnSuffix: "example.test",
    netbiosName: "EXAMPLE",
  })),
  authenticate: vi.fn(() => Promise.resolve(result)),
  probeAvailability: vi.fn(() => Promise.resolve(availability)),
  getHealthStatus: vi.fn(() => "unknown" as const),
});

let localPasswordHash = "";

beforeAll(async () => {
  localPasswordHash = await hashPassword("local-password");
});

const legacyPasswordHash = async (password: string): Promise<string> => {
  const salt = Buffer.alloc(16, 0x3c);
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => {
      if (error) reject(error);
      else resolve(Buffer.from(value));
    });
  });
  return `flowpilot-scrypt$v1$N=32768,r=8,p=1,maxmem=67108864$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
};

const userRecord = (patch: Partial<AuthUserRecord> = {}): AuthUserRecord => ({
  id: "00000000-0000-0000-0000-000000000001",
  revision: 1,
  loginName: "superadmin",
  normalizedLoginName: "superadmin",
  name: "超级管理员",
  email: "superadmin@example.test",
  authenticationMode: "password",
  passwordHash: localPasswordHash,
  enabled: true,
  builtInSuperAdmin: false,
  department: { id: "00000000-0000-0000-0000-000000000010", name: "系统", path: "系统" },
  position: { id: "00000000-0000-0000-0000-000000000020", name: "系统管理员" },
  roles: [
    { id: "00000000-0000-0000-0000-000000000030", name: "角色一", enabled: true, permissions: ["work-list:查看"] },
    { id: "00000000-0000-0000-0000-000000000031", name: "停用角色", enabled: false, permissions: ["org-role:查看"] },
  ],
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  ...patch,
});

describe("AuthService", () => {
  it("creates a hashed opaque session and returns the effective permission union", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord());
    const service = new AuthService(persistence, limiter(), domainProvider());
    const now = new Date("2026-08-25T00:00:00.000Z");

    const result = await service.login({ loginName: " SuperAdmin ", password: "local-password" }, "10.0.0.10", now);
    const stored = [...persistence.sessionsByHash.values()][0];

    expect(stored).toBeDefined();
    expect(stored?.tokenHash).toBe(hashSessionToken(result.sessionToken));
    expect(stored?.tokenHash).not.toBe(result.sessionToken);
    expect(stored?.tokenHash).toHaveLength(64);
    expect(stored?.idleExpiresAt.getTime()).toBe(now.getTime() + SESSION_IDLE_DURATION_MS);
    expect(stored?.absoluteExpiresAt.getTime()).toBe(now.getTime() + SESSION_ABSOLUTE_DURATION_MS);
    expect(result.dto.roleIds).toEqual(["00000000-0000-0000-0000-000000000030"]);
    expect(result.dto.permissions).toEqual(["work-list:查看"]);
  });

  it("recomputes authorization and slides only the idle expiration", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord());
    const service = new AuthService(persistence, limiter(), domainProvider());
    const loginAt = new Date("2026-08-25T00:00:00.000Z");
    const login = await service.login({ loginName: "superadmin", password: "local-password" }, "10.0.0.11", loginAt);
    const accessAt = new Date("2026-08-25T07:00:00.000Z");

    const authenticated = await service.authenticate(login.sessionToken, accessAt);

    expect(persistence.touches).toHaveLength(1);
    expect(persistence.touches[0]?.idleExpiresAt.toISOString()).toBe("2026-08-25T15:00:00.000Z");
    expect(authenticated.dto.expiresAt).toBe("2026-08-25T15:00:00.000Z");
  });

  it("returns 503 when every domain endpoint is unavailable without creating a session", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ authenticationMode: "domain" }));
    const service = new AuthService(persistence, limiter(), domainProvider("unavailable"));

    await expect(service.login({ loginName: "superadmin", password: "domain-password" }, "10.0.0.12"))
      .rejects.toMatchObject({
        problem: {
          status: 503,
          code: "DOMAIN_AUTHENTICATION_UNAVAILABLE",
          title: "域认证暂不可用",
        },
      });
    expect(persistence.sessionsByHash.size).toBe(0);
  });

  it("creates a session after domain authentication and passes only the canonical bare account", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({
      loginName: "alice",
      normalizedLoginName: "alice",
      authenticationMode: "domain",
    }));
    const provider = domainProvider("authenticated");
    const service = new AuthService(persistence, limiter(), provider);

    const result = await service.login(
      { loginName: "EXAMPLE\\Alice", password: "request-only-password" },
      "10.0.0.15",
    );

    expect(provider.authenticate).toHaveBeenCalledWith("alice", "request-only-password");
    expect(result.dto.user.loginName).toBe("alice");
    expect(persistence.sessionsByHash.size).toBe(1);
  });

  it("accepts a matching UPN for a local password account without contacting the domain", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord());
    const provider = domainProvider("unavailable");
    const service = new AuthService(persistence, limiter(), provider);

    const result = await service.login(
      { loginName: "SuperAdmin@EXAMPLE.TEST", password: "local-password" },
      "10.0.0.16",
    );

    expect(result.dto.user.loginName).toBe("superadmin");
    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.probeAvailability).not.toHaveBeenCalled();
  });

  it("maps a rejected domain bind to generic invalid credentials and never falls back to a stored password", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({
      authenticationMode: "domain",
      passwordHash: localPasswordHash,
    }));
    const provider = domainProvider("invalid-credentials");
    const service = new AuthService(persistence, limiter(), provider);

    await expect(service.login(
      { loginName: "superadmin", password: "local-password" },
      "10.0.0.17",
    )).rejects.toMatchObject({
      problem: { status: 401, code: "INVALID_CREDENTIALS" },
    });

    expect(provider.authenticate).toHaveBeenCalledOnce();
    expect(provider.probeAvailability).not.toHaveBeenCalled();
    expect(persistence.sessionsByHash.size).toBe(0);
    expect(persistence.passwordReplacements).toHaveLength(0);
  });

  it("runs the password timing equalizer for a failed domain login", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ authenticationMode: "domain" }));
    const service = new TimingObservableAuthService(
      persistence,
      limiter(),
      domainProvider("invalid-credentials"),
    );

    await expect(service.login(
      { loginName: "superadmin", password: "wrong-domain-password" },
      "10.0.0.28",
    )).rejects.toMatchObject({ problem: { status: 401, code: "INVALID_CREDENTIALS" } });

    expect(service.timingEqualizer).toHaveBeenCalledOnce();
    expect(service.timingEqualizer).toHaveBeenCalledWith("wrong-domain-password");
  });

  it("handles an early timing-equalizer failure without an unhandled rejection", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ authenticationMode: "domain" }));
    const provider = domainProvider("invalid-credentials");
    vi.mocked(provider.authenticate).mockImplementationOnce(() => new Promise((resolve) => {
      setImmediate(() => resolve("invalid-credentials"));
    }));
    const service = new TimingObservableAuthService(persistence, limiter(), provider);
    service.timingEqualizer.mockRejectedValueOnce(new Error("scrypt unavailable"));

    await expect(service.login(
      { loginName: "superadmin", password: "wrong-domain-password" },
      "10.0.0.29",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });
  });

  it("counts rejected domain credentials in the existing account/IP login limit", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ authenticationMode: "domain" }));
    const provider = domainProvider("invalid-credentials");
    const service = new AuthService(persistence, limiter(), provider);
    const now = new Date("2026-08-25T01:00:00.000Z");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login(
        { loginName: "superadmin", password: "wrong-domain-password" },
        "10.0.0.20",
        now,
      )).rejects.toMatchObject({ problem: { status: 401, code: "INVALID_CREDENTIALS" } });
    }
    await expect(service.login(
      { loginName: "superadmin", password: "wrong-domain-password" },
      "10.0.0.20",
      now,
    )).rejects.toMatchObject({ problem: { status: 429, code: "RATE_LIMITED" } });

    expect(provider.authenticate).toHaveBeenCalledTimes(5);
  });

  it("keeps local-password authentication independent from a domain outage", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ builtInSuperAdmin: true }));
    const provider = domainProvider("unavailable");
    const service = new AuthService(persistence, limiter(), provider);

    await expect(service.login(
      { loginName: "superadmin", password: "local-password" },
      "10.0.0.18",
    )).resolves.toMatchObject({ dto: { superAdmin: true } });

    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.probeAvailability).not.toHaveBeenCalled();
  });

  it("does not query a user for a mismatched UPN and returns the generic credential error", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord());
    const provider = domainProvider("authenticated");
    const service = new AuthService(persistence, limiter(), provider);

    await expect(service.login(
      { loginName: "superadmin@other.example", password: "local-password" },
      "10.0.0.19",
    )).rejects.toMatchObject({ problem: { status: 401, code: "INVALID_CREDENTIALS" } });

    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.probeAvailability).toHaveBeenCalledOnce();
    expect(persistence.sessionsByHash.size).toBe(0);
  });

  it("returns the same domain-unavailable response for an unknown account during an outage", async () => {
    const persistence = new FakeAuthPersistence();
    const provider = domainProvider("unavailable", "unavailable");
    const service = new AuthService(persistence, limiter(), provider);

    await expect(service.login(
      { loginName: "unknown-user", password: "unknown-password" },
      "10.0.0.21",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });

    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.probeAvailability).toHaveBeenCalledOnce();
  });

  it("does not reveal a configured domain account when domain authentication is disabled", async () => {
    const unknownPersistence = new FakeAuthPersistence();
    const disabledProvider = domainProvider("unavailable", "disabled");
    const unknownService = new AuthService(unknownPersistence, limiter(), disabledProvider);

    await expect(unknownService.login(
      { loginName: "unknown-user", password: "unknown-password" },
      "10.0.0.25",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });

    const domainPersistence = new FakeAuthPersistence();
    domainPersistence.addUser(userRecord({ authenticationMode: "domain" }));
    const domainService = new AuthService(domainPersistence, limiter(), disabledProvider);
    await expect(domainService.login(
      { loginName: "superadmin", password: "unknown-password" },
      "10.0.0.26",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });
  });

  it("rate-limits every domain-unavailable response by IP without creating an account oracle", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ authenticationMode: "domain" }));
    const provider = domainProvider("unavailable", "unavailable");
    const unavailableLimiter = limiter({
      unavailableWindowMs: 1_000,
      unavailableBlockMs: 2_000,
      unavailableIpLimit: 2,
    });
    const service = new AuthService(persistence, unavailableLimiter, provider);
    const now = new Date("2026-08-25T01:30:00.000Z");

    await expect(service.login(
      { loginName: "unknown-user", password: "unknown-password" },
      "10.0.0.27",
      now,
    )).rejects.toMatchObject({ problem: { status: 503 } });
    await expect(service.login(
      { loginName: "superadmin", password: "unknown-password" },
      "10.0.0.27",
      now,
    )).rejects.toMatchObject({ problem: { status: 503 } });
    await expect(service.login(
      { loginName: "another-unknown-user", password: "unknown-password" },
      "10.0.0.27",
      now,
    )).rejects.toMatchObject({ problem: { status: 429, code: "RATE_LIMITED" } });

    expect(provider.probeAvailability).toHaveBeenCalledOnce();
    expect(provider.authenticate).toHaveBeenCalledOnce();
  });

  it("returns the same domain-unavailable response for a disabled account during an outage", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ enabled: false, authenticationMode: "domain" }));
    const provider = domainProvider("unavailable", "unavailable");
    const service = new AuthService(persistence, limiter(), provider);

    await expect(service.login(
      { loginName: "superadmin", password: "unknown-password" },
      "10.0.0.24",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });

    expect(provider.authenticate).not.toHaveBeenCalled();
    expect(provider.probeAvailability).toHaveBeenCalledOnce();
  });

  it("returns domain unavailable for a wrong local password during an outage without probing a correct local login", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ builtInSuperAdmin: true }));
    const outageProvider = domainProvider("unavailable", "unavailable");
    const outageService = new AuthService(persistence, limiter(), outageProvider);

    await expect(outageService.login(
      { loginName: "superadmin", password: "wrong-local-password" },
      "10.0.0.22",
    )).rejects.toMatchObject({
      problem: { status: 503, code: "DOMAIN_AUTHENTICATION_UNAVAILABLE" },
    });
    expect(outageProvider.probeAvailability).toHaveBeenCalledOnce();

    const successfulProvider = domainProvider("unavailable", "unavailable");
    const successfulService = new AuthService(persistence, limiter(), successfulProvider);
    await expect(successfulService.login(
      { loginName: "superadmin", password: "local-password" },
      "10.0.0.23",
    )).resolves.toMatchObject({ dto: { superAdmin: true } });
    expect(successfulProvider.probeAvailability).not.toHaveBeenCalled();
  });

  it("gives the built-in super administrator every catalog permission", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({
      builtInSuperAdmin: true,
      allPermissionCodes: ["work-list:查看", "org-role:编辑", "config-definition:查看"],
    }));
    const service = new AuthService(persistence, limiter(), domainProvider());

    const result = await service.login({ loginName: "superadmin", password: "local-password" }, "10.0.0.13");

    expect(result.dto.permissions).toEqual(["config-definition:查看", "org-role:编辑", "work-list:查看"]);
    expect(result.dto.superAdmin).toBe(true);
  });

  it("gradually replaces a legacy hash with compare-and-swap semantics", async () => {
    const persistence = new FakeAuthPersistence();
    persistence.addUser(userRecord({ passwordHash: await legacyPasswordHash("legacy-password") }));
    const service = new AuthService(persistence, limiter(), domainProvider());

    await service.login({ loginName: "superadmin", password: "legacy-password" }, "10.0.0.14");

    expect(persistence.passwordReplacements).toHaveLength(1);
    expect(persistence.passwordReplacements[0]?.replacementPasswordHash).toContain(
      "$N=65536,r=8,p=1,maxmem=100663296$",
    );
  });
});
