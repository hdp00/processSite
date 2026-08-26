import { Inject, Injectable } from "@nestjs/common";
import { ProblemException } from "../common/http/problem-details.js";
import { AUTH_PERSISTENCE, type AuthPersistence } from "./auth.persistence.js";
import {
  DOMAIN_AUTHENTICATION_PROVIDER,
  type DomainAuthenticationProvider,
} from "./domain-authentication.js";
import type {
  AuthenticatedSession,
  AuthUserRecord,
  LoginResult,
  SessionDto,
  SessionPrincipal,
  StoredSessionRecord,
  UserDto,
} from "./auth.types.js";
import type { LoginRequest } from "./auth.schemas.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { hashPassword, verifyPasswordDetailed } from "./password-codec.js";
import { createOpaqueSessionToken, createSessionId, hashSessionToken } from "./session-token.js";

export const SESSION_IDLE_DURATION_MS = 8 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_DURATION_MS = 24 * 60 * 60 * 1_000;

const invalidCredentials = () => new ProblemException({
  status: 401,
  code: "INVALID_CREDENTIALS",
  title: "登录失败",
  detail: "账号或密码错误。",
});

const authenticationRequired = () => new ProblemException({
  status: 401,
  code: "AUTHENTICATION_REQUIRED",
  title: "需要登录",
  detail: "当前会话不存在或已经失效，请重新登录。",
});

const domainAuthenticationUnavailable = () => new ProblemException({
  status: 503,
  code: "DOMAIN_AUTHENTICATION_UNAVAILABLE",
  title: "域认证暂不可用",
  detail: "无法连接域认证服务，请稍后重试或联系系统管理员。",
});

export function normalizeLoginName(loginName: string): string {
  return loginName.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((left, right) => left.localeCompare(right));

const effectiveAuthorization = (user: AuthUserRecord) => {
  const activeRoles = user.roles.filter((role) => role.enabled);
  return {
    roleIds: uniqueSorted(activeRoles.map((role) => role.id)),
    permissions: user.builtInSuperAdmin
      ? uniqueSorted(user.allPermissionCodes ?? activeRoles.flatMap((role) => role.permissions))
      : uniqueSorted(activeRoles.flatMap((role) => role.permissions)),
  };
};

const userDto = (user: AuthUserRecord): UserDto => ({
  id: user.id,
  revision: user.revision,
  loginName: user.loginName,
  name: user.name,
  email: user.email,
  authenticationMode: user.authenticationMode,
  status: user.enabled ? "enabled" : "disabled",
  department: user.department,
  position: user.position,
  roles: user.roles.map((role) => ({ id: role.id, name: role.name })),
  superAdmin: user.builtInSuperAdmin,
  createdAt: user.createdAt.toISOString(),
  updatedAt: user.updatedAt.toISOString(),
});

const effectiveExpiration = (session: StoredSessionRecord): Date => (
  session.idleExpiresAt.getTime() < session.absoluteExpiresAt.getTime()
    ? session.idleExpiresAt
    : session.absoluteExpiresAt
);

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_PERSISTENCE) private readonly persistence: AuthPersistence,
    private readonly loginRateLimiter: LoginRateLimiter,
    @Inject(DOMAIN_AUTHENTICATION_PROVIDER) private readonly domainAuthentication: DomainAuthenticationProvider,
  ) {}

  async login(input: LoginRequest, clientIp: string, now = new Date()): Promise<LoginResult> {
    const normalizedLoginName = this.domainAuthentication.normalizeLoginName(input.loginName);
    const rateLimitLoginName = normalizedLoginName ?? normalizeLoginName(input.loginName);
    this.loginRateLimiter.assertAllowed(rateLimitLoginName, clientIp, now.getTime());
    const releaseAuthenticationSlot = this.loginRateLimiter.acquireAuthenticationSlot(clientIp);
    try {
      const user = normalizedLoginName
        ? await this.persistence.findUserByNormalizedLoginName(normalizedLoginName)
        : undefined;

      if (user?.enabled && user.authenticationMode === "domain" && !user.builtInSuperAdmin) {
        const timingEqualizer = this.equalizePasswordVerificationTiming(input.password).then(
          () => true,
          () => false,
        );
        let domainResult: Awaited<ReturnType<DomainAuthenticationProvider["authenticate"]>>;
        try {
          domainResult = await this.domainAuthentication.authenticate(user.normalizedLoginName, input.password);
          if (!await timingEqualizer) {
            this.rejectDomainAuthenticationUnavailable(clientIp, now.getTime());
          }
        } catch {
          await timingEqualizer;
          this.rejectDomainAuthenticationUnavailable(clientIp, now.getTime());
        }
        if (domainResult !== "authenticated") {
          if (domainResult === "unavailable") {
            this.rejectDomainAuthenticationUnavailable(clientIp, now.getTime());
          }
          this.loginRateLimiter.recordFailure(rateLimitLoginName, clientIp, now.getTime());
          throw invalidCredentials();
        }
      } else {
        const verification = await verifyPasswordDetailed(
          input.password,
          user?.enabled && user.authenticationMode === "password" ? user.passwordHash : undefined,
        );
        if (!user?.enabled || user.authenticationMode !== "password" || !verification.matches) {
          if (user?.authenticationMode === "password" || user?.builtInSuperAdmin) {
            this.loginRateLimiter.recordFailure(rateLimitLoginName, clientIp, now.getTime());
            throw invalidCredentials();
          }
          return await this.rejectInvalidCredentialsAfterAvailabilityProbe(
            rateLimitLoginName,
            clientIp,
            now.getTime(),
          );
        }
        if (verification.needsRehash && user.passwordHash) {
          const replacementPasswordHash = await hashPassword(input.password);
          await this.persistence.replacePasswordHashIfUnchanged(
            user.id,
            user.passwordHash,
            replacementPasswordHash,
          );
        }
      }

      if (!user) throw invalidCredentials();

      const sessionToken = createOpaqueSessionToken();
      const createdAt = new Date(now);
      const storedSession = await this.persistence.createSession({
        id: createSessionId(),
        tokenHash: hashSessionToken(sessionToken),
        operatorUserId: user.id,
        effectiveUserId: user.id,
        createdAt,
        lastAccessedAt: createdAt,
        idleExpiresAt: new Date(createdAt.getTime() + SESSION_IDLE_DURATION_MS),
        absoluteExpiresAt: new Date(createdAt.getTime() + SESSION_ABSOLUTE_DURATION_MS),
      });
      const authenticated = this.toAuthenticatedSession(storedSession, user, user);
      this.loginRateLimiter.recordSuccess(rateLimitLoginName, clientIp);
      return { ...authenticated, sessionToken };
    } finally {
      releaseAuthenticationSlot();
    }
  }

  async authenticate(sessionToken: string | undefined, now = new Date()): Promise<AuthenticatedSession> {
    if (!sessionToken || sessionToken.length > 512) throw authenticationRequired();
    const session = await this.persistence.findSessionByTokenHash(hashSessionToken(sessionToken));
    if (!session || session.revokedAt) throw authenticationRequired();

    if (session.idleExpiresAt.getTime() <= now.getTime() || session.absoluteExpiresAt.getTime() <= now.getTime()) {
      await this.persistence.revokeSession(session.id, now, "expired");
      throw authenticationRequired();
    }

    const userPromise = this.persistence.findUserById(session.effectiveUserId);
    const operatorUserPromise = session.operatorUserId === session.effectiveUserId
      ? userPromise
      : this.persistence.findUserById(session.operatorUserId);
    const [user, operatorUser] = await Promise.all([userPromise, operatorUserPromise]);
    if (!user?.enabled || !operatorUser?.enabled) {
      await this.persistence.revokeSession(session.id, now, "user-disabled-or-missing");
      throw authenticationRequired();
    }

    const nextIdleExpiresAt = new Date(Math.min(
      now.getTime() + SESSION_IDLE_DURATION_MS,
      session.absoluteExpiresAt.getTime(),
    ));
    await this.persistence.touchSession(session.id, now, nextIdleExpiresAt);
    const touchedSession: StoredSessionRecord = {
      ...session,
      lastAccessedAt: now,
      idleExpiresAt: nextIdleExpiresAt,
    };
    return this.toAuthenticatedSession(touchedSession, user, operatorUser);
  }

  async logout(principal: SessionPrincipal, now = new Date()): Promise<void> {
    await this.persistence.revokeSession(principal.sessionId, now, "logout");
  }

  private async rejectInvalidCredentialsAfterAvailabilityProbe(
    normalizedLoginName: string,
    clientIp: string,
    now: number,
  ): Promise<never> {
    let availability: unknown;
    try {
      availability = await this.domainAuthentication.probeAvailability();
    } catch {
      this.rejectDomainAuthenticationUnavailable(clientIp, now);
    }
    if (availability !== "reachable") this.rejectDomainAuthenticationUnavailable(clientIp, now);
    this.loginRateLimiter.recordFailure(normalizedLoginName, clientIp, now);
    throw invalidCredentials();
  }

  private rejectDomainAuthenticationUnavailable(clientIp: string, now: number): never {
    this.loginRateLimiter.recordUnavailableAttempt(clientIp, now);
    throw domainAuthenticationUnavailable();
  }

  protected async equalizePasswordVerificationTiming(password: string): Promise<void> {
    await verifyPasswordDetailed(password, undefined);
  }

  private toAuthenticatedSession(
    session: StoredSessionRecord,
    user: AuthUserRecord,
    operatorUser: AuthUserRecord,
  ): AuthenticatedSession {
    const authorization = effectiveAuthorization(user);
    const expiresAt = effectiveExpiration(session);
    const principal: SessionPrincipal = {
      sessionId: session.id,
      userId: user.id,
      operatorUserId: operatorUser.id,
      roleIds: authorization.roleIds,
      permissions: authorization.permissions,
      superAdmin: user.builtInSuperAdmin,
      operatorSuperAdmin: operatorUser.builtInSuperAdmin,
      expiresAt,
    };
    const dto: SessionDto = {
      user: userDto(user),
      operatorUser: userDto(operatorUser),
      roleIds: authorization.roleIds,
      permissions: authorization.permissions,
      superAdmin: user.builtInSuperAdmin,
      operatorSuperAdmin: operatorUser.builtInSuperAdmin,
      expiresAt: expiresAt.toISOString(),
    };
    return { principal, dto };
  }
}
