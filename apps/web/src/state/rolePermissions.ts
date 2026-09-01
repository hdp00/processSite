import { getPublishedVersion, useProcessDefinitionStore } from "./useProcessDefinitionStore";
import { isSessionSuperAdmin, type PersonaId } from "./usePrototypeStore";
import {
  ROLE_PERMISSIONS_CHANGED_EVENT,
  hasUserPermission,
  normalizeRolePermissionList,
} from "./permissionEngine";

export {
  ROLE_PERMISSIONS_CHANGED_EVENT,
  normalizeRolePermissionList,
};

export function hasPersonaPermission(personaId: PersonaId, permission: string) {
  return hasUserPermission(personaId, permission);
}

export function canPersonaAccessLaunch(personaId: PersonaId) {
  return hasPersonaPermission(personaId, "work-launch:查看")
    && hasPersonaPermission(personaId, "work-launch:发起");
}

export function canPersonaLaunchDefinition(personaId: PersonaId, definitionId: string) {
  if (isSessionSuperAdmin(personaId)) return true;
  if (!canPersonaAccessLaunch(personaId)) return false;
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);
  const version = getPublishedVersion(definition);
  return Boolean(definition && !definition.disabled && version);
}

export function notifyRolePermissionsChanged() {
  window.dispatchEvent(new Event(ROLE_PERMISSIONS_CHANGED_EVENT));
}
