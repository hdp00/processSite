import { Inject, Injectable } from "@nestjs/common";
import { ProblemException } from "../common/http/problem-details.js";
import type { SessionPrincipal } from "../auth/auth.types.js";
import {
  DIRECTORY_PERSISTENCE,
  type DepartmentCatalogRecord,
  type DirectoryPersistence,
  type PageSelection,
  type PermissionCatalogRecord,
} from "./directory.persistence.js";
import type {
  DepartmentListQuery,
  PositionListQuery,
  ProcessDefinitionListQuery,
  RoleListQuery,
  WorkflowGroupListQuery,
} from "./directory.schemas.js";
import type {
  DepartmentDto,
  PageDto,
  PermissionDto,
  PositionDto,
  PositionPageDto,
  ProcessDefinitionDto,
  ProcessDefinitionPageDto,
  ProcessDefinitionStatus,
  RoleDto,
  RolePageDto,
  WorkflowPermissionGroupDto,
  WorkflowPermissionGroupPageDto,
} from "./directory.types.js";

const pageResult = <T>(items: T[], total: number, selection: PageSelection): PageDto<T> => ({
  items,
  meta: {
    page: selection.page,
    pageSize: selection.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / selection.pageSize),
  },
});

const status = (enabled: boolean): "enabled" | "disabled" => enabled ? "enabled" : "disabled";

const pagePermissionCount = (permissionCodes: string[]): number => new Set(permissionCodes.map((code) => {
  const separator = code.lastIndexOf(":");
  return separator < 0 ? code : code.slice(0, separator);
})).size;

const permissionDto = (record: PermissionCatalogRecord): PermissionDto => ({
  code: record.code,
  name: record.name,
  category: record.category,
  kind: record.kind,
  ...(record.description ? { description: record.description } : {}),
});

const comparePermissionCode = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

const processDefinitionStatus = (record: { disabled: boolean; publishedVersionId?: string }): ProcessDefinitionStatus => (
  record.disabled ? "disabled" : record.publishedVersionId ? "published" : "unpublished"
);

const requirePermission = (principal: SessionPrincipal, permission: string): void => {
  if (principal.superAdmin || principal.permissions.includes(permission)) return;
  throw new ProblemException({
    status: 403,
    code: "PERMISSION_DENIED",
    title: "没有查看权限",
    detail: `当前账号缺少 ${permission} 权限。`,
  });
};

const departmentDto = (
  record: DepartmentCatalogRecord,
  level: number,
  children: DepartmentDto[],
): DepartmentDto => ({
  id: record.id,
  revision: record.revision,
  code: record.code,
  name: record.name,
  ...(record.parentId ? { parentId: record.parentId } : {}),
  path: record.path,
  level,
  sortOrder: record.sortOrder,
  status: status(record.enabled),
  ...(record.description ? { description: record.description } : {}),
  userCount: record.userCount,
  children,
});

@Injectable()
export class DirectoryService {
  constructor(@Inject(DIRECTORY_PERSISTENCE) private readonly persistence: DirectoryPersistence) {}

  async listRoles(query: RoleListQuery): Promise<RolePageDto> {
    const result = await this.persistence.listRoles(query);
    const items: RoleDto[] = result.items.map((record) => ({
      id: record.id,
      revision: record.revision,
      code: record.code,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      status: status(record.enabled),
      builtIn: record.builtIn,
      memberCount: record.memberIds.length,
      memberIds: [...record.memberIds],
      permissionCount: record.permissionCodes.length,
      pagePermissionCount: pagePermissionCount(record.permissionCodes),
      actionPermissionCount: record.permissionCodes.length,
    }));
    return pageResult(items, result.total, query);
  }

  async listPermissions(principal: SessionPrincipal): Promise<PermissionDto[]> {
    requirePermission(principal, "org-role:查看");
    const permissions = await this.persistence.listPermissions();
    return [...permissions]
      .sort((left, right) => left.sortOrder - right.sortOrder || comparePermissionCode(left.code, right.code))
      .map(permissionDto);
  }

  async listWorkflowPermissionGroups(query: WorkflowGroupListQuery): Promise<WorkflowPermissionGroupPageDto> {
    const result = await this.persistence.listWorkflowPermissionGroups(query);
    const items: WorkflowPermissionGroupDto[] = result.items.map((record) => ({
      id: record.id,
      revision: record.revision,
      code: record.code,
      name: record.name,
      ...(record.description ? { description: record.description } : {}),
      purposes: [...record.purposes],
      status: status(record.enabled),
      directUserIds: [...record.directUserIds],
      roleIds: [...record.roleIds],
      effectiveMemberCount: record.effectiveMemberCount,
      openTaskCount: record.openTaskCount,
      referencedProcesses: [...record.referencedProcesses],
    }));
    return pageResult(items, result.total, query);
  }

  async listDepartments(query: DepartmentListQuery): Promise<DepartmentDto[]> {
    const records = await this.persistence.listDepartments(query.includeDisabled);
    const byParent = new Map<string | undefined, DepartmentCatalogRecord[]>();
    records.forEach((record) => {
      const siblings = byParent.get(record.parentId) ?? [];
      siblings.push(record);
      byParent.set(record.parentId, siblings);
    });
    byParent.forEach((items) => items.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name)));
    const build = (record: DepartmentCatalogRecord, level: number): DepartmentDto => departmentDto(
      record,
      level,
      (byParent.get(record.id) ?? []).map((child) => build(child, level + 1)),
    );
    return (byParent.get(undefined) ?? []).map((record) => build(record, 1));
  }

  async listPositions(query: PositionListQuery): Promise<PositionPageDto> {
    const result = await this.persistence.listPositions(query);
    const items: PositionDto[] = result.items.map((record) => ({
      id: record.id,
      revision: record.revision,
      name: record.name,
      sortOrder: record.sortOrder,
      status: status(record.enabled),
      ...(record.description ? { description: record.description } : {}),
      userCount: record.userCount,
    }));
    return pageResult(items, result.total, query);
  }

  async listProcessDefinitions(
    principal: SessionPrincipal,
    query: ProcessDefinitionListQuery,
  ): Promise<ProcessDefinitionPageDto> {
    requirePermission(principal, "config-definition:查看");
    const result = await this.persistence.listProcessDefinitions(query);
    const items: ProcessDefinitionDto[] = result.items.map((record) => ({
      id: record.id,
      revision: record.revision,
      code: record.code,
      name: record.name,
      description: record.description,
      type: record.type,
      disabled: record.disabled,
      status: processDefinitionStatus(record),
      ...(record.publishedVersionId ? { publishedVersionId: record.publishedVersionId } : {}),
      ...(record.publishedInstancePrefix ? { publishedInstancePrefix: record.publishedInstancePrefix } : {}),
      nextVersionNumber: record.nextVersionNumber,
      versionCount: record.versionCount,
      instanceCount: record.instanceCount,
      updatedAt: record.updatedAt.toISOString(),
      updatedBy: record.updatedBy,
    }));
    return pageResult(items, result.total, query);
  }
}
