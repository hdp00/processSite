import type { PersonaId } from "./usePrototypeStore";

export const ROLE_PERMISSION_STORAGE_KEY = "flowpilot-role-permissions-v1";
export const ROLE_PERMISSIONS_CHANGED_EVENT = "flowpilot-role-permissions-changed";

const personaRoleId: Record<PersonaId, string> = {
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
  admin: ["pdf-review", "test-report-review", "free-collaboration", "engineering-change"],
  wangmin: ["pdf-review", "test-report-review", "free-collaboration"],
  zhangwei: [],
  lina: [],
  zhaolei: [],
  hejing: [],
};

export function readStoredRolePermissions(): Record<string, string[]> {
  try {
    return JSON.parse(window.localStorage.getItem(ROLE_PERMISSION_STORAGE_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function hasPersonaPermission(personaId: PersonaId, permission: string) {
  const roleId = personaRoleId[personaId];
  const stored = readStoredRolePermissions();
  const permissions = stored[roleId] ?? defaultLaunchPermissions[roleId] ?? [];
  return permissions.includes(permission);
}

export function canPersonaAccessLaunch(personaId: PersonaId) {
  return hasPersonaPermission(personaId, "work-launch:查看")
    && hasPersonaPermission(personaId, "work-launch:发起")
    && launchDefinitionsByPersona[personaId].length > 0;
}

export function canPersonaLaunchDefinition(personaId: PersonaId, definitionId: string) {
  return canPersonaAccessLaunch(personaId) && launchDefinitionsByPersona[personaId].includes(definitionId);
}

export function notifyRolePermissionsChanged() {
  window.dispatchEvent(new Event(ROLE_PERMISSIONS_CHANGED_EVENT));
}
