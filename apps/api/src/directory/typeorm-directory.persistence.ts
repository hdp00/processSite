import { Injectable } from "@nestjs/common";
import { In } from "typeorm";
import {
  DepartmentEntity,
  FlowPilotDataSourceManager,
  PermissionEntity,
  PositionEntity,
  RoleEntity,
  RolePermissionEntity,
  UserEntity,
  UserRoleEntity,
  WorkflowGroupPurposeEntity,
  WorkflowGroupRoleEntity,
  WorkflowGroupUserEntity,
  WorkflowPermissionGroupEntity,
} from "../database/index.js";
import { BUILTIN_PERMISSION_SEEDS } from "../database/seed/builtin-catalog.js";
import type {
  DepartmentCatalogRecord,
  DirectoryPersistence,
  PageSelection,
  PagedRecords,
  PermissionCatalogRecord,
  PositionCatalogRecord,
  ProcessDefinitionCatalogRecord,
  RoleCatalogRecord,
  WorkflowPermissionGroupCatalogRecord,
} from "./directory.persistence.js";
import type {
  ProcessDefinitionStatus,
  ProcessDefinitionType,
  WorkflowGroupPurpose,
} from "./directory.types.js";

const offset = (query: PageSelection): number => (query.page - 1) * query.pageSize;

const builtinPermissionMetadata = new Map(
  BUILTIN_PERMISSION_SEEDS.map((permission) => [permission.code, permission] as const),
);

const customPermissionCategory = (resource: string): string => {
  if (resource.startsWith("work-")) return "员工工作区";
  if (resource.startsWith("config-")) return "流程配置";
  if (resource.startsWith("org-")) return "用户与权限";
  if (resource.startsWith("system-")) return "系统运维";
  return "其他权限";
};

const escapedLike = (value: string): string => `%${value
  .replaceAll("\\", "\\\\")
  .replaceAll("%", "\\%")
  .replaceAll("_", "\\_")
  .replaceAll("[", "\\[")}%`;

const addToStringList = (target: Map<string, string[]>, key: string, value: string): void => {
  const values = target.get(key) ?? [];
  values.push(value);
  target.set(key, values);
};

@Injectable()
export class TypeOrmDirectoryPersistence implements DirectoryPersistence {
  constructor(private readonly dataSources: FlowPilotDataSourceManager) {}

  async listRoles(
    query: PageSelection & { status?: "enabled" | "disabled" | undefined },
  ): Promise<PagedRecords<RoleCatalogRecord>> {
    const dataSource = await this.dataSources.ensureInitialized();
    const roleQuery = dataSource.getRepository(RoleEntity).createQueryBuilder("role");
    if (query.q) {
      roleQuery.andWhere("(role.name LIKE :search ESCAPE '\\' OR role.code LIKE :search ESCAPE '\\')", {
        search: escapedLike(query.q),
      });
    }
    if (query.status) roleQuery.andWhere("role.isEnabled = :enabled", { enabled: query.status === "enabled" });
    const [roles, total] = await roleQuery
      .orderBy("role.name", "ASC")
      .addOrderBy("role.id", "ASC")
      .skip(offset(query))
      .take(query.pageSize)
      .getManyAndCount();
    const roleIds = roles.map((role) => role.id);
    if (!roleIds.length) return { items: [], total };

    const [userRoles, rolePermissions] = await Promise.all([
      dataSource.getRepository(UserRoleEntity).find({ where: { roleId: In(roleIds) } }),
      dataSource.getRepository(RolePermissionEntity).find({ where: { roleId: In(roleIds) } }),
    ]);
    const memberIdsByRole = new Map<string, string[]>();
    const permissionCodesByRole = new Map<string, string[]>();
    userRoles.forEach((link) => addToStringList(memberIdsByRole, link.roleId, link.userId));
    rolePermissions.forEach((link) => addToStringList(permissionCodesByRole, link.roleId, link.permissionCode));

    return {
      items: roles.map((role) => ({
        id: role.id,
        revision: role.revision,
        code: role.code,
        name: role.name,
        ...(role.description ? { description: role.description } : {}),
        enabled: role.isEnabled,
        builtIn: role.isBuiltin,
        memberIds: [...(memberIdsByRole.get(role.id) ?? [])].sort(),
        permissionCodes: [...(permissionCodesByRole.get(role.id) ?? [])].sort(),
      })),
      total,
    };
  }

  async listPermissions(): Promise<PermissionCatalogRecord[]> {
    const dataSource = await this.dataSources.ensureInitialized();
    const permissions = await dataSource.getRepository(PermissionEntity).find({
      order: { sortOrder: "ASC", code: "ASC" },
    });
    return permissions.map((permission) => {
      const metadata = builtinPermissionMetadata.get(permission.code);
      return {
        code: permission.code,
        name: metadata?.name ?? permission.name,
        category: metadata?.category ?? customPermissionCategory(permission.resource),
        kind: metadata?.kind ?? (permission.action === "查看" ? "page" : "action"),
        ...(metadata?.description ? { description: metadata.description } : {}),
        sortOrder: metadata?.sortOrder ?? permission.sortOrder,
      };
    });
  }

  async listWorkflowPermissionGroups(
    query: PageSelection & {
      purpose?: WorkflowGroupPurpose | undefined;
      status?: "enabled" | "disabled" | undefined;
    },
  ): Promise<PagedRecords<WorkflowPermissionGroupCatalogRecord>> {
    const dataSource = await this.dataSources.ensureInitialized();
    const groupQuery = dataSource.getRepository(WorkflowPermissionGroupEntity).createQueryBuilder("group");
    if (query.q) {
      groupQuery.andWhere("(group.name LIKE :search ESCAPE '\\' OR group.code LIKE :search ESCAPE '\\')", {
        search: escapedLike(query.q),
      });
    }
    if (query.status) groupQuery.andWhere("group.isEnabled = :enabled", { enabled: query.status === "enabled" });
    if (query.purpose) {
      groupQuery.innerJoin(
        WorkflowGroupPurposeEntity,
        "purposeFilter",
        "purposeFilter.groupId = group.id AND purposeFilter.purpose = :purpose",
        { purpose: query.purpose },
      );
    }
    const [groups, total] = await groupQuery
      .orderBy("group.name", "ASC")
      .addOrderBy("group.id", "ASC")
      .skip(offset(query))
      .take(query.pageSize)
      .getManyAndCount();
    const groupIds = groups.map((group) => group.id);
    if (!groupIds.length) return { items: [], total };

    const [directLinks, groupRoleLinks, purposeLinks] = await Promise.all([
      dataSource.getRepository(WorkflowGroupUserEntity).find({ where: { groupId: In(groupIds) } }),
      dataSource.getRepository(WorkflowGroupRoleEntity).find({ where: { groupId: In(groupIds) } }),
      dataSource.getRepository(WorkflowGroupPurposeEntity).find({ where: { groupId: In(groupIds) } }),
    ]);
    const linkedRoleIds = [...new Set(groupRoleLinks.map((link) => link.roleId))];
    const enabledRoles = linkedRoleIds.length
      ? await dataSource.getRepository(RoleEntity).find({ where: { id: In(linkedRoleIds), isEnabled: true } })
      : [];
    const enabledRoleIds = new Set(enabledRoles.map((role) => role.id));
    const roleUserLinks = enabledRoleIds.size
      ? await dataSource.getRepository(UserRoleEntity).find({ where: { roleId: In([...enabledRoleIds]) } })
      : [];
    const candidateUserIds = [...new Set([
      ...directLinks.map((link) => link.userId),
      ...roleUserLinks.map((link) => link.userId),
    ])];
    const effectiveUsers = candidateUserIds.length
      ? await dataSource.getRepository(UserEntity).find({
        select: { id: true },
        where: { id: In(candidateUserIds), isEnabled: true, isBuiltinSuperAdmin: false },
      })
      : [];
    const effectiveUserIds = new Set(effectiveUsers.map((user) => user.id));
    const directIdsByGroup = new Map<string, string[]>();
    const roleIdsByGroup = new Map<string, string[]>();
    const purposesByGroup = new Map<string, WorkflowGroupPurpose[]>();
    const userIdsByRole = new Map<string, string[]>();
    directLinks.forEach((link) => addToStringList(directIdsByGroup, link.groupId, link.userId));
    groupRoleLinks.forEach((link) => addToStringList(roleIdsByGroup, link.groupId, link.roleId));
    purposeLinks.forEach((link) => {
      const purposes = purposesByGroup.get(link.groupId) ?? [];
      purposes.push(link.purpose);
      purposesByGroup.set(link.groupId, purposes);
    });
    roleUserLinks.forEach((link) => addToStringList(userIdsByRole, link.roleId, link.userId));

    return {
      items: groups.map((group) => {
        const directUserIds = [...(directIdsByGroup.get(group.id) ?? [])].sort();
        const roleIds = [...(roleIdsByGroup.get(group.id) ?? [])].sort();
        const effectiveMembers = new Set(directUserIds.filter((userId) => effectiveUserIds.has(userId)));
        roleIds.filter((roleId) => enabledRoleIds.has(roleId)).forEach((roleId) => {
          (userIdsByRole.get(roleId) ?? []).forEach((userId) => {
            if (effectiveUserIds.has(userId)) effectiveMembers.add(userId);
          });
        });
        return {
          id: group.id,
          revision: group.revision,
          code: group.code,
          name: group.name,
          ...(group.description ? { description: group.description } : {}),
          purposes: [...(purposesByGroup.get(group.id) ?? [])].sort(),
          enabled: group.isEnabled,
          directUserIds,
          roleIds,
          effectiveMemberCount: effectiveMembers.size,
          openTaskCount: 0,
          referencedProcesses: [],
        };
      }),
      total,
    };
  }

  async listDepartments(includeDisabled: boolean): Promise<DepartmentCatalogRecord[]> {
    const dataSource = await this.dataSources.ensureInitialized();
    const departments = await dataSource.getRepository(DepartmentEntity).find({
      ...(includeDisabled ? {} : { where: { isEnabled: true } }),
      order: { sortOrder: "ASC", name: "ASC", id: "ASC" },
    });
    const departmentIds = departments.map((department) => department.id);
    const users = departmentIds.length
      ? await dataSource.getRepository(UserEntity).find({
        select: { id: true, departmentId: true },
        where: { departmentId: In(departmentIds) },
      })
      : [];
    const userCounts = new Map<string, number>();
    users.forEach((user) => {
      if (user.departmentId) userCounts.set(user.departmentId, (userCounts.get(user.departmentId) ?? 0) + 1);
    });
    return departments.map((department) => ({
      id: department.id,
      revision: department.revision,
      code: department.code,
      name: department.name,
      ...(department.parentId ? { parentId: department.parentId } : {}),
      path: department.pathCache,
      sortOrder: department.sortOrder,
      enabled: department.isEnabled,
      ...(department.description ? { description: department.description } : {}),
      userCount: userCounts.get(department.id) ?? 0,
    }));
  }

  async listPositions(
    query: PageSelection & { status?: "enabled" | "disabled" | undefined },
  ): Promise<PagedRecords<PositionCatalogRecord>> {
    const dataSource = await this.dataSources.ensureInitialized();
    const positionQuery = dataSource.getRepository(PositionEntity).createQueryBuilder("position");
    if (query.q) {
      positionQuery.andWhere("(position.name LIKE :search ESCAPE '\\' OR position.code LIKE :search ESCAPE '\\')", {
        search: escapedLike(query.q),
      });
    }
    if (query.status) {
      positionQuery.andWhere("position.isEnabled = :enabled", { enabled: query.status === "enabled" });
    }
    const [positions, total] = await positionQuery
      .orderBy("position.sortOrder", "ASC")
      .addOrderBy("position.name", "ASC")
      .addOrderBy("position.id", "ASC")
      .skip(offset(query))
      .take(query.pageSize)
      .getManyAndCount();
    const positionIds = positions.map((position) => position.id);
    const users = positionIds.length
      ? await dataSource.getRepository(UserEntity).find({
        select: { id: true, positionId: true },
        where: { positionId: In(positionIds) },
      })
      : [];
    const userCounts = new Map<string, number>();
    users.forEach((user) => {
      if (user.positionId) userCounts.set(user.positionId, (userCounts.get(user.positionId) ?? 0) + 1);
    });
    return {
      items: positions.map((position) => ({
        id: position.id,
        revision: position.revision,
        name: position.name,
        sortOrder: position.sortOrder,
        enabled: position.isEnabled,
        ...(position.description ? { description: position.description } : {}),
        userCount: userCounts.get(position.id) ?? 0,
      })),
      total,
    };
  }

  listProcessDefinitions(
    _query: PageSelection & {
      type?: ProcessDefinitionType | undefined;
      status?: ProcessDefinitionStatus | undefined;
    },
  ): Promise<PagedRecords<ProcessDefinitionCatalogRecord>> {
    // TODO: 流程定义持久化纵切面接入后，替换首版空库占位查询。
    return Promise.resolve({ items: [], total: 0 });
  }
}
