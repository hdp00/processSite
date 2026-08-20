import { http } from "msw";
import { MOCK_API_BASE_URL } from "../apiBase";
import type {
  ProcessInstanceDetail,
  WorkflowDecisionResult,
  WorkflowTaskListItem,
} from "../../api/contracts";
import type { InstanceStatus, ProcessInstance, WorkflowTask } from "../../data/types";
import { hasUserPermission } from "../../state/permissionEngine";
import { useProcessDefinitionStore } from "../../state/useProcessDefinitionStore";
import { isSuperAdminPersona, usePrototypeStore } from "../../state/usePrototypeStore";
import { isUserInWorkflowGroup } from "../../state/useIdentityStore";
import { canUserViewInstance } from "../../state/workflowAccess";
import { resolveLockedProcessVersion } from "../../state/processVersionResolver";
import { canEditProcessInstanceSubmission } from "../../utils/processInstanceAccess";
import { compareDomainTimestamps } from "../../utils/domainTime";
import { assignAttachmentsToInstance, getAttachmentRecords, reconcileAttachmentsForInstance } from "../attachmentRepository";
import { dispatchWorkflowEmailNotifications } from "./attachmentsNotifications";
import {
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  checkIfMatch,
  entityEtag,
  pageQuery,
  paginate,
  parseJsonBody,
  requireActor,
  requirePermission,
  withIdempotency,
} from "../runtime";

const API = MOCK_API_BASE_URL;

const instanceById = (id: string) => usePrototypeStore.getState().instances.find((item) => item.id === id);
const taskById = (id: string) => usePrototypeStore.getState().tasks.find((item) => item.id === id);

const resolveVersion = (instance: ProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === instance.definitionId);
  return resolveLockedProcessVersion(definition, instance);
};

const validateAttachmentReferences = async (
  request: Request,
  actorId: string,
  instance: ProcessInstance,
  attachmentIdsByField?: Record<string, string[]>,
) => {
  if (!attachmentIdsByField) return undefined;
  const version = resolveVersion(instance);
  if (!version) return apiProblem(request, 409, "INSTANCE_VERSION_MISSING", "流程版本不可用", "无法校验附件字段。 ");
  const entries = Object.entries(attachmentIdsByField);
  const ids = entries.flatMap(([, fieldIds]) => fieldIds);
  if (new Set(ids).size !== ids.length) return apiProblem(request, 422, "ATTACHMENT_REFERENCE_DUPLICATED", "附件引用重复", "同一附件只能关联到一个表单字段。 ");
  const records = await getAttachmentRecords(ids);
  if (records.length !== ids.length) return apiProblem(request, 422, "ATTACHMENT_NOT_FOUND", "附件引用无效", "部分附件不存在或已经被删除。 ");
  for (const [fieldId, fieldIds] of entries) {
    const field = version.snapshot.form.fields.find((item) => item.id === fieldId && item.type === "attachment");
    if (!field) return apiProblem(request, 422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", `字段 ${fieldId} 不属于当前流程版本。`);
    const maxCount = field.attachment?.inlinePdf ? 1 : field.attachment?.maxCount ?? 20;
    if (fieldIds.length > maxCount) return apiProblem(request, 422, "ATTACHMENT_LIMIT_REACHED", "附件数量超过限制", `“${field.label}”最多保存 ${maxCount} 个附件。`);
    const fieldRecords = records.filter((record) => fieldIds.includes(record.id));
    if (fieldRecords.some((record) => record.uploadedById !== actorId && record.instanceId !== instance.id && !isSuperAdminPersona(actorId))) {
      return apiProblem(request, 403, "ATTACHMENT_REFERENCE_FORBIDDEN", "不能使用该附件", "只能提交本人暂存或当前流程已有的附件。 ");
    }
    if (field.attachment?.inlinePdf && fieldRecords.some((record) => record.contentType !== "application/pdf" && !record.name.toLowerCase().endsWith(".pdf"))) {
      return apiProblem(request, 415, "PDF_ATTACHMENT_REQUIRED", "文件格式不支持", `“${field.label}”只允许 PDF 文件。`);
    }
  }
  return undefined;
};

const commitAttachmentReferences = async (
  instanceId: string,
  attachmentIdsByField?: Record<string, string[]>,
) => {
  if (attachmentIdsByField) await reconcileAttachmentsForInstance(instanceId, attachmentIdsByField);
};

const instanceDetail = (instance: ProcessInstance): ProcessInstanceDetail => ({
  instance: structuredClone(instance),
  tasks: structuredClone(usePrototypeStore.getState().tasks.filter((task) => task.instanceId === instance.id)),
});

const parseDateValue = (value: string) => {
  const normalized = value.replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/\s+/g, " ");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const filterInstances = (request: Request, actorId: string) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const definitionId = url.searchParams.get("definitionId");
  const status = url.searchParams.get("status") as InstanceStatus | null;
  const initiatorId = url.searchParams.get("initiatorId");
  const createdFrom = url.searchParams.get("createdFrom");
  const createdTo = url.searchParams.get("createdTo");
  const fromTime = createdFrom ? Date.parse(createdFrom) : undefined;
  const toTime = createdTo ? Date.parse(createdTo) : undefined;
  return usePrototypeStore.getState().instances
    .filter((item) => canUserViewInstance(actorId, item))
    .filter((item) => !q || `${item.code}${item.title}${item.documentCode}${item.initiator}`.toLowerCase().includes(q))
    .filter((item) => !definitionId || item.definitionId === definitionId)
    .filter((item) => !status || item.status === status)
    .filter((item) => !initiatorId || item.initiatorId === initiatorId)
    .filter((item) => {
      const time = parseDateValue(item.createdAt);
      if (time === undefined) return !createdFrom && !createdTo;
      return (!Number.isFinite(fromTime) || time >= Number(fromTime)) && (!Number.isFinite(toTime) || time <= Number(toTime));
    })
    .sort((left, right) => compareDomainTimestamps(right.createdAt, left.createdAt));
};

const ensureSessionActor = (request: Request, actorId: string) =>
  usePrototypeStore.getState().personaId === actorId
    ? undefined
    : apiProblem(request, 409, "MOCK_SESSION_ACTOR_MISMATCH", "Mock 会话身份不一致", "请切换界面身份或重新登录后再提交命令。 ");

const taskHandlingMode = (task: WorkflowTask, instance: ProcessInstance) =>
  resolveVersion(instance)?.snapshot.flow.nodes.find((node) => node.id === task.nodeId)?.data?.handlingMode ?? "approval";

const actorCanHandleTask = (actorId: string, task: WorkflowTask) =>
  isSuperAdminPersona(actorId) || isUserInWorkflowGroup(actorId, task.permissionGroupId);

const taskListItem = (task: WorkflowTask, instance: ProcessInstance, actorId: string): WorkflowTaskListItem => {
  const version = resolveVersion(instance);
  const node = version?.snapshot.flow.nodes.find((item) => item.id === task.nodeId);
  const handlingMode = node?.data?.handlingMode ?? "approval";
  const canHandle = task.status === "待处理" && instance.status === "审核中" && actorCanHandleTask(actorId, task);
  const allowedActions: WorkflowTaskListItem["allowedActions"] = [];
  if (canHandle && hasUserPermission(actorId, "work-task:审核")) {
    allowedActions.push(handlingMode === "confirmation" ? "confirm" : "pass");
    if (handlingMode === "approval" && hasUserPermission(actorId, "work-task:驳回")) allowedActions.push("reject");
  }
  if (
    task.status === "已完成" && (task.action === "通过" || task.action === "确认") &&
    node?.data?.allowRepeatedEditing && node.data.editableFields?.length && task.round === instance.round &&
    instance.status !== "驳回待处理" && instance.status !== "已关闭" &&
    (isSuperAdminPersona(actorId) || task.completedById === actorId) && hasUserPermission(actorId, "work-task:审核")
  ) allowedActions.push("revise-fields");
  return { task: structuredClone(task), instance: structuredClone(instance), handlingMode, allowedActions };
};

const findVisibleInstance = (request: Request, id: string, actorId: string) => {
  const instance = instanceById(id);
  return instance && canUserViewInstance(actorId, instance)
    ? { instance }
    : { response: apiProblem(request, 404, "INSTANCE_NOT_FOUND", "流程实例不存在", "未找到指定实例，或当前用户无权查看。") };
};

const auditInstance = (actorId: string, actorName: string, action: string, instance: ProcessInstance, summary: string, details?: Record<string, unknown>) =>
  appendAuditEvent({ category: "instance", action, actorId, actorName, resourceType: "process-instance", resourceId: instance.id, summary, details });

export const instanceTaskHandlers = [
  http.get(`${API}/process-instances`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-list:查看");
    if (auth.response) return auth.response;
    const pagination = pageQuery(request);
    if ("response" in pagination) return pagination.response;
    return apiOk(request, paginate(filterInstances(request, auth.actor.id), pagination.number, pagination.size));
  }),

  http.post(`${API}/process-instances`, async ({ request }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-launch:发起");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const body = await parseJsonBody<{
        definitionId?: string;
        formValues?: Record<string, unknown>;
        copySourceInstanceId?: string;
        assigneeByNode?: Record<string, string | undefined>;
        firstAssigneeId?: string;
        attachmentIds?: string[];
        attachmentIdsByField?: Record<string, string[]>;
      }>(request);
      if (body instanceof Response) return body;
      if (!body.definitionId || !body.formValues || typeof body.formValues !== "object") {
        return apiProblem(request, 422, "VALIDATION_FAILED", "发起数据不完整", "definitionId 和 formValues 为必填项。 ");
      }
      if (body.copySourceInstanceId) {
        const source = instanceById(body.copySourceInstanceId);
        if (!source || source.definitionId !== body.definitionId || source.status !== "已完成" || source.workflowType === "free") {
          return apiProblem(request, 409, "COPY_SOURCE_INVALID", "复制来源不可用", "来源流程必须是目标流程中仍然存在的已完成审批实例。 ");
        }
        if (!hasUserPermission(auth.actor.id, "work-list:复制新建") || !canUserViewInstance(auth.actor.id, source)) {
          return apiProblem(request, 403, "COPY_SOURCE_FORBIDDEN", "不能复制该流程", "当前账号没有复制新建权限或已失去来源流程查看权限。 ");
        }
      }
      const attachments = body.attachmentIds?.length ? await getAttachmentRecords(body.attachmentIds) : [];
      if (attachments.length !== (body.attachmentIds?.length ?? 0)) return apiProblem(request, 422, "ATTACHMENT_NOT_FOUND", "附件引用无效", "部分附件不存在或已经被删除。 ");
      const attachmentIdsByField = body.attachmentIdsByField ?? {};
      const mappedAttachmentIds = new Set(Object.values(attachmentIdsByField).flat());
      if ((body.attachmentIds ?? []).some((id) => !mappedAttachmentIds.has(id))) {
        return apiProblem(request, 422, "ATTACHMENT_FIELD_MISSING", "附件字段关联无效", "每个附件都必须关联到当前版本中的附件字段。 ");
      }
      const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === body.definitionId);
      const launchVersion = definition?.versions.find((version) => version.id === definition.publishedVersionId);
      if (!launchVersion) return apiProblem(request, 409, "DEFINITION_NOT_PUBLISHED", "流程当前不可发起", "没有可用的发布版本。 ");
      for (const [fieldId, fieldAttachmentIds] of Object.entries(attachmentIdsByField)) {
        const field = launchVersion.snapshot.form.fields.find((item) => item.id === fieldId && item.type === "attachment");
        if (!field) return apiProblem(request, 422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", `字段 ${fieldId} 不属于当前发布版本。`);
        const maxCount = field.attachment?.inlinePdf ? 1 : field.attachment?.maxCount ?? 20;
        if (fieldAttachmentIds.length > maxCount) return apiProblem(request, 422, "ATTACHMENT_LIMIT_REACHED", "附件数量超过限制", `“${field.label}”最多保存 ${maxCount} 个附件。`);
        const fieldRecords = attachments.filter((record) => fieldAttachmentIds.includes(record.id));
        if (fieldRecords.some((record) => record.uploadedById !== auth.actor.id || record.instanceId)) {
          return apiProblem(request, 403, "ATTACHMENT_REFERENCE_FORBIDDEN", "不能使用该附件", "发起流程只能提交当前用户本次暂存且尚未关联实例的附件。 ");
        }
        if (fieldRecords.some((record) => record.size > (field.attachment?.maxSizeMb ?? 100) * 1024 * 1024)) {
          return apiProblem(request, 413, "ATTACHMENT_TOO_LARGE", "附件超过大小限制", `“${field.label}”存在超过大小限制的附件。`);
        }
        if (field.attachment?.inlinePdf && fieldRecords.some((record) => record.contentType !== "application/pdf" && !record.name.toLowerCase().endsWith(".pdf"))) {
          return apiProblem(request, 415, "PDF_ATTACHMENT_REQUIRED", "文件格式不支持", `“${field.label}”只允许 PDF 文件。`);
        }
      }
      const id = usePrototypeStore.getState().createProcessInstance({
        definitionId: body.definitionId,
        formValues: body.formValues,
        assigneeByNode: body.assigneeByNode,
        firstAssigneeId: body.firstAssigneeId,
        attachmentNames: attachments.map((item) => item.name),
        attachmentIds: body.attachmentIds,
        attachmentIdsByField,
      });
      const instance = id ? instanceById(id) : undefined;
      if (!instance) return apiProblem(request, 403, "INSTANCE_CREATE_FORBIDDEN", "流程发起失败", "请确认流程已发布、账号具有发起权限且表单内容有效。 ");
      await assignAttachmentsToInstance(body.attachmentIds ?? [], instance.id, attachmentIdsByField);
      auditInstance(auth.actor.id, auth.actor.name, "create", instance, `发起流程 ${instance.code}`, body.copySourceInstanceId
        ? { copySourceInstanceId: body.copySourceInstanceId }
        : undefined);
      dispatchWorkflowEmailNotifications(request, instance.id);
      return apiOk(request, instanceDetail(instance), { status: 201, headers: { Location: `${API}/process-instances/${instance.id}`, ETag: entityEtag(instance) } });
    });
  }),

  http.get(`${API}/process-instances/:instanceId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-list:查看");
    if (auth.response) return auth.response;
    const found = findVisibleInstance(request, String(params.instanceId ?? ""), auth.actor.id);
    if ("response" in found) return found.response;
    return apiOk(request, instanceDetail(found.instance), { headers: { ETag: entityEtag(found.instance) } });
  }),

  http.patch(`${API}/process-instances/:instanceId/submission`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-launch:发起");
    if (auth.response) return auth.response;
    const mismatch = ensureSessionActor(request, auth.actor.id);
    if (mismatch) return mismatch;
    const found = findVisibleInstance(request, String(params.instanceId ?? ""), auth.actor.id);
    if ("response" in found) return found.response;
    if (!canEditProcessInstanceSubmission(found.instance, auth.actor, isSuperAdminPersona(auth.actor.id))) {
      return apiProblem(request, 403, "INSTANCE_UPDATE_FORBIDDEN", "不能修改流程", "只有流程创建人或超级管理员可以修改发起内容。 ");
    }
    const conflict = checkIfMatch(request, found.instance, true);
    if (conflict) return conflict;
    const hasDecision = usePrototypeStore.getState().tasks.some((task) => task.instanceId === found.instance.id && task.round === found.instance.round && task.status === "已完成" && Boolean(task.action));
    if (hasDecision || found.instance.status !== "审核中") return apiProblem(request, 409, "INSTANCE_CONTENT_LOCKED", "流程内容已经锁定", "首个审批或确认结果提交后不能再修改发起内容。 ");
    const body = await parseJsonBody<{ formValues?: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]>; assigneeByNode?: Record<string, string> }>(request);
    if (body instanceof Response) return body;
    if (!body.formValues) return apiProblem(request, 422, "FORM_VALUES_REQUIRED", "缺少表单内容", "formValues 为必填项。 ");
    const attachmentProblem = await validateAttachmentReferences(request, auth.actor.id, found.instance, body.attachmentIdsByField);
    if (attachmentProblem) return attachmentProblem;
    const result = usePrototypeStore.getState().updateUnreviewedInstance(found.instance.id, { formValues: body.formValues, attachmentNames: body.attachmentNames, assigneeByNode: body.assigneeByNode });
    if (!result.ok) return apiProblem(request, result.reason === "forbidden" ? 403 : 409, "INSTANCE_UPDATE_REJECTED", "流程修改失败", result.message);
    await commitAttachmentReferences(found.instance.id, body.attachmentIdsByField);
    const updated = instanceById(found.instance.id)!;
    auditInstance(auth.actor.id, auth.actor.name, "update-submission", updated, `修改未审核流程 ${updated.code}`);
    dispatchWorkflowEmailNotifications(request, updated.id);
    return apiOk(request, instanceDetail(updated), { headers: { ETag: entityEtag(updated) } });
  }),

  http.post(`${API}/process-instances/:instanceId/resubmissions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-launch:发起");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = findVisibleInstance(request, String(params.instanceId ?? ""), auth.actor.id);
      if ("response" in found) return found.response;
      if (!canEditProcessInstanceSubmission(found.instance, auth.actor, isSuperAdminPersona(auth.actor.id))) {
        return apiProblem(request, 403, "RESUBMISSION_FORBIDDEN", "无法重新提交", "只有流程创建人或超级管理员可以修改并重新提交。 ");
      }
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      if (found.instance.status !== "驳回待处理") return apiProblem(request, 409, "INSTANCE_NOT_REJECTED", "流程不在待重新提交状态", "只有驳回待处理流程可以重新提交。 ");
      const body = await parseJsonBody<{ formValues?: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]> }>(request);
      if (body instanceof Response) return body;
      if (!body.formValues) return apiProblem(request, 422, "FORM_VALUES_REQUIRED", "缺少表单内容", "formValues 为必填项。 ");
      const attachmentProblem = await validateAttachmentReferences(request, auth.actor.id, found.instance, body.attachmentIdsByField);
      if (attachmentProblem) return attachmentProblem;
      const result = usePrototypeStore.getState().republishInstance(found.instance.id, { formValues: body.formValues, attachmentNames: body.attachmentNames });
      if (!result.ok) return apiProblem(request, result.reason === "forbidden" ? 403 : 409, "RESUBMISSION_FORBIDDEN", "无法重新提交", result.message);
      await commitAttachmentReferences(found.instance.id, body.attachmentIdsByField);
      const updated = instanceById(found.instance.id)!;
      if (updated.status === "驳回待处理") return apiProblem(request, 409, "RESUBMISSION_FORBIDDEN", "无法重新提交", "当前账号没有重新提交权限或版本状态已经变化。 ");
      auditInstance(auth.actor.id, auth.actor.name, "resubmit", updated, `重新提交流程 ${updated.code}，第 ${updated.round} 轮`);
      dispatchWorkflowEmailNotifications(request, updated.id);
      return apiOk(request, instanceDetail(updated), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.post(`${API}/process-instances/:instanceId/close`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-launch:发起");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = findVisibleInstance(request, String(params.instanceId ?? ""), auth.actor.id);
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ reason?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.reason?.trim()) return apiProblem(request, 422, "REASON_REQUIRED", "关闭原因不能为空", "请填写关闭原因。 ");
      const result = usePrototypeStore.getState().closeInstance(found.instance.id, body.reason.trim());
      if (!result.ok) return apiProblem(request, result.reason === "forbidden" ? 403 : 409, "CLOSE_FORBIDDEN", "不能关闭流程", result.message);
      const updated = instanceById(found.instance.id)!;
      if (updated.status !== "已关闭") return apiProblem(request, 403, "CLOSE_FORBIDDEN", "不能关闭流程", "当前账号或流程规则不允许关闭该实例。 ");
      auditInstance(auth.actor.id, auth.actor.name, "close", updated, `关闭流程 ${updated.code}`, { reason: body.reason.trim() });
      return apiOk(request, instanceDetail(updated), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.get(`${API}/me/workflow-tasks`, async ({ request }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-task:查看");
    if (auth.response) return auth.response;
    const pagination = pageQuery(request);
    if ("response" in pagination) return pagination.response;
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const definitionId = url.searchParams.get("definitionId");
    const view = url.searchParams.get("view") ?? "pending";
    const instances = new Map(usePrototypeStore.getState().instances.map((item) => [item.id, item]));
    const items = usePrototypeStore.getState().tasks
      .map((task) => ({ task, instance: instances.get(task.instanceId) }))
      .filter((entry): entry is { task: WorkflowTask; instance: ProcessInstance } => Boolean(entry.instance))
      .filter(({ task, instance }) => canUserViewInstance(auth.actor.id, instance) && (actorCanHandleTask(auth.actor.id, task) || task.completedById === auth.actor.id))
      .filter(({ task }) => view === "all" || (view === "completed" ? task.status === "已完成" : task.status === "待处理"))
      .filter(({ task }) => !definitionId || task.definitionId === definitionId)
      .filter(({ task, instance }) => !q || `${instance.code}${instance.title}${instance.initiator}${task.nodeName}`.toLowerCase().includes(q))
      .map(({ task, instance }) => taskListItem(task, instance, auth.actor.id))
      .sort((left, right) => compareDomainTimestamps(right.task.createdAt, left.task.createdAt));
    return apiOk(request, paginate(items, pagination.number, pagination.size));
  }),

  http.get(`${API}/workflow-tasks/:taskId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-task:查看");
    if (auth.response) return auth.response;
    const task = taskById(String(params.taskId ?? ""));
    const instance = task ? instanceById(task.instanceId) : undefined;
    if (!task || !instance || !canUserViewInstance(auth.actor.id, instance) || (!actorCanHandleTask(auth.actor.id, task) && task.completedById !== auth.actor.id)) {
      return apiProblem(request, 404, "TASK_NOT_FOUND", "审核任务不存在", "未找到指定任务，或当前用户无权查看。 ");
    }
    const item = taskListItem(task, instance, auth.actor.id);
    return apiOk(request, item, { headers: { ETag: entityEtag(task) } });
  }),

  http.post(`${API}/workflow-tasks/:taskId/decision`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:审核");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const taskId = String(params.taskId ?? "");
      const task = taskById(taskId);
      const instance = task ? instanceById(task.instanceId) : undefined;
      if (!task || !instance || !actorCanHandleTask(auth.actor.id, task)) return apiProblem(request, 404, "TASK_NOT_FOUND", "审核任务不存在", "未找到当前用户可以处理的任务。 ");
      const conflict = checkIfMatch(request, task, true);
      if (conflict) return conflict;
      if (task.status !== "待处理") return apiProblem(request, 409, "TASK_ALREADY_COMPLETED", "任务已经处理", "请刷新任务详情查看最新结果。 ");
      const body = await parseJsonBody<{ action?: "pass" | "confirm" | "reject"; comment?: string; fieldValues?: Record<string, unknown>; attachmentIdsByField?: Record<string, string[]> }>(request);
      if (body instanceof Response) return body;
      if (!body.action || !["pass", "confirm", "reject"].includes(body.action)) return apiProblem(request, 422, "ACTION_INVALID", "处理动作无效", "action 必须是 pass、confirm 或 reject。 ");
      const handlingMode = taskHandlingMode(task, instance);
      if ((handlingMode === "confirmation" && body.action !== "confirm") || (handlingMode === "approval" && body.action === "confirm")) {
        return apiProblem(request, 409, "ACTION_NOT_ALLOWED_FOR_NODE", "节点不允许该处理动作", handlingMode === "confirmation" ? "确认节点只能提交确认。" : "审批节点只能通过或驳回。 ");
      }
      if (body.action === "reject" && !body.comment?.trim()) return apiProblem(request, 422, "COMMENT_REQUIRED", "驳回说明不能为空", "驳回时必须填写说明。 ");
      if (body.action === "reject" && !hasUserPermission(auth.actor.id, "work-task:驳回")) return apiProblem(request, 403, "REJECT_PERMISSION_DENIED", "没有驳回权限", "当前账号只能执行正向处理。 ");
      const attachmentProblem = await validateAttachmentReferences(request, auth.actor.id, instance, body.attachmentIdsByField);
      if (attachmentProblem) return attachmentProblem;
      const beforeTaskIds = new Map(usePrototypeStore.getState().tasks.filter((item) => item.instanceId === instance.id).map((item) => [item.id, item.status]));
      const saved = usePrototypeStore.getState().reviewInstance(instance.id, body.action, body.comment?.trim() ?? "", undefined, body.fieldValues, task.id);
      if (!saved) return apiProblem(request, 409, "TASK_DECISION_REJECTED", "任务处理失败", "任务状态、节点处理方式或权限已经变化。 ");
      await commitAttachmentReferences(instance.id, body.attachmentIdsByField);
      const updatedInstance = instanceById(instance.id)!;
      const updatedTask = taskById(task.id)!;
      const changedTasks = usePrototypeStore.getState().tasks.filter((item) => item.instanceId === instance.id && beforeTaskIds.get(item.id) !== item.status);
      const result: WorkflowDecisionResult = {
        instance: structuredClone(updatedInstance),
        task: structuredClone(updatedTask),
        activatedTaskIds: changedTasks.filter((item) => item.status === "待处理").map((item) => item.id),
        cancelledTaskIds: changedTasks.filter((item) => item.status === "已取消").map((item) => item.id),
      };
      appendAuditEvent({ category: "task", action: body.action, actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "workflow-task", resourceId: task.id, summary: `${auth.actor.name}${body.action === "pass" ? "通过" : body.action === "confirm" ? "确认" : "驳回"}节点 ${task.nodeName}`, details: { instanceId: instance.id, comment: body.comment } });
      dispatchWorkflowEmailNotifications(request, updatedInstance.id);
      return apiOk(request, result, { headers: { ETag: entityEtag(updatedTask) } });
    });
  }),

  http.post(`${API}/workflow-tasks/:taskId/field-revisions`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:审核");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const task = taskById(String(params.taskId ?? ""));
      const instance = task ? instanceById(task.instanceId) : undefined;
      if (!task || !instance) return apiProblem(request, 404, "TASK_NOT_FOUND", "审核任务不存在", "未找到指定任务。 ");
      const conflict = checkIfMatch(request, task, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ fieldValues?: Record<string, unknown>; comment?: string; attachmentIdsByField?: Record<string, string[]> }>(request);
      if (body instanceof Response) return body;
      if (!body.fieldValues || typeof body.fieldValues !== "object") return apiProblem(request, 422, "FIELD_VALUES_REQUIRED", "缺少修改字段", "fieldValues 为必填对象。 ");
      const attachmentProblem = await validateAttachmentReferences(request, auth.actor.id, instance, body.attachmentIdsByField);
      if (attachmentProblem) return attachmentProblem;
      const result = usePrototypeStore.getState().reviseCompletedTask(instance.id, task.id, body.fieldValues, body.comment);
      if (result === "forbidden") return apiProblem(request, 409, "REPEAT_EDIT_FORBIDDEN", "不允许继续修改", "节点未开启重复修改、当前用户不是实际处理人，或流程已驳回/关闭。 ");
      if (result === "no-changes") return apiProblem(request, 409, "NO_FIELD_CHANGES", "没有字段变化", "提交内容与当前值一致。 ");
      await commitAttachmentReferences(instance.id, body.attachmentIdsByField);
      const updatedInstance = instanceById(instance.id)!;
      const updatedTask = taskById(task.id)!;
      appendAuditEvent({ category: "task", action: "revise-fields", actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "workflow-task", resourceId: task.id, summary: `继续修改节点 ${task.nodeName} 的授权字段`, details: { instanceId: instance.id, comment: body.comment } });
      return apiOk(request, { instance: structuredClone(updatedInstance), task: structuredClone(updatedTask) }, { headers: { ETag: entityEtag(updatedTask) } });
    });
  }),
];
