import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EnableStatus = "启用" | "停用";
export type AuthenticationMode = "domain" | "password";
export type WorkflowGroupPurpose = "发起" | "审批/受理" | "关闭";

export interface DomainUser {
  id: string;
  account: string;
  email: string;
  name: string;
  password: string;
  authenticationMode: AuthenticationMode;
  department: string[];
  departmentPath: string;
  jobTitle: string;
  roles: string[];
  roleIds?: string[];
  status: EnableStatus;
  lastLogin: string;
  builtIn?: boolean;
}

const companyEmail = (account: string) => `${account.trim().toLowerCase()}@company.local`;

export interface DomainRole {
  id: string;
  name: string;
  code: string;
  description: string;
  pagePermissions: number;
  actionPermissions: number;
  users: number;
  status: EnableStatus;
  members: string[];
  memberUserIds?: string[];
  builtIn?: boolean;
}

export interface WorkflowPermissionGroup {
  id: string;
  code: string;
  name: string;
  processes: string[];
  purposes: WorkflowGroupPurpose[];
  directMembers: string[];
  linkedRoles: string[];
  directMemberUserIds?: string[];
  linkedRoleIds?: string[];
  status: EnableStatus;
  referenced: boolean;
  openTasks: number;
  effectiveMemberCount?: number;
  updatedAt: string;
}

type CollectionUpdater<T> = T[] | ((current: T[]) => T[]);

interface IdentityState {
  users: DomainUser[];
  roles: DomainRole[];
  workflowGroups: WorkflowPermissionGroup[];
  setUsers: (updater: CollectionUpdater<DomainUser>) => void;
  setRoles: (updater: CollectionUpdater<DomainRole>) => void;
  setWorkflowGroups: (updater: CollectionUpdater<WorkflowPermissionGroup>) => void;
  resetIdentity: () => void;
}

const roleSeed: DomainRole[] = [
  { id: "ROLE-SUPER", name: "超级管理员", code: "super_admin", description: "系统内置最高权限角色", pagePermissions: 11, actionPermissions: 33, users: 1, status: "启用", members: [], builtIn: true },
  { id: "ROLE-001", name: "系统管理员", code: "system_admin", description: "维护用户、角色、权限及系统参数", pagePermissions: 11, actionPermissions: 33, users: 1, status: "启用", members: ["周杰"] },
  { id: "ROLE-002", name: "流程管理员", code: "workflow_admin", description: "创建、配置、发布和停用流程", pagePermissions: 5, actionPermissions: 10, users: 2, status: "启用", members: ["周杰", "王敏"] },
  { id: "ROLE-003", name: "文控专员", code: "document_controller", description: "发起流程、处理文控节点、重新提交与关闭受控流程", pagePermissions: 3, actionPermissions: 8, users: 2, status: "启用", members: ["王敏", "刘芳"] },
  { id: "ROLE-004", name: "研发审核员", code: "rd_reviewer", description: "研发审核页面和动作权限", pagePermissions: 2, actionPermissions: 3, users: 2, status: "启用", members: ["张伟", "陈晨"] },
  { id: "ROLE-005", name: "质量审核员", code: "quality_reviewer", description: "质量审核页面和动作权限", pagePermissions: 2, actionPermissions: 3, users: 1, status: "启用", members: ["林晓"] },
  { id: "ROLE-006", name: "生产审核员", code: "production_reviewer", description: "生产审核页面和动作权限", pagePermissions: 2, actionPermissions: 3, users: 2, status: "启用", members: ["赵磊", "孙悦"] },
  { id: "ROLE-007", name: "只读观察员", code: "readonly_observer", description: "查看被授权流程，无处理权限", pagePermissions: 1, actionPermissions: 1, users: 1, status: "启用", members: ["何静"] },
];

const primaryUsers: DomainUser[] = [
  { id: "superadmin", account: "superadmin", email: "", name: "超级管理员", password: "1", authenticationMode: "password", department: [], departmentPath: "", jobTitle: "", roles: ["超级管理员"], status: "启用", lastLogin: "从未登录", builtIn: true },
  { id: "admin", account: "admin", email: companyEmail("admin"), name: "周杰", password: "1", authenticationMode: "domain", department: ["document"], departmentPath: "文控", jobTitle: "经理", roles: ["系统管理员", "流程管理员"], status: "启用", lastLogin: "2026-08-13 09:18" },
  { id: "wangmin", account: "wangmin", email: companyEmail("wangmin"), name: "王敏", password: "1", authenticationMode: "domain", department: ["document"], departmentPath: "文控", jobTitle: "员工", roles: ["文控专员", "流程管理员"], status: "启用", lastLogin: "2026-08-13 10:32" },
  { id: "zhangwei", account: "zhangwei", email: companyEmail("zhangwei"), name: "张伟", password: "1", authenticationMode: "domain", department: ["rd", "rd-software"], departmentPath: "研发 / 软件", jobTitle: "员工", roles: ["研发审核员"], status: "启用", lastLogin: "2026-08-13 09:26" },
  { id: "lina", account: "lina", email: companyEmail("lina"), name: "林晓", password: "1", authenticationMode: "domain", department: ["quality", "quality-system"], departmentPath: "质量 / 体系", jobTitle: "员工", roles: ["质量审核员"], status: "启用", lastLogin: "2026-08-13 08:46" },
  { id: "zhaolei", account: "zhaolei", email: companyEmail("zhaolei"), name: "赵磊", password: "1", authenticationMode: "domain", department: ["production", "production-line1"], departmentPath: "生产 / 一车间", jobTitle: "员工", roles: ["生产审核员"], status: "启用", lastLogin: "2026-08-12 16:21" },
  { id: "hejing", account: "hejing", email: companyEmail("hejing"), name: "何静", password: "1", authenticationMode: "domain", department: ["quality"], departmentPath: "质量", jobTitle: "员工", roles: ["只读观察员"], status: "启用", lastLogin: "2026-08-12 15:04" },
  { id: "chenchen", account: "chenchen", email: companyEmail("chenchen"), name: "陈晨", password: "1", authenticationMode: "domain", department: ["rd", "rd-hardware"], departmentPath: "研发 / 硬件", jobTitle: "员工", roles: ["研发审核员"], status: "启用", lastLogin: "2026-08-12 13:20" },
  { id: "liufang", account: "liufang", email: companyEmail("liufang"), name: "刘芳", password: "1", authenticationMode: "domain", department: ["document"], departmentPath: "文控", jobTitle: "员工", roles: ["文控专员"], status: "启用", lastLogin: "2026-08-11 14:05" },
  { id: "sunyue", account: "sunyue", email: companyEmail("sunyue"), name: "孙悦", password: "1", authenticationMode: "domain", department: ["production", "production-line2"], departmentPath: "生产 / 二车间", jobTitle: "员工", roles: ["生产审核员"], status: "启用", lastLogin: "2026-08-11 11:28" },
];

const departments = [
  { value: ["rd", "rd-software"], path: "研发 / 软件" },
  { value: ["rd", "rd-hardware"], path: "研发 / 硬件" },
  { value: ["rd", "rd-test"], path: "研发 / 测试" },
  { value: ["quality", "quality-system"], path: "质量 / 体系" },
  { value: ["quality", "quality-iqc"], path: "质量 / 来料检验" },
  { value: ["production", "production-line1"], path: "生产 / 一车间" },
  { value: ["production", "production-line2"], path: "生产 / 二车间" },
];

const generatedUsers: DomainUser[] = Array.from({ length: 228 }, (_, index) => {
  const number = index + 11;
  const account = `user${String(number).padStart(3, "0")}`;
  const department = departments[index % departments.length];
  const role = index % 5 === 0 ? "质量审核员" : index % 3 === 0 ? "研发审核员" : index % 7 === 0 ? "生产审核员" : "只读观察员";
  return {
    id: `USR-${String(number).padStart(4, "0")}`,
    account,
    email: companyEmail(account),
    name: `演示员工${String(number).padStart(3, "0")}`,
    password: "1",
    authenticationMode: "domain",
    department: department.value,
    departmentPath: department.path,
    jobTitle: index % 23 === 0 ? "经理" : "员工",
    roles: [role],
    status: index % 31 === 0 ? "停用" : "启用",
    lastLogin: index % 9 === 0 ? "从未登录" : "2026-08-10 09:26",
  };
});

const userSeed = [...primaryUsers, ...generatedUsers];

const groupSeed: WorkflowPermissionGroup[] = [
  { id: "PDF审核_文控_流程权限组", code: "PG-0001", name: "PDF审核_文控_流程权限组", processes: ["PDF 文件审核"], purposes: ["发起", "关闭"], directMembers: ["王敏", "刘芳"], linkedRoles: ["文控专员"], status: "启用", referenced: true, openTasks: 7, updatedAt: "2026-08-13 10:32" },
  { id: "PDF审核_研发_流程权限组", code: "PG-0002", name: "PDF审核_研发_流程权限组", processes: ["PDF 文件审核"], purposes: ["审批/受理"], directMembers: ["张伟", "陈晨"], linkedRoles: ["研发审核员"], status: "启用", referenced: true, openTasks: 12, updatedAt: "2026-08-13 09:18" },
  { id: "PDF审核_质量_流程权限组", code: "PG-0003", name: "PDF审核_质量_流程权限组", processes: ["PDF 文件审核"], purposes: ["审批/受理"], directMembers: ["林晓"], linkedRoles: ["质量审核员"], status: "启用", referenced: true, openTasks: 9, updatedAt: "2026-08-12 17:45" },
  { id: "PDF审核_生产_流程权限组", code: "PG-0004", name: "PDF审核_生产_流程权限组", processes: ["PDF 文件审核"], purposes: ["审批/受理"], directMembers: ["赵磊", "孙悦"], linkedRoles: ["生产审核员"], status: "启用", referenced: true, openTasks: 9, updatedAt: "2026-08-12 16:21" },
  { id: "测试报告_发起_流程权限组", code: "PG-0005", name: "测试报告_发起_流程权限组", processes: ["测试报告审核"], purposes: ["发起", "关闭"], directMembers: ["王敏"], linkedRoles: ["文控专员"], status: "启用", referenced: true, openTasks: 3, updatedAt: "2026-08-11 14:05" },
  { id: "测试报告_研发_流程权限组", code: "PG-0006", name: "测试报告_研发_流程权限组", processes: ["测试报告审核"], purposes: ["审批/受理"], directMembers: ["张伟"], linkedRoles: ["研发审核员"], status: "启用", referenced: true, openTasks: 2, updatedAt: "2026-08-11 13:05" },
  { id: "测试报告_质量_流程权限组", code: "PG-0007", name: "测试报告_质量_流程权限组", processes: ["测试报告审核"], purposes: ["审批/受理"], directMembers: ["林晓"], linkedRoles: ["质量审核员"], status: "启用", referenced: true, openTasks: 2, updatedAt: "2026-08-11 13:05" },
  { id: "测试报告_生产_流程权限组", code: "PG-0008", name: "测试报告_生产_流程权限组", processes: ["测试报告审核"], purposes: ["审批/受理"], directMembers: ["赵磊"], linkedRoles: ["生产审核员"], status: "启用", referenced: true, openTasks: 2, updatedAt: "2026-08-11 13:05" },
  { id: "自由协作_发起_流程权限组", code: "PG-0009", name: "自由协作_发起_流程权限组", processes: ["自由协作事项流程"], purposes: ["发起", "关闭"], directMembers: ["王敏", "周杰"], linkedRoles: ["文控专员"], status: "启用", referenced: true, openTasks: 4, updatedAt: "2026-08-10 11:28" },
  { id: "自由协作_受理_流程权限组", code: "PG-0010", name: "自由协作_受理_流程权限组", processes: ["自由协作事项流程"], purposes: ["审批/受理"], directMembers: ["张伟", "林晓", "赵磊", "孙悦"], linkedRoles: [], status: "启用", referenced: true, openTasks: 6, updatedAt: "2026-08-10 11:28" },
  { id: "供应商变更_发起_流程权限组", code: "PG-0011", name: "供应商变更_发起_流程权限组", processes: ["供应商变更会签"], purposes: ["发起", "关闭"], directMembers: ["王敏"], linkedRoles: ["文控专员"], status: "启用", referenced: true, openTasks: 0, updatedAt: "2026-08-09 09:18" },
  { id: "供应商变更_评审_流程权限组", code: "PG-0012", name: "供应商变更_评审_流程权限组", processes: ["供应商变更会签"], purposes: ["审批/受理"], directMembers: ["张伟", "林晓", "赵磊"], linkedRoles: [], status: "启用", referenced: true, openTasks: 0, updatedAt: "2026-08-09 09:18" },
  { id: "技术文件只读_流程权限组", code: "PG-0013", name: "技术文件只读_流程权限组", processes: [], purposes: ["审批/受理"], directMembers: ["何静"], linkedRoles: ["只读观察员"], status: "停用", referenced: false, openTasks: 0, updatedAt: "2026-08-08 09:18" },
];

const normalizeWorkflowGroupPurposes = (values: unknown): WorkflowGroupPurpose[] => {
  const source = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  const normalized = source.flatMap((value): WorkflowGroupPurpose[] => {
    if (value === "发起" || value === "关闭" || value === "审批/受理") return [value];
    if (value === "审批" || value === "自由流程受理") return ["审批/受理"];
    return [];
  });
  if (source.includes("发起") && !source.includes("关闭")) normalized.push("关闭");
  return [...new Set(normalized)];
};

const applyUpdater = <T,>(current: T[], updater: CollectionUpdater<T>) =>
  typeof updater === "function" ? updater(current) : updater;

const syncUsersFromRoles = (users: DomainUser[], previous: DomainRole[], next: DomainRole[]) => {
  const roleNames = new Set([...previous, ...next].filter((role) => !role.builtIn).map((role) => role.name));
  return users.map((user) => {
    if (user.builtIn) return user;
    const retained = user.roles.filter((role) => !roleNames.has(role));
    const assigned = next.filter((role) => role.members.includes(user.name)).map((role) => role.name);
    return { ...user, roles: [...new Set([...retained, ...assigned])] };
  });
};

const canonicalizeIdentityRelations = (
  users: DomainUser[],
  roles: DomainRole[],
  workflowGroups: WorkflowPermissionGroup[],
) => {
  const usersWithRoleIds = users.map((user) => ({
    ...user,
    ...(user.builtIn ? { email: "", department: [], departmentPath: "", jobTitle: "" } : {}),
    authenticationMode: user.builtIn ? "password" as const : user.authenticationMode ?? "domain",
    roleIds: user.roleIds ?? roles.filter((role) => user.roles.includes(role.name)).map((role) => role.id),
  }));
  const rolesWithMemberIds = roles.map((role) => ({
    ...role,
    memberUserIds: role.memberUserIds ?? usersWithRoleIds
      .filter((user) => role.members.includes(user.name) || user.roleIds?.includes(role.id))
      .map((user) => user.id),
  }));
  const normalizedUsers = usersWithRoleIds.map((user) => ({
    ...user,
    roles: rolesWithMemberIds.filter((role) => role.memberUserIds?.includes(user.id)).map((role) => role.name),
    roleIds: rolesWithMemberIds.filter((role) => role.memberUserIds?.includes(user.id)).map((role) => role.id),
  }));
  const normalizedRoles = rolesWithMemberIds.map((role) => ({
    ...role,
    members: normalizedUsers.filter((user) => role.memberUserIds?.includes(user.id)).map((user) => user.name),
    users: normalizedUsers.filter((user) => role.memberUserIds?.includes(user.id)).length,
  }));
  const normalizedGroups = workflowGroups.map((group) => {
    const directMemberUserIds = group.directMemberUserIds
      ?? normalizedUsers.filter((user) => group.directMembers.includes(user.name)).map((user) => user.id);
    const linkedRoleIds = group.linkedRoleIds
      ?? normalizedRoles.filter((role) => group.linkedRoles.includes(role.name)).map((role) => role.id);
    return {
      ...group,
      directMemberUserIds,
      linkedRoleIds,
      directMembers: normalizedUsers.filter((user) => directMemberUserIds.includes(user.id)).map((user) => user.name),
      linkedRoles: normalizedRoles.filter((role) => linkedRoleIds.includes(role.id)).map((role) => role.name),
    };
  });
  return { users: normalizedUsers, roles: normalizedRoles, workflowGroups: normalizedGroups };
};

const repairPersistedIdentityRelations = (
  users: DomainUser[],
  roles: DomainRole[],
  workflowGroups: WorkflowPermissionGroup[],
) => {
  const roleIds = new Set(roles.map((role) => role.id));
  const userIds = new Set(users.map((user) => user.id));
  const roleIdByName = new Map(roles.map((role) => [role.name, role.id]));
  const userIdByName = new Map(users.map((user) => [user.name, user.id]));

  const repairedUsers = users.map((user) => ({
    ...user,
    roleIds: [...new Set([
      ...(user.roleIds ?? []).filter((roleId) => roleIds.has(roleId)),
      ...user.roles.flatMap((roleName) => {
        const roleId = roleIdByName.get(roleName);
        return roleId ? [roleId] : [];
      }),
    ])],
  }));

  const repairedRoles = roles.map((role) => ({
    ...role,
    memberUserIds: [...new Set([
      ...(role.memberUserIds ?? []).filter((userId) => userIds.has(userId)),
      ...role.members.flatMap((userName) => {
        const userId = userIdByName.get(userName);
        return userId ? [userId] : [];
      }),
      ...repairedUsers.filter((user) => user.roleIds.includes(role.id)).map((user) => user.id),
    ])],
  }));

  const repairedGroups = workflowGroups.map((group) => ({
    ...group,
    directMemberUserIds: [...new Set([
      ...(group.directMemberUserIds ?? []).filter((userId) => userIds.has(userId)),
      ...group.directMembers.flatMap((userName) => {
        const userId = userIdByName.get(userName);
        return userId ? [userId] : [];
      }),
    ])],
    linkedRoleIds: [...new Set([
      ...(group.linkedRoleIds ?? []).filter((roleId) => roleIds.has(roleId)),
      ...group.linkedRoles.flatMap((roleName) => {
        const roleId = roleIdByName.get(roleName);
        return roleId ? [roleId] : [];
      }),
    ])],
  }));

  return canonicalizeIdentityRelations(repairedUsers, repairedRoles, repairedGroups);
};

const initialIdentity = canonicalizeIdentityRelations(userSeed, roleSeed, groupSeed);

export const useIdentityStore = create<IdentityState>()(
  persist(
    (set) => ({
      users: initialIdentity.users,
      roles: initialIdentity.roles,
      workflowGroups: initialIdentity.workflowGroups,
      setUsers: (updater) => set((state) => {
        const users = applyUpdater(state.users, updater).map((user) => ({
          ...user,
          roleIds: state.roles.filter((role) => user.roles.includes(role.name)).map((role) => role.id),
        }));
        const roles = state.roles.map((role) => ({
          ...role,
          memberUserIds: users.filter((user) => user.roleIds?.includes(role.id)).map((user) => user.id),
        }));
        return canonicalizeIdentityRelations(users, roles, state.workflowGroups);
      }),
      setRoles: (updater) => set((state) => {
        const roles = applyUpdater(state.roles, updater).map((role) => ({
          ...role,
          memberUserIds: role.memberUserIds ?? state.users.filter((user) => role.members.includes(user.name)).map((user) => user.id),
        }));
        const users = syncUsersFromRoles(state.users, state.roles, roles).map((user) => ({
          ...user,
          roleIds: roles.filter((role) => role.memberUserIds?.includes(user.id)).map((role) => role.id),
        }));
        return canonicalizeIdentityRelations(users, roles, state.workflowGroups);
      }),
      setWorkflowGroups: (updater) => set((state) => canonicalizeIdentityRelations(
        state.users,
        state.roles,
        applyUpdater(state.workflowGroups, updater),
      )),
      resetIdentity: () => set(initialIdentity),
    }),
    {
      name: "flowpilot-identity-domain-v1",
      version: 7,
      migrate: (persisted) => {
        const state = persisted as Partial<IdentityState>;
        return repairPersistedIdentityRelations(
          Array.isArray(state.users) ? state.users.map((user) => ({
            ...user,
            email: user.builtIn ? "" : user.email?.trim() || companyEmail(user.account),
            password: user.password || "1",
            authenticationMode: user.builtIn ? "password" : user.authenticationMode ?? "domain",
            roles: [...(user.roles ?? [])],
          })) : userSeed,
          Array.isArray(state.roles) ? state.roles : roleSeed,
          Array.isArray(state.workflowGroups) ? state.workflowGroups.map((group) => ({
            ...group,
            purposes: normalizeWorkflowGroupPurposes(group.purposes),
          })) : groupSeed,
        );
      },
    },
  ),
);

export const findIdentityUser = (userId: string) =>
  useIdentityStore.getState().users.find((user) => user.id === userId);

export const authenticateLocalAccount = (account: string, password: string) => {
  const normalized = account.trim().toLowerCase();
  const user = useIdentityStore.getState().users.find((item) => item.account.toLowerCase() === normalized);
  if (!user || user.password !== password) return { ok: false as const, reason: "账号或密码错误" };
  if (user.status !== "启用") return { ok: false as const, reason: "该账号已停用，请联系管理员" };
  return { ok: true as const, user };
};

export const effectiveGroupMemberIds = (groupIdOrName: string) => {
  const { users, roles, workflowGroups } = useIdentityStore.getState();
  const group = workflowGroups.find((item) => item.id === groupIdOrName || item.name === groupIdOrName);
  if (!group) return [];
  // 停用仅阻止权限组被新流程引用；既有发布版本和运行实例仍需解析当前有效成员。
  const enabledLinkedRoleIds = new Set(
    roles.filter((role) => role.status === "启用" && group.linkedRoleIds?.includes(role.id)).map((role) => role.id),
  );
  return users
    .filter((user) => !user.builtIn && user.status === "启用")
    .filter((user) => group.directMemberUserIds?.includes(user.id)
      || user.roleIds?.some((roleId) => enabledLinkedRoleIds.has(roleId)))
    .map((user) => user.id);
};

export const isUserInWorkflowGroup = (userId: string, groupIdOrName: string) =>
  effectiveGroupMemberIds(groupIdOrName).includes(userId);

export const workflowGroupLabel = (groupIdOrName: string) =>
  useIdentityStore.getState().workflowGroups.find((group) => group.id === groupIdOrName || group.name === groupIdOrName)?.name
  ?? "未识别流程权限组";

export const resolveWorkflowGroupLabel = (
  groups: WorkflowPermissionGroup[],
  groupIdOrName: string,
) => groups.find((group) => group.id === groupIdOrName || group.name === groupIdOrName)?.name
  ?? "未识别流程权限组";

export const resolveWorkflowGroupLabels = (
  groups: WorkflowPermissionGroup[],
  groupIdsOrNames: string[],
) => groupIdsOrNames.map((group) => resolveWorkflowGroupLabel(groups, group));

export const workflowPermissionGroupOptions = (purpose?: WorkflowGroupPurpose) =>
  useIdentityStore.getState().workflowGroups
    .filter((group) => group.status === "启用" && (!purpose || group.purposes.includes(purpose)))
    .map((group) => ({ value: group.id, label: group.name }));
