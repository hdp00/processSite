import { create } from "zustand";
import { persist } from "zustand/middleware";
import { initialInstances, initialNotices } from "../data/mock";
import type { FreeFlowEntry, NoticeItem, ProcessInstance, WorkflowTask } from "../data/types";
import { getEffectiveVersion, useProcessDefinitionStore, type ProcessVersion } from "./useProcessDefinitionStore";
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
import { hasUserPermission } from "./permissionEngine";

type ReviewAction = "pass" | "reject";
type RepublishChanges = Partial<
  Pick<ProcessInstance, "title" | "documentCode" | "documentType" | "documentLevel" | "description" | "pdfName">
> & { formValues?: Record<string, unknown>; attachmentNames?: string[] };
export type PersonaId = string;
export const SUPER_ADMIN_PERSONA_ID: PersonaId = "superadmin";
export const isSuperAdminPersona = (personaId: PersonaId) => personaId === SUPER_ADMIN_PERSONA_ID;

export interface FreeFlowCreateInput {
  title: string;
  category: string;
  priority: ProcessInstance["priority"];
  description: string;
  initialContent: string;
  attachmentName?: string;
  assignee: string;
  instancePrefix?: string;
}

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
  instances: ProcessInstance[];
  tasks: WorkflowTask[];
  notices: NoticeItem[];
  login: (personaId?: PersonaId) => void;
  logout: () => void;
  switchPersona: (personaId: PersonaId) => void;
  markAllNoticesRead: () => void;
  createProcessInstance: (input: CreateProcessInstanceInput) => string | null;
  reviewInstance: (id: string, action: ReviewAction, comment: string, documentLevel?: string, fieldChanges?: Record<string, unknown>) => void;
  closeInstance: (id: string, reason: string) => void;
  updateUnreviewedInstance: (id: string, changes: RepublishChanges) => void;
  republishInstance: (id: string, changes: RepublishChanges) => void;
  copyCompletedInstance: (sourceId: string, title: string) => string | null;
  createFreeFlow: (input: FreeFlowCreateInput) => string;
  replyFreeFlow: (id: string, content: string) => void;
  transferFreeFlow: (id: string, content: string, nextAssignee: string) => void;
  editFreeFlowReply: (id: string, entryId: string, content: string) => void;
  updateFreeFlowInitial: (id: string, changes: FreeFlowInitialChanges) => void;
  forceReassignFreeFlow: (id: string, reason: string, assignee: string) => void;
  closeFreeFlow: (id: string, reason: string) => void;
  reopenFreeFlow: (id: string, reason: string, assignee: string) => void;
  resetDemo: () => void;
}

const nowText = () =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replaceAll("/", "-");

const normalizeTemplateVersion = (value: string) => {
  const matched = value.match(/^v(\d+)/i);
  return matched ? `V${Number(matched[1])}` : value;
};

const currentPersona = (personaId: PersonaId) => {
  const identity = findIdentityUser(personaId);
  if (identity) return { id: identity.id, name: identity.name, role: identity.roles.join("、") || identity.jobTitle };
  return personas.find((item) => item.id === personaId) ?? personas[0];
};

const legacyDefinitionId = (instance: ProcessInstance) => {
  if (instance.definitionId) return instance.definitionId;
  if (instance.workflowType === "free" || instance.template.includes("自由")) return "free-collaboration";
  if (instance.template.includes("测试报告")) return "test-report-review";
  if (instance.template.includes("供应商")) return "supplier-change-review";
  return "pdf-review";
};

const resolveInstanceVersion = (instance: ProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === legacyDefinitionId(instance));
  return definition?.versions.find((version) => version.id === instance.versionId)
    ?? definition?.versions.find((version) => version.version === normalizeTemplateVersion(instance.templateVersion))
    ?? getEffectiveVersion(definition);
};

const isStarterActor = (instance: ProcessInstance, userId: string) => {
  if (isSuperAdminPersona(userId)) return true;
  const version = resolveInstanceVersion(instance);
  return Boolean(version?.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(userId, groupId)));
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

const tasksForInstance = (instance: ProcessInstance, version?: ProcessVersion): WorkflowTask[] => {
  const definitionId = instance.definitionId ?? legacyDefinitionId(instance);
  const versionId = instance.versionId ?? version?.id ?? `${definitionId}-${normalizeTemplateVersion(instance.templateVersion).toLowerCase()}`;
  const createdAt = instance.createdAt;
  const approvalNodes = version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval" && node.data.permissionGroup) ?? [];
  if (approvalNodes.length) {
    return approvalNodes.map((node, index) => {
      const reviewer = instance.reviewers.find((item) => item.key === node.id) ?? instance.reviewers[index];
      return {
        id: `task-${instance.id}-${node.id}-r${instance.round}`,
        instanceId: instance.id,
        definitionId,
        versionId,
        nodeId: node.id,
        nodeName: node.data?.label ?? "审批",
        permissionGroupId: node.data?.permissionGroup ?? "",
        status: reviewer?.status === "待审核"
          ? "待处理"
          : reviewer?.status === "已通过" || reviewer?.status === "已驳回"
            ? "已完成"
            : "已取消",
        defaultAssigneeId: instance.designatedReviewerId,
        completedById: userIdByIdOrName(reviewer?.name),
        completedByName: reviewer?.status === "已通过" || reviewer?.status === "已驳回" ? reviewer.name : undefined,
        action: reviewer?.status === "已通过" ? "通过" : reviewer?.status === "已驳回" ? "驳回" : undefined,
        comment: reviewer?.comment,
        createdAt,
        completedAt: reviewer?.actionAt,
        round: instance.round,
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
    status: reviewer.status === "待审核" ? "待处理" : reviewer.status === "已取消" ? "已取消" : "已完成",
    completedByName: reviewer.status === "已通过" || reviewer.status === "已驳回" ? reviewer.name : undefined,
    action: reviewer.status === "已通过" ? "通过" : reviewer.status === "已驳回" ? "驳回" : undefined,
    comment: reviewer.comment,
    createdAt,
    completedAt: reviewer.actionAt,
    round: instance.round,
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

const hydrateLegacyInstance = (instance: ProcessInstance): ProcessInstance => {
  const definitionId = legacyDefinitionId(instance);
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId);
  const version = definition?.versions.find((item) => item.version === normalizeTemplateVersion(instance.templateVersion))
    ?? getEffectiveVersion(definition);
  return {
    ...instance,
    definitionId,
    versionId: instance.versionId ?? version?.id,
    initiatorId: instance.initiatorId ?? userIdByIdOrName(instance.initiator),
    formValues: instance.formValues ?? {
      title: instance.title,
      documentCode: instance.documentCode,
      documentType: instance.documentType,
      description: instance.description,
    },
    attachmentNames: instance.attachmentNames ?? (instance.pdfName && instance.pdfName !== "无附件" ? [instance.pdfName] : []),
  };
};

const initialRuntimeInstances = initialInstances.map(hydrateLegacyInstance);
const initialTasks = initialRuntimeInstances.flatMap((instance) => tasksForInstance(instance, resolveInstanceVersion(instance)));

const findFormValue = (version: ProcessVersion, values: Record<string, unknown>, preferred: string[]) => {
  const field = version.snapshot.form.fields.find((item) =>
    preferred.some((keyword) => item.id.toLowerCase().includes(keyword.toLowerCase()) || item.label.includes(keyword)),
  );
  return field ? displayValue(values[field.id]) : "";
};

const synchronizedInstanceFields = (version: ProcessVersion, values: Record<string, unknown>) => {
  const title = findFormValue(version, values, ["title", "标题"]);
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

const buildApprovalRuntime = (
  instanceId: string,
  definitionId: string,
  version: ProcessVersion,
  assigneeByNode: Record<string, string | undefined>,
  createdAt: string,
) => {
  const approvalNodes = version.snapshot.flow.nodes.filter(
    (node) => node.data?.kind === "approval" && node.data.permissionGroup,
  );
  const reviewers = approvalNodes.map((node) => {
    const groupId = node.data?.permissionGroup ?? "";
    const requestedAssigneeId = userIdByIdOrName(assigneeByNode[node.id]);
    const defaultAssigneeId = requestedAssigneeId && effectiveGroupMemberIds(groupId).includes(requestedAssigneeId)
      ? requestedAssigneeId
      : effectiveGroupMemberIds(groupId)[0];
    const defaultAssignee = findIdentityUser(defaultAssigneeId);
    return {
      key: node.id,
      name: defaultAssignee?.name ?? "待组内成员处理",
      group: useIdentityStore.getState().workflowGroups.find((group) => group.id === groupId)?.name ?? groupId,
      shortGroup: node.data?.label ?? "审批",
      status: "待审核" as const,
      defaultAssigneeId,
    };
  });
  const approvalNodeIds = new Set(approvalNodes.map((node) => node.id));
  const tasks: WorkflowTask[] = reviewers.map((reviewer) => ({
    id: `task-${instanceId}-${reviewer.key}-r1`,
    instanceId,
    definitionId,
    versionId: version.id,
    nodeId: reviewer.key,
    nodeName: reviewer.shortGroup,
    permissionGroupId: approvalNodes.find((node) => node.id === reviewer.key)?.data?.permissionGroup ?? "",
    status: version.snapshot.flow.edges.some((edge) => edge.target === reviewer.key && approvalNodeIds.has(edge.source))
      ? "未激活"
      : "待处理",
    defaultAssigneeId: reviewer.defaultAssigneeId,
    createdAt,
    round: 1,
  }));
  return {
    reviewers: reviewers.map(({ defaultAssigneeId: _defaultAssigneeId, ...reviewer }) => reviewer),
    tasks,
    currentNode: tasks.filter((task) => task.status === "待处理").map((task) => task.nodeName).join(" / ") || "等待审批",
  };
};

const activateReadyTasks = (runtimeTasks: WorkflowTask[], version: ProcessVersion, instanceId: string, round: number) => {
  const approvalIds = new Set(version.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval").map((node) => node.id));
  return runtimeTasks.map((task) => {
    if (task.instanceId !== instanceId || task.round !== round || task.status !== "未激活") return task;
    const predecessors = version.snapshot.flow.edges
      .filter((edge) => edge.target === task.nodeId && approvalIds.has(edge.source))
      .map((edge) => edge.source);
    const ready = predecessors.every((nodeId) => runtimeTasks.some((candidate) =>
      candidate.instanceId === instanceId &&
      candidate.round === round &&
      candidate.nodeId === nodeId &&
      candidate.status === "已完成" &&
      candidate.action === "通过",
    ));
    return ready ? { ...task, status: "待处理" as const } : task;
  });
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
      instances: initialRuntimeInstances,
      tasks: initialTasks,
      notices: initialNotices,
      login: (personaId = "lina") => set({ authenticated: true, personaId }),
      logout: () => set({ authenticated: false }),
      switchPersona: (personaId) => set({ personaId }),
      markAllNoticesRead: () =>
        set((state) => ({ notices: state.notices.map((notice) => ({ ...notice, read: true })) })),
      createProcessInstance: (input) => {
        const state = get();
        const actor = findIdentityUser(state.personaId);
        const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === input.definitionId);
        const version = getEffectiveVersion(definition);
        const canStart = Boolean(
          actor?.status === "启用" &&
          definition &&
          !definition.disabled &&
          version &&
          (isSuperAdminPersona(state.personaId) || version.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(actor.id, groupId))),
        );
        if (!actor || !definition || !version || !canStart || !hasUserPermission(actor.id, "work-launch:发起")) return null;

        const createdAt = nowText();
        const createdId = crypto.randomUUID();
        const prefix = version.basic.instancePrefix || extractInstancePrefix(definition.code) || "FLOW";
        const approvalRuntime = definition.type === "approval"
          ? buildApprovalRuntime(createdId, definition.id, version, input.assigneeByNode ?? {}, createdAt)
          : undefined;
        const firstAssigneeId = userIdByIdOrName(input.firstAssigneeId);
        const firstAssignee = firstAssigneeId ? findIdentityUser(firstAssigneeId) : undefined;
        if (definition.type === "free") {
          const allowed = (version.basic.assigneeGroups ?? []).some((groupId) =>
            firstAssigneeId ? isUserInWorkflowGroup(firstAssigneeId, groupId) : false,
          );
          if (!firstAssignee || !allowed) return null;
        }
        const title = findFormValue(version, input.formValues, ["title", "标题"])
          || `${version.basic.name}申请`;
        const description = findFormValue(version, input.formValues, ["description", "摘要", "说明", "内容"]);
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
          status: definition.type === "approval" ? "审核中" : "进行中",
          initiator: actor.name,
          initiatorId: actor.id,
          department: actor.departmentPath,
          createdAt,
          updatedAt: createdAt,
          round: 1,
          currentNode: definition.type === "approval" ? approvalRuntime?.currentNode ?? "等待审批" : (firstAssignee?.name ?? ""),
          currentAssignee: definition.type === "free" ? firstAssignee?.name : undefined,
          designatedReviewer: definition.type === "free" ? firstAssignee?.name : undefined,
          designatedReviewerId: definition.type === "free" ? firstAssignee?.id : undefined,
          priority: displayValue(input.formValues.priority) === "紧急" ? "紧急" : "普通",
          description,
          pdfName: attachmentNames[0] ?? "无附件",
          pdfSize: attachmentNames.length ? "待上传" : "—",
          documentCode: findFormValue(version, input.formValues, ["documentCode", "文件编号", "编号"]),
          documentType: findFormValue(version, input.formValues, ["documentType", "文件类型", "分类"]),
          documentLevel: findFormValue(version, input.formValues, ["documentLevel", "密级"]),
          revision: findFormValue(version, input.formValues, ["revision", "版本"]),
          category: findFormValue(version, input.formValues, ["category", "分类"]),
          participants: definition.type === "free" ? [actor.name, firstAssignee?.name ?? ""].filter(Boolean) : undefined,
          reviewers: approvalRuntime?.reviewers ?? [],
          freeTimeline: definition.type === "free"
            ? [freeEntry("created", actor.name, { content: displayValue(input.formValues.initialContent), assignee: firstAssignee?.name })]
            : undefined,
          formValues: structuredClone(input.formValues),
          attachmentNames,
        };
        const notice: NoticeItem = {
          id: `notice-${Date.now()}`,
          title: definition.type === "free" ? `新事项已指派给${firstAssignee?.name}` : "流程已成功发起",
          detail: title,
          time: "刚刚",
          read: false,
          instanceId: createdId,
        };
        set({
          instances: [created, ...state.instances],
          tasks: [...(approvalRuntime?.tasks ?? []), ...state.tasks],
          notices: [notice, ...state.notices],
        });
        useProcessDefinitionStore.getState().recordInstanceCreated(definition.id, version.id);
        return createdId;
      },
      reviewInstance: (id, action, comment, documentLevel, fieldChanges) =>
        set((state) => {
          const actionAt = nowText();
          const actor = findIdentityUser(state.personaId);
          const task = state.tasks.find((item) =>
            item.instanceId === id &&
            item.status === "待处理" &&
            (isSuperAdminPersona(state.personaId) || (actor ? isUserInWorkflowGroup(actor.id, item.permissionGroupId) : false)),
          );
          const actionPermission = action === "reject" ? "work-task:驳回" : "work-task:审核";
          if (!actor || !task || !hasUserPermission(actor.id, actionPermission)) return state;
          const targetInstance = state.instances.find((instance) => instance.id === id);
          const targetVersion = targetInstance ? resolveInstanceVersion(targetInstance) : undefined;
          const autoCloseOnReject = action === "reject" && targetVersion?.snapshot.flow.meta?.rejectionHandling === "auto-close";
          const completedTasks = state.tasks.map((item) => item.id === task.id
            ? {
                ...item,
                status: "已完成" as const,
                completedById: actor.id,
                completedByName: actor.name,
                action: action === "pass" ? ("通过" as const) : ("驳回" as const),
                comment,
                completedAt: actionAt,
              }
            : item);
          const tasks = action === "reject"
            ? completedTasks.map((item) => item.instanceId === id && (item.status === "待处理" || item.status === "未激活")
              ? { ...item, status: "已取消" as const }
              : item)
            : targetVersion && targetInstance
              ? activateReadyTasks(completedTasks, targetVersion, id, targetInstance.round)
              : completedTasks;
          const instances = state.instances.map((instance) => {
            if (instance.id !== id || instance.status !== "审核中") return instance;
            const reviewers = instance.reviewers.map((reviewer) => {
              if (reviewer.key === task.nodeId && reviewer.status === "待审核") {
                return {
                  ...reviewer,
                  status: action === "pass" ? ("已通过" as const) : ("已驳回" as const),
                  actionAt,
                  comment: comment || (action === "pass" ? "同意，按修订内容执行。" : "请修正后重新发布。"),
                  substitute: Boolean(task.defaultAssigneeId && task.defaultAssigneeId !== actor.id),
                  name: actor.name,
                };
              }
              if (action === "reject" && reviewer.status === "待审核") {
                return { ...reviewer, status: "已取消" as const };
              }
              return reviewer;
            });

            const allPassed = reviewers.length > 0 && reviewers.every((reviewer) => reviewer.status === "已通过");
            const mergedFormValues = fieldChanges
              ? { ...(instance.formValues ?? {}), ...structuredClone(fieldChanges) }
              : instance.formValues;
            return {
              ...instance,
              ...(targetVersion && mergedFormValues ? synchronizedInstanceFields(targetVersion, mergedFormValues) : {}),
              documentLevel: documentLevel ?? instance.documentLevel,
              formValues: mergedFormValues,
              reviewers,
              updatedAt: actionAt,
              status: action === "reject" ? (autoCloseOnReject ? ("已关闭" as const) : ("驳回待处理" as const)) : allPassed ? ("已完成" as const) : instance.status,
              currentNode: action === "reject"
                ? autoCloseOnReject ? "流程已关闭" : "等待发布方重新发布"
                : allPassed
                  ? "流程结束"
                  : tasks.filter((item) => item.instanceId === id && item.round === instance.round && item.status === "待处理").map((item) => item.nodeName).join(" / "),
            };
          });

          const target = state.instances.find((instance) => instance.id === id);
          const notice: NoticeItem = {
            id: `notice-${Date.now()}`,
            title: action === "pass" ? "审核意见已提交" : "流程已驳回文控处理",
            detail: target?.title ?? "流程状态已更新",
            time: "刚刚",
            read: false,
            instanceId: id,
          };
          return { instances, tasks, notices: [notice, ...state.notices] };
        }),
      closeInstance: (id, reason) =>
        set((state) => {
          const target = state.instances.find((instance) => instance.id === id);
          const actor = findIdentityUser(state.personaId);
          const version = target ? resolveInstanceVersion(target) : undefined;
          const canClose = Boolean(
            target && actor && target.status !== "已关闭" &&
            hasUserPermission(actor.id, "work-launch:发起") &&
            !(target.status === "驳回待处理" && version?.snapshot.flow.meta?.rejectionHandling === "resubmit-only") &&
            (isSuperAdminPersona(actor.id) || version?.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(actor.id, groupId))),
          );
          if (!canClose) return state;
          return {
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
        };
        }),
      updateUnreviewedInstance: (id, changes) =>
        set((state) => {
          const target = state.instances.find((instance) => instance.id === id);
          const actor = findIdentityUser(state.personaId);
          const version = target ? resolveInstanceVersion(target) : undefined;
          const canEdit = Boolean(
            target && actor &&
            hasUserPermission(actor.id, "work-launch:发起") &&
            (isSuperAdminPersona(actor.id) || version?.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(actor.id, groupId))),
          );
          if (!canEdit) return state;
          return { instances: state.instances.map((instance) => {
            const hasReviewAction = instance.reviewers.some(
              (reviewer) => reviewer.status === "已通过" || reviewer.status === "已驳回",
            );
            if (instance.id !== id || instance.status !== "审核中" || hasReviewAction) return instance;
            return {
              ...instance,
              ...changes,
              updatedAt: nowText(),
            };
          }),
          };
        }),
      republishInstance: (id, changes) =>
        set((state) => {
          const target = state.instances.find((instance) => instance.id === id);
          const actor = findIdentityUser(state.personaId);
          const version = target ? resolveInstanceVersion(target) : undefined;
          const canRepublish = Boolean(
            target?.status === "驳回待处理" && actor && version &&
            hasUserPermission(actor.id, "work-launch:发起") &&
            (isSuperAdminPersona(actor.id) || version.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(actor.id, groupId))),
          );
          if (!target || !version || !canRepublish) return state;
          const nextRound = target.round + 1;
          const previousAssignments = Object.fromEntries(state.tasks
            .filter((task) => task.instanceId === id && task.round === target.round && task.defaultAssigneeId)
            .map((task) => [task.nodeId, task.defaultAssigneeId]));
          const freshRuntime = buildApprovalRuntime(target.id, target.definitionId ?? legacyDefinitionId(target), version, previousAssignments, nowText());
          const freshTasks = freshRuntime.tasks.map((task) => ({ ...task, id: `task-${target.id}-${task.nodeId}-r${nextRound}`, round: nextRound }));
          return {
          instances: state.instances.map((instance) =>
            instance.id === id
              ? {
                  ...instance,
                  ...changes,
                  status: "审核中",
                  currentNode: freshRuntime.currentNode,
                  round: nextRound,
                  updatedAt: nowText(),
                  reviewers: freshRuntime.reviewers,
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
          };
        }),
      copyCompletedInstance: (sourceId, title) => {
        const source = get().instances.find((instance) => instance.id === sourceId);
        if (!source || source.status !== "已完成" || !source.definitionId || !hasUserPermission(get().personaId, "work-list:复制新建")) return null;
        const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === source.definitionId);
        const version = getEffectiveVersion(definition);
        if (!version) return null;
        const copiedValues = structuredClone(source.formValues ?? {});
        version.snapshot.form.fields.filter((field) => field.type === "attachment").forEach((field) => delete copiedValues[field.id]);
        const titleField = version.snapshot.form.fields.find((field) => field.id.toLowerCase().includes("title") || field.label.includes("标题"));
        if (titleField) copiedValues[titleField.id] = title.trim() || `${source.title}（复制）`;
        else copiedValues.title = title.trim() || `${source.title}（复制）`;
        return get().createProcessInstance({ definitionId: source.definitionId, formValues: copiedValues, attachmentNames: [] });
      },
      createFreeFlow: (input) => {
        const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.type === "free" && getEffectiveVersion(item));
        if (!definition) return "";
        return get().createProcessInstance({
          definitionId: definition.id,
          firstAssigneeId: input.assignee,
          attachmentNames: input.attachmentName ? [input.attachmentName] : [],
          formValues: {
            title: input.title,
            category: input.category,
            priority: input.priority,
            description: input.description,
            initialContent: input.initialContent,
          },
        }) ?? "";
      },
      replyFreeFlow: (id, content) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReply =
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                (instance.participants?.includes(persona.name) || isSuperAdminPersona(state.personaId));
              if (instance.id !== id || !canReply) return instance;
              return {
                ...instance,
                updatedAt: actionAt,
                participants: isSuperAdminPersona(state.personaId)
                  ? instance.participants
                  : [...new Set([...(instance.participants ?? []), persona.name])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reply", persona.name, { content }),
                ],
              };
            }),
          };
        }),
      transferFreeFlow: (id, content, nextAssignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          const target = state.instances.find((instance) => instance.id === id);
          const canTransfer =
            target?.workflowType === "free" &&
            target.status === "进行中" &&
            (target.currentAssignee === persona.name || isSuperAdminPersona(state.personaId)) &&
            isAllowedFreeAssignee(target, nextAssignee);
          if (!target || !canTransfer) return state;
          const entries: FreeFlowEntry[] = [
            ...(target.freeTimeline ?? []),
            freeEntry("reply", persona.name, { content, assignee: nextAssignee }),
            freeEntry("assigned", persona.name, { assignee: nextAssignee }),
          ];
          return {
            instances: state.instances.map((instance) =>
              instance.id === id
                ? {
                    ...instance,
                    currentAssignee: nextAssignee,
                    designatedReviewer: nextAssignee,
                    currentNode: `${nextAssignee}受理中`,
                    updatedAt: actionAt,
                    participants: [...new Set([...(instance.participants ?? []), nextAssignee])],
                    freeTimeline: entries,
                  }
                : instance,
            ),
            notices: [
              {
                id: `notice-${Date.now()}`,
                title: `${persona.name}向你转交了一项事项`,
                detail: target.title,
                time: "刚刚",
                read: false,
                instanceId: id,
              },
              ...state.notices,
            ],
          };
        }),
      editFreeFlowReply: (id, entryId, content) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const editedAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              if (instance.id !== id || instance.workflowType !== "free" || instance.status !== "进行中") return instance;
              return {
                ...instance,
                updatedAt: editedAt,
                freeTimeline: (instance.freeTimeline ?? []).map((entry) =>
                  entry.id === entryId && entry.type === "reply" && entry.actor === persona.name
                    ? {
                        ...entry,
                        content,
                        editedAt,
                        revisions: [
                          ...(entry.revisions ?? []),
                          { content: entry.content ?? "", editedAt },
                        ],
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
                instance.initiator !== persona.name
              ) return instance;
              const originalInitialContent = instance.freeTimeline?.find((entry) => entry.type === "created")?.content ?? "";
              const fieldChanges = [
                instance.title !== changes.title ? { field: "标题", before: instance.title, after: changes.title } : null,
                instance.category !== changes.category ? { field: "事项分类", before: instance.category ?? "—", after: changes.category } : null,
                instance.priority !== changes.priority ? { field: "优先级", before: instance.priority, after: changes.priority } : null,
                instance.description !== changes.description ? { field: "事项摘要", before: instance.description, after: changes.description } : null,
                originalInitialContent !== changes.initialContent ? { field: "初始说明", before: "原富文本内容", after: "新富文本内容" } : null,
              ].filter((change): change is { field: string; before: string; after: string } => Boolean(change));
              return {
                ...instance,
                title: changes.title,
                category: changes.category,
                documentType: changes.category,
                priority: changes.priority,
                description: changes.description,
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
      forceReassignFreeFlow: (id, reason, assignee) =>
        set((state) => {
          const persona = currentPersona(state.personaId);
          const actionAt = nowText();
          return {
            instances: state.instances.map((instance) => {
              const canReassign =
                instance.id === id &&
                instance.workflowType === "free" &&
                instance.status === "进行中" &&
                isStarterActor(instance, state.personaId) &&
                isAllowedFreeAssignee(instance, assignee);
              if (!canReassign) return instance;
              return {
                ...instance,
                currentAssignee: assignee,
                designatedReviewer: assignee,
                currentNode: `${assignee}受理中`,
                updatedAt: actionAt,
                participants: [...new Set([...(instance.participants ?? []), assignee])],
                freeTimeline: [
                  ...(instance.freeTimeline ?? []),
                  freeEntry("reassigned", persona.name, {
                    content: reason,
                    assignee,
                    previousAssignee: instance.currentAssignee,
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
                (instance.currentAssignee === persona.name || isStarterActor(instance, state.personaId));
              if (instance.id !== id || !canClose) return instance;
              return {
                ...instance,
                status: "已关闭",
                currentAssignee: undefined,
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
          return {
            instances: state.instances.map((instance) => {
              const canReopen =
                instance.workflowType === "free" &&
                instance.status === "已关闭" &&
                (instance.participants?.includes(persona.name) || isStarterActor(instance, state.personaId)) &&
                isAllowedFreeAssignee(instance, assignee);
              if (instance.id !== id || !canReopen) return instance;
              return {
                ...instance,
                status: "进行中",
                currentAssignee: assignee,
                designatedReviewer: assignee,
                currentNode: `${assignee}受理中`,
                updatedAt: actionAt,
                participants: [...new Set([...(instance.participants ?? []), persona.name, assignee])],
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
          instances: initialRuntimeInstances,
          tasks: initialTasks,
          notices: initialNotices,
          authenticated: true,
          personaId: state.personaId,
        }));
      },
    }),
    {
      name: "flowpilot-prototype-v5",
      version: 10,
      migrate: (persisted) => {
        const state = persisted as PrototypeState;
        const existing = (state.instances ?? []).map((instance) => hydrateLegacyInstance({
          ...instance,
          code: normalizeLegacyInstanceNumber(instance.code),
          templateVersion: normalizeTemplateVersion(instance.templateVersion),
        }));
        const missingFreeInstances = initialRuntimeInstances.filter(
          (instance) => instance.workflowType === "free" && !existing.some((item) => item.id === instance.id),
        );
        const instances = [...existing, ...missingFreeInstances];
        const tasks = Array.isArray(state.tasks) && state.tasks.length
          ? state.tasks.map((task) => task.definitionId === "test-report-review" && task.permissionGroupId.startsWith("PDF审核_")
            ? { ...task, permissionGroupId: legacyPermissionGroup(task.nodeId, task.definitionId) }
            : task)
          : instances.flatMap((instance) => tasksForInstance(instance, resolveInstanceVersion(instance)));
        return { ...state, instances, tasks };
      },
    },
  ),
);
