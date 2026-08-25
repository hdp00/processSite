import { Injectable } from "@nestjs/common";
import { In, IsNull, type DataSource } from "typeorm";
import {
  FlowPilotDataSourceManager,
  PermissionEntity,
  RoleEntity,
  RolePermissionEntity,
  SessionEntity,
  UserEntity,
  UserRoleEntity,
} from "../database/index.js";
import type { AuthPersistence, CreateSessionRecord } from "./auth.persistence.js";
import type { AuthRoleRecord, AuthUserRecord, StoredSessionRecord } from "./auth.types.js";

const missingProfileReference = (userId: string, reference: "department" | "position"): Error => (
  new Error(`用户 ${userId} 缺少必需的 ${reference} 引用`)
);

const storedSessionRecord = (session: SessionEntity): StoredSessionRecord => ({
  id: session.id,
  tokenHash: session.tokenHash,
  operatorUserId: session.operatorUserId,
  effectiveUserId: session.effectiveUserId ?? session.operatorUserId,
  createdAt: session.createdAt,
  lastAccessedAt: session.lastAccessedAt,
  idleExpiresAt: session.idleExpiresAt,
  absoluteExpiresAt: session.absoluteExpiresAt,
  ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
  ...(session.revocationReason ? { revokedReason: session.revocationReason } : {}),
});

@Injectable()
export class TypeOrmAuthPersistence implements AuthPersistence {
  constructor(private readonly dataSources: FlowPilotDataSourceManager) {}

  async findUserByNormalizedLoginName(normalizedLoginName: string): Promise<AuthUserRecord | undefined> {
    const dataSource = await this.dataSources.ensureInitialized();
    const user = await dataSource.getRepository(UserEntity).findOne({
      where: { normalizedLoginName },
      relations: { department: true, position: true },
    });
    return user ? this.toAuthUserRecord(dataSource, user) : undefined;
  }

  async findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    const dataSource = await this.dataSources.ensureInitialized();
    const user = await dataSource.getRepository(UserEntity).findOne({
      where: { id: userId },
      relations: { department: true, position: true },
    });
    return user ? this.toAuthUserRecord(dataSource, user) : undefined;
  }

  async replacePasswordHashIfUnchanged(
    userId: string,
    expectedPasswordHash: string,
    replacementPasswordHash: string,
  ): Promise<boolean> {
    const dataSource = await this.dataSources.ensureInitialized();
    const result = await dataSource.getRepository(UserEntity).update(
      {
        id: userId,
        authenticationMode: "password",
        passwordHash: expectedPasswordHash,
      },
      { passwordHash: replacementPasswordHash },
    );
    return result.affected === 1;
  }

  async createSession(input: CreateSessionRecord): Promise<StoredSessionRecord> {
    const dataSource = await this.dataSources.ensureInitialized();
    const repository = dataSource.getRepository(SessionEntity);
    const session = repository.create({
      id: input.id,
      tokenHash: input.tokenHash,
      operatorUserId: input.operatorUserId,
      effectiveUserId: input.effectiveUserId,
      permissionVersion: 1,
      createdAt: input.createdAt,
      lastAccessedAt: input.lastAccessedAt,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
      revocationReason: null,
    });
    return storedSessionRecord(await repository.save(session));
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredSessionRecord | undefined> {
    const dataSource = await this.dataSources.ensureInitialized();
    const session = await dataSource.getRepository(SessionEntity).findOneBy({ tokenHash });
    return session ? storedSessionRecord(session) : undefined;
  }

  async touchSession(sessionId: string, lastAccessedAt: Date, idleExpiresAt: Date): Promise<void> {
    const dataSource = await this.dataSources.ensureInitialized();
    await dataSource.getRepository(SessionEntity).update(
      { id: sessionId, revokedAt: IsNull() },
      { lastAccessedAt, idleExpiresAt },
    );
  }

  async revokeSession(sessionId: string, revokedAt: Date, reason: string): Promise<void> {
    const dataSource = await this.dataSources.ensureInitialized();
    await dataSource.getRepository(SessionEntity).update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt, revocationReason: reason },
    );
  }

  private async toAuthUserRecord(dataSource: DataSource, user: UserEntity): Promise<AuthUserRecord> {
    if (!user.department) throw missingProfileReference(user.id, "department");
    if (!user.position) throw missingProfileReference(user.id, "position");

    const userRoles = await dataSource.getRepository(UserRoleEntity).find({ where: { userId: user.id } });
    const roleIds = [...new Set(userRoles.map((link) => link.roleId))];
    const [roles, rolePermissions, allPermissions] = await Promise.all([
      roleIds.length
        ? dataSource.getRepository(RoleEntity).find({ where: { id: In(roleIds) } })
        : Promise.resolve([]),
      roleIds.length
        ? dataSource.getRepository(RolePermissionEntity).find({ where: { roleId: In(roleIds) } })
        : Promise.resolve([]),
      user.isBuiltinSuperAdmin
        ? dataSource.getRepository(PermissionEntity).find({ order: { sortOrder: "ASC", code: "ASC" } })
        : Promise.resolve([]),
    ]);
    const permissionCodesByRole = new Map<string, string[]>();
    rolePermissions.forEach((link) => {
      const permissionCodes = permissionCodesByRole.get(link.roleId) ?? [];
      permissionCodes.push(link.permissionCode);
      permissionCodesByRole.set(link.roleId, permissionCodes);
    });
    const authRoles: AuthRoleRecord[] = roles
      .map((role) => ({
        id: role.id,
        name: role.name,
        enabled: role.isEnabled,
        permissions: [...(permissionCodesByRole.get(role.id) ?? [])].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

    return {
      id: user.id,
      revision: user.revision,
      loginName: user.loginName,
      normalizedLoginName: user.normalizedLoginName,
      name: user.displayName,
      email: user.email,
      authenticationMode: user.authenticationMode,
      ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
      enabled: user.isEnabled,
      builtInSuperAdmin: user.isBuiltinSuperAdmin,
      department: {
        id: user.department.id,
        name: user.department.name,
        path: user.department.pathCache,
      },
      position: { id: user.position.id, name: user.position.name },
      roles: authRoles,
      ...(user.isBuiltinSuperAdmin
        ? { allPermissionCodes: allPermissions.map((permission) => permission.code) }
        : {}),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
