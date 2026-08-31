import { create } from "zustand";
import { persist } from "zustand/middleware";
import { initialInstances } from "../data/mock";
import type {
  FreeFlowEntry,
  LegacyProcessInstance,
  ProcessInstance,
  WorkflowFieldChange,
  WorkflowTask,
} from "../data/types";
import { getPublishedVersion, useProcessDefinitionStore, type ProcessVersion } from "./useProcessDefinitionStore";
import {
  effectiveGroupMemberIds,
  findIdentityUser,
  isUserInWorkflowGroup,
  useIdentityStore,
} from "./useIdentityStore";
import {
  extractInstancePrefix,
  issueNextInstanceNumber,
  normalizeLegacyInstanceNumber,
  resetInstanceNumberSequences,
} from "../utils/instanceNumber";
import { applyDesignerFieldVisibility, conditionOperatorLabel, evaluateNodeCondition, normalizeDesignerFormValues, PROCESS_TITLE_FIELD_ID, type StoredDesignerField, type StoredDesignerTableColumn } from "../utils/designerStorage";
import { hasUserPermission } from "./permissionEngine";
import { resolveLockedProcessVersion } from "./processVersionResolver";
import { canEditProcessInstanceSubmission } from "../utils/processInstanceAccess";
import { displayDesignerChoiceValue } from "../utils/designerOptions";
import { nowDomainTimestamp } from "../utils/domainTime";
import { createClientUuid } from "../utils/clientId";
import type { AuthSession, ImpersonationContext } from "../api/contracts";

type ReviewAction = "pass" | "confirm" | "reject";
export type RepeatEditResult = "updated" | "no-changes" | "forbidden";
export type RuntimeCommandResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "version-missing" | "forbidden" | "invalid-state" | "locked"; message: string };
type RepublishChanges = Partial<
  Pick<ProcessInstance, "title" | "documentCode" | "documentType" | "documentLevel" | "description" | "pdfName" | "attachmentIds" | "attachmentIdsByField">
> & { formValues?: Record<string, unknown>; attachmentNames?: string[] };
type UnreviewedInstanceChanges = RepublishChanges & {
  assigneeByNode?: Record<string, string | undefined>;
};
export type PersonaId = string;
export const SUPER_ADMIN_PERSONA_ID: PersonaId = "superadmin";
export const isSuperAdminPersona = (personaId: PersonaId) => personaId === SUPER_ADMIN_PERSONA_ID;

export interface FreeFlowInitialChanges {
  title: string;
  category: string;
  priority: ProcessInstance["priority"];
  description: string;
  initialContent: string;
}

export interface CreateProcessInstanceInput {
  definitionId: string;
  formValues: Record<string, unknown>;
  assigneeByNode?: Record<string, string | undefined>;
  firstAssigneeId?: string;
  attachmentNames?: string[];
  attachmentIds?: string[];
  attachmentIdsByField?: Record<string, string[]>;
}

export const personas: Array<{
  id: PersonaId;
  name: string;
  role: string;
}> = [
  { id: "wangmin", name: "王敏", role: "文控专员" },
  { id: "zhangwei", name: "张伟", role: "研发审核人" },
  { id: "lina", name: "林晓", role: "质量审核人" },
  { id: "zhaolei", name: "赵磊", role: "生产审核人" },
  { id: "admin", name: "周杰", role: "系统管理员" },
  { id: "hejing", name: "何静", role: "只读查看者" },
  { id: "superadmin", name: "超级管理员", role: "系统内置 · 全部权限" },
];

interface PrototypeState {
  authenticated: boolean;
  personaId: PersonaId;
  operatorUserId: PersonaId;
  sessionPermissions: string[];
  sessionSuperAdmin: boolean;
  operatorSuperAdmin: boolean;
  impersonation?: ImpersonationContext;
  instances: ProcessInstance[];
  tasks: WorkflowTask[];
  login: (personaId?: PersonaId) => void;
  applyAuthSession: (session: AuthSession) => void;
  logout: () => void;
  switchPersona: (personaId: PersonaId) => void;
  createProcessInstance: (input: CreateProcessInstanceInput) => string | null;
  reviewInstance: (id: string, action: ReviewAction, comment: string, documentLevel?: string, fieldChanges?: Record<string, unknown>, taskId?: string) => boolean;
  reviseCompletedTask: (id: string, taskId: string, fieldChanges: Record<string, unknown>, comment?: string) => RepeatEditResult;
  closeInstance: (id: string, reason: string) => RuntimeCommandResult;
  updateUnreviewedInstance: (id: string, changes: UnreviewedInstanceChanges) => RuntimeCommandResult;
  republishInstance: (id: string, changes: RepublishChanges) => RuntimeCommandResult;
  replyFreeFlow: (id: string, content: string, attachments?: FreeFlowEntry["attachments"]) => void;
  transferFreeFlow: (id: string, nextAssignee: string, content?: string, attachments?: FreeFlowEntry["attachments"]) => void;
  editFreeFlowReply: (id: string, entryId: string, content: string) => void;
  updateFreeFlowInitial: (id: string, changes: FreeFlowInitialChanges) => void;
  closeFreeFlow: (id: string, reason: string) => void;
  reopenFreeFlow: (id: string, reason: string, assignee: string) => void;
  resetDemo: () => void;
}

const nowText = nowDomainTimestamp;

const normalizeTemplateVersion = (value: string) => {
  const matched = value.match(/^v(\d+)/i);
  return matched ? `V${Number(matched[1])}` : value;
};

const currentPersona = (personaId: PersonaId) => {
  const identity = findIdentityUser(personaId);
  if (identity) return { id: identity.id, name: identity.name, role: identity.roles.join("、") || identity.jobTitle };
  return personas.find((item) => item.id === personaId) ?? personas[0];
};

const legacyDefinitionId = (instance: LegacyProcessInstance) => {
  if (instance.definitionId) return instance.definitionId;
  if (instance.workflowType === "free" || instance.template.includes("自由")) return "free-collaboration";
  if (instance.template.includes("测试报告")) return "test-report-review";
  if (instance.template.includes("供应商")) return "supplier-change-review";
  return "pdf-review";
};

const resolveInstanceVersion = (instance: LegacyProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === legacyDefinitionId(instance));
  return resolveLockedProcessVersion(definition, instance);
};

const isStarterActor = (instance: ProcessInstance, userId: string) => {
  if (isSuperAdminPersona(userId)) return true;
  const version = resolveInstanceVersion(instance);
  return Boolean(version?.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(userId, groupId)));
};

export const canUserTransferFreeFlow = (instance: ProcessInstance, userId: string) => {
  if (instance.workflowType !== "free" || instance.status !== "进行中") return false;
  if (isSuperAdminPersona(userId)) return true;
  const version = resolveInstanceVersion(instance);
  if (!version) return false;
  return [...version.basic.starterGroups, ...(version.basic.assigneeGroups ?? [])]
    .some((groupId) => isUserInWorkflowGroup(userId, groupId));
};

const isCloserActor = (instance: ProcessInstance, userId: string) => {
  if (isSuperAdminPersona(userId)) return true;
  const version = resolveInstanceVersion(instance);
  return Boolean(version?.basic.closeGroups.some((groupId) => isUserInWorkflowGroup(userId, groupId)));
};

const isAllowedFreeAssignee = (instance: ProcessInstance, assignee: string) => {
  const assigneeId = userIdByIdOrName(assignee);
  const version = resolveInstanceVersion(instance);
  return Boolean(assigneeId && version?.basic.assigneeGroups?.some((groupId) => isUserInWorkflowGroup(assigneeId, groupId)));
};

const legacyPermissionGroup = (reviewerKey: string, definitionId: string) => {
  const prefix = definitionId === "test-report-review" ? "测试报告" : definitionId === "supplier-change-review" ? "供应商变更" : "PDF审核";
  if (prefix === "供应商变更") return "供应商变更_评审_流程权限组";
  return ({ rd: `${prefix}_研发_流程权限组`, qa: `${prefix}_质量_流程权限组`, production: `${prefix}_生产_流程权限组` }[reviewerKey] ?? reviewerKey);
};

const normalizeInstanceReviewers = (instance: ProcessInstance, version?: ProcessVersion): ProcessInstance => {
  const approvalNodes = version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval" && node.data.permissionGroup) ?? [];
  if (!approvalNodes.length || instance.workflowType === "free") return instance;

  const definitionId = instance.definitionId ?? legacyDefinitionId(instance);
  const unmatched = [...instance.reviewers];
  const reviewers = approvalNodes.map((node) => {
    const permissionGroupId = node.data?.permissionGroup ?? "";
    const matchedIndex = unmatched.findIndex((reviewer) =>
      reviewer.key === node.id
      || reviewer.group === permissionGroupId
      || legacyPermissionGroup(reviewer.key, definitionId) === permissionGroupId,
    );
    const reviewer = matchedIndex >= 0 ? unmatched.splice(matchedIndex, 1)[0] : undefined;
    return {
      key: node.id,
      name: reviewer?.name ?? "组内共享",
      group: permissionGroupId || reviewer?.group || "未配置流程权限组",
      shortGroup: node.data?.label ?? reviewer?.shortGroup ?? "审批",
      status: reviewer?.status ?? ("待审核" as const),
      actionAt: reviewer?.actionAt,
      comment: reviewer?.comment,
      substitute: reviewer?.substitute,
      conditionSummary: reviewer?.conditionSummary,
    };
  });
  return { ...instance, reviewers };
};

const tasksForInstance = (instance: ProcessInstance, version?: ProcessVersion): WorkflowTask[] => {
  const definitionId = instance.definitionId ?? legacyDefinitionId(instance);
  const versionId = instance.versionId ?? version?.id ?? `${definitionId}-${normalizeTemplateVersion(instance.templateVersion).toLowerCase()}`;
  const createdAt = instance.createdAt;
  const approvalNodes = version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval" && node.data.permissionGroup) ?? [];
  if (approvalNodes.length) {
    const normalizedInstance = normalizeInstanceReviewers(instance, version);
    return approvalNodes.map((node) => {
      const reviewer = normalizedInstance.reviewers.find((item) => item.key === node.id);
      const completed = reviewer?.status === "已通过" || reviewer?.status === "已确认" || reviewer?.status === "已驳回";
      const permissionGroupId = node.data?.permissionGroup ?? "";
      const reviewerAssigneeId = userIdByIdOrName(reviewer?.name);
      return {
        id: `task-${instance.id}-${node.id}-r${instance.round}`,
        instanceId: instance.id,
        definitionId,
        versionId,
        nodeId: node.id,
        nodeName: node.data?.label ?? "审批",
        permissionGroupId,
        status: reviewer?.status === "待审核"
          ? "待处理"
          : reviewer?.status === "已跳过"
            ? "已跳过"
          : reviewer?.status === "已通过" || reviewer?.status === "已确认" || reviewer?.status === "已驳回"
            ? "已完成"
            : "已取消",
        defaultAssigneeId: reviewerAssigneeId && isUserInWorkflowGroup(reviewerAssigneeId, permissionGroupId)
          ? reviewerAssigneeId
          : undefined,
        completedById: completed ? reviewerAssigneeId : undefined,
        completedByName: completed ? reviewer?.name : undefined,
        action: reviewer?.status === "已通过" ? "通过" : reviewer?.status === "已确认" ? "确认" : reviewer?.status === "已驳回" ? "驳回" : undefined,
        comment: reviewer?.comment,
        createdAt,
        completedAt: reviewer?.actionAt,
        round: instance.round,
        conditionSummary: reviewer?.conditionSummary,
        conditionEvaluatedAt: reviewer?.status === "已跳过" ? reviewer.actionAt : undefined,
      } satisfies WorkflowTask;
    });
  }
  return instance.reviewers.map((reviewer) => ({
    id: `task-${instance.id}-${reviewer.key}-r${instance.round}`,
    instanceId: instance.id,
    definitionId,
    versionId,
    nodeId: reviewer.key,
    nodeName: reviewer.shortGroup || reviewer.group,
    permissionGroupId: legacyPermissionGroup(reviewer.key, definitionId),
    status: reviewer.status === "待审核" ? "待处理" : reviewer.status === "已跳过" ? "已跳过" : reviewer.status === "已取消" ? "已取消" : "已完成",
    completedByName: reviewer.status === "已通过" || reviewer.status === "已确认" || reviewer.status === "已驳回" ? reviewer.name : undefined,
    action: reviewer.status === "已通过" ? "通过" : reviewer.status === "已确认" ? "确认" : reviewer.status === "已驳回" ? "驳回" : undefined,
    comment: reviewer.comment,
    createdAt,
    completedAt: reviewer.actionAt,
    round: instance.round,
    conditionSummary: reviewer.conditionSummary,
    conditionEvaluatedAt: reviewer.status === "已跳过" ? reviewer.actionAt : undefined,
  }));
};

const userIdByIdOrName = (value?: string) => {
  if (!value) return undefined;
  const user = useIdentityStore.getState().users.find((item) => item.id === value || item.name === value);
  return user?.id;
};

const displayValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
  return "";
};

const auditValue = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "（空）";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
    return value.map(String).join("、") || "（空）";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const auditFieldValue = (field: StoredDesignerField, value: unknown) =>
  ["select", "radio", "checkbox", "cascader"].includes(field.type)
    ? displayDesignerChoiceValue(field.options, value, { hierarchical: field.type === "cascader" }) || "（空）"
    : auditValue(value);

const auditColumnValue = (column: StoredDesignerTableColumn, value: unknown) =>
  column.type && column.type !== "text"
    ? displayDesignerChoiceValue(column.options, value) || "（空）"
    : auditValue(value);

const sameValue = (left: unknown, right: unknown) => {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const mergeAuthorizedFieldValues = (
  version: ProcessVersion,
  nodeId: string,
  currentValues: Record<string, unknown>,
  requestedValues: Record<string, unknown>,
) => {
  const editableFields = version.snapshot.flow.nodes.find((node) => node.id === nodeId)?.data?.editableFields ?? [];
  const nextValues = structuredClone(currentValues);
  const changes: WorkflowFieldChange[] = [];
  editableFields.forEach((editableKey) => {
    const [fieldId, columnId] = editableKey.split(".");
    const field = version.snapshot.form.fields.find((item) => item.id === fieldId);
    if (!field || !Object.prototype.hasOwnProperty.call(requestedValues, fieldId)) return;
    if (!columnId) {
      const before = currentValues[fieldId];
      const after = structuredClone(requestedValues[fieldId]);
      if (sameValue(before, after)) return;
      nextValues[fieldId] = after;
      changes.push({ fieldId, label: field.label, before: auditFieldValue(field, before), after: auditFieldValue(field, after) });
      return;
    }
    const column = field.columns?.find((item) => item.id === columnId);
    if (!column) return;
    const currentRows = Array.isArray(currentValues[fieldId]) ? currentValues[fieldId] as Array<Record<string, unknown>> : [];
    const requestedRows = Array.isArray(requestedValues[fieldId]) ? requestedValues[fieldId] as Array<Record<string, unknown>> : [];
    const mergedRows = currentRows.map((row, index) => ({
      ...row,
      [columnId]: requestedRows[index]?.[columnId] ?? row[columnId],
    }));
    const before = currentRows.map((row) => row[columnId]);
    const after = mergedRows.map((row) => row[columnId]);
    if (sameValue(before, after)) return;
    nextValues[fieldId] = mergedRows;
    changes.push({
      fieldId: editableKey,
      label: `${field.label} / ${column.label}`,
      before: auditColumnValue(column, before),
      after: auditColumnValue(column, after),
    });
  });
  return { values: nextValues, changes };
};

const hydrateLegacyInstance = (instance: LegacyProcessInstance): ProcessInstance => {
  const definitionId = legacyDefinitionId(instance);
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);
  const version = definition?.versions.find((item) => item.version === normalizeTemplateVersion(instance.templateVersion));
  const hydrated: ProcessInstance = {
    ...instance,
    template: version?.basic.name ?? instance.template,
    currentNode: instance.workflowType === "free" && instance.status === "进行中"
      ? instance.currentAssignee ?? instance.currentNode.replace(/受理中$/, "")
      : instance.currentNode
        .replace("等待发布方重新发布", "等待发起方重新提交")
        .replace("等待发布方重新处理", "等待发起方重新提交"),
    definitionId,
    versionId: instance.versionId ?? version?.id ?? `legacy-version:${normalizeTemplateVersion(instance.templateVersion)}`,
    initiatorId: instance.initiatorId ?? userIdByIdOrName(instance.initiator) ?? `legacy-user:${instance.initiator}`,
    currentAssigneeId: instance.currentAssigneeId ?? userIdByIdOrName(instance.currentAssignee),
    participantIds: instance.participantIds ?? (instance.participants ?? []).map(userIdByIdOrName).filter((value): value is string => Boolean(value)),
    formValues: instance.formValues ?? {
      title: instance.title,
      documentCode: instance.documentCode,
      documentType: instance.documentType,
      description: instance.description,
    },
    attachmentNames: instance.attachmentNames ?? (instance.pdfName && instance.pdfName !== "无附件" ? [instance.pdfName] : []),
  };
  return normalizeInstanceReviewers(hydrated, version);
};

const normalizeTaskForInstance = (
  task: WorkflowTask,
  instance: ProcessInstance,
  version?: ProcessVersion,
): WorkflowTask | undefined => {
  const definitionId = instance.definitionId ?? legacyDefinitionId(instance);
  const approvalNodes = version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval" && node.data.permissionGroup) ?? [];
  if (!approvalNodes.length) return { ...task, definitionId, versionId: instance.versionId ?? task.versionId };

  const legacyGroupId = legacyPermissionGroup(task.nodeId, definitionId);
  const node = approvalNodes.find((item) => item.id === task.nodeId)
    ?? approvalNodes.find((item) => item.data?.permissionGroup === task.permissionGroupId)
    ?? approvalNodes.find((item) => item.data?.permissionGroup === legacyGroupId)
    ?? approvalNodes.find((item) => item.data?.label === task.nodeName);
  if (!node) {
    return task.round === instance.round && (task.status === "待处理" || task.status === "未激活")
      ? undefined
      : task;
  }

  const permissionGroupId = node.data?.permissionGroup ?? task.permissionGroupId;
  const reviewer = instance.reviewers.find((item) => item.key === node.id);
  const storedAssignee = findIdentityUser(userIdByIdOrName(task.defaultAssigneeId) ?? "");
  const reviewerAssignee = findIdentityUser(userIdByIdOrName(reviewer?.name) ?? "");
  const keepStoredAssignee = Boolean(storedAssignee && (
    task.status === "已完成"
    || isUserInWorkflowGroup(storedAssignee.id, permissionGroupId)
  ));
  const defaultAssigneeId = keepStoredAssignee
    ? storedAssignee?.id
    : reviewerAssignee && isUserInWorkflowGroup(reviewerAssignee.id, permissionGroupId)
      ? reviewerAssignee.id
      : undefined;
  return {
    ...task,
    definitionId,
    versionId: instance.versionId ?? version?.id ?? task.versionId,
    nodeId: node.id,
    nodeName: node.data?.label ?? task.nodeName,
    permissionGroupId,
    defaultAssigneeId,
    completedById: task.completedById ?? userIdByIdOrName(task.completedByName),
  };
};

const taskStateRank = (task: WorkflowTask) => task.status === "已完成"
  ? 4
  : task.status === "待处理"
    ? 3
    : task.status === "未激活"
      ? 2
      : 1;

const synchronizeInstanceReviewersFromTasks = (
  instance: ProcessInstance,
  tasks: WorkflowTask[],
  version?: ProcessVersion,
): ProcessInstance => {
  const normalized = normalizeInstanceReviewers(instance, version);
  if (!version || normalized.workflowType === "free") return normalized;
  const currentTasks = tasks.filter((task) => task.instanceId === instance.id && task.round === instance.round);
  const reviewers = normalized.reviewers.map((reviewer) => {
    const task = currentTasks.find((item) => item.nodeId === reviewer.key);
    if (!task) return reviewer;
    const status = task.status === "已完成"
      ? task.action === "驳回" ? "已驳回" as const : task.action === "确认" ? "已确认" as const : "已通过" as const
      : task.status === "已取消"
        ? "已取消" as const
        : task.status === "已跳过"
          ? "已跳过" as const
          : "待审核" as const;
    return {
      ...reviewer,
      status,
      name: task.completedByName ?? reviewer.name,
      actionAt: task.completedAt ?? task.conditionEvaluatedAt ?? reviewer.actionAt,
      comment: task.comment ?? reviewer.comment,
      substitute: Boolean(task.completedById && task.defaultAssigneeId && task.completedById !== task.defaultAssigneeId),
      conditionSummary: task.conditionSummary ?? reviewer.conditionSummary,
    };
  });
  const activeNodeNames = currentTasks.filter((task) => task.status === "待处理").map((task) => task.nodeName);
  return {
    ...normalized,
    reviewers,
    currentNode: normalized.status === "审核中" && activeNodeNames.length
      ? activeNodeNames.join(" / ")
      : normalized.currentNode,
  };
};

export const normalizePrototypeRuntimeData = (instances: ProcessInstance[], sourceTasks: WorkflowTask[]) => {
  const normalizedInstances = instances.map((instance) => normalizeInstanceReviewers(instance, resolveInstanceVersion(instance)));
  const instanceById = new Map(normalizedInstances.map((instance) => [instance.id, instance]));
  const taskByNodeAndRound = new Map<string, WorkflowTask>();
  sourceTasks.forEach((task) => {
    const instance = instanceById.get(task.instanceId);
    if (!instance) return;
    const normalized = normalizeTaskForInstance(task, instance, resolveInstanceVersion(instance));
    if (!normalized) return;
    const key = `${normalized.instanceId}:${normalized.round}:${normalized.nodeId}`;
    const existing = taskByNodeAndRound.get(key);
    if (!existing || taskStateRank(normalized) > taskStateRank(existing)) taskByNodeAndRound.set(key, normalized);
  });
  normalizedInstances.forEach((instance) => {
    const version = resolveInstanceVersion(instance);
    tasksForInstance(instance, version).forEach((task) => {
      const key = `${task.instanceId}:${task.round}:${task.nodeId}`;
      if (!taskByNodeAndRound.has(key)) taskByNodeAndRound.set(key, task);
    });
  });
  const tasks = [...taskByNodeAndRound.values()];
  return {
    tasks,
    instances: normalizedInstances.map((instance) => synchronizeInstanceReviewersFromTasks(instance, tasks, resolveInstanceVersion(instance))),
  };
};

const initialRuntimeInstances = initialInstances.map(hydrateLegacyInstance);
const initialRuntimeData = normalizePrototypeRuntimeData(
  initialRuntimeInstances,
  initialRuntimeInstances.flatMap((instance) => tasksForInstance(instance, resolveInstanceVersion(instance))),
);
const normalizedInitialInstances = initialRuntimeData.instances;
const initialTasks = initialRuntimeData.tasks;

const findFormValue = (version: ProcessVersion, values: Record<string, unknown>, preferred: string[]) => {
  const field = version.snapshot.form.fields.find((item) =>
    preferred.some((keyword) => item.id.toLowerCase().includes(keyword.toLowerCase()) || item.label.includes(keyword)),
  );
  return field ? displayValue(values[field.id]) : "";
};

const synchronizedInstanceFields = (version: ProcessVersion, values: Record<string, unknown>) => {
  const title = displayValue(values[PROCESS_TITLE_FIELD_ID]);
  const documentCode = findFormValue(version, values, ["documentCode", "文件编号", "报告编号"]);
  const documentType = findFormValue(version, values, ["documentType", "文件类型", "分类"]);
  const description = findFormValue(version, values, ["description", "摘要", "说明"]);
  return {
    ...(title ? { title } : {}),
    ...(documentCode ? { documentCode } : {}),
    ...(documentType ? { documentType } : {}),
    ...(description ? { description } : {}),
  };
};

const collectModifiedFieldReferences = (
  version: ProcessVersion,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) => version.snapshot.form.fields
  .filter((field) => JSON.stringify(before[field.id] ?? null) !== JSON.stringify(after[field.id] ?? null))
  .map((field) => ({ fieldId: field.id, label: field.label }));

const synchronizedAttachmentFields = (version: ProcessVersion, values: Record<string, unknown>) => {
  const attachmentFields = version.snapshot.form.fields.filter((field) => field.type === "attachment");
  if (!attachmentFields.length) return {};
  const attachmentIdsByField = Object.fromEntries(attachmentFields.map((field) => {
    const value = values[field.id];
    const ids = Array.isArray(value) ? value.flatMap((item) => item && typeof item === "object" && "id" in item && item.id ? [String(item.id)] : []) : [];
    return [field.id, ids];
  }));
  const attachmentNames = attachmentFields.flatMap((field) => {
    const value = values[field.id];
    return Array.isArray(value) ? value.flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [item] : [];
      if (item && typeof item === "object" && "name" in item && item.name) return [String(item.name)];
      return [];
    }) : [];
  });
  const attachmentIds = Object.values(attachmentIdsByField).flat();
  return {
    attachmentNames,
    attachmentIds,
    attachmentIdsByField,
    pdfName: attachmentNames[0] ?? "无附件",
  };
};

const buildApprovalRuntime = (
  instanceId: string,
  definitionId: string,
  version: ProcessVersion,
  assigneeByNode: Record<string, string | undefined>,
  createdAt: string,
  formValues: Record<string, unknown>,
  round = 1,
) => {
  const approvalNodes = version.snapshot.flow.nodes.filter(
    (node) => node.data?.kind === "approval" && node.data.permissionGroup,
  );
  const reviewers = approvalNodes.map((node) => {
    const groupId = node.data?.permissionGroup ?? "";
    const requestedAssigneeId = userIdByIdOrName(assigneeByNode[node.id]);
    const defaultAssigneeId = node.data?.specifyAssignee
      ? requestedAssigneeId && effectiveGroupMemberIds(groupId).includes(requestedAssigneeId)
        ? requestedAssigneeId
        : effectiveGroupMemberIds(groupId)[0]
      : undefined;
    const defaultAssignee = defaultAssigneeId ? findIdentityUser(defaultAssigneeId) : undefined;
    return {
      key: node.id,
      name: defaultAssignee?.name ?? "待组内成员处理",
      group: useIdentityStore.getState().workflowGroups.find((group) => group.id === groupId)?.name ?? groupId,
      shortGroup: node.data?.label ?? "审批",
      status: "待审核" as const,
      defaultAssigneeId,
    };
  });
  const tasks: WorkflowTask[] = reviewers.map((reviewer) => ({
    id: `task-${instanceId}-${reviewer.key}-r${round}`,
    instanceId,
    definitionId,
    versionId: version.id,
    nodeId: reviewer.key,
    nodeName: reviewer.shortGroup,
    permissionGroupId: approvalNodes.find((node) => node.id === reviewer.key)?.data?.permissionGroup ?? "",
    status: "未激活",
    defaultAssigneeId: reviewer.defaultAssigneeId,
    createdAt,
    round,
  }));
  const reconciledTasks = reconcileReadyTasks(tasks, version, instanceId, round, formValues, createdAt);
  const reviewerStatusByNode = new Map(reconciledTasks.map((task) => [task.nodeId, task]));
  const runtimeReviewers = reviewers.map(({ defaultAssigneeId: _defaultAssigneeId, ...reviewer }) => {
    const task = reviewerStatusByNode.get(reviewer.key);
    return task?.status === "已跳过"
      ? { ...reviewer, status: "已跳过" as const, actionAt: task.conditionEvaluatedAt, conditionSummary: task.conditionSummary }
      : reviewer;
  });
  const completed = reconciledTasks.length > 0 && reconciledTasks.every((task) => task.status === "已跳过");
  return {
    reviewers: runtimeReviewers,
    tasks: reconciledTasks,
    completed,
    currentNode: completed ? "流程结束" : reconciledTasks.filter((task) => task.status === "待处理").map((task) => task.nodeName).join(" / ") || "等待审批",
  };
};

const reconcileReadyTasks = (runtimeTasks: WorkflowTask[], version: ProcessVersion, instanceId: string, round: number, formValues: Record<string, unknown>, evaluatedAt: string) => {
  const normalizedFormValues = normalizeDesignerFormValues(version.snapshot.form.fields, formValues);
  const approvalIds = new Set(version.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval").map((node) => node.id));
  let next = runtimeTasks;
  let changed = true;
  while (changed) {
    changed = false;
    next = next.map((task) => {
      if (task.instanceId !== instanceId || task.round !== round || task.status !== "未激活") return task;
      const predecessors = version.snapshot.flow.edges.filter((edge) => edge.target === task.nodeId && approvalIds.has(edge.source)).map((edge) => edge.source);
      const ready = predecessors.every((nodeId) => next.some((candidate) => candidate.instanceId === instanceId && candidate.round === round && candidate.nodeId === nodeId && ((candidate.status === "已完成" && (candidate.action === "通过" || candidate.action === "确认")) || candidate.status === "已跳过")));
      if (!ready) return task;
      changed = true;
      const node = version.snapshot.flow.nodes.find((item) => item.id === task.nodeId);
      const evaluation = evaluateNodeCondition(node?.data?.activationCondition, normalizedFormValues);
      if (evaluation.matches) return { ...task, status: "待处理" as const };
      const summary = evaluation.results.map(({ rule, actual }) => {
        const sourceField = version.snapshot.form.fields.find((field) => field.id === rule.fieldId);
        const label = sourceField?.label ?? rule.fieldId;
        const expectedText = sourceField ? displayDesignerChoiceValue(sourceField.options, rule.value) : String(rule.value ?? "");
        const actualText = sourceField ? displayDesignerChoiceValue(sourceField.options, actual, { hierarchical: sourceField.type === "cascader" }) : Array.isArray(actual) ? actual.join("、") : String(actual ?? "空");
        return `${label} ${conditionOperatorLabel(rule.operator)} ${expectedText}（实际：${actualText || "空"}）`;
      }).join("；");
      return { ...task, status: "已跳过" as const, conditionSummary: summary || "条件不满足", conditionEvaluatedAt: evaluatedAt };
    });
  }
  return next;
};

const freeEntry = (
  type: FreeFlowEntry["type"],
  actor: string,
  changes: Partial<FreeFlowEntry> = {},
): FreeFlowEntry => ({
  id: `free-entry-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  type,
  actor,
  time: nowText(),
  ...changes,
});

export const usePrototypeStore = create<PrototypeState>()(
  persist(
    (set, get) => ({
      authenticated: false,
      personaId: "lina",
      operatorUserId: "lina",
      sessionPermissions: [],
      sessionSuperAdmin: false,
      operatorSuperAdmin: false,
      impersonation: undefined,
      instances: normalizedInitialInstances,
      tasks: initialTasks,
      login: (personaId = "lina") => set({
        authenticated: true,
        personaId,
        operatorUserId: personaId,
        sessionPermissions: [],
        sessionSuperAdmin: isSuperAdminPersona(personaId),
        operatorSuperAdmin: isSuperAdminPersona(personaId),
        impersonation: undefined,
      }),
      applyAuthSession: (session) => set({
        authenticated: true,
        personaId: session.user.id,
        operatorUserId: session.operatorUser?.id ?? session.user.id,
        sessionPermissions: [...(session.permissions ?? [])],
        sessionSuperAdmin: session.superAdmin ?? isSuperAdminPersona(session.user.id),
        operatorSuperAdmin: session.operatorSuperAdmin
          ?? isSuperAdminPersona(session.operatorUser?.id ?? session.user.id),
        impersonation: session.impersonation,
      }),
      logout: () => set({
        authenticated: false,
        sessionPermissions: [],
        sessionSuperAdmin: false,
        operatorSuperAdmin: false,
        impersonation: undefined,
      }),
      switchPersona: (personaId) => set({ personaId }),
      createProcessInstance: (input) => {
        const state = get();
        const actor = findIdentityUser(state.personaId);
        const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === input.definitionId);
        const version = getPublishedVersion(definition);
        const canStart = Boolean(
          actor?.status === "启用" &&
          definition &&
          !definition.disabled &&
          version &&
          (isSuperAdminPersona(state.personaId) || version.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(actor.id, groupId))),
        );
        if (!actor || !definition || !version || !canStart || !hasUserPermission(actor.id, "work-launch:发起")) return null;

        const createdAt = nowText();
        const createdId = createClientUuid();
        const prefix = version.basic.instancePrefix || extractInstancePrefix(definition.code) || "FLOW";
        const formValues = applyDesignerFieldVisibility(
          version.snapshot.form.fields,
          normalizeDesignerFormValues(version.snapshot.form.fields, input.formValues),
        );
        const approvalRuntime = definition.type === "approval"
          ? buildApprovalRuntime(createdId, definition.id, version, input.assigneeByNode ?? {}, createdAt, formValues)
          : undefined;
        const firstAssigneeId = userIdByIdOrName(input.firstAssigneeId);
        const firstAssignee = firstAssigneeId ? findIdentityUser(firstAssigneeId) : undefined;
        if (definition.type === "free") {
          const allowed = (version.basic.assigneeGroups ?? []).some((groupId) =>
            firstAssigneeId ? isUserInWorkflowGroup(firstAssigneeId, groupId) : false,
          );
          if (!firstAssignee || !allowed) return null;
        }
        const title = displayValue(formValues[PROCESS_TITLE_FIELD_ID])
          || `${version.basic.name}申请`;
        const description = findFormValue(version, formValues, ["description", "摘要", "说明", "内容"]);
        const attachmentNames = [...(input.attachmentNames ?? [])];
        const created: ProcessInstance = {
          id: createdId,
          definitionId: definition.id,
          versionId: version.id,
          workflowType: definition.type,
          code: issueNextInstanceNumber(prefix, state.instances.map((item) => item.code)),
          title,
          template: version.basic.name,
          templateVersion: version.version,
          status: definition.type === "approval" ? approvalRuntime?.completed ? "已完成" : "审核中" : "进行中",
          initiator: actor.name,
          initiatorId: actor.id,
          department: actor.departmentPath,
          createdAt,
          updatedAt: createdAt,
          round: 1,
          currentNode: definition.type === "approval" ? approvalRuntime?.currentNode ?? "等待审批" : (firstAssignee?.name ?? ""),
          currentAssignee: definition.type === "free" ? firstAssignee?.name : undefined,
          currentAssigneeId: definition.type === "free" ? firstAssignee?.id : undefined,
          designatedReviewer: definition.type === "free" ? firstAssignee?.name : undefined,
          designatedReviewerId: definition.type === "free" ? firstAssignee?.id : undefined,
          priority: displayValue(formValues.priority) === "紧急" ? "紧急" : "普通",
          description,
          pdfName: attachmentNames[0] ?? "无附件",
          pdfSize: attachmentNames.length ? "待上传" : "—",
          documentCode: findFormValue(version, formValues, ["documentCode", "文件编号", "编号"]),
          documentType: findFormValue(version, formValues, ["documentType", "文件类型", "分类"]),
          documentLevel: findFormValue(version, formValues, ["documentLevel", "密级"]),
          revision: findFormValue(version, formValues, ["revision", "版本"]),
          category: findFormValue(version, formValues, ["category", "分类"]),
          participants: definition.type === "free" ? [actor.name, firstAssignee?.name ?? ""].filter(Boolean) : undefined,
          participantIds: definition.type === "free" ? [actor.id, firstAssignee?.id ?? ""].filter(Boolean) : undefined,
          reviewers: approvalRuntime?.reviewers ?? [],
          freeTimeline: definition.type === "free"
            ? [freeEntry("created", actor.name, { content: displayValue(formValues.initialContent), assignee: firstAssignee?.name })]
            : undefined,
          formValues,
          attachmentNames,
          attachmentIds: [...(input.attachmentIds ?? [])],
          attachmentIdsByField: structuredClone(input.attachmentIdsByField ?? {}),
          resubmissions: definition.type === "approval" ? [] : undefined,
        };
        const instances = [created, ...state.instances];
        set({
          instances,
          tasks: [...(approvalRuntime?.tasks ?? []), ...state.tasks],
        });
        useProcessDefinitionStore.getState().synchronizeInstanceCounts(instances);
        return createdId;
      },
      reviewInstance: (id, action, comment, documentLevel, fieldChanges, taskId) => {
        const state = get();
        const actionAt = nowText();
        const actor = findIdentityUser(state.personaId);
        const task = state.tasks.find((item) =>
          item.instanceId === id &&
          item.status === "待处理" &&
          (!taskId || item.id === taskId) &&
          (isSuperAdminPersona(state.personaId) || (actor ? isUserInWorkflowGroup(actor.id, item.permissionGroupId) : false)),
        );
        const targetInstance = state.instances.find((instance) => instance.id === id);
        const targetVersion = targetInstance ? resolveInstanceVersion(targetInstance) : undefined;
        const targetNode = targetVersion?.snapshot.flow.nodes.find((node) => node.id === task?.nodeId);
        const handlingMode = targetNode?.data?.handlingMode ?? "approval";
        const actionMatchesNode = handlingMode === "confirmation" ? action === "confirm" : action !== "confirm";
        if (
          !actor || !task || !targetInstance || !targetVersion || targetInstance.status !== "审核中" ||
          !actionMatchesNode || (action === "reject" && !comment.trim()) ||
          !hasUserPermission(actor.id, "work-task:审核")
        ) return false;

        const autoCloseOnReject = action === "reject" && targetVersion.snapshot.flow.meta?.rejectionHandling === "auto-close";
        const authorized = fieldChanges
          ? mergeAuthorizedFieldValues(targetVersion, task.nodeId, targetInstance.formValues ?? {}, fieldChanges)
          : { values: targetInstance.formValues ?? {}, changes: [] as WorkflowFieldChange[] };
        const mergedFormValues = applyDesignerFieldVisibility(targetVersion.snapshot.form.fields, authorized.values);
        const taskAction = action === "pass" ? ("通过" as const) : action === "confirm" ? ("确认" as const) : ("驳回" as const);
        const reviewerStatus = action === "pass" ? ("已通过" as const) : action === "confirm" ? ("已确认" as const) : ("已驳回" as const);

        set((current) => {
          const completedTasks = current.tasks.map((item) => item.id === task.id
            ? {
                ...item,
                status: "已完成" as const,
                completedById: actor.id,
                completedByName: actor.name,
                action: taskAction,
                comment,
                completedAt: actionAt,
                submittedFieldChanges: authorized.changes,
              }
            : item);
          const tasks = action === "reject"
            ? completedTasks.map((item) => item.instanceId === id && (item.status === "待处理" || item.status === "未激活")
              ? { ...item, status: "已取消" as const }
              : item)
            : reconcileReadyTasks(completedTasks, targetVersion, id, targetInstance.round, mergedFormValues, actionAt);
          const instances = current.instances.map((instance) => {
            if (instance.id !== id || instance.status !== "审核中") return instance;
            const reviewers = instance.reviewers.map((reviewer) => {
              if (reviewer.key === task.nodeId && reviewer.status === "待审核") {
                return {
                  ...reviewer,
                  status: reviewerStatus,
                  actionAt,
                  comment: comment || (action === "pass" ? "同意，按修订内容执行。" : action === "confirm" ? "已确认本节点。" : "请修正后重新提交。"),
                  substitute: Boolean(task.defaultAssigneeId && task.defaultAssigneeId !== actor.id),
                  name: actor.name,
                };
              }
              if (action === "reject" && reviewer.status === "待审核") return { ...reviewer, status: "已取消" as const };
              const skippedTask = tasks.find((item) => item.instanceId === id && item.round === instance.round && item.nodeId === reviewer.key && item.status === "已跳过");
              if (skippedTask && reviewer.status === "待审核") return { ...reviewer, status: "已跳过" as const, actionAt: skippedTask.conditionEvaluatedAt, conditionSummary: skippedTask.conditionSummary };
              return reviewer;
            });
            const runtimeTasks = tasks.filter((item) => item.instanceId === id && item.round === instance.round);
            const allPositive = runtimeTasks.length > 0 && runtimeTasks.every((runtimeTask) =>
              runtimeTask.status === "已跳过" || (runtimeTask.status === "已完成" && (runtimeTask.action === "通过" || runtimeTask.action === "确认")),
            );
            return {
              ...instance,
              ...synchronizedInstanceFields(targetVersion, mergedFormValues),
              ...synchronizedAttachmentFields(targetVersion, mergedFormValues),
              documentLevel: documentLevel ?? instance.documentLevel,
              formValues: mergedFormValues,
              reviewers,
              updatedAt: actionAt,
              status: action === "reject" ? (autoCloseOnReject ? ("已关闭" as const) : ("驳回待处理" as const)) : allPositive ? ("已完成" as const) : instance.status,
              currentNode: action === "reject"
                ? autoCloseOnReject ? "流程已关闭" : "等待发起方重新提交"
                : allPositive
                  ? "流程结束"
                  : tasks.filter((item) => item.instanceId === id && item.round === instance.round && item.status === "待处理").map((item) => item.nodeName).join(" / ") || "等待审批",
            };
          });
          return { instances, tasks };
        });
        return true;
      },
      reviseCompletedTask: (id, taskId, fieldChanges, comment) => {
        const state = get();
        const actor = findIdentityUser(state.personaId);
        const instance = state.instances.find((item) => item.id === id);
        const task = state.tasks.find((item) => item.id === taskId && item.instanceId === id);
        const version = instance ? resolveInstanceVersion(instance) : undefined;
        const node = version?.snapshot.flow.nodes.find((item) => item.id === task?.nodeId);
        const canRevise = Boolean(
          actor && instance && task && version && node?.data?.allowRepeatedEditing && node.data.editableFields?.length &&
          task.round === instance.round && task.status === "已完成" && (task.action === "通过" || task.action === "确认") &&
          instance.status !== "驳回待处理" && instance.status !== "已关闭" &&
          (isSuperAdminPersona(actor.id) || task.completedById === actor.id) && hasUserPermission(actor.id, "work-task:审核"),
        );
        if (!actor || !instance || !task || !version || !canRevise) return "forbidden";
        const authorized = mergeAuthorizedFieldValues(version, task.nodeId, instance.formValues ?? {}, fieldChanges);
        const nextValues = applyDesignerFieldVisibility(version.snapshot.form.fields, authorized.values);
        if (!authorized.changes.length) return "no-changes";
        const editedAt = nowText();
        set((current) => ({
          instances: current.instances.map((item) => item.id === id ? {
            ...item,
            ...synchronizedInstanceFields(version, nextValues),
            ...synchronizedAttachmentFields(version, nextValues),
            formValues: nextValues,
            updatedAt: editedAt,
          } : item),
          tasks: current.tasks.map((item) => item.id === task.id ? {
            ...item,
            fieldRevisions: [...(item.fieldRevisions ?? []), {
              id: `revision-${createClientUuid()}`,
              editedById: actor.id,
              editedByName: actor.name,
              editedAt,
              comment: comment?.trim() || undefined,
              changes: authorized.changes,
            }],
          } : item),
        }));
        return "updated";
      },
      closeInstance: (id, reason) => {
        const state = get();
        const target = state.instances.find((instance) => instance.id === id);
        if (!target) return { ok: false, reason: "not-found", message: "流程实例不存在或已被删除" };
        const version = resolveInstanceVersion(target);
        if (!version) return { ok: false, reason: "version-missing", message: "实例锁定的流程版本不存在，已禁止继续操作" };
        const actor = findIdentityUser(state.personaId);
        if (!actor || !isCloserActor(target, actor.id)) return { ok: false, reason: "forbidden", message: "当前账号不再具有关闭此流程的权限" };
        if (target.status === "已关闭") return { ok: false, reason: "invalid-state", message: "流程已经关闭" };
        if (target.status === "驳回待处理" && version.snapshot.flow.meta?.rejectionHandling === "resubmit-only") {
          return { ok: false, reason: "invalid-state", message: "当前流程规则只允许重新提交，不能关闭" };
        }
        set({
          instances: state.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  status: "已关闭",
                  currentNode: "流程已关闭",
                  updatedAt: nowText(),
                  description: `${instance.description}（关闭说明：${reason}）`,
                  reviewers: instance.reviewers.map((reviewer) =>
                    reviewer.status === "待审核" ? { ...reviewer, status: "已取消" } : reviewer,
                  ),
                }
              : instance,
          ),
          tasks: state.tasks.map((taskItem) =>
            taskItem.instanceId === id && (taskItem.status === "待处理" || taskItem.status === "未激活")
              ? { ...taskItem, status: "已取消" as const }
              : taskItem,
          ),
        });
        return { ok: true };
      },
      updateUnreviewedInstance: (id, changes) => {
          const state = get();
          const target = state.instances.find((instance) => instance.id === id);
          if (!target) return { ok: false, reason: "not-found", message: "流程实例不存在或已被删除" };
          const version = resolveInstanceVersion(target);
          if (!version) return { ok: false, reason: "version-missing", message: "实例锁定的流程版本不存在，已禁止继续操作" };
          const actor = findIdentityUser(state.personaId);
          const canEdit = Boolean(
            actor && hasUserPermission(actor.id, "work-launch:发起")
            && canEditProcessInstanceSubmission(target, actor, isSuperAdminPersona(actor.id)),
          );
          if (!canEdit) return { ok: false, reason: "forbidden", message: "只有流程创建人或超级管理员可以修改发起内容" };
          const hasReviewAction = state.tasks.some((task) => task.instanceId === id && task.round === target.round && task.status === "已完成" && Boolean(task.action));
          if (target.status !== "审核中") return { ok: false, reason: "invalid-state", message: "流程当前状态不允许修改" };
          if (hasReviewAction) return { ok: false, reason: "locked", message: "已有审核人提交结果，流程内容已经锁定" };
          const { assigneeByNode, ...instanceChanges } = changes;
          const updatedAt = nowText();
          const nextValues = applyDesignerFieldVisibility(
            version.snapshot.form.fields,
            normalizeDesignerFormValues(version.snapshot.form.fields, changes.formValues ?? target.formValues ?? {}),
          );
          const previousAssignments = Object.fromEntries(state.tasks
            .filter((task) => task.instanceId === id && task.round === target.round && task.defaultAssigneeId)
            .map((task) => [task.nodeId, task.defaultAssigneeId]));
          const runtime = buildApprovalRuntime(
            target.id,
            target.definitionId ?? legacyDefinitionId(target),
            version,
            { ...previousAssignments, ...assigneeByNode },
            updatedAt,
            nextValues,
            target.round,
          );
          set({
            instances: state.instances.map((instance) => instance.id === id ? {
              ...instance,
              ...instanceChanges,
              ...synchronizedInstanceFields(version, nextValues),
              ...synchronizedAttachmentFields(version, nextValues),
              formValues: nextValues,
              status: runtime.completed ? "已完成" : "审核中",
              currentNode: runtime.currentNode,
              reviewers: runtime.reviewers,
              updatedAt,
            } : instance),
            tasks: [...runtime.tasks, ...state.tasks.filter((task) => !(task.instanceId === id && task.round === target.round))],
          });
          return { ok: true };
        },
      republishInstance: (id, changes) => {
          const state = get();
          const target = state.instances.find((instance) => instance.id === id);
          if (!target) return { ok: false, reason: "not-found", message: "流程实例不存在或已被删除" };
          const version = resolveInstanceVersion(target);
          if (!version) return { ok: false, reason: "version-missing", message: "实例锁定的流程版本不存在，已禁止继续操作" };
          const actor = findIdentityUser(state.personaId);
          const canRepublish = Boolean(
            target.status === "驳回待处理" && actor
            && hasUserPermission(actor.id, "work-launch:发起")
            && canEditProcessInstanceSubmission(target, actor, isSuperAdminPersona(actor.id)),
          );
          if (target.status !== "驳回待处理") return { ok: false, reason: "invalid-state", message: "只有驳回待处理流程可以重新提交" };
          if (!canRepublish || !actor) return { ok: false, reason: "forbidden", message: "只有流程创建人或超级管理员可以修改并重新提交" };
          const nextRound = target.round + 1;
          const submittedAt = nowText();
          const previousAssignments = Object.fromEntries(state.tasks
            .filter((task) => task.instanceId === id && task.round === target.round && task.defaultAssigneeId)
            .map((task) => [task.nodeId, task.defaultAssigneeId]));
          const nextValues = applyDesignerFieldVisibility(
            version.snapshot.form.fields,
            normalizeDesignerFormValues(version.snapshot.form.fields, changes.formValues ?? target.formValues ?? {}),
          );
          const modifiedFields = collectModifiedFieldReferences(version, target.formValues ?? {}, nextValues);
          const freshRuntime = buildApprovalRuntime(target.id, target.definitionId ?? legacyDefinitionId(target), version, previousAssignments, submittedAt, nextValues, nextRound);
          const freshTasks = freshRuntime.tasks;
          set({
          instances: state.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  ...changes,
                  ...synchronizedInstanceFields(version, nextValues),
                  ...synchronizedAttachmentFields(version, nextValues),
                  formValues: nextValues,
                  status: freshRuntime.completed ? "已完成" : "审核中",
                  currentNode: freshRuntime.currentNode,
                  round: nextRound,
                  updatedAt: submittedAt,
                  reviewers: freshRuntime.reviewers,
                  resubmissions: [
                    ...(instance.resubmissions ?? []),
                    {
                      round: nextRound,
                      submittedAt,
                      submittedById: actor.id,
                      submittedByName: actor.name,
                      modifiedFields,
                    },
                  ],
                }
              : instance,
          ),
          tasks: [
            ...freshTasks,
            ...state.tasks.map((task) =>
              task.instanceId === id && (task.status === "待处理" || task.status === "未激活")
                ? { ...task, status: "已取消" as const }
                : task,
            ),
          ],
          });
          return { ok: true };
        },
      replyFreeFlow: (id, content, attachments) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReply =
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                (instance.participantIds?.includes(persona.id) || isSuperAdminPersona(state.personaId));
              if (instance.id !== id || !canReply) return instance;
              return {
                ...instance,
                updatedAt: actionAt,
                participants: isSuperAdminPersona(state.personaId)
                  ? instance.participants
                  : [...new Set([...(instance.participants ?? []), persona.name])],
                participantIds: isSuperAdminPersona(state.personaId)
                  ? instance.participantIds
                  : [...new Set([...(instance.participantIds ?? []), persona.id])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reply", persona.name, { content, attachments }),
                ],
              };
            }),
          };
        }),
      transferFreeFlow: (id, nextAssignee, content, attachments) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          const target = state.instances.find((instance) => instance.id === id);
          const nextAssigneeId = userIdByIdOrName(nextAssignee);
          const hasContent = Boolean(content?.trim());
          const canTransfer = Boolean(
            target
            && canUserTransferFreeFlow(target, state.personaId)
            && nextAssigneeId !== target.currentAssigneeId
            && isAllowedFreeAssignee(target, nextAssignee)
          );
          if (!target || !canTransfer) return state;
          const entries: FreeFlowEntry[] = [
            ...(target.freeTimeline ?? []),
            ...(hasContent ? [freeEntry("reply", persona.name, { content, attachments, time: actionAt })] : []),
            freeEntry("assigned", persona.name, {
              assignee: nextAssignee,
              previousAssignee: target.currentAssignee,
              time: actionAt,
            }),
          ];
          const includeActor = !isSuperAdminPersona(state.personaId);
          return {
            instances: state.instances.map((instance) =>
              instance.id === id
                ? {
                    ...instance,
                    currentAssignee: nextAssignee,
                    currentAssigneeId: nextAssigneeId,
                    designatedReviewer: nextAssignee,
                    currentNode: nextAssignee,
                    updatedAt: actionAt,
                    participants: [...new Set([...(instance.participants ?? []), ...(includeActor ? [persona.name] : []), nextAssignee])],
                    participantIds: [...new Set([...(instance.participantIds ?? []), ...(includeActor ? [persona.id] : []), ...(nextAssigneeId ? [nextAssigneeId] : [])])],
                    freeTimeline: entries,
                  }
                : instance,
            ),
          };
        }),
      editFreeFlowReply: (id, entryId, content) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const editedAt = nowText();
          const target = state.instances.find((instance) => instance.id === id);
          const targetEntry = target?.freeTimeline?.find((entry) => entry.id === entryId);
          const canEdit = target?.workflowType === "free"
            && target.status === "进行中"
            && targetEntry?.type === "reply"
            && targetEntry.actor === persona.name
            && targetEntry.content !== content;
          if (!target || !canEdit) return state;
          return {
            instances: state.instances.map((instance) => {
              if (instance.id !== id) return instance;
              return {
                ...instance,
                updatedAt: editedAt,
                freeTimeline: (instance.freeTimeline ?? []).map((entry) =>
                  entry.id === entryId && entry.type === "reply" && entry.actor === persona.name
                    ? {
                        ...entry,
                        content,
                        editedAt,
                      }
                    : entry,
                ),
              };
            }),
          };
        }),
      updateFreeFlowInitial: (id, changes) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              if (
                instance.id !== id ||
                instance.workflowType !== "free" ||
                instance.status !== "进行中" ||
                !canEditProcessInstanceSubmission(instance, persona, isSuperAdminPersona(state.personaId))
              ) return instance;
              const originalInitialContent = instance.freeTimeline?.find((entry) => entry.type === "created")?.content ?? "";
              const fieldChanges = [
                instance.title !== changes.title ? { field: "标题", before: instance.title, after: changes.title } : null,
                instance.category !== changes.category ? { field: "事项分类", before: instance.category ?? "—", after: changes.category } : null,
                instance.priority !== changes.priority ? { field: "优先级", before: instance.priority, after: changes.priority } : null,
                instance.description !== changes.description ? { field: "事项摘要", before: instance.description, after: changes.description } : null,
                originalInitialContent !== changes.initialContent ? { field: "初始说明", before: "原富文本内容", after: "新富文本内容" } : null,
              ].filter((change): change is { field: string; before: string; after: string } => Boolean(change));
              if (!fieldChanges.length) return instance;
              return {
                ...instance,
                title: changes.title,
                category: changes.category,
                documentType: changes.category,
                priority: changes.priority,
                description: changes.description,
                formValues: { ...(instance.formValues ?? {}), [PROCESS_TITLE_FIELD_ID]: changes.title },
                updatedAt: actionAt,
                freeTimeline: [
                  ...(instance.freeTimeline ?? []).map((entry) =>
                    entry.type === "created"
                      ? {
                          ...entry,
                          content: changes.initialContent,
                          editedAt: actionAt,
                          revisions: originalInitialContent !== changes.initialContent
                            ? [...(entry.revisions ?? []), { content: originalInitialContent, editedAt: actionAt }]
                            : entry.revisions,
                        }
                      : entry,
                  ),
                  freeEntry("form-edited", persona.name, {
                    content: `修改了${fieldChanges.map((change) => change.field).join("、") || "初始表单"}`,
                    fieldChanges,
                  }),
                ],
              };
            }),
          };
        }),
      closeFreeFlow: (id, reason) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canClose =
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                isCloserActor(instance, state.personaId);
              if (instance.id !== id || !canClose) return instance;
              return {
                ...instance,
                status: "已关闭",
                currentAssignee: undefined,
                currentAssigneeId: undefined,
                designatedReviewer: undefined,
                currentNode: "事项已关闭",
                updatedAt: actionAt,
                freeTimeline: [...(instance.freeTimeline ?? []), freeEntry("closed", persona.name, { content: reason })],
              };
            }),
          };
        }),
      reopenFreeFlow: (id, reason, assignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          const assigneeId = userIdByIdOrName(assignee);
          return {
            instances: state.instances.map((instance) => {
              const canReopen =
                instance.workflowType === "free" &&
                instance.status === "已关闭" &&
                (instance.participantIds?.includes(persona.id) || isStarterActor(instance, state.personaId)) &&
                isAllowedFreeAssignee(instance, assignee);
              if (instance.id !== id || !canReopen) return instance;
              return {
                ...instance,
                status: "进行中",
                currentAssignee: assignee,
                currentAssigneeId: assigneeId,
                designatedReviewer: assignee,
                currentNode: assignee,
                updatedAt: actionAt,
                participants: [...new Set([...(instance.participants ?? []), assignee])],
                participantIds: [...new Set([...(instance.participantIds ?? []), ...(assigneeId ? [assigneeId] : [])])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reopened", persona.name, { content: reason, assignee }),
                ],
              };
            }),
          };
        }),
      resetDemo: () => {
        resetInstanceNumberSequences();
        set((state) => ({
          instances: normalizedInitialInstances,
          tasks: initialTasks,
          authenticated: true,
          personaId: state.personaId,
          operatorUserId: state.operatorUserId,
          sessionPermissions: state.sessionPermissions,
          sessionSuperAdmin: state.sessionSuperAdmin,
          operatorSuperAdmin: state.operatorSuperAdmin,
          impersonation: state.impersonation,
        }));
        useProcessDefinitionStore.getState().synchronizeInstanceCounts(normalizedInitialInstances);
      },
    }),
    {
      name: "flowpilot-prototype-v5",
      version: 18,
      migrate: (persisted) => {
        const { notices: legacyNotices, ...state } = persisted as PrototypeState & { notices?: unknown };
        void legacyNotices;
        const existing = (state.instances ?? []).map((instance) => {
          const hydrated = hydrateLegacyInstance({
            ...instance,
            code: normalizeLegacyInstanceNumber(instance.code),
            templateVersion: normalizeTemplateVersion(instance.templateVersion),
          });
          const version = resolveInstanceVersion(hydrated);
          return version ? {
            ...hydrated,
            formValues: normalizeDesignerFormValues(version.snapshot.form.fields, hydrated.formValues ?? {}),
          } : hydrated;
        });
        const missingFreeInstances = normalizedInitialInstances.filter(
          (instance) => instance.workflowType === "free" && !existing.some((item) => item.id === instance.id),
        );
        const runtime = normalizePrototypeRuntimeData(
          [...existing, ...missingFreeInstances],
          Array.isArray(state.tasks) ? state.tasks : [],
        );
        return {
          ...state,
          operatorUserId: state.operatorUserId ?? state.personaId ?? "lina",
          sessionPermissions: Array.isArray(state.sessionPermissions) ? state.sessionPermissions : [],
          sessionSuperAdmin: state.sessionSuperAdmin ?? isSuperAdminPersona(state.personaId ?? ""),
          operatorSuperAdmin: state.operatorSuperAdmin
            ?? isSuperAdminPersona(state.operatorUserId ?? state.personaId ?? ""),
          impersonation: state.impersonation,
          ...runtime,
        };
      },
    },
  ),
);

useProcessDefinitionStore.getState().synchronizeInstanceCounts(usePrototypeStore.getState().instances);
