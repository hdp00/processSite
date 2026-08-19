import type { ProcessInstance, WorkflowTask } from "../data/types";
import { hasPersonaPermission } from "./rolePermissions";
import { getPublishedVersion, useProcessDefinitionStore } from "./useProcessDefinitionStore";
import { findIdentityUser, isUserInWorkflowGroup } from "./useIdentityStore";
import { isSuperAdminPersona, usePrototypeStore } from "./usePrototypeStore";
import { resolveLockedProcessVersion } from "./processVersionResolver";

const instanceVersion = (instance: ProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === instance.definitionId);
  return resolveLockedProcessVersion(definition, instance);
};

const isNamedOrId = (values: string[], userId: string, userName: string) =>
  values.includes(userId) || values.includes(userName);

export function canUserViewInstance(userId: string, instance: ProcessInstance) {
  if (!hasPersonaPermission(userId, "work-list:查看")) return false;
  if (isSuperAdminPersona(userId)) return true;
  const user = findIdentityUser(userId);
  if (!user || user.status !== "启用") return false;
  if (instance.initiatorId === user.id || instance.initiator === user.name) return true;
  if (instance.participantIds?.includes(user.id) || instance.currentAssigneeId === user.id) return true;

  const version = instanceVersion(instance);
  if (!version) return false;
  if (isNamedOrId(version.basic.visibleUsers, user.id, user.name)) return true;
  if (user.roles.some((role) => version.basic.visibleRoles.includes(role))) return true;
  if (version.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(user.id, groupId))) return true;
  if (version.basic.closeGroups.some((groupId) => isUserInWorkflowGroup(user.id, groupId))) return true;
  const approvalGroups = version.snapshot.flow.nodes
    .filter((node) => node.data?.kind === "approval")
    .map((node) => node.data?.permissionGroup)
    .filter((groupId): groupId is string => Boolean(groupId));
  if (approvalGroups.some((groupId) => isUserInWorkflowGroup(user.id, groupId))) return true;
  return usePrototypeStore.getState().tasks.some((task) =>
    task.instanceId === instance.id && (task.defaultAssigneeId === user.id || task.completedById === user.id),
  );
}

export function canUserViewDefinition(userId: string, definitionId: string) {
  const instances = usePrototypeStore.getState().instances.filter((instance) => instance.definitionId === definitionId);
  if (instances.some((instance) => canUserViewInstance(userId, instance))) return true;
  if (!hasPersonaPermission(userId, "work-list:查看")) return false;
  if (isSuperAdminPersona(userId)) return true;
  const user = findIdentityUser(userId);
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);
  const version = getPublishedVersion(definition);
  if (!user || !version) return false;
  return version.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(user.id, groupId))
    || version.basic.closeGroups.some((groupId) => isUserInWorkflowGroup(user.id, groupId))
    || version.basic.visibleUsers.some((value) => value === user.id || value === user.name)
    || user.roles.some((role) => version.basic.visibleRoles.includes(role))
    || version.snapshot.flow.nodes.some((node) =>
      Boolean(node.data?.permissionGroup && isUserInWorkflowGroup(user.id, node.data.permissionGroup)),
    );
}

export function canUserProcessTask(userId: string, task: WorkflowTask) {
  if (!hasPersonaPermission(userId, "work-task:审核")) return false;
  return isSuperAdminPersona(userId) || isUserInWorkflowGroup(userId, task.permissionGroupId);
}

export function canUserCloseInstance(userId: string, instance: ProcessInstance) {
  const version = instanceVersion(instance);
  if (instance.status === "驳回待处理" && version?.snapshot.flow.meta?.rejectionHandling === "resubmit-only") return false;
  if (isSuperAdminPersona(userId)) return true;
  return Boolean(version?.basic.closeGroups.some((groupId) => isUserInWorkflowGroup(userId, groupId)));
}
