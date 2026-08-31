import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installMemoryBrowserStorage, type MemoryStorage } from "../test/memoryStorage";

let storage: MemoryStorage;
let identityModule: typeof import("./useIdentityStore");
let definitionModule: typeof import("./useProcessDefinitionStore");
let prototypeModule: typeof import("./usePrototypeStore");
let permissionModule: typeof import("./permissionEngine");
let clientModule: typeof import("../api/client");
let runtimeModule: typeof import("../mocks/runtime");
let organizationModule: typeof import("./useOrganizationStore");

beforeAll(async () => {
  ({ localStorage: storage } = installMemoryBrowserStorage());
  identityModule = await import("./useIdentityStore");
  definitionModule = await import("./useProcessDefinitionStore");
  prototypeModule = await import("./usePrototypeStore");
  permissionModule = await import("./permissionEngine");
  clientModule = await import("../api/client");
  runtimeModule = await import("../mocks/runtime");
  organizationModule = await import("./useOrganizationStore");
});

beforeEach(() => {
  storage.clear();
  identityModule.useIdentityStore.getState().resetIdentity();
  organizationModule.useOrganizationStore.getState().resetOrganization();
  definitionModule.useProcessDefinitionStore.getState().resetDefinitions();
  prototypeModule.usePrototypeStore.getState().resetDemo();
});

describe("演示领域数据完整性", () => {
  it("远端返回二级部门叶子标识时恢复完整级联路径", () => {
    const departments = organizationModule.useOrganizationStore.getState().departments;

    expect(organizationModule.departmentCascaderValue(["rd-software"], departments))
      .toEqual(["rd", "rd-software"]);
    expect(organizationModule.departmentCascaderValue(["quality"], departments))
      .toEqual(["quality"]);
  });

  it("定义、版本、实例、待办和用户之间不存在悬空引用或重复标识", () => {
    const { users, workflowGroups } = identityModule.useIdentityStore.getState();
    const definitions = definitionModule.useProcessDefinitionStore.getState().definitions;
    const { instances, tasks } = prototypeModule.usePrototypeStore.getState();
    const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
    const instanceById = new Map(instances.map((instance) => [instance.id, instance]));
    const userIds = new Set(users.map((user) => user.id));
    const departmentIds = new Set(organizationModule.useOrganizationStore.getState().departments.map((department) => department.key));
    const groupIds = new Set(workflowGroups.flatMap((group) => [group.id, group.name]));

    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(definitions.length);
    expect(new Set(definitions.map((definition) => definition.code)).size).toBe(definitions.length);
    expect(new Set(definitions.flatMap((definition) => definition.versions.map((version) => version.id))).size)
      .toBe(definitions.reduce((total, definition) => total + definition.versions.length, 0));
    expect(new Set(instances.map((instance) => instance.id)).size).toBe(instances.length);
    expect(new Set(instances.map((instance) => instance.code)).size).toBe(instances.length);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);

    users.filter((user) => !user.builtIn).forEach((user) => {
      user.department.forEach((departmentId) => {
        expect(departmentIds.has(departmentId), `用户 ${user.id} 引用的部门 ${departmentId} 应存在`).toBe(true);
      });
    });

    instances.forEach((instance) => {
      const definition = definitionById.get(instance.definitionId);
      const version = definition?.versions.find((item) => item.id === instance.versionId);
      expect(definition, `实例 ${instance.id} 引用的定义应存在`).toBeDefined();
      expect(version, `实例 ${instance.id} 引用的版本应存在`).toBeDefined();
      expect(instance.template).toBe(version?.basic.name);
      expect(instance.template.trim()).not.toBe("");
      expect(instance.templateVersion.toUpperCase()).toBe(version?.version.toUpperCase());
      expect(
        userIds.has(instance.initiatorId) || instance.initiatorId.startsWith("legacy-user:"),
        `实例 ${instance.id} 的发起人应为当前用户或已标记的历史用户`,
      ).toBe(true);
      if (instance.currentAssigneeId) expect(userIds.has(instance.currentAssigneeId)).toBe(true);
      instance.participantIds?.forEach((userId) => expect(userIds.has(userId)).toBe(true));
    });

    tasks.forEach((task) => {
      const instance = instanceById.get(task.instanceId);
      const definition = definitionById.get(task.definitionId);
      const version = definition?.versions.find((item) => item.id === task.versionId);
      expect(instance, `待办 ${task.id} 引用的实例应存在`).toBeDefined();
      expect(task.definitionId).toBe(instance?.definitionId);
      expect(task.versionId).toBe(instance?.versionId);
      expect(version?.snapshot.flow.nodes.some((node) => node.id === task.nodeId), `待办 ${task.id} 的流程节点应存在`).toBe(true);
      expect(groupIds.has(task.permissionGroupId), `待办 ${task.id} 的权限组应存在`).toBe(true);
      if (task.defaultAssigneeId) expect(userIds.has(task.defaultAssigneeId)).toBe(true);
      if (task.completedById) expect(userIds.has(task.completedById)).toBe(true);
      expect(task.round).toBeGreaterThanOrEqual(1);
      expect(task.round).toBeLessThanOrEqual(instance?.round ?? 0);
    });
  });

  it("用户、角色和流程权限组的双向成员关系保持一致", () => {
    const { users, roles, workflowGroups } = identityModule.useIdentityStore.getState();
    const userById = new Map(users.map((user) => [user.id, user]));
    const roleById = new Map(roles.map((role) => [role.id, role]));

    users.forEach((user) => {
      expect(user.roleIds?.map((roleId) => roleById.get(roleId)?.name)).toEqual(user.roles);
      user.roleIds?.forEach((roleId) => expect(roleById.get(roleId)?.memberUserIds).toContain(user.id));
    });
    roles.forEach((role) => {
      expect(role.memberUserIds?.map((userId) => userById.get(userId)?.name)).toEqual(role.members);
      expect(role.users).toBe(role.memberUserIds?.length ?? 0);
      role.memberUserIds?.forEach((userId) => expect(userById.get(userId)?.roleIds).toContain(role.id));
    });
    workflowGroups.forEach((group) => {
      expect(group.directMemberUserIds?.map((userId) => userById.get(userId)?.name)).toEqual(group.directMembers);
      expect(group.linkedRoleIds?.map((roleId) => roleById.get(roleId)?.name)).toEqual(group.linkedRoles);
    });
  });
});

describe("身份、权限和持久化边界", () => {
  it("流程权限组的动态成员随角色成员变化，并排除停用用户", () => {
    const roleId = "ROLE-004";
    const groupId = "PDF审核_研发_流程权限组";
    expect(identityModule.isUserInWorkflowGroup("hejing", groupId)).toBe(false);

    identityModule.useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === roleId
      ? { ...role, memberUserIds: [...(role.memberUserIds ?? []), "hejing"] }
      : role));
    expect(identityModule.isUserInWorkflowGroup("hejing", groupId)).toBe(true);

    identityModule.useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === roleId
      ? { ...role, status: "停用" }
      : role));
    expect(identityModule.isUserInWorkflowGroup("hejing", groupId)).toBe(false);

    identityModule.useIdentityStore.getState().setRoles((roles) => roles.map((role) => role.id === roleId
      ? { ...role, status: "启用" }
      : role));
    identityModule.useIdentityStore.getState().setUsers((users) => users.map((user) => user.id === "hejing"
      ? { ...user, status: "停用" }
      : user));
    expect(identityModule.isUserInWorkflowGroup("hejing", groupId)).toBe(false);
  });

  it("停用权限组保留既有运行资格但不再进入新流程选项，超级管理员权限独立", () => {
    expect(identityModule.effectiveGroupMemberIds("技术文件只读_流程权限组").length).toBeGreaterThan(0);
    expect(identityModule.workflowPermissionGroupOptions().map((option) => option.value))
      .not.toContain("技术文件只读_流程权限组");
    expect(permissionModule.hasUserPermission("superadmin", "org-role:授权")).toBe(true);
    expect(permissionModule.hasUserPermission("missing-user", "work-list:查看")).toBe(false);
  });

  it("旧身份数据迁移补齐凭据、稳定标识并归一化权限组用途", async () => {
    const current = identityModule.useIdentityStore.getState();
    const users = structuredClone(current.users);
    const roles = structuredClone(current.roles);
    const workflowGroups = structuredClone(current.workflowGroups);
    const legacyUser = users.find((user) => user.id === "wangmin")!;
    Reflect.deleteProperty(legacyUser, "email");
    Reflect.deleteProperty(legacyUser, "password");
    Reflect.deleteProperty(legacyUser, "roleIds");
    roles.forEach((role) => Reflect.deleteProperty(role, "memberUserIds"));
    const legacyGroup = workflowGroups.find((group) => group.id === "PDF审核_文控_流程权限组")!;
    legacyGroup.purposes = ["发起", "审批" as typeof legacyGroup.purposes[number]];
    Reflect.deleteProperty(legacyGroup, "directMemberUserIds");
    Reflect.deleteProperty(legacyGroup, "linkedRoleIds");
    storage.setItem("flowpilot-identity-domain-v1", JSON.stringify({
      state: { users, roles, workflowGroups },
      version: 0,
    }));

    await identityModule.useIdentityStore.persist.rehydrate();

    const migrated = identityModule.useIdentityStore.getState();
    expect(migrated.users.find((user) => user.id === "wangmin")).toMatchObject({
      email: "wangmin@company.local",
      password: "1",
      authenticationMode: "domain",
      roleIds: ["ROLE-002", "ROLE-003"],
    });
    expect(migrated.workflowGroups.find((group) => group.id === legacyGroup.id)).toMatchObject({
      purposes: ["发起", "审批/受理", "关闭"],
      directMemberUserIds: expect.arrayContaining(["wangmin", "liufang"]),
      linkedRoleIds: ["ROLE-003"],
    });
  });

  it("旧身份数据中的空稳定标识不会清空普通用户角色和流程权限组", async () => {
    const current = identityModule.useIdentityStore.getState();
    storage.setItem("flowpilot-identity-domain-v1", JSON.stringify({
      state: {
        users: current.users.map((user) => ({ ...user, roleIds: [] })),
        roles: current.roles.map((role) => ({ ...role, memberUserIds: [] })),
        workflowGroups: current.workflowGroups.map((group) => ({
          ...group,
          directMemberUserIds: [],
          linkedRoleIds: [],
        })),
      },
      version: 4,
    }));

    await identityModule.useIdentityStore.persist.rehydrate();

    expect(identityModule.findIdentityUser("lina")).toMatchObject({
      roles: ["质量审核员"],
      roleIds: ["ROLE-005"],
    });
    expect(identityModule.isUserInWorkflowGroup("lina", "PDF审核_质量_流程权限组")).toBe(true);
    expect(permissionModule.hasUserPermission("lina", "work-task:查看")).toBe(true);
    expect(permissionModule.hasUserPermission("lina", "org-role:授权")).toBe(false);
  });

  it("旧组织数据自动补齐用户已经引用的生产车间", async () => {
    const current = organizationModule.useOrganizationStore.getState();
    storage.setItem("flowpilot-organization-domain-v1", JSON.stringify({
      state: {
        departments: current.departments.filter((department) =>
          !["production-line1", "production-line2"].includes(department.key)),
        jobTitles: current.jobTitles,
      },
      version: 1,
    }));

    await organizationModule.useOrganizationStore.persist.rehydrate();

    const productionChildren = organizationModule.useOrganizationStore.getState().departments
      .filter((department) => department.parentKey === "production");
    expect(productionChildren).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "production-line1", path: "生产 / 一车间" }),
      expect.objectContaining({ key: "production-line2", path: "生产 / 二车间" }),
    ]));
  });

  it("损坏的会话和权限 JSON 安全降级，重置只清理本应用的运行时键", () => {
    storage.setItem("flowpilot-prototype-v5", "{broken-json");
    storage.setItem(permissionModule.ROLE_PERMISSION_STORAGE_KEY, "not-json");
    storage.setItem("flowpilot-mock-api-settings-v1", "[");
    storage.setItem("flowpilot-form-designer-draft-v2-demo", "draft");
    storage.setItem("flowpilot-task-center-flow-v1:user", "filter");
    storage.setItem("unrelated-application-key", "keep");

    expect(permissionModule.currentSessionUserId()).toBe("");
    expect(clientModule.readApiAccessToken()).toBeUndefined();
    expect(permissionModule.readStoredRolePermissions()).toEqual(permissionModule.defaultRolePermissionMap);
    expect(runtimeModule.readMockApiSettings()).toMatchObject({ scenario: "normal" });

    runtimeModule.resetMockApiRuntime();
    expect(storage.getItem("flowpilot-form-designer-draft-v2-demo")).toBeNull();
    expect(storage.getItem("flowpilot-task-center-flow-v1:user")).toBeNull();
    expect(storage.getItem("unrelated-application-key")).toBe("keep");
  });
});
