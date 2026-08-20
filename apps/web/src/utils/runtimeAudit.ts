import type { AuditEvent } from "../api/contracts";
import type { ProcessInstance, WorkflowTask } from "../data/types";

/**
 * 将原型运行态转换为审计事件。页面和 MSW 接口共同使用本选择器，
 * 避免审计页维护一份与真实实例、待办脱节的静态演示数据。
 */
export const collectRuntimeAuditEvents = (
  instances: ProcessInstance[],
  tasks: WorkflowTask[],
): AuditEvent[] => {
  const instanceById = new Map(instances.map((item) => [item.id, item]));
  const decisions = tasks.flatMap((task): AuditEvent[] => {
    if (!task.action || !task.completedAt) return [];
    const instance = instanceById.get(task.instanceId);
    const result: AuditEvent[] = [{
      id: `runtime-decision-${task.id}`,
      category: "task",
      action: task.action === "通过" ? "pass" : task.action === "确认" ? "confirm" : "reject",
      actorId: task.completedById,
      actorName: task.completedByName,
      resourceType: "workflow-task",
      resourceId: task.id,
      occurredAt: task.completedAt,
      summary: `${task.completedByName ?? "审核人"}${task.action}节点 ${task.nodeName}`,
      details: { instanceId: task.instanceId, instanceCode: instance?.code, round: task.round },
    }];
    (task.fieldRevisions ?? []).forEach((revision) => result.push({
      id: `runtime-revision-${revision.id}`,
      category: "task",
      action: "revise-fields",
      actorId: revision.editedById,
      actorName: revision.editedByName,
      resourceType: "workflow-task",
      resourceId: task.id,
      occurredAt: revision.editedAt,
      summary: `${revision.editedByName}继续修改节点 ${task.nodeName} 的授权字段`,
      details: {
        instanceId: task.instanceId,
        fields: revision.changes.map((change) => ({ fieldId: change.fieldId, label: change.label })),
      },
    }));
    return result;
  });
  const freeFlowEvents = instances.flatMap((instance) => (instance.freeTimeline ?? []).map((entry): AuditEvent => ({
    id: `runtime-free-${instance.id}-${entry.id}`,
    category: "instance",
    action: entry.type,
    actorName: entry.actor,
    resourceType: "free-flow-instance",
    resourceId: instance.id,
    occurredAt: entry.time,
    summary: `${entry.actor}执行${entry.type}`,
    details: { assignee: entry.assignee },
  })));
  const resubmissions = instances.flatMap((instance) => (instance.resubmissions ?? []).map((record): AuditEvent => ({
    id: `runtime-resubmission-${instance.id}-r${record.round}`,
    category: "instance",
    action: "resubmit",
    actorId: record.submittedById,
    actorName: record.submittedByName,
    resourceType: "process-instance",
    resourceId: instance.id,
    occurredAt: record.submittedAt,
    summary: `${record.submittedByName}重新提交流程实例 ${instance.code}`,
    details: {
      definitionId: instance.definitionId,
      versionId: instance.versionId,
      round: record.round,
      modifiedFields: record.modifiedFields,
    },
  })));
  const creations = instances.map((instance): AuditEvent => ({
    id: `runtime-created-${instance.id}`,
    category: "instance",
    action: "create",
    actorId: instance.initiatorId,
    actorName: instance.initiator,
    resourceType: instance.workflowType === "free" ? "free-flow-instance" : "process-instance",
    resourceId: instance.id,
    occurredAt: instance.createdAt,
    summary: `${instance.initiator}创建流程实例 ${instance.code}`,
    details: { definitionId: instance.definitionId, versionId: instance.versionId },
  }));
  return [...decisions, ...resubmissions, ...freeFlowEvents, ...creations];
};
