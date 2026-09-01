import { allPermissionCodes } from "../data/permissionCatalog";
import { usePrototypeStore } from "./usePrototypeStore";

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

export function hasUserPermission(userId: string, permission: string) {
  const session = usePrototypeStore.getState();
  return session.authenticated
    && session.personaId === userId
    && (session.sessionSuperAdmin || session.sessionPermissions.includes(permission));
}

export const currentSessionUserId = () => usePrototypeStore.getState().personaId;

export const currentUserCan = (permission: string) => hasUserPermission(currentSessionUserId(), permission);
