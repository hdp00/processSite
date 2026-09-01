import type { ProcessInstance, WorkflowTask } from "../data/types";
import { hasPersonaPermission } from "./rolePermissions";
import { useProcessDefinitionStore } from "./useProcessDefinitionStore";

/**
 * 这些函数只控制已经由后端返回的数据的界面入口。
 * 真正的数据范围、流程权限组和状态校验始终由后端执行。
 */
export function canUserViewInstance(userId: string, instance: ProcessInstance) {
  return Boolean(instance.id) && hasPersonaPermission(userId, "work-list:查看");
}

export function canUserViewDefinition(userId: string, definitionId: string) {
  return hasPersonaPermission(userId, "work-list:查看")
    && useProcessDefinitionStore.getState().definitions.some((item) => item.id === definitionId);
}

export function canUserProcessTask(userId: string, task: WorkflowTask) {
  return hasPersonaPermission(userId, "work-task:审核")
    && Boolean(task.allowedActions?.some((action) => ["pass", "confirm", "reject", "revise-fields"].includes(action)));
}

export function canUserCloseInstance(userId: string, instance: ProcessInstance) {
  return hasPersonaPermission(userId, "work-task:关闭") && instance.canClose === true;
}
