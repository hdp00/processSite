import { findIdentityUser, useIdentityStore } from "./useIdentityStore";
import { allPermissionCodes } from "../data/permissionCatalog";

export const ROLE_PERMISSION_STORAGE_KEY = "flowpilot-role-permissions-v3";
export const PREVIOUS_ROLE_PERMISSION_STORAGE_KEY = "flowpilot-role-permissions-v2";
export const LEGACY_ROLE_PERMISSION_STORAGE_KEY = "flowpilot-role-permissions-v1";
export const ROLE_PERMISSIONS_CHANGED_EVENT = "flowpilot-role-permissions-changed";

const editActionAliases = new Set(["新增", "新建", "编辑", "启停", "停用"]);

export function normalizeRolePermissionList(permissions: string[]) {
  const knownPermissions = new Set(allPermissionCodes);
  return Array.from(new Set(permissions.map((permission) => {
    if (permission === "work-task:驳回") return "work-task:审核";
    const separatorIndex = permission.lastIndexOf(":");
    if (separatorIndex < 0) return permission;
    const pageKey = permission.slice(0, separatorIndex);
    const action = permission.slice(separatorIndex + 1);
    return editActionAliases.has(action) ? `${pageKey}:编辑` : permission;
  }).filter((permission) => knownPermissions.has(permission))));
}

const reviewerPermissions = ["work-task:查看", "work-task:审核", "work-list:查看"];
const latestDirectoryDeletePermissions = [
  "org-department:删除",
  "org-group:删除",
];
const permissionsBeforeLatestDirectoryDeletes = allPermissionCodes.filter((permission) =>
  !latestDirectoryDeletePermissions.includes(permission));

export const defaultRolePermissionMap: Record<string, string[]> = {
  "ROLE-SUPER": allPermissionCodes,
  "ROLE-001": allPermissionCodes,
  "ROLE-002": ["work-task:查看", "work-list:查看", "work-list:打印", "config-definition:查看", "config-definition:编辑", "config-definition:发布", "config-definition:删除", "config-form:编辑"],
  "ROLE-003": ["work-launch:查看", "work-launch:发起", "work-task:查看", "work-task:审核", "work-task:关闭", "work-list:查看", "work-list:复制新建", "work-list:打印"],
  "ROLE-004": reviewerPermissions,
  "ROLE-005": reviewerPermissions,
  "ROLE-006": reviewerPermissions,
  "ROLE-007": ["work-list:查看"],
};

export function readStoredRolePermissions(): Record<string, string[]> {
  try {
    const current = window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY);
    const previous = current === null ? window.localStorage.getItem(PREVIOUS_ROLE_PERMISSION_STORAGE_KEY) : null;
    const legacy = current === null && previous === null ? window.localStorage.getItem(LEGACY_ROLE_PERMISSION_STORAGE_KEY) : null;
    const stored = JSON.parse(current ?? previous ?? legacy ?? "{}") as Record<string, string[]>;
    const saved = Object.fromEntries(Object.entries(stored).map(([roleId, permissions]) => [
      roleId,
      normalizeRolePermissionList(permissions),
    ]));
    if (legacy !== null && saved["ROLE-003"]) {
      saved["ROLE-003"] = Array.from(new Set([
        ...saved["ROLE-003"],
        "work-task:审核",
        "work-task:关闭",
      ]));
    }
    const upgrading = current === null && (previous !== null || legacy !== null);
    if (upgrading && saved["ROLE-001"]
      && permissionsBeforeLatestDirectoryDeletes.every((permission) => saved["ROLE-001"].includes(permission))) {
      saved["ROLE-001"] = Array.from(new Set([...saved["ROLE-001"], ...latestDirectoryDeletePermissions]));
    }
    if (upgrading) window.localStorage.setItem(ROLE_PERMISSION_STORAGE_KEY, JSON.stringify(saved));
    return {
      ...defaultRolePermissionMap,
      ...saved,
      "ROLE-SUPER": allPermissionCodes,
    };
  } catch {
    return { ...defaultRolePermissionMap };
  }
}

export function hasUserPermission(userId: string, permission: string) {
  if (import.meta.env.VITE_API_MODE === "remote") {
    try {
      const stored = JSON.parse(window.localStorage.getItem("flowpilot-prototype-v5") ?? "{}") as {
        state?: {
          authenticated?: boolean;
          personaId?: string;
          sessionPermissions?: string[];
          sessionSuperAdmin?: boolean;
        };
      };
      const session = stored.state;
      if (session?.authenticated && session.personaId === userId) {
        return Boolean(session.sessionSuperAdmin || session.sessionPermissions?.includes(permission));
      }
    } catch {
      return false;
    }
  }
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
