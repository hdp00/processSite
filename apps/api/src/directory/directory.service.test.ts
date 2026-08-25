import { describe, expect, it } from "vitest";
import { ProblemException } from "../common/http/problem-details.js";
import type { SessionPrincipal } from "../auth/auth.types.js";
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
import { DirectoryService } from "./directory.service.js";

class FakeDirectoryPersistence implements DirectoryPersistence {
  roles: RoleCatalogRecord[] = [];
  groups: WorkflowPermissionGroupCatalogRecord[] = [];
  departments: DepartmentCatalogRecord[] = [];
  positions: PositionCatalogRecord[] = [];
  definitions: ProcessDefinitionCatalogRecord[] = [];
  permissions: PermissionCatalogRecord[] = [];

  listRoles(_query: PageSelection & { status?: "enabled" | "disabled" }): Promise<PagedRecords<RoleCatalogRecord>> {
    return Promise.resolve({ items: this.roles, total: this.roles.length });
  }

  listPermissions(): Promise<PermissionCatalogRecord[]> {
    return Promise.resolve(this.permissions);
  }

  listWorkflowPermissionGroups(): Promise<PagedRecords<WorkflowPermissionGroupCatalogRecord>> {
    return Promise.resolve({ items: this.groups, total: this.groups.length });
  }

  listDepartments(): Promise<DepartmentCatalogRecord[]> {
    return Promise.resolve(this.departments);
  }

  listPositions(): Promise<PagedRecords<PositionCatalogRecord>> {
    return Promise.resolve({ items: this.positions, total: this.positions.length });
  }

  listProcessDefinitions(): Promise<PagedRecords<ProcessDefinitionCatalogRecord>> {
    return Promise.resolve({ items: this.definitions, total: this.definitions.length });
  }
}

const principal = (permissions: string[] = [], superAdmin = false): SessionPrincipal => ({
  sessionId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  operatorUserId: "00000000-0000-0000-0000-000000000002",
  roleIds: [],
  permissions,
  superAdmin,
  operatorSuperAdmin: false,
  expiresAt: new Date("2026-08-25T08:00:00.000Z"),
});

describe("DirectoryService", () => {
  it("returns formal role paging metadata and permission counts", async () => {
    const persistence = new FakeDirectoryPersistence();
    persistence.roles = [{
      id: "00000000-0000-0000-0000-000000000010",
      revision: 3,
      code: "reviewer",
      name: "审核员",
      enabled: true,
      builtIn: false,
      memberIds: ["00000000-0000-0000-0000-000000000011"],
      permissionCodes: ["work-task:查看", "work-task:审核", "work-list:查看"],
    }];
    const service = new DirectoryService(persistence);

    const result = await service.listRoles({ page: 1, pageSize: 20 });

    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });
    expect(result.items[0]).toMatchObject({
      status: "enabled",
      memberCount: 1,
      permissionCount: 3,
      pagePermissionCount: 2,
      actionPermissionCount: 3,
    });
  });

  it("builds the formal two-level department tree deterministically", async () => {
    const persistence = new FakeDirectoryPersistence();
    persistence.departments = [
      {
        id: "00000000-0000-0000-0000-000000000021",
        revision: 1,
        code: "child",
        name: "子部门",
        parentId: "00000000-0000-0000-0000-000000000020",
        path: "总部 / 子部门",
        sortOrder: 20,
        enabled: true,
        userCount: 2,
      },
      {
        id: "00000000-0000-0000-0000-000000000020",
        revision: 1,
        code: "root",
        name: "总部",
        path: "总部",
        sortOrder: 10,
        enabled: true,
        userCount: 1,
      },
    ];
    const service = new DirectoryService(persistence);

    const result = await service.listDepartments({ includeDisabled: false });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ level: 1, children: [{ level: 2, name: "子部门" }] });
  });

  it("maps and stably sorts the formal permission catalog", async () => {
    const persistence = new FakeDirectoryPersistence();
    persistence.permissions = [
      {
        code: "org-role:编辑",
        name: "角色管理 - 编辑",
        category: "用户与权限",
        kind: "action",
        description: "配置系统页面及动作权限",
        sortOrder: 802,
      },
      {
        code: "work-launch:查看",
        name: "流程发起 - 查看",
        category: "员工工作区",
        kind: "page",
        description: "进入发起中心并提交流程权限组授权的流程",
        sortOrder: 101,
      },
      {
        code: "org-role:授权",
        name: "角色管理 - 授权",
        category: "用户与权限",
        kind: "action",
        description: "配置系统页面及动作权限",
        sortOrder: 802,
      },
    ];
    const service = new DirectoryService(persistence);

    await expect(service.listPermissions(principal())).rejects.toMatchObject({
      problem: { status: 403, code: "PERMISSION_DENIED" },
    });
    const expected = [
      {
        code: "work-launch:查看",
        name: "流程发起 - 查看",
        category: "员工工作区",
        kind: "page",
        description: "进入发起中心并提交流程权限组授权的流程",
      },
      {
        code: "org-role:授权",
        name: "角色管理 - 授权",
        category: "用户与权限",
        kind: "action",
        description: "配置系统页面及动作权限",
      },
      {
        code: "org-role:编辑",
        name: "角色管理 - 编辑",
        category: "用户与权限",
        kind: "action",
        description: "配置系统页面及动作权限",
      },
    ];
    await expect(service.listPermissions(principal(["org-role:查看"]))).resolves.toEqual(expected);
    await expect(service.listPermissions(principal([], true))).resolves.toEqual(expected);
  });

  it("requires definition read permission and returns an empty formal page when granted", async () => {
    const persistence = new FakeDirectoryPersistence();
    const service = new DirectoryService(persistence);
    const query = { page: 1, pageSize: 100 } as const;

    await expect(service.listProcessDefinitions(principal(), query))
      .rejects.toBeInstanceOf(ProblemException);
    await expect(service.listProcessDefinitions(principal(["config-definition:查看"]), query))
      .resolves.toEqual({ items: [], meta: { page: 1, pageSize: 100, total: 0, totalPages: 0 } });
  });
});
