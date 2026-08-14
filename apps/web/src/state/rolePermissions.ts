import { isSuperAdminPersona, type PersonaId } from "./usePrototypeStore";

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

const personaRoleId: Record<PersonaId, string> = {
  superadmin: "ROLE-SUPER",
  admin: "ROLE-001",
  wangmin: "ROLE-003",
  zhangwei: "ROLE-004",
  lina: "ROLE-005",
  zhaolei: "ROLE-006",
  hejing: "ROLE-007",
};

const defaultLaunchPermissions: Record<string, string[]> = {
  "ROLE-001": ["work-launch:查看", "work-launch:发起"],
  "ROLE-003": ["work-launch:查看", "work-launch:发起"],
};

const launchDefinitionsByPersona: Record<PersonaId, string[]> = {
  superadmin: [],
  admin: ["pdf-review", "test-report-review", "free-collaboration", "engineering-change"],
  wangmin: ["pdf-review", "test-report-review", "free-collaboration"],
  zhangwei: [],
  lina: [],
  zhaolei: [],
  hejing: [],
};

export function readStoredRolePermissions(): Record<string, string[]> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY) ?? "{}") as Record<string, string[]>;
    return Object.fromEntries(
      Object.entries(stored).map(([roleId, permissions]) => [roleId, normalizeRolePermissionList(permissions)]),
    );
  } catch {
    return {};
  }
}

export function hasPersonaPermission(personaId: PersonaId, permission: string) {
  if (isSuperAdminPersona(personaId)) return true;
  const roleId = personaRoleId[personaId];
  const stored = readStoredRolePermissions();
  const permissions = stored[roleId] ?? defaultLaunchPermissions[roleId] ?? [];
  return permissions.includes(permission);
}

export function canPersonaAccessLaunch(personaId: PersonaId) {
  if (isSuperAdminPersona(personaId)) return true;
  return hasPersonaPermission(personaId, "work-launch:查看")
    && hasPersonaPermission(personaId, "work-launch:发起")
    && launchDefinitionsByPersona[personaId].length > 0;
}

export function canPersonaLaunchDefinition(personaId: PersonaId, definitionId: string) {
  if (isSuperAdminPersona(personaId)) return true;
  return canPersonaAccessLaunch(personaId) && launchDefinitionsByPersona[personaId].includes(definitionId);
}

export function notifyRolePermissionsChanged() {
  window.dispatchEvent(new Event(ROLE_PERMISSIONS_CHANGED_EVENT));
}
