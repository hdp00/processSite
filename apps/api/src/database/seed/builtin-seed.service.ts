import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { EntityManager, Repository } from "typeorm";
import { hashPassword } from "../../auth/password-codec.js";
import type { AppEnvironment } from "../../config/environment.js";
import {
  DepartmentEntity,
  PermissionEntity,
  PositionEntity,
  RoleEntity,
  RolePermissionEntity,
  SystemStateEntity,
  UserEntity,
  UserRoleEntity
} from "../entities/index.js";
import { FlowPilotDataSourceManager } from "../flowpilot-data-source.manager.js";
import { TypeOrmPersistenceUnitOfWork } from "../persistence/typeorm-persistence-unit-of-work.js";
import {
  BUILTIN_IDS,
  BUILTIN_PERMISSION_SEEDS,
  BUILTIN_SEED_VERSION,
  type BuiltinPermissionSeed
} from "./builtin-catalog.js";

export class BootstrapAdminPasswordRequiredError extends Error {
  readonly code = "BOOTSTRAP_ADMIN_PASSWORD_REQUIRED";

  constructor() {
    super("首次初始化必须通过外置 Secrets 配置 FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD");
    this.name = "BootstrapAdminPasswordRequiredError";
  }
}

export class BuiltinSeedConflictError extends Error {
  readonly code = "BUILTIN_SEED_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "BuiltinSeedConflictError";
  }
}

export interface BuiltinSeedResult {
  readonly seedVersion: string;
  readonly createdDepartment: boolean;
  readonly createdPosition: boolean;
  readonly createdManagerPosition: boolean;
  readonly createdEmployeePosition: boolean;
  readonly createdRole: boolean;
  readonly createdUser: boolean;
  readonly createdPermissions: number;
  readonly updatedPermissions: number;
  readonly removedPermissions: number;
  readonly removedRolePermissions: number;
  readonly createdRolePermissions: number;
  readonly createdUserRole: boolean;
}

const requireStableId = (
  resource: string,
  actualId: string,
  expectedId: string
): void => {
  if (actualId !== expectedId) {
    throw new BuiltinSeedConflictError(`${resource} 的稳定标识与内置种子不一致`);
  }
};

const findOrCreateDepartment = async (
  repository: Repository<DepartmentEntity>,
  now: Date
): Promise<{ entity: DepartmentEntity; created: boolean }> => {
  const existing = await repository.findOne({ where: { normalizedCode: "system" } });
  if (existing) {
    requireStableId("系统部门", existing.id, BUILTIN_IDS.systemDepartment);
    return { entity: existing, created: false };
  }
  const entity = repository.create({
    id: BUILTIN_IDS.systemDepartment,
    code: "system",
    normalizedCode: "system",
    name: "系统内置",
    parentId: null,
    pathCache: "系统内置",
    sortOrder: -1,
    isEnabled: true,
    description: "系统内置账号专用部门",
    revision: 1,
    createdAt: now,
    updatedAt: now
  });
  return { entity: await repository.save(entity), created: true };
};

interface BuiltinPositionSeed {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly description: string;
}

const findOrCreatePosition = async (
  repository: Repository<PositionEntity>,
  seed: BuiltinPositionSeed,
  now: Date
): Promise<{ entity: PositionEntity; created: boolean }> => {
  const existing = await repository.findOne({ where: { normalizedCode: seed.code } });
  if (existing) {
    requireStableId(`初始职务“${seed.name}”`, existing.id, seed.id);
    if (existing.normalizedName !== seed.name) {
      throw new BuiltinSeedConflictError(`初始职务“${seed.name}”的规范化名称不一致`);
    }
    return { entity: existing, created: false };
  }
  const entity = repository.create({
    id: seed.id,
    code: seed.code,
    normalizedCode: seed.code,
    name: seed.name,
    normalizedName: seed.name,
    sortOrder: seed.sortOrder,
    isEnabled: true,
    description: seed.description,
    revision: 1,
    createdAt: now,
    updatedAt: now
  });
  return { entity: await repository.save(entity), created: true };
};

const findOrCreateRole = async (
  repository: Repository<RoleEntity>,
  now: Date
): Promise<{ entity: RoleEntity; created: boolean }> => {
  const existing = await repository.findOne({ where: { normalizedCode: "super_admin" } });
  if (existing) {
    requireStableId("超级管理员角色", existing.id, BUILTIN_IDS.superAdminRole);
    if (existing.normalizedName !== "超级管理员" || !existing.isBuiltin || !existing.isEnabled) {
      throw new BuiltinSeedConflictError("超级管理员角色的内置或启用状态无效");
    }
    return { entity: existing, created: false };
  }
  const entity = repository.create({
    id: BUILTIN_IDS.superAdminRole,
    code: "super_admin",
    normalizedCode: "super_admin",
    name: "超级管理员",
    normalizedName: "超级管理员",
    description: "系统内置最高权限角色",
    isEnabled: true,
    isBuiltin: true,
    revision: 1,
    createdAt: now,
    updatedAt: now
  });
  return { entity: await repository.save(entity), created: true };
};

const ensurePermission = async (
  repository: Repository<PermissionEntity>,
  seed: BuiltinPermissionSeed
): Promise<"created" | "updated" | "unchanged"> => {
  const existing = await repository.findOne({ where: { code: seed.code } });
  if (existing) {
    if (existing.resource !== seed.resource || existing.action !== seed.action) {
      throw new BuiltinSeedConflictError(`权限 ${seed.code} 的资源或动作与内置目录不一致`);
    }
    if (
      existing.name !== seed.name
      || existing.sortOrder !== seed.sortOrder
      || !existing.isBuiltin
    ) {
      await repository.update({ code: seed.code }, {
        name: seed.name,
        sortOrder: seed.sortOrder,
        isBuiltin: true
      });
      return "updated";
    }
    return "unchanged";
  }
  await repository.save(repository.create({
    code: seed.code,
    resource: seed.resource,
    action: seed.action,
    name: seed.name,
    sortOrder: seed.sortOrder,
    isBuiltin: true
  }));
  return "created";
};

const findOrCreateUser = async (
  repository: Repository<UserEntity>,
  departmentId: string,
  positionId: string,
  passwordHash: string | undefined,
  now: Date
): Promise<{ entity: UserEntity; created: boolean }> => {
  const [existingByLogin, existingBuiltin] = await Promise.all([
    repository.findOne({ where: { normalizedLoginName: "superadmin" } }),
    repository.findOne({ where: { isBuiltinSuperAdmin: true } })
  ]);
  const existing = existingByLogin ?? existingBuiltin;
  if (existing) {
    requireStableId("超级管理员账号", existing.id, BUILTIN_IDS.superAdminUser);
    if (
      existing.normalizedLoginName !== "superadmin"
      || !existing.isBuiltinSuperAdmin
      || !existing.isEnabled
      || existing.authenticationMode !== "password"
      || !existing.passwordHash
    ) {
      throw new BuiltinSeedConflictError("超级管理员账号的内置安全属性无效");
    }
    return { entity: existing, created: false };
  }
  if (!passwordHash) throw new BootstrapAdminPasswordRequiredError();
  const entity = repository.create({
    id: BUILTIN_IDS.superAdminUser,
    loginName: "superadmin",
    normalizedLoginName: "superadmin",
    displayName: "超级管理员",
    email: "superadmin@flowpilot.invalid",
    authenticationMode: "password",
    passwordHash,
    departmentId,
    positionId,
    isEnabled: true,
    isBuiltinSuperAdmin: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null
  });
  return { entity: await repository.save(entity), created: true };
};

@Injectable()
export class BuiltinSeedService {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly dataSources: FlowPilotDataSourceManager,
    private readonly unitOfWork: TypeOrmPersistenceUnitOfWork
  ) {}

  async run(now = new Date()): Promise<BuiltinSeedResult> {
    const dataSource = await this.dataSources.ensureInitialized();
    const existing = await dataSource.getRepository(UserEntity).findOne({
      where: { normalizedLoginName: "superadmin" },
      select: { id: true }
    });
    const bootstrapPassword = this.config.get("FLOWPILOT_BOOTSTRAP_ADMIN_PASSWORD", { infer: true });
    if (!existing && !bootstrapPassword) throw new BootstrapAdminPasswordRequiredError();
    // Password derivation is intentionally outside the database transaction.
    const passwordHash = !existing && bootstrapPassword
      ? await hashPassword(bootstrapPassword)
      : undefined;

    return this.unitOfWork.execute(async ({ manager }) => this.seed(manager, passwordHash, now), {
      isolationLevel: "SERIALIZABLE"
    });
  }

  private async seed(
    manager: EntityManager,
    passwordHash: string | undefined,
    now: Date
  ): Promise<BuiltinSeedResult> {
    const department = await findOrCreateDepartment(manager.getRepository(DepartmentEntity), now);
    const positionRepository = manager.getRepository(PositionEntity);
    const position = await findOrCreatePosition(positionRepository, {
      id: BUILTIN_IDS.systemPosition,
      code: "system",
      name: "系统内置",
      sortOrder: -1,
      description: "系统内置账号专用职务"
    }, now);
    const managerPosition = await findOrCreatePosition(positionRepository, {
      id: BUILTIN_IDS.managerPosition,
      code: "manager",
      name: "经理",
      sortOrder: 10,
      description: "系统初始职务：经理"
    }, now);
    const employeePosition = await findOrCreatePosition(positionRepository, {
      id: BUILTIN_IDS.employeePosition,
      code: "employee",
      name: "员工",
      sortOrder: 20,
      description: "系统初始职务：员工"
    }, now);
    const role = await findOrCreateRole(manager.getRepository(RoleEntity), now);
    const permissionRepository = manager.getRepository(PermissionEntity);
    const rolePermissionRepository = manager.getRepository(RolePermissionEntity);
    const currentPermissionCodes = new Set(BUILTIN_PERMISSION_SEEDS.map((permission) => permission.code));
    const obsoleteBuiltinPermissions = (await permissionRepository.find({
      where: { isBuiltin: true }
    })).filter((permission) => !currentPermissionCodes.has(permission.code));
    let removedPermissions = 0;
    let removedRolePermissions = 0;
    for (const obsolete of obsoleteBuiltinPermissions) {
      const rolePermissionDeletion = await rolePermissionRepository.delete({
        permissionCode: obsolete.code
      });
      removedRolePermissions += rolePermissionDeletion.affected ?? 0;
      const permissionDeletion = await permissionRepository.delete({
        code: obsolete.code,
        isBuiltin: true
      });
      removedPermissions += permissionDeletion.affected ?? 0;
    }
    let createdPermissions = 0;
    let updatedPermissions = 0;
    for (const permission of BUILTIN_PERMISSION_SEEDS) {
      const outcome = await ensurePermission(permissionRepository, permission);
      if (outcome === "created") createdPermissions += 1;
      if (outcome === "updated") updatedPermissions += 1;
    }
    const user = await findOrCreateUser(
      manager.getRepository(UserEntity),
      department.entity.id,
      position.entity.id,
      passwordHash,
      now
    );

    const userRoleRepository = manager.getRepository(UserRoleEntity);
    const existingUserRole = await userRoleRepository.findOne({
      where: { userId: user.entity.id, roleId: role.entity.id }
    });
    if (!existingUserRole) {
      await userRoleRepository.save(userRoleRepository.create({
        userId: user.entity.id,
        roleId: role.entity.id,
        grantedBy: user.entity.id,
        grantedAt: now
      }));
    }

    let createdRolePermissions = 0;
    for (const permission of BUILTIN_PERMISSION_SEEDS) {
      const existingRolePermission = await rolePermissionRepository.findOne({
        where: { roleId: role.entity.id, permissionCode: permission.code }
      });
      if (!existingRolePermission) {
        await rolePermissionRepository.save(rolePermissionRepository.create({
          roleId: role.entity.id,
          permissionCode: permission.code,
          grantedBy: user.entity.id,
          grantedAt: now
        }));
        createdRolePermissions += 1;
      }
    }

    const stateRepository = manager.getRepository(SystemStateEntity);
    const seedState = await stateRepository.findOne({ where: { stateKey: "builtin-seed" } });
    const valueJson = JSON.stringify({ version: BUILTIN_SEED_VERSION });
    if (seedState) {
      if (seedState.valueJson !== valueJson) {
        await stateRepository.update(
          { stateKey: seedState.stateKey },
          { valueJson, revision: seedState.revision + 1, updatedAt: now }
        );
      }
    } else {
      await stateRepository.save(stateRepository.create({
        stateKey: "builtin-seed",
        valueJson,
        revision: 1,
        updatedAt: now
      }));
    }

    return {
      seedVersion: BUILTIN_SEED_VERSION,
      createdDepartment: department.created,
      createdPosition: position.created,
      createdManagerPosition: managerPosition.created,
      createdEmployeePosition: employeePosition.created,
      createdRole: role.created,
      createdUser: user.created,
      createdPermissions,
      updatedPermissions,
      removedPermissions,
      removedRolePermissions,
      createdRolePermissions,
      createdUserRole: !existingUserRole
    };
  }
}
