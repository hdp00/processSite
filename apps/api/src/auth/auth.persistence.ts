import type { AuthUserRecord, StoredSessionRecord } from "./auth.types.js";

export const AUTH_PERSISTENCE = Symbol("AUTH_PERSISTENCE");

export interface CreateSessionRecord {
  id: string;
  tokenHash: string;
  operatorUserId: string;
  effectiveUserId: string;
  createdAt: Date;
  lastAccessedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface AuthPersistence {
  findUserByNormalizedLoginName(normalizedLoginName: string): Promise<AuthUserRecord | undefined>;
  findUserById(userId: string): Promise<AuthUserRecord | undefined>;
  replacePasswordHashIfUnchanged(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<boolean>;
  createSession(session: CreateSessionRecord): Promise<StoredSessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<StoredSessionRecord | undefined>;
  touchSession(sessionId: string, lastAccessedAt: Date, idleExpiresAt: Date): Promise<void>;
  revokeSession(sessionId: string, revokedAt: Date, reason: string): Promise<void>;
}
