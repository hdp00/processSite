import { http } from "msw";
import { MOCK_API_BASE_URL } from "../apiBase";
import type { ProcessInstance } from "../../data/types";
import { findIdentityUser } from "../../state/useIdentityStore";
import { isSuperAdminPersona, usePrototypeStore } from "../../state/usePrototypeStore";
import { canEditProcessInstanceSubmission } from "../../utils/processInstanceAccess";
import {
  apiOk,
  apiProblem,
  appendAuditEvent,
  applyMockScenario,
  checkIfMatch,
  entityEtag,
  parseJsonBody,
  requirePermission,
  withIdempotency,
} from "../runtime";

const API = MOCK_API_BASE_URL;

const instanceById = (id: string) => usePrototypeStore.getState().instances.find((item) => item.id === id);

const ensureFreeFlow = (request: Request, id: string) => {
  const instance = instanceById(id);
  return instance?.workflowType === "free"
    ? { instance }
    : { response: apiProblem(request, 404, "FREE_FLOW_NOT_FOUND", "自由协作事项不存在", "未找到指定的自由协作事项。") };
};

const ensureSessionActor = (request: Request, actorId: string) =>
  usePrototypeStore.getState().personaId === actorId
    ? undefined
    : apiProblem(request, 409, "MOCK_SESSION_ACTOR_MISMATCH", "Mock 会话身份不一致", "请切换界面身份或重新登录后再提交命令。 ");

const changed = (before: ProcessInstance, after?: ProcessInstance) =>
  Boolean(after && JSON.stringify(before) !== JSON.stringify(after));

const audit = (actorId: string, actorName: string, action: string, instance: ProcessInstance, summary: string, details?: Record<string, unknown>) =>
  appendAuditEvent({ category: "instance", action, actorId, actorName, resourceType: "free-flow-instance", resourceId: instance.id, summary, details });

export const freeFlowHandlers = [
  http.post(`${API}/process-instances/:instanceId/free-collaboration/replies`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:查看");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
      if ("response" in found) return found.response;
      const body = await parseJsonBody<{ content?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.content?.trim()) return apiProblem(request, 422, "CONTENT_REQUIRED", "回复内容不能为空", "请填写回复内容。 ");
      usePrototypeStore.getState().replyFreeFlow(found.instance.id, body.content);
      const updated = instanceById(found.instance.id);
      if (!changed(found.instance, updated)) return apiProblem(request, 403, "REPLY_FORBIDDEN", "不能回复该事项", "只有参与人可以在进行中的事项中回复。 ");
      audit(auth.actor.id, auth.actor.name, "reply", updated!, `回复自由协作事项 ${updated!.code}`);
      return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.post(`${API}/process-instances/:instanceId/free-collaboration/transfers`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:查看");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ nextAssigneeId?: string; content?: string }>(request);
      if (body instanceof Response) return body;
      const assignee = body.nextAssigneeId ? findIdentityUser(body.nextAssigneeId) : undefined;
      if (!assignee) return apiProblem(request, 422, "ASSIGNEE_REQUIRED", "受理人无效", "请选择有效的新受理人。 ");
      usePrototypeStore.getState().transferFreeFlow(found.instance.id, assignee.name, body.content);
      const updated = instanceById(found.instance.id);
      if (!changed(found.instance, updated)) return apiProblem(request, 403, "TRANSFER_FORBIDDEN", "不能变更受理人", "只有当前有效的发起或受理权限组成员可以变更为其他有效受理人。 ");
      audit(auth.actor.id, auth.actor.name, "transfer", updated!, `将 ${updated!.code} 的受理人变更为 ${assignee.name}`);
      return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.patch(`${API}/process-instances/:instanceId/free-collaboration/replies/:entryId`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-task:查看");
    if (auth.response) return auth.response;
    const mismatch = ensureSessionActor(request, auth.actor.id);
    if (mismatch) return mismatch;
    const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
    if ("response" in found) return found.response;
    const conflict = checkIfMatch(request, found.instance, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<{ content?: string }>(request);
    if (body instanceof Response) return body;
    if (!body.content?.trim()) return apiProblem(request, 422, "CONTENT_REQUIRED", "回复内容不能为空", "请填写回复内容。 ");
    usePrototypeStore.getState().editFreeFlowReply(found.instance.id, String(params.entryId ?? ""), body.content);
    const updated = instanceById(found.instance.id);
    if (!changed(found.instance, updated)) return apiProblem(request, 403, "EDIT_REPLY_FORBIDDEN", "不能编辑该回复", "只有回复人本人可以编辑进行中事项的回复。 ");
    audit(auth.actor.id, auth.actor.name, "edit-reply", updated!, `编辑自由协作事项 ${updated!.code} 的回复`);
    return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
  }),

  http.put(`${API}/process-instances/:instanceId/free-collaboration/initial-form`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    const auth = requirePermission(request, "work-launch:发起");
    if (auth.response) return auth.response;
    const mismatch = ensureSessionActor(request, auth.actor.id);
    if (mismatch) return mismatch;
    const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
    if ("response" in found) return found.response;
    if (!canEditProcessInstanceSubmission(found.instance, auth.actor, isSuperAdminPersona(auth.actor.id))) {
      return apiProblem(request, 403, "UPDATE_SUBMISSION_FORBIDDEN", "不能修改初始表单", "只有流程创建人或超级管理员可以修改进行中事项的初始表单。 ");
    }
    const conflict = checkIfMatch(request, found.instance, true);
    if (conflict) return conflict;
    const body = await parseJsonBody<{ title?: string; category?: string; priority?: "普通" | "紧急"; description?: string; initialContent?: string }>(request);
    if (body instanceof Response) return body;
    if (!body.title?.trim() || !body.category?.trim() || !body.description?.trim() || !body.initialContent?.trim()) return apiProblem(request, 422, "VALIDATION_FAILED", "初始表单不完整", "标题、分类、优先级、摘要和初始说明均为必填项。 ");
    usePrototypeStore.getState().updateFreeFlowInitial(found.instance.id, {
      title: body.title.trim(), category: body.category.trim(), priority: body.priority === "紧急" ? "紧急" : "普通", description: body.description.trim(), initialContent: body.initialContent,
    });
    const updated = instanceById(found.instance.id);
    if (!changed(found.instance, updated)) return apiProblem(request, 403, "UPDATE_SUBMISSION_FORBIDDEN", "不能修改初始表单", "只有流程创建人或超级管理员可以修改进行中事项的初始表单。 ");
    audit(auth.actor.id, auth.actor.name, "update-submission", updated!, `修改自由协作事项 ${updated!.code} 初始表单`);
    return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
  }),

  http.post(`${API}/process-instances/:instanceId/free-collaboration/reassignments`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-launch:发起");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ reason?: string; assigneeId?: string }>(request);
      if (body instanceof Response) return body;
      const assignee = body.assigneeId ? findIdentityUser(body.assigneeId) : undefined;
      if (!body.reason?.trim() || !assignee) return apiProblem(request, 422, "VALIDATION_FAILED", "改派内容不完整", "请填写改派原因并选择有效受理人。 ");
      usePrototypeStore.getState().forceReassignFreeFlow(found.instance.id, body.reason, assignee.name);
      const updated = instanceById(found.instance.id);
      if (!changed(found.instance, updated)) return apiProblem(request, 403, "REASSIGN_FORBIDDEN", "不能改派该事项", "只有发起流程权限组成员可以异常改派。 ");
      audit(auth.actor.id, auth.actor.name, "reassign", updated!, `将 ${updated!.code} 异常改派给 ${assignee.name}`, { reason: body.reason });
      return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.post(`${API}/process-instances/:instanceId/free-collaboration/close`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:关闭");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ reason?: string }>(request);
      if (body instanceof Response) return body;
      if (!body.reason?.trim()) return apiProblem(request, 422, "REASON_REQUIRED", "关闭原因不能为空", "请填写关闭原因。 ");
      usePrototypeStore.getState().closeFreeFlow(found.instance.id, body.reason);
      const updated = instanceById(found.instance.id);
      if (!changed(found.instance, updated)) return apiProblem(request, 403, "CLOSE_FORBIDDEN", "不能关闭该事项", "只有关闭流程权限组成员可以关闭。 ");
      audit(auth.actor.id, auth.actor.name, "close", updated!, `关闭自由协作事项 ${updated!.code}`, { reason: body.reason });
      return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
    });
  }),

  http.post(`${API}/process-instances/:instanceId/free-collaboration/reopen`, async ({ request, params }) => {
    const simulated = await applyMockScenario(request, true);
    if (simulated) return simulated;
    return withIdempotency(request, async () => {
      const auth = requirePermission(request, "work-task:查看");
      if (auth.response) return auth.response;
      const mismatch = ensureSessionActor(request, auth.actor.id);
      if (mismatch) return mismatch;
      const found = ensureFreeFlow(request, String(params.instanceId ?? ""));
      if ("response" in found) return found.response;
      const conflict = checkIfMatch(request, found.instance, true);
      if (conflict) return conflict;
      const body = await parseJsonBody<{ reason?: string; assigneeId?: string }>(request);
      if (body instanceof Response) return body;
      const assignee = body.assigneeId ? findIdentityUser(body.assigneeId) : undefined;
      if (!body.reason?.trim() || !assignee) return apiProblem(request, 422, "VALIDATION_FAILED", "重新打开内容不完整", "请填写原因并选择有效受理人。 ");
      usePrototypeStore.getState().reopenFreeFlow(found.instance.id, body.reason, assignee.name);
      const updated = instanceById(found.instance.id);
      if (!changed(found.instance, updated)) return apiProblem(request, 403, "REOPEN_FORBIDDEN", "不能重新打开该事项", "只有参与人或发起权限组成员可以重新打开。 ");
      audit(auth.actor.id, auth.actor.name, "reopen", updated!, `重新打开自由协作事项 ${updated!.code}`, { reason: body.reason, assigneeId: assignee.id });
      return apiOk(request, structuredClone(updated!), { headers: { ETag: entityEtag(updated) } });
    });
  }),
];
