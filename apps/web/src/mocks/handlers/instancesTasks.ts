import { http } from "msw";
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
import { getAttachmentRecords } from "../attachmentRepository";
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

const API = "/api/v1";

const instanceById = (id: string) => usePrototypeStore.getState().instances.find((item) => item.id === id);
const taskById = (id: string) => usePrototypeStore.getState().tasks.find((item) => item.id === id);

const resolveVersion = (instance: ProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === instance.definitionId);
  return resolveLockedProcessVersion(definition, instance);
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
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
        assigneeByNode?: Record<string, string | undefined>;
        firstAssigneeId?: string;
        attachmentIds?: string[];
      }>(request);
      if (body instanceof Response) return body;
      if (!body.definitionId || !body.formValues || typeof body.formValues !== "object") {
        return apiProblem(request, 422, "VALIDATION_FAILED", "发起数据不完整", "definitionId 和 formValues 为必填项。 ");
      }
      const attachments = body.attachmentIds?.length ? await getAttachmentRecords(body.attachmentIds) : [];
      if (attachments.length !== (body.attachmentIds?.length ?? 0)) return apiProblem(request, 422, "ATTACHMENT_NOT_FOUND", "附件引用无效", "部分附件不存在或已经被删除。 ");
      const id = usePrototypeStore.getState().createProcessInstance({
        definitionId: body.definitionId,
        formValues: body.formValues,
        assigneeByNode: body.assigneeByNode,
        firstAssigneeId: body.firstAssigneeId,
        attachmentNames: attachments.map((item) => item.name),
      });
      const instance = id ? instanceById(id) : undefined;
      if (!instance) return apiProblem(request, 403, "INSTANCE_CREATE_FORBIDDEN", "流程发起失败", "请确认流程已发布、账号具有发起权限且表单内容有效。 ");
      auditInstance(auth.actor.id, auth.actor.name, "create", instance, `发起流程 ${instance.code}`);
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
    const conflict = checkIfMatch(request, found.instance, true);
    if (conflict) return conflict;
    const hasDecision = usePrototypeStore.getState().tasks.some((task) => task.instanceId === found.instance.id && task.round === found.instance.round && task.status === "已完成" && Boolean(task.action));
    if (hasDecision || found.instance.status !== "审核中") return apiProblem(request, 409, "INSTANCE_CONTENT_LOCKED", "流程内容已经锁定", "首个审批或确认结果提交后不能再修改发起内容。 ");
    const body = await parseJsonBody<{ formValues?: Record<string, unknown>; attachmentNames?: string[] }>(request);
    if (body instanceof Response) return body;
    if (!body.formValues) return apiProblem(request, 422, "FORM_VALUES_REQUIRED", "缺少表单内容", "formValues 为必填项。 ");
    const result = usePrototypeStore.getState().updateUnreviewedInstance(found.instance.id, { formValues: body.formValues, attachmentNames: body.attachmentNames });
    if (!result.ok) return apiProblem(request, result.reason === "forbidden" ? 403 : 409, "INSTANCE_UPDATE_REJECTED", "流程修改失败", result.message);
    const updated = instanceById(found.instance.id)!;
    auditInstance(auth.actor.id, auth.actor.name, "update-submission", updated, `修改未审核流程 ${updated.code}`);
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
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      if (found.instance.status !== "驳回待处理") return apiProblem(request, 409, "INSTANCE_NOT_REJECTED", "流程不在待重新提交状态", "只有驳回待处理流程可以重新提交。 ");
      const body = await parseJsonBody<{ formValues?: Record<string, unknown>; attachmentNames?: string[] }>(request);
      if (body instanceof Response) return body;
      if (!body.formValues) return apiProblem(request, 422, "FORM_VALUES_REQUIRED", "缺少表单内容", "formValues 为必填项。 ");
      const result = usePrototypeStore.getState().republishInstance(found.instance.id, { formValues: body.formValues, attachmentNames: body.attachmentNames });
      if (!result.ok) return apiProblem(request, result.reason === "forbidden" ? 403 : 409, "RESUBMISSION_FORBIDDEN", "无法重新提交", result.message);
      const updated = instanceById(found.instance.id)!;
      if (updated.status === "驳回待处理") return apiProblem(request, 409, "RESUBMISSION_FORBIDDEN", "无法重新提交", "当前账号没有重新提交权限或版本状态已经变化。 ");
      auditInstance(auth.actor.id, auth.actor.name, "resubmit", updated, `重新提交流程 ${updated.code}，第 ${updated.round} 轮`);
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

  http.post(`${API}/process-instances/:instanceId/copies`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-list:复制新建");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = findVisibleInstance(request, String(params.instanceId ?? ""), auth.actor.id);
      if ("response" in found) return found.response;
      const body = await parseJsonBody<{ title?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.title?.trim()) return apiProblem(request, 422, "TITLE_REQUIRED", "新流程标题不能为空", "请填写复制后流程的标题。 ");
      const createdId = usePrototypeStore.getState().copyCompletedInstance(found.instance.id, body.title.trim());
      const created = createdId ? instanceById(createdId) : undefined;
      if (!created) return apiProblem(request, 409, "COPY_INSTANCE_FAILED", "复制新建失败", "只有已完成流程且当前用户具有目标流程发起权限时才能复制。 ");
      auditInstance(auth.actor.id, auth.actor.name, "copy", created, `从 ${found.instance.code} 复制新建 ${created.code}`);
      return apiOk(request, instanceDetail(created), { status: 201, headers: { Location: `${API}/process-instances/${created.id}`, ETag: entityEtag(created) } });
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
      .sort((left, right) => right.task.createdAt.localeCompare(left.task.createdAt));
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
      const body = await parseJsonBody<{ action?: "pass" | "confirm" | "reject"; comment?: string; fieldValues?: Record<string, unknown> }>(request);
      if (body instanceof Response) return body;
      if (!body.action || !["pass", "confirm", "reject"].includes(body.action)) return apiProblem(request, 422, "ACTION_INVALID", "处理动作无效", "action 必须是 pass、confirm 或 reject。 ");
      const handlingMode = taskHandlingMode(task, instance);
      if ((handlingMode === "confirmation" && body.action !== "confirm") || (handlingMode === "approval" && body.action === "confirm")) {
        return apiProblem(request, 409, "ACTION_NOT_ALLOWED_FOR_NODE", "节点不允许该处理动作", handlingMode === "confirmation" ? "确认节点只能提交确认。" : "审批节点只能通过或驳回。 ");
      }
      if (body.action === "reject" && !body.comment?.trim()) return apiProblem(request, 422, "COMMENT_REQUIRED", "驳回说明不能为空", "驳回时必须填写说明。 ");
      if (body.action === "reject" && !hasUserPermission(auth.actor.id, "work-task:驳回")) return apiProblem(request, 403, "REJECT_PERMISSION_DENIED", "没有驳回权限", "当前账号只能执行正向处理。 ");
      const beforeTaskIds = new Map(usePrototypeStore.getState().tasks.filter((item) => item.instanceId === instance.id).map((item) => [item.id, item.status]));
      const saved = usePrototypeStore.getState().reviewInstance(instance.id, body.action, body.comment?.trim() ?? "", undefined, body.fieldValues, task.id);
      if (!saved) return apiProblem(request, 409, "TASK_DECISION_REJECTED", "任务处理失败", "任务状态、节点处理方式或权限已经变化。 ");
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
      const body = await parseJsonBody<{ fieldValues?: Record<string, unknown>; comment?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.fieldValues || typeof body.fieldValues !== "object") return apiProblem(request, 422, "FIELD_VALUES_REQUIRED", "缺少修改字段", "fieldValues 为必填对象。 ");
      const result = usePrototypeStore.getState().reviseCompletedTask(instance.id, task.id, body.fieldValues, body.comment);
      if (result === "forbidden") return apiProblem(request, 409, "REPEAT_EDIT_FORBIDDEN", "不允许继续修改", "节点未开启重复修改、当前用户不是实际处理人，或流程已驳回/关闭。 ");
      if (result === "no-changes") return apiProblem(request, 409, "NO_FIELD_CHANGES", "没有字段变化", "提交内容与当前值一致。 ");
      const updatedInstance = instanceById(instance.id)!;
      const updatedTask = taskById(task.id)!;
      appendAuditEvent({ category: "task", action: "revise-fields", actorId: auth.actor.id, actorName: auth.actor.name, resourceType: "workflow-task", resourceId: task.id, summary: `继续修改节点 ${task.nodeName} 的授权字段`, details: { instanceId: instance.id, comment: body.comment } });
      return apiOk(request, { instance: structuredClone(updatedInstance), task: structuredClone(updatedTask) }, { headers: { ETag: entityEtag(updatedTask) } });
    });
  }),
];
