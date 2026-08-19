import { findIdentityUser, useIdentityStore } from "./useIdentityStore";

export const ROLE_PERMISSION_STORAGE_KEY = "flowpilot-role-permissions-v1";
export const ROLE_PERMISSIONS_CHANGED_EVENT = "flowpilot-role-permissions-changed";

const editActionAliases = new Set(["新增", "新建", "编辑", "启停", "停用"]);

export function normalizeRolePermissionList(permissions: string[]) {
  return Array.from(new Set(permissions.map((permission) => {
    const separatorIndex = permission.lastIndexOf(":");
    if (separatorIndex < 0) return permission;
    const pageKey = permission.slice(0, separatorIndex);
    const action = permission.slice(separatorIndex + 1);
    return editActionAliases.has(action) ? `${pageKey}:编辑` : permission;
  })));
}

const allPermissions = [
  "work-launch:查看", "work-launch:发起",
  "work-task:查看", "work-task:审核", "work-task:驳回",
  "work-list:查看", "work-list:复制新建", "work-list:打印",
  "config-definition:查看", "config-definition:编辑", "config-definition:发布",
  "config-form:查看", "config-form:编辑", "config-form:预览",
  "org-user:查看", "org-user:编辑", "org-user:重置密码",
  "org-department:查看", "org-department:编辑",
  "org-role:查看", "org-role:编辑", "org-role:授权",
  "org-group:查看", "org-group:编辑",
  "system-monitor:查看", "system-monitor:导出",
  "system-audit:查看", "system-audit:导出",
];

const reviewerPermissions = ["work-task:查看", "work-task:审核", "work-task:驳回", "work-list:查看"];

export const defaultRolePermissionMap: Record<string, string[]> = {
  "ROLE-SUPER": allPermissions,
  "ROLE-001": allPermissions,
  "ROLE-002": ["work-task:查看", "work-list:查看", "work-list:打印", "config-definition:查看", "config-definition:编辑", "config-definition:发布", "config-form:查看", "config-form:编辑", "config-form:预览"],
  "ROLE-003": ["work-launch:查看", "work-launch:发起", "work-task:查看", "work-list:查看", "work-list:复制新建", "work-list:打印"],
  "ROLE-004": reviewerPermissions,
  "ROLE-005": reviewerPermissions,
  "ROLE-006": reviewerPermissions,
  "ROLE-007": ["work-list:查看"],
};

export function readStoredRolePermissions(): Record<string, string[]> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    return {
      ...defaultRolePermissionMap,
      ...Object.fromEntries(Object.entries(stored).map(([roleId, permissions]) => [roleId, normalizeRolePermissionList(permissions)])),
      "ROLE-SUPER": allPermissions,
    };
  } catch {
    return { ...defaultRolePermissionMap };
  }
}

export function hasUserPermission(userId: string, permission: string) {
  if (userId === "superadmin") return true;
  const user = findIdentityUser(userId);
  if (!user || user.status !== "启用") return false;
  const roles = useIdentityStore.getState().roles.filter((role) => role.status === "启用" && user.roleIds?.includes(role.id));
  const permissionMap = readStoredRolePermissions();
  return roles.some((role) => (permissionMap[role.id] ?? []).includes(permission));
}

export function currentSessionUserId() {
  try {
    const stored = JSON.parse(window.localStorage.getItem("flowpilot-prototype-v5") ?? "{}") as { state?: { personaId?: string } };
    return stored.state?.personaId ?? "";
  } catch {
    return "";
  }
}

export const currentUserCan = (permission: string) => hasUserPermission(currentSessionUserId(), permission);
