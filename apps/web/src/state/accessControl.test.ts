import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { installMemoryBrowserStorage, type MemoryStorage } from "../test/memoryStorage";

let storage: MemoryStorage;
let identityModule: typeof import("./useIdentityStore");
let permissionModule: typeof import("./permissionEngine");
let rolePermissionModule: typeof import("./rolePermissions");
let workflowAccessModule: typeof import("./workflowAccess");
let definitionModule: typeof import("./useProcessDefinitionStore");
let prototypeModule: typeof import("./usePrototypeStore");

beforeAll(async () => {
  ({ localStorage: storage } = installMemoryBrowserStorage());
  identityModule = await import("./useIdentityStore");
  permissionModule = await import("./permissionEngine");
  rolePermissionModule = await import("./rolePermissions");
  definitionModule = await import("./useProcessDefinitionStore");
  prototypeModule = await import("./usePrototypeStore");
  workflowAccessModule = await import("./workflowAccess");
});

beforeEach(() => {
  vi.unstubAllEnvs();
  storage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  prototypeModule.usePrototypeStore.getState().resetDemo();
});

const setRolePermissionOverrides = (overrides: Record<string, string[]>) => {
  storage.setItem(permissionModule.ROLE_PERMISSION_STORAGE_KEY, JSON.stringify(overrides));
};

const publishedVersion = (definitionId: string) => {
  const definition = definitionModule.useProcessDefinitionStore.getState().definitions
    .find((item) => item.id === definitionId)!;
  return definition.versions.find((version) => version.id === definition.publishedVersionId)!;
};

const configurePublishedAccess = (
  definitionId: string,
  access: {
    starterGroups?: string[];
    closeGroups?: string[];
    assigneeGroups?: string[];
    visibleRoles?: string[];
    visibleUsers?: string[];
    approvalGroups?: string[];
    rejectionHandling?: "resubmit-or-close" | "resubmit-only" | "auto-close";
  },
) => {
  definitionModule.useProcessDefinitionStore.setState((state) => ({
    definitions: state.definitions.map((definition) => {
      if (definition.id !== definitionId) return definition;
      return {
        ...definition,
        versions: definition.versions.map((version) => version.id !== definition.publishedVersionId
          ? version
          : {
              ...version,
              basic: {
                ...version.basic,
                starterGroups: access.starterGroups ?? [],
                closeGroups: access.closeGroups ?? [],
                assigneeGroups: access.assigneeGroups ?? [],
                visibleRoles: access.visibleRoles ?? [],
                visibleUsers: access.visibleUsers ?? [],
              },
              snapshot: {
                ...version.snapshot,
                flow: {
                  ...version.snapshot.flow,
                  nodes: (access.approvalGroups ?? []).map((permissionGroup, index) => ({
                    id: `approval-${index}`,
                    position: { x: 0, y: index * 100 },
                    data: { kind: "approval" as const, label: `审批 ${index + 1}`, permissionGroup },
                  })),
                  meta: {
                    ...version.snapshot.flow.meta,
                    rejectionHandling: access.rejectionHandling ?? "resubmit-or-close",
                  },
                },
              },
            }),
      };
    }),
  }));
};

const isolatedInstance = (definitionId = "pdf-review"): ProcessInstance => {
  const version = publishedVersion(definitionId);
  const source = prototypeModule.usePrototypeStore.getState().instances
    .find((instance) => instance.definitionId === "pdf-review")!;
  return {
    ...structuredClone(source),
    id: `access-${definitionId}`,
    definitionId,
    versionId: version.id,
    initiator: "周杰",
    initiatorId: "admin",
    participantIds: [],
    participants: [],
    currentAssignee: undefined,
    currentAssigneeId: undefined,
  };
};

describe("角色权限引擎", () => {
  it("归一化历史编辑动作、移除失效权限，并去除归一化后的重复项", () => {
    expect(permissionModule.normalizeRolePermissionList([
      "org-user:新增",
      "org-user:新建",
      "org-user:启停",
      "org-user:停用",
      "org-user:查看",
      "work-task:驳回",
      "不含分隔符",
      "domain:sub:编辑",
    ])).toEqual([
      "org-user:编辑",
      "org-user:查看",
      "work-task:审核",
    ]);
  });

  it("将旧版驳回权限迁入审核，并为文控专员补齐审核与关闭权限", () => {
    storage.setItem(permissionModule.LEGACY_ROLE_PERMISSION_STORAGE_KEY, JSON.stringify({
      "ROLE-003": ["work-launch:查看", "work-launch:发起", "work-task:查看"],
      "ROLE-005": ["work-task:查看", "work-task:审核", "work-task:驳回"],
    }));

    const stored = permissionModule.readStoredRolePermissions();
    expect(stored["ROLE-003"]).toEqual(expect.arrayContaining(["work-task:审核", "work-task:关闭"]));
    expect(stored["ROLE-005"]).toEqual(["work-task:查看", "work-task:审核"]);
    expect(stored["ROLE-005"]).not.toContain("work-task:驳回");
    expect(storage.getItem(permissionModule.ROLE_PERMISSION_STORAGE_KEY)).not.toBeNull();
  });

  it("升级 v2 权限时只补齐最新目录删除权限，不恢复曾主动移除的权限", () => {
    const latestDeletes = ["org-department:删除", "org-group:删除"];
    const previousFullPermissions = permissionModule.defaultRolePermissionMap["ROLE-001"]
      .filter((permission) => !latestDeletes.includes(permission));
    storage.setItem(permissionModule.PREVIOUS_ROLE_PERMISSION_STORAGE_KEY, JSON.stringify({
      "ROLE-001": previousFullPermissions,
      "ROLE-CUSTOM": ["org-user:查看", "org-user:编辑"],
    }));

    const stored = permissionModule.readStoredRolePermissions();
    expect(stored["ROLE-001"]).toEqual(expect.arrayContaining(latestDeletes));
    expect(stored["ROLE-001"]).toContain("org-user:删除");
    expect(stored["ROLE-CUSTOM"]).toEqual(["org-user:查看", "org-user:编辑"]);
    expect(stored["ROLE-CUSTOM"]).not.toContain("org-user:删除");
    expect(storage.getItem(permissionModule.ROLE_PERMISSION_STORAGE_KEY)).not.toBeNull();
  });

  it("合并持久化覆盖但不允许覆盖超级管理员，并在 JSON 损坏时回退默认值", () => {
    setRolePermissionOverrides({
      "ROLE-007": ["work-task:新增", "work-task:查看"],
      "ROLE-SUPER": [],
      "ROLE-CUSTOM": ["custom-page:查看"],
    });

    const stored = permissionModule.readStoredRolePermissions();
    expect(stored["ROLE-007"]).toEqual(["work-task:查看"]);
    expect(stored["ROLE-CUSTOM"]).toEqual([]);
    expect(stored["ROLE-SUPER"]).toContain("org-role:授权");
    expect(stored["ROLE-SUPER"]).toEqual(expect.arrayContaining([
      "org-user:删除",
      "org-role:删除",
      "org-department:删除",
      "org-group:删除",
    ]));

    storage.setItem(permissionModule.ROLE_PERMISSION_STORAGE_KEY, "{broken");
    expect(permissionModule.readStoredRolePermissions()).toEqual(permissionModule.defaultRolePermissionMap);
  });

  it("只通过启用用户的启用角色授权，并保持超级管理员独立授权", () => {
    expect(permissionModule.hasUserPermission("superadmin", "unknown:operation")).toBe(true);
    expect(permissionModule.hasUserPermission("missing-user", "work-list:查看")).toBe(false);
    expect(permissionModule.hasUserPermission("lina", "work-task:审核")).toBe(true);
    expect(permissionModule.hasUserPermission("wangmin", "work-task:审核")).toBe(true);
    expect(permissionModule.hasUserPermission("wangmin", "work-task:关闭")).toBe(true);
    expect(permissionModule.hasUserPermission("lina", "work-task:关闭")).toBe(false);
    expect(permissionModule.hasUserPermission("lina", "org-role:授权")).toBe(false);

    identityModule.useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === "ROLE-005"
      ? { ...role, status: "停用" }
      : role));
    expect(permissionModule.hasUserPermission("lina", "work-task:审核")).toBe(false);

    identityModule.useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === "hejing"
      ? { ...user, status: "停用" }
      : user));
    setRolePermissionOverrides({ "ROLE-007": ["work-task:查看"] });
    expect(permissionModule.hasUserPermission("hejing", "work-task:查看")).toBe(false);
  });

  it("远程模式只信任当前会话权限，并支持会话超级管理员", () => {
    vi.stubEnv("VITE_API_MODE", "remote");
    storage.setItem("flowpilot-prototype-v5", JSON.stringify({
      state: {
        authenticated: true,
        personaId: "lina",
        sessionPermissions: ["work-task:查看"],
        sessionSuperAdmin: false,
      },
    }));

    expect(permissionModule.hasUserPermission("lina", "work-task:查看")).toBe(true);
    expect(permissionModule.hasUserPermission("lina", "org-role:授权")).toBe(false);

    storage.setItem("flowpilot-prototype-v5", JSON.stringify({
      state: { authenticated: true, personaId: "lina", sessionPermissions: [], sessionSuperAdmin: true },
    }));
    expect(permissionModule.hasUserPermission("lina", "org-role:授权")).toBe(true);

    storage.setItem("flowpilot-prototype-v5", "not-json");
    expect(permissionModule.hasUserPermission("lina", "work-task:查看")).toBe(false);
  });

  it("读取当前会话身份，并通过 currentUserCan 使用同一权限边界", () => {
    storage.setItem("flowpilot-prototype-v5", JSON.stringify({ state: { personaId: "hejing" } }));
    expect(permissionModule.currentSessionUserId()).toBe("hejing");
    expect(permissionModule.currentUserCan("work-list:查看")).toBe(true);

    storage.setItem("flowpilot-prototype-v5", "invalid");
    expect(permissionModule.currentSessionUserId()).toBe("");
    expect(permissionModule.currentUserCan("work-list:查看")).toBe(false);
  });
});

describe("身份目录派生关系", () => {
  it("本地认证忽略账号首尾空格和大小写，并区分错误凭据与停用账号", () => {
    expect(identityModule.authenticateLocalAccount("  LiNa  ", "1")).toMatchObject({
      ok: true,
      user: { id: "lina" },
    });
    expect(identityModule.authenticateLocalAccount("lina", "wrong")).toEqual({
      ok: false,
      reason: "账号或密码错误",
    });

    identityModule.useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === "lina"
      ? { ...user, status: "停用" }
      : user));
    expect(identityModule.authenticateLocalAccount("lina", "1")).toEqual({
      ok: false,
      reason: "该账号已停用，请联系管理员",
    });
  });

  it("有效权限组成员合并直接成员与启用角色成员，并排除停用成员实体和内置用户", () => {
    const groupId = "PDF审核_研发_流程权限组";
    const initialMembers = identityModule.effectiveGroupMemberIds(groupId);
    expect(initialMembers).toEqual(expect.arrayContaining(["zhangwei", "chenchen"]));
    expect(new Set(initialMembers).size).toBe(initialMembers.length);
    expect(initialMembers).not.toContain("superadmin");
    expect(identityModule.isUserInWorkflowGroup("zhangwei", groupId)).toBe(true);
    expect(identityModule.effectiveGroupMemberIds("missing-group")).toEqual([]);
    expect(identityModule.effectiveGroupMemberIds("技术文件只读_流程权限组").length).toBeGreaterThan(0);

    identityModule.useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === "zhangwei"
      ? { ...user, status: "停用" }
      : user));
    expect(identityModule.effectiveGroupMemberIds(groupId)).not.toContain("zhangwei");

    identityModule.useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === "ROLE-004"
      ? { ...role, status: "停用" }
      : role));
    expect(identityModule.effectiveGroupMemberIds(groupId)).toEqual(["chenchen"]);
  });

  it("流程权限组选项只返回启用且用途匹配的组，并提供稳定的未知组标签", () => {
    expect(identityModule.workflowGroupLabel("PDF审核_质量_流程权限组")).toBe("PDF审核_质量_流程权限组");
    expect(identityModule.workflowGroupLabel("missing-group")).toBe("未识别流程权限组");
    expect(identityModule.resolveWorkflowGroupLabel([], "missing-group")).toBe("未识别流程权限组");
    expect(identityModule.resolveWorkflowGroupLabels(
      identityModule.useIdentityStore.getState().workflowGroups,
      ["PDF审核_文控_流程权限组", "missing-group"],
    )).toEqual(["PDF审核_文控_流程权限组", "未识别流程权限组"]);

    const starterOptions = identityModule.workflowPermissionGroupOptions("发起");
    expect(starterOptions).toContainEqual({
      value: "PDF审核_文控_流程权限组",
      label: "PDF审核_文控_流程权限组",
    });
    expect(starterOptions.some((option) => option.value === "PDF审核_质量_流程权限组")).toBe(false);
    expect(identityModule.workflowPermissionGroupOptions().some((option) => option.value === "技术文件只读_流程权限组"))
      .toBe(false);
  });

  it("按成员姓名导入新角色并按稳定标识维护权限组时同步双向关系", () => {
    const current = identityModule.useIdentityStore.getState();
    identityModule.useIdentityStore.getState().setRoles([
      ...current.roles,
      {
        id: "ROLE-CUSTOM-AUDITOR",
        name: "临时审计员",
        code: "temporary_auditor",
        description: "验证旧成员姓名到稳定标识的同步",
        pagePermissions: 1,
        actionPermissions: 0,
        users: 1,
        status: "启用",
        members: ["何静"],
      },
    ]);

    expect(identityModule.findIdentityUser("hejing")).toMatchObject({
      roles: expect.arrayContaining(["临时审计员"]),
      roleIds: expect.arrayContaining(["ROLE-CUSTOM-AUDITOR"]),
    });
    expect(identityModule.useIdentityStore.getState().roles.find((role) => role.id === "ROLE-CUSTOM-AUDITOR"))
      .toMatchObject({ memberUserIds: ["hejing"], members: ["何静"], users: 1 });

    identityModule.useIdentityStore.getState().setWorkflowGroups((groups) => [
      ...groups,
      {
        id: "custom-audit-group",
        code: "PG-CUSTOM",
        name: "临时审计流程权限组",
        processes: [],
        purposes: ["审批/受理"],
        directMembers: [],
        linkedRoles: [],
        directMemberUserIds: ["hejing"],
        linkedRoleIds: ["ROLE-CUSTOM-AUDITOR"],
        status: "启用",
        referenced: false,
        openTasks: 0,
        updatedAt: "2026-08-20 12:00",
      },
    ]);

    expect(identityModule.workflowGroupLabel("custom-audit-group")).toBe("临时审计流程权限组");
    expect(identityModule.effectiveGroupMemberIds("custom-audit-group")).toEqual(["hejing"]);
    expect(identityModule.useIdentityStore.getState().workflowGroups.find((group) => group.id === "custom-audit-group"))
      .toMatchObject({ directMembers: ["何静"], linkedRoles: ["临时审计员"] });
  });
});

describe("页面入口与流程数据范围", () => {
  it("流程发起同时要求页面和动作权限、已发布且启用的定义以及发起组成员资格", () => {
    expect(rolePermissionModule.canPersonaAccessLaunch("wangmin")).toBe(true);
    expect(rolePermissionModule.canPersonaAccessLaunch("hejing")).toBe(false);

    setRolePermissionOverrides({ "ROLE-007": ["work-launch:查看"] });
    expect(rolePermissionModule.canPersonaAccessLaunch("hejing")).toBe(false);

    expect(rolePermissionModule.canPersonaLaunchDefinition("superadmin", "missing-definition")).toBe(true);
    expect(rolePermissionModule.canPersonaLaunchDefinition("wangmin", "pdf-review")).toBe(true);
    expect(rolePermissionModule.canPersonaLaunchDefinition("wangmin", "missing-definition")).toBe(false);
    expect(rolePermissionModule.canPersonaLaunchDefinition("hejing", "pdf-review")).toBe(false);

    definitionModule.useProcessDefinitionStore.setState((state) => ({
      definitions: state.definitions.map((definition) => definition.id === "pdf-review"
        ? { ...definition, disabled: true }
        : definition),
    }));
    expect(rolePermissionModule.canPersonaLaunchDefinition("wangmin", "pdf-review")).toBe(false);

    const dispatch = vi.spyOn(window, "dispatchEvent");
    rolePermissionModule.notifyRolePermissionsChanged();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: permissionModule.ROLE_PERMISSIONS_CHANGED_EVENT }));
  });

  it("流程实例依次支持发起人、参与人、受理人、显式用户、角色和流程组的数据范围", () => {
    configurePublishedAccess("pdf-review", {});
    const instance = isolatedInstance();

    expect(workflowAccessModule.canUserViewInstance("hejing", { ...instance, initiatorId: "hejing" })).toBe(true);
    expect(workflowAccessModule.canUserViewInstance("hejing", { ...instance, initiator: "何静" })).toBe(true);
    expect(workflowAccessModule.canUserViewInstance("hejing", { ...instance, participantIds: ["hejing"] })).toBe(true);
    expect(workflowAccessModule.canUserViewInstance("hejing", { ...instance, currentAssigneeId: "hejing" })).toBe(true);

    configurePublishedAccess("pdf-review", { visibleUsers: ["何静"] });
    expect(workflowAccessModule.canUserViewInstance("hejing", instance)).toBe(true);
    configurePublishedAccess("pdf-review", { visibleRoles: ["ROLE-007"] });
    expect(workflowAccessModule.canUserViewInstance("hejing", instance)).toBe(true);
    configurePublishedAccess("pdf-review", { starterGroups: ["PDF审核_文控_流程权限组"] });
    expect(workflowAccessModule.canUserViewInstance("wangmin", instance)).toBe(true);
    configurePublishedAccess("pdf-review", { assigneeGroups: ["PDF审核_研发_流程权限组"] });
    expect(workflowAccessModule.canUserViewInstance("zhangwei", instance)).toBe(true);
    configurePublishedAccess("pdf-review", { closeGroups: ["PDF审核_文控_流程权限组"] });
    expect(workflowAccessModule.canUserViewInstance("wangmin", instance)).toBe(true);
    configurePublishedAccess("pdf-review", { approvalGroups: ["PDF审核_研发_流程权限组"] });
    expect(workflowAccessModule.canUserViewInstance("zhangwei", instance)).toBe(true);

    configurePublishedAccess("pdf-review", {});
    expect(workflowAccessModule.canUserViewInstance("hejing", instance)).toBe(false);
    expect(workflowAccessModule.canUserViewInstance("lina", { ...instance, definitionId: "missing" })).toBe(false);
    expect(workflowAccessModule.canUserViewInstance("superadmin", { ...instance, definitionId: "missing" })).toBe(true);
    expect(workflowAccessModule.canUserViewInstance("wangmin", instance)).toBe(false);
  });

  it("正式会话中的超级管理员 GUID 可以查看和处理任意流程", () => {
    const userId = "f6f819c0-cc2d-4ab7-b857-e8ee70e71c5c";
    const instance = { ...isolatedInstance(), definitionId: "missing" };
    vi.stubEnv("VITE_API_MODE", "remote");
    prototypeModule.usePrototypeStore.setState({
      authenticated: true,
      personaId: userId,
      operatorUserId: userId,
      sessionPermissions: [],
      sessionSuperAdmin: true,
      operatorSuperAdmin: true,
    });

    expect(workflowAccessModule.canUserViewInstance(userId, instance)).toBe(true);
    expect(workflowAccessModule.canUserCloseInstance(userId, instance)).toBe(true);
    expect(rolePermissionModule.canPersonaLaunchDefinition(userId, "missing")).toBe(true);
  });

  it("历史待办的默认处理人和实际完成人都保留实例查看权", () => {
    configurePublishedAccess("pdf-review", {});
    const instance = isolatedInstance();
    const sourceTask = prototypeModule.usePrototypeStore.getState().tasks[0];
    const task = {
      ...structuredClone(sourceTask),
      id: "task-access-history",
      instanceId: instance.id,
      defaultAssigneeId: "hejing",
      completedById: undefined,
    } satisfies WorkflowTask;
    prototypeModule.usePrototypeStore.setState((state) => ({ tasks: [...state.tasks, task] }));

    expect(workflowAccessModule.canUserViewInstance("hejing", instance)).toBe(true);
    prototypeModule.usePrototypeStore.setState((state) => ({
      tasks: state.tasks.map((item) => item.id === task.id
        ? { ...item, defaultAssigneeId: undefined, completedById: "hejing" }
        : item),
    }));
    expect(workflowAccessModule.canUserViewInstance("hejing", instance)).toBe(true);
  });

  it("流程定义可见性复用实例权限，并覆盖显式范围与流程组范围", () => {
    const definitionId = "supplier-change-review";
    configurePublishedAccess(definitionId, {});
    prototypeModule.usePrototypeStore.setState((state) => ({
      instances: state.instances.filter((instance) => instance.definitionId !== definitionId),
    }));

    expect(workflowAccessModule.canUserViewDefinition("hejing", definitionId)).toBe(false);
    expect(workflowAccessModule.canUserViewDefinition("superadmin", definitionId)).toBe(true);
    expect(workflowAccessModule.canUserViewDefinition("hejing", "missing-definition")).toBe(false);

    configurePublishedAccess(definitionId, { visibleUsers: ["hejing"] });
    expect(workflowAccessModule.canUserViewDefinition("hejing", definitionId)).toBe(true);
    configurePublishedAccess(definitionId, { visibleRoles: ["ROLE-007"] });
    expect(workflowAccessModule.canUserViewDefinition("hejing", definitionId)).toBe(true);
    configurePublishedAccess(definitionId, { starterGroups: ["PDF审核_文控_流程权限组"] });
    expect(workflowAccessModule.canUserViewDefinition("wangmin", definitionId)).toBe(true);
    configurePublishedAccess(definitionId, { assigneeGroups: ["PDF审核_研发_流程权限组"] });
    expect(workflowAccessModule.canUserViewDefinition("zhangwei", definitionId)).toBe(true);
    configurePublishedAccess(definitionId, { closeGroups: ["PDF审核_文控_流程权限组"] });
    expect(workflowAccessModule.canUserViewDefinition("wangmin", definitionId)).toBe(true);
    configurePublishedAccess(definitionId, { approvalGroups: ["PDF审核_质量_流程权限组"] });
    expect(workflowAccessModule.canUserViewDefinition("lina", definitionId)).toBe(true);

    configurePublishedAccess(definitionId, {});
    const instance = isolatedInstance(definitionId);
    prototypeModule.usePrototypeStore.setState((state) => ({
      instances: [...state.instances, { ...instance, initiatorId: "hejing" }],
    }));
    expect(workflowAccessModule.canUserViewDefinition("hejing", definitionId)).toBe(true);
  });

  it("任务处理要求动作权限和流程组成员资格，关闭规则优先尊重驳回策略", () => {
    const task = prototypeModule.usePrototypeStore.getState().tasks
      .find((item) => item.permissionGroupId === "PDF审核_研发_流程权限组")!;
    expect(workflowAccessModule.canUserProcessTask("hejing", task)).toBe(false);
    expect(workflowAccessModule.canUserProcessTask("superadmin", task)).toBe(true);
    expect(workflowAccessModule.canUserProcessTask("zhangwei", task)).toBe(true);
    expect(workflowAccessModule.canUserProcessTask("lina", task)).toBe(false);

    const instance = isolatedInstance();
    configurePublishedAccess("pdf-review", { closeGroups: ["PDF审核_文控_流程权限组"] });
    expect(workflowAccessModule.canUserCloseInstance("wangmin", instance)).toBe(true);
    expect(workflowAccessModule.canUserCloseInstance("lina", instance)).toBe(false);
    expect(workflowAccessModule.canUserCloseInstance("superadmin", instance)).toBe(true);

    setRolePermissionOverrides({
      "ROLE-003": permissionModule.defaultRolePermissionMap["ROLE-003"].filter((permission) => permission !== "work-task:关闭"),
    });
    expect(workflowAccessModule.canUserCloseInstance("wangmin", instance)).toBe(false);
    expect(workflowAccessModule.canUserCloseInstance("superadmin", instance)).toBe(true);

    configurePublishedAccess("pdf-review", {
      closeGroups: ["PDF审核_文控_流程权限组"],
      rejectionHandling: "resubmit-only",
    });
    expect(workflowAccessModule.canUserCloseInstance("superadmin", { ...instance, status: "驳回待处理" })).toBe(false);
  });
});
