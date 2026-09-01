import { create } from "zustand";

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

const applyUpdater = <T,>(current: T[], updater: CollectionUpdater<T>) =>
  typeof updater === "function" ? updater(current) : updater;

const synchronizeRelations = (
  users: DomainUser[],
  roles: DomainRole[],
  workflowGroups: WorkflowPermissionGroup[],
) => {
  const normalizedUsers = users.map((user) => ({
    ...user,
    ...(user.builtIn ? { email: "", department: [], departmentPath: "", jobTitle: "" } : {}),
    roleIds: user.roleIds ?? roles.filter((role) => user.roles.includes(role.name)).map((role) => role.id),
  }));
  const normalizedRoles = roles.map((role) => {
    const memberUserIds = role.memberUserIds
      ?? normalizedUsers.filter((user) => user.roleIds?.includes(role.id)).map((user) => user.id);
    return {
      ...role,
      memberUserIds,
      members: normalizedUsers.filter((user) => memberUserIds.includes(user.id)).map((user) => user.name),
      users: memberUserIds.length,
    };
  });
  const usersWithRoleNames = normalizedUsers.map((user) => ({
    ...user,
    roles: normalizedRoles.filter((role) => role.memberUserIds?.includes(user.id)).map((role) => role.name),
  }));
  const normalizedGroups = workflowGroups.map((group) => {
    const directMemberUserIds = group.directMemberUserIds ?? [];
    const linkedRoleIds = group.linkedRoleIds ?? [];
    return {
      ...group,
      directMemberUserIds,
      linkedRoleIds,
      directMembers: usersWithRoleNames.filter((user) => directMemberUserIds.includes(user.id)).map((user) => user.name),
      linkedRoles: normalizedRoles.filter((role) => linkedRoleIds.includes(role.id)).map((role) => role.name),
    };
  });
  return { users: usersWithRoleNames, roles: normalizedRoles, workflowGroups: normalizedGroups };
};

export const useIdentityStore = create<IdentityState>()((set) => ({
  users: [],
  roles: [],
  workflowGroups: [],
  setUsers: (updater) => set((state) => synchronizeRelations(
    applyUpdater(state.users, updater), state.roles, state.workflowGroups,
  )),
  setRoles: (updater) => set((state) => synchronizeRelations(
    state.users, applyUpdater(state.roles, updater), state.workflowGroups,
  )),
  setWorkflowGroups: (updater) => set((state) => synchronizeRelations(
    state.users, state.roles, applyUpdater(state.workflowGroups, updater),
  )),
  resetIdentity: () => set({ users: [], roles: [], workflowGroups: [] }),
}));

export const findIdentityUser = (userId: string) =>
  useIdentityStore.getState().users.find((user) => user.id === userId);

export const effectiveGroupMemberIds = (groupIdOrName: string) => {
  const { users, roles, workflowGroups } = useIdentityStore.getState();
  const group = workflowGroups.find((item) => item.id === groupIdOrName || item.name === groupIdOrName);
  if (!group) return [];
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

export const resolveWorkflowGroupLabel = (groups: WorkflowPermissionGroup[], groupIdOrName: string) =>
  groups.find((group) => group.id === groupIdOrName || group.name === groupIdOrName)?.name ?? "未识别流程权限组";

export const resolveWorkflowGroupLabels = (groups: WorkflowPermissionGroup[], groupIdsOrNames: string[]) =>
  groupIdsOrNames.map((group) => resolveWorkflowGroupLabel(groups, group));

export const workflowPermissionGroupOptions = (purpose?: WorkflowGroupPurpose) =>
  useIdentityStore.getState().workflowGroups
    .filter((group) => group.status === "启用" && (!purpose || group.purposes.includes(purpose)))
    .map((group) => ({ value: group.id, label: group.name }));
