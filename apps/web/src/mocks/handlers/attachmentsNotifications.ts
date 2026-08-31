import { http, HttpResponse } from "msw";
import { MOCK_API_BASE_URL } from "../apiBase";
import type {
  AttachmentRecord,
  EmailOutboxItem,
  MockScenario,
} from "../../api/contracts";
import type { ProcessInstance, WorkflowTask } from "../../data/types";
import { hasUserPermission } from "../../state/permissionEngine";
import {
  effectiveGroupMemberIds,
  findIdentityUser,
  useIdentityStore,
  type DomainUser,
} from "../../state/useIdentityStore";
import {
  useProcessDefinitionStore,
  type ProcessVersion,
} from "../../state/useProcessDefinitionStore";
import { isSuperAdminPersona, usePrototypeStore } from "../../state/usePrototypeStore";
import {
  canUserProcessTask,
  canUserViewInstance,
} from "../../state/workflowAccess";
import type { StoredDesignerField } from "../../utils/designerStorage";
import { isProcessInstanceCreator } from "../../utils/processInstanceAccess";
import { compareDomainTimestamps } from "../../utils/domainTime";
import { createClientUuid } from "../../utils/clientId";
import {
  deleteAttachment,
  getAttachmentRecords,
  getStoredAttachment,
  putAttachment,
} from "../attachmentRepository";
import {
  apiNoContent,
  apiOk,
  apiProblem,
  applyMockScenario,
  appendAuditEvent,
  checkIfMatch,
  entityEtag,
  pageQuery,
  paginate,
  readMockApiSettings,
  requestIdOf,
  requireActor,
  requirePermission,
  withIdempotency,
} from "../runtime";

const API_BASE = MOCK_API_BASE_URL;
const EMAIL_OUTBOX_KEY = "flowpilot-mock-email-outbox-v1";
const DEFAULT_MAX_ATTACHMENT_SIZE_MB = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DANGEROUS_ATTACHMENT_EXTENSIONS = new Set([
  "exe", "dll", "com", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "msi", "scr", "reg", "lnk",
]);

interface AttachmentScope {
  instance: ProcessInstance;
  version: ProcessVersion;
  field: StoredDesignerField;
}

interface ParsedUpload {
  file: File;
  instanceId?: string;
  definitionId?: string;
  versionId?: string;
  fieldId?: string;
  purpose: "form-field" | "free-reply";
}

const pathParam = (value: string | readonly string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? "" : String(value ?? "");

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

const scenarioOf = (request: Request): MockScenario => {
  const supported = new Set<MockScenario>([
    "normal",
    "slow",
    "offline",
    "server-error",
    "conflict",
    "mail-fail",
    "upload-fail",
  ]);
  const header = request.headers.get("X-Mock-Scenario") as MockScenario | null;
  const query = new URL(request.url).searchParams.get("mockScenario") as MockScenario | null;
  if (header && supported.has(header)) return header;
  if (query && supported.has(query)) return query;
  return readMockApiSettings().scenario;
};

const attachmentId = () =>
  `attachment-${createClientUuid()}`;

const resolveLockedVersion = (instance: ProcessInstance) => {
  const definition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === instance.definitionId);
  if (!definition) return undefined;
  if (instance.versionId) return definition.versions.find((version) => version.id === instance.versionId);
  return definition.versions.find((version) => version.version.toLowerCase() === instance.templateVersion.toLowerCase());
};

const configuredAttachmentField = (version: ProcessVersion, fieldId: string) =>
  version.snapshot.form.fields.find((field) => field.id === fieldId && field.type === "attachment");

const valueNames = (value: unknown) => Array.isArray(value)
  ? value.flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [item] : [];
      if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
        return item.name.trim() ? [item.name] : [];
      }
      return [];
    })
  : [];

const attachmentValues = (value: unknown) => Array.isArray(value) ? value : [];

const attachmentReference = (record: AttachmentRecord) => ({
  id: record.id,
  name: record.name,
  size: record.size,
  contentType: record.contentType,
});

const attachmentNamesFor = (version: ProcessVersion, values: Record<string, unknown>) =>
  version.snapshot.form.fields
    .filter((field) => field.type === "attachment")
    .flatMap((field) => valueNames(values[field.id]));

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const synchronizeInstanceAttachment = (
  instanceIdValue: string,
  version: ProcessVersion,
  fieldId: string,
  references: unknown[],
  primarySize?: number,
) => {
  let updated = false;
  usePrototypeStore.setState((state) => ({
    instances: state.instances.map((instance) => {
      if (instance.id !== instanceIdValue) return instance;
      const formValues = { ...(instance.formValues ?? {}), [fieldId]: references };
      const attachmentNames = attachmentNamesFor(version, formValues);
      const firstAttachmentFieldId = version.snapshot.form.fields.find((field) => field.type === "attachment")?.id;
      updated = true;
      return {
        ...instance,
        formValues,
        attachmentNames,
        pdfName: attachmentNames[0] ?? "无附件",
        pdfSize: attachmentNames.length
          ? firstAttachmentFieldId === fieldId && primarySize !== undefined
            ? formatFileSize(primarySize)
            : instance.pdfSize === "—" ? "待上传" : instance.pdfSize
          : "—",
        updatedAt: nowText(),
      };
    }),
  }));
  return updated;
};

const actorOwnsInstance = (actor: DomainUser, instance: ProcessInstance) =>
  isProcessInstanceCreator(instance, actor);

const canModifyAttachmentField = (
  actor: DomainUser,
  instance: ProcessInstance,
  version: ProcessVersion,
  field: StoredDesignerField,
) => {
  if (isSuperAdminPersona(actor.id)) return true;
  const tasks = usePrototypeStore.getState().tasks.filter((task) => task.instanceId === instance.id && task.round === instance.round);
  const hasReviewResult = tasks.some((task) => task.status === "已完成" && Boolean(task.action));
  const initiatorMayEdit = actorOwnsInstance(actor, instance)
    && hasUserPermission(actor.id, "work-launch:发起")
    && (field.inputStage ?? "initiator") !== "reviewer"
    && ((instance.status === "审核中" && !hasReviewResult) || instance.status === "驳回待处理");
  if (initiatorMayEdit) return true;

  if (instance.workflowType === "free" && instance.status === "进行中") {
    return (instance.currentAssigneeId === actor.id || actorOwnsInstance(actor, instance))
      && (hasUserPermission(actor.id, "work-task:审核") || hasUserPermission(actor.id, "work-launch:发起"));
  }

  const pendingTask = tasks.find((task) => {
    const node = version.snapshot.flow.nodes.find((item) => item.id === task.nodeId)?.data;
    return task.status === "待处理" && node?.editableFields?.includes(field.id) && canUserProcessTask(actor.id, task);
  });
  if (pendingTask) return true;

  return instance.status !== "驳回待处理" && instance.status !== "已关闭" && tasks.some((task) => {
    const node = version.snapshot.flow.nodes.find((item) => item.id === task.nodeId)?.data;
    return task.status === "已完成"
      && (task.action === "通过" || task.action === "确认")
      && task.completedById === actor.id
      && Boolean(node?.allowRepeatedEditing && node.editableFields?.includes(field.id));
  });
};

const findAttachmentScope = (
  request: Request,
  actor: DomainUser,
  instanceIdValue: string,
  fieldIdValue: string,
): AttachmentScope | Response => {
  const instance = usePrototypeStore.getState().instances.find((item) => item.id === instanceIdValue);
  if (!instance) return apiProblem(request, 404, "INSTANCE_NOT_FOUND", "流程实例不存在", "未找到指定的流程实例。 ");
  const version = resolveLockedVersion(instance);
  if (!version) {
    return apiProblem(request, 409, "LOCKED_VERSION_NOT_FOUND", "流程版本不可用", "实例锁定的流程版本不存在，无法校验附件字段。 ");
  }
  const field = configuredAttachmentField(version, fieldIdValue);
  if (!field) {
    return apiProblem(request, 422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", "指定字段不是该实例锁定版本中的附件字段。", {
      errors: [{ path: "fieldId", code: "NOT_ATTACHMENT_FIELD", message: "请选择有效的附件字段。" }],
    });
  }
  if (!canModifyAttachmentField(actor, instance, version, field)) {
    return apiProblem(request, 403, "ATTACHMENT_EDIT_FORBIDDEN", "不能修改此附件", "当前账号、实例状态或节点授权不允许修改该附件字段。 ");
  }
  return { instance, version, field };
};

const parseUpload = async (request: Request): Promise<ParsedUpload | Response> => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiProblem(request, 400, "INVALID_MULTIPART_BODY", "上传内容无效", "请求体必须是 multipart/form-data。 ");
  }
  const candidate = form.get("file");
  if (!(candidate instanceof File)) {
    return apiProblem(request, 422, "ATTACHMENT_FILE_REQUIRED", "缺少附件文件", "multipart 请求必须包含名为 file 的文件。", {
      errors: [{ path: "file", code: "REQUIRED", message: "请选择要上传的文件。" }],
    });
  }
  const instanceIdValue = String(form.get("instanceId") ?? "").trim() || undefined;
  const definitionIdValue = String(form.get("definitionId") ?? "").trim() || undefined;
  const versionIdValue = String(form.get("versionId") ?? "").trim() || undefined;
  const fieldIdValue = String(form.get("fieldId") ?? "").trim() || undefined;
  const purposeValue = String(form.get("purpose") ?? "form-field").trim();
  if (purposeValue !== "form-field" && purposeValue !== "free-reply") {
    return apiProblem(request, 422, "ATTACHMENT_PURPOSE_INVALID", "附件用途无效", "purpose 只支持 form-field 或 free-reply。 ");
  }
  if (purposeValue === "free-reply") {
    if (!instanceIdValue || definitionIdValue || versionIdValue || fieldIdValue) {
      return apiProblem(request, 422, "ATTACHMENT_SCOPE_INCOMPLETE", "附件范围无效", "回复附件只需要提供 instanceId 和 purpose=free-reply。 ");
    }
    return {
      file: candidate,
      instanceId: instanceIdValue,
      purpose: "free-reply",
    };
  }
  const hasInstanceScope = Boolean(instanceIdValue);
  const hasDefinitionScope = Boolean(definitionIdValue || versionIdValue);
  if ((hasInstanceScope && (!fieldIdValue || hasDefinitionScope)) || (hasDefinitionScope && (!definitionIdValue || !versionIdValue || !fieldIdValue))) {
    return apiProblem(request, 422, "ATTACHMENT_SCOPE_INCOMPLETE", "附件范围不完整", "instanceId 与 fieldId 必须同时提供或同时省略。", {
      errors: [{ path: "instanceId/fieldId", code: "PAIR_REQUIRED", message: "请同时提供实例和字段。" }],
    });
  }
  if (!candidate.name.trim()) {
    return apiProblem(request, 422, "ATTACHMENT_NAME_REQUIRED", "文件名无效", "上传文件必须具有有效名称。 ");
  }
  return { file: candidate, instanceId: instanceIdValue, definitionId: definitionIdValue, versionId: versionIdValue, fieldId: fieldIdValue, purpose: "form-field" };
};

const validateFile = async (
  request: Request,
  file: File,
  field?: StoredDesignerField,
) => {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (DANGEROUS_ATTACHMENT_EXTENSIONS.has(extension)) {
    return apiProblem(request, 415, "DANGEROUS_ATTACHMENT_TYPE", "文件类型不安全", "系统禁止上传可执行文件、脚本或快捷方式。", {
      errors: [{ path: "file", code: "DANGEROUS_TYPE", message: `不允许上传 .${extension} 文件。` }],
    });
  }
  const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isExecutable = signature[0] === 0x4d && signature[1] === 0x5a;
  if (isExecutable) {
    return apiProblem(request, 415, "DANGEROUS_ATTACHMENT_SIGNATURE", "文件内容不安全", "文件内容被识别为 Windows 可执行文件，与文件名无关。 ");
  }
  const maxSizeMb = field?.attachment?.maxSizeMb ?? DEFAULT_MAX_ATTACHMENT_SIZE_MB;
  if (file.size > maxSizeMb * 1024 * 1024) {
    return apiProblem(request, 413, "ATTACHMENT_TOO_LARGE", "附件超过大小限制", `单个文件不能超过 ${maxSizeMb} MB。`, {
      errors: [{ path: "file", code: "MAX_SIZE", message: `文件大小上限为 ${maxSizeMb} MB。` }],
    });
  }
  const allowedExtensions = field?.attachment?.allowedExtensions ?? [];
  const isConvertedPdf = Boolean(field?.attachment?.excelToPdf && extension === "pdf");
  if (allowedExtensions.length && !allowedExtensions.includes(extension) && !isConvertedPdf) {
    return apiProblem(request, 415, "ATTACHMENT_EXTENSION_NOT_ALLOWED", "文件格式不支持", `该字段只允许 ${allowedExtensions.join("、")} 文件。`);
  }
  const hasPdfSignature = String.fromCharCode(...signature.slice(0, 5)) === "%PDF-";
  if (extension === "pdf" && !hasPdfSignature) {
    return apiProblem(request, 415, "PDF_SIGNATURE_INVALID", "PDF 内容无效", "文件扩展名为 PDF，但内容签名不是有效的 PDF。 ");
  }
  if (field?.attachment?.inlinePdf) {
    const hasPdfName = file.name.toLowerCase().endsWith(".pdf");
    const hasPdfType = !file.type || file.type.toLowerCase() === "application/pdf";
    if (!hasPdfName || !hasPdfType) {
      return apiProblem(request, 415, "PDF_ATTACHMENT_REQUIRED", "文件格式不支持", "该字段用于页面内 PDF 显示，只能上传 PDF 文件。", {
        errors: [{ path: "file", code: "PDF_REQUIRED", message: "请选择 PDF 文件。" }],
      });
    }
  }
  return undefined;
};

const attachmentRecord = (file: File, actor: DomainUser, scope?: { instanceId: string; fieldId: string }): AttachmentRecord => ({
  id: attachmentId(),
  name: file.name,
  size: file.size,
  contentType: file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : file.type || "application/octet-stream",
  uploadedById: actor.id,
  uploadedAt: new Date().toISOString(),
  lifecycle: scope ? "active" : "temporary",
  ...scope,
});

const canReadAttachment = (actor: DomainUser, record: AttachmentRecord) => {
  if (isSuperAdminPersona(actor.id) || record.uploadedById === actor.id) return true;
  if (!record.instanceId) return false;
  const instance = usePrototypeStore.getState().instances.find((item) => item.id === record.instanceId);
  return Boolean(instance && canUserViewInstance(actor.id, instance));
};

const storageProblem = (request: Request, error: unknown) =>
  apiProblem(
    request,
    500,
    "ATTACHMENT_STORAGE_ERROR",
    "附件存储失败",
    error instanceof Error ? error.message : "Mock 附件存储发生未知错误。",
  );

const outboxStorageProblem = (request: Request, error: unknown) =>
  apiProblem(
    request,
    500,
    "EMAIL_OUTBOX_STORAGE_ERROR",
    "邮件通知记录读取失败",
    error instanceof Error ? error.message : "Mock 邮件 outbox 发生未知错误。",
  );

const recordAudit = (event: Parameters<typeof appendAuditEvent>[0]) => {
  try {
    appendAuditEvent(event);
  } catch {
    // 审计存储空间不足时不应让已完成的业务写操作变成可重试失败。
  }
};

const readStoredOutbox = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EMAIL_OUTBOX_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as EmailOutboxItem[] : [];
  } catch {
    return [];
  }
};

const writeStoredOutbox = (items: EmailOutboxItem[]) => {
  window.localStorage.setItem(EMAIL_OUTBOX_KEY, JSON.stringify(items));
};

const validRecipients = (userIds: string[]) => {
  const users = useIdentityStore.getState().users;
  const seenEmails = new Set<string>();
  return userIds.flatMap((userId) => {
    const user = users.find((item) => item.id === userId);
    const email = user?.email.trim().toLowerCase() ?? "";
    if (!user || user.status !== "启用" || !EMAIL_PATTERN.test(email) || seenEmails.has(email)) return [];
    seenEmails.add(email);
    return [{ user, email }];
  });
};

const taskRecipientIds = (task: WorkflowTask, notifyReviewers: boolean, extraUserIds: string[]) => [
  ...(notifyReviewers
    ? task.defaultAssigneeId ? [task.defaultAssigneeId] : effectiveGroupMemberIds(task.permissionGroupId)
    : []),
  ...extraUserIds,
];

const initiatorIdOf = (instance: ProcessInstance) =>
  instance.initiatorId
  ?? useIdentityStore.getState().users.find((user) => user.name === instance.initiator)?.id;

const makeDelivery = (
  id: string,
  kind: EmailOutboxItem["kind"],
  instance: ProcessInstance,
  recipient: { user: DomainUser; email: string },
  details: Pick<EmailOutboxItem, "taskId" | "nodeId">,
): EmailOutboxItem => ({
  id,
  kind,
  instanceId: instance.id,
  ...details,
  recipientUserId: recipient.user.id,
  recipientName: recipient.user.name,
  email: recipient.email,
  status: "queued",
  attempts: 0,
  createdAt: new Date().toISOString(),
});

const deriveOutboxCandidates = (instanceId?: string) => {
  const { instances, tasks } = usePrototypeStore.getState();
  const candidates: EmailOutboxItem[] = [];
  tasks
    .filter((task) => !instanceId || task.instanceId === instanceId)
    .filter((task) => task.status === "待处理")
    .forEach((task) => {
      const instance = instances.find((item) => item.id === task.instanceId);
      const version = instance ? resolveLockedVersion(instance) : undefined;
      const node = version?.snapshot.flow.nodes.find((item) => item.id === task.nodeId);
      const notification = node?.data?.emailNotification;
      if (!instance || node?.data?.kind !== "approval" || !notification?.enabled) return;
      validRecipients(taskRecipientIds(task, Boolean(notification.notifyReviewers), notification.extraUserIds ?? []))
        .forEach((recipient) => {
          candidates.push(makeDelivery(
            `email:task-activated:${task.id}:${recipient.user.id}`,
            "task-activated",
            instance,
            recipient,
            { taskId: task.id, nodeId: task.nodeId },
          ));
        });
    });

  instances.filter((instance) => (!instanceId || instance.id === instanceId) && instance.status === "已完成").forEach((instance) => {
    const version = resolveLockedVersion(instance);
    version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "end").forEach((node) => {
      const notification = node.data?.emailNotification;
      if (!notification?.enabled) return;
      const initiatorId = notification.notifyInitiator ? initiatorIdOf(instance) : undefined;
      validRecipients([...(initiatorId ? [initiatorId] : []), ...(notification.extraUserIds ?? [])])
        .forEach((recipient) => {
          candidates.push(makeDelivery(
            `email:process-completed:${instance.id}:${node.id}:${recipient.user.id}`,
            "process-completed",
            instance,
            recipient,
            { nodeId: node.id },
          ));
        });
    });
  });
  return candidates;
};

export const dispatchWorkflowEmailNotifications = (request: Request, instanceId?: string) => {
  const { instances, tasks } = usePrototypeStore.getState();
  const instanceIds = new Set(instances.map((instance) => instance.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const existing = readStoredOutbox().filter((item) =>
    instanceIds.has(item.instanceId) && (!item.taskId || taskIds.has(item.taskId)),
  );
  const byId = new Map(existing.map((item) => [item.id, item]));
  const added: EmailOutboxItem[] = [];
  deriveOutboxCandidates(instanceId).forEach((candidate) => {
    if (byId.has(candidate.id)) return;
    byId.set(candidate.id, candidate);
    added.push(candidate);
  });

  const scenario = scenarioOf(request);
  const dispatchedAt = new Date().toISOString();
  const items = Array.from(byId.values()).map((item) => {
    if (item.status !== "queued") return item;
    return scenario === "mail-fail"
      ? { ...item, status: "failed" as const, attempts: item.attempts + 1, lastError: "模拟邮件网关连接失败" }
      : { ...item, status: "sent" as const, attempts: item.attempts + 1, sentAt: dispatchedAt, lastError: undefined };
  });
  writeStoredOutbox(items);
  added.forEach((item) => recordAudit({
    category: item.kind === "task-activated" ? "task" : "instance",
    action: "email.delivery-created",
    resourceType: "email-delivery",
    resourceId: item.id,
    summary: `已为 ${item.recipientName} 生成${item.kind === "task-activated" ? "节点待办" : "流程完成"}邮件通知`,
    details: { instanceId: item.instanceId, taskId: item.taskId, nodeId: item.nodeId, email: item.email },
  }));
  return items;
};

const updateOutboxItem = (delivery: EmailOutboxItem) => {
  const items = readStoredOutbox();
  writeStoredOutbox(items.map((item) => item.id === delivery.id ? delivery : item));
};

const uploadHandler = http.post(`${API_BASE}/attachments`, async ({ request }) => {
  const scenarioResponse = await applyMockScenario(request, true);
  if (scenarioResponse) return scenarioResponse;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  const actor = authenticated.actor;
  if (scenarioOf(request) === "upload-fail") {
    return apiProblem(request, 503, "UPLOAD_STORAGE_UNAVAILABLE", "附件上传失败", "模拟附件存储服务当前不可用，请稍后重试。 ");
  }

  return withIdempotency(request, async () => {
    const parsed = await parseUpload(request);
    if (parsed instanceof Response) return parsed;
    if (parsed.purpose === "free-reply") {
      const instance = usePrototypeStore.getState().instances.find((item) => item.id === parsed.instanceId);
      const canReply = instance?.workflowType === "free"
        && instance.status === "进行中"
        && (isSuperAdminPersona(actor.id) || instance.participantIds?.includes(actor.id));
      if (!canReply) {
        return apiProblem(request, 403, "FREE_REPLY_FORBIDDEN", "不能回复该事项", "只有发起人、当前受理人或历史参与人可以上传回复附件。 ");
      }
    } else if (!hasUserPermission(actor.id, "work-launch:发起") && !hasUserPermission(actor.id, "work-task:审核")) {
      return apiProblem(request, 403, "ATTACHMENT_UPLOAD_FORBIDDEN", "不能上传附件", "当前账号没有发起流程或处理审核任务的权限。 ");
    }
    let scope: AttachmentScope | undefined;
    if (parsed.instanceId && parsed.fieldId) {
      const result = findAttachmentScope(request, actor, parsed.instanceId, parsed.fieldId);
      if (result instanceof Response) return result;
      scope = result;
    }
    const definitionVersion = parsed.definitionId && parsed.versionId
      ? useProcessDefinitionStore.getState().definitions.find((item) => item.id === parsed.definitionId)?.versions.find((item) => item.id === parsed.versionId)
      : undefined;
    const policyField = scope?.field ?? (definitionVersion && parsed.fieldId ? configuredAttachmentField(definitionVersion, parsed.fieldId) : undefined);
    if ((parsed.definitionId || parsed.versionId) && !policyField) {
      return apiProblem(request, 422, "ATTACHMENT_FIELD_INVALID", "附件字段无效", "上传范围不是指定流程版本中的附件字段。 ");
    }
    const validation = await validateFile(request, parsed.file, policyField);
    if (validation) return validation;

    try {
      if (scope && parsed.instanceId && parsed.fieldId) {
        const records = await getAttachmentRecords();
        const scopedRecords = records.filter((record) => record.instanceId === parsed.instanceId && record.fieldId === parsed.fieldId);
        const currentNames = valueNames(scope.instance.formValues?.[parsed.fieldId]);
        const maxCount = scope.field.attachment?.inlinePdf ? 1 : scope.field.attachment?.maxCount ?? 20;
        if (scope.field.attachment?.inlinePdf && (scopedRecords.length || currentNames.length)) {
          return apiProblem(request, 409, "ATTACHMENT_REPLACE_REQUIRED", "该字段只保留一个 PDF", "请使用附件替换接口上传新文件。 ");
        }
        if (Math.max(scopedRecords.length, currentNames.length) >= maxCount) {
          return apiProblem(request, 409, "ATTACHMENT_LIMIT_REACHED", "附件数量已达上限", `该字段最多保存 ${maxCount} 个附件。`);
        }
        if (currentNames.includes(parsed.file.name)) {
          return apiProblem(request, 409, "ATTACHMENT_NAME_EXISTS", "文件名重复", "该字段已存在同名附件，请重命名后上传。 ");
        }
      }

      const record = parsed.purpose === "free-reply"
        ? { ...attachmentRecord(parsed.file, actor), instanceId: parsed.instanceId, purpose: "free-reply" as const }
        : attachmentRecord(parsed.file, actor, parsed.instanceId && parsed.fieldId
          ? { instanceId: parsed.instanceId, fieldId: parsed.fieldId }
          : undefined);
      await putAttachment({ record, blob: parsed.file });
      if (scope && parsed.instanceId && parsed.fieldId) {
        const references = [...attachmentValues(scope.instance.formValues?.[parsed.fieldId]), attachmentReference(record)];
        if (!synchronizeInstanceAttachment(parsed.instanceId, scope.version, parsed.fieldId, references, record.size)) {
          await deleteAttachment(record.id);
          return apiProblem(request, 409, "INSTANCE_CHANGED", "流程实例已变化", "附件已回滚，请刷新流程实例后重试。 ");
        }
      }
      recordAudit({
        category: "instance",
        action: "attachment.upload",
        actorId: actor.id,
        actorName: actor.name,
        resourceType: "attachment",
        resourceId: record.id,
        summary: `上传附件 ${record.name}`,
        details: { instanceId: record.instanceId, fieldId: record.fieldId, size: record.size, contentType: record.contentType },
      });
      return apiOk(request, record, { status: 201, headers: { ETag: entityEtag(record) } });
    } catch (error) {
      return storageProblem(request, error);
    }
  });
});

const attachmentMetadataHandler = http.get(`${API_BASE}/attachments/:attachmentId`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request);
  if (scenarioResponse) return scenarioResponse;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  try {
    const stored = await getStoredAttachment(pathParam(params.attachmentId));
    if (!stored) return apiProblem(request, 404, "ATTACHMENT_NOT_FOUND", "附件不存在", "未找到指定附件，文件可能已被替换或删除。 ");
    if (!canReadAttachment(authenticated.actor, stored.record)) {
      return apiProblem(request, 403, "ATTACHMENT_READ_FORBIDDEN", "不能访问附件", "当前账号无权查看该附件。 ");
    }
    return apiOk(request, stored.record, { headers: { ETag: entityEtag(stored.record) } });
  } catch (error) {
    return storageProblem(request, error);
  }
});

const attachmentContentHandler = http.get(`${API_BASE}/attachments/:attachmentId/content`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request);
  if (scenarioResponse) return scenarioResponse;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  try {
    const stored = await getStoredAttachment(pathParam(params.attachmentId));
    if (!stored) return apiProblem(request, 404, "ATTACHMENT_NOT_FOUND", "附件不存在", "未找到指定附件内容，文件可能已被替换或删除。 ");
    if (!canReadAttachment(authenticated.actor, stored.record)) {
      return apiProblem(request, 403, "ATTACHMENT_READ_FORBIDDEN", "不能下载附件", "当前账号无权下载该附件。 ");
    }
    return new HttpResponse(stored.blob, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(stored.record.name)}`,
        "Content-Length": String(stored.record.size),
        "Content-Type": stored.record.contentType,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Request-Id": requestIdOf(request),
      },
    });
  } catch (error) {
    return storageProblem(request, error);
  }
});

const deleteAttachmentHandler = http.delete(`${API_BASE}/attachments/:attachmentId`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request, true);
  if (scenarioResponse) return scenarioResponse;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  try {
    const stored = await getStoredAttachment(pathParam(params.attachmentId));
    if (!stored) return apiProblem(request, 404, "ATTACHMENT_NOT_FOUND", "附件不存在", "未找到指定附件，文件可能已被替换或删除。 ");
    const etagProblem = checkIfMatch(request, stored.record);
    if (etagProblem) return etagProblem;
    let scope: AttachmentScope | undefined;
    if (stored.record.instanceId && stored.record.fieldId) {
      const result = findAttachmentScope(request, authenticated.actor, stored.record.instanceId, stored.record.fieldId);
      if (result instanceof Response) return result;
      scope = result;
    } else if (stored.record.uploadedById !== authenticated.actor.id && !isSuperAdminPersona(authenticated.actor.id)) {
      return apiProblem(request, 403, "ATTACHMENT_DELETE_FORBIDDEN", "不能删除附件", "只有上传人可以删除尚未关联流程实例的附件。 ");
    }

    await deleteAttachment(stored.record.id);
    if (scope && stored.record.instanceId && stored.record.fieldId) {
      const references = attachmentValues(scope.instance.formValues?.[stored.record.fieldId])
        .filter((value) => {
          if (typeof value === "string") return value !== stored.record.name && value !== stored.record.id;
          return !(value && typeof value === "object" && (("id" in value && value.id === stored.record.id) || ("name" in value && value.name === stored.record.name)));
        });
      if (!synchronizeInstanceAttachment(stored.record.instanceId, scope.version, stored.record.fieldId, references)) {
        await putAttachment(stored);
        return apiProblem(request, 409, "INSTANCE_CHANGED", "流程实例已变化", "附件删除已回滚，请刷新后重试。 ");
      }
    }
    recordAudit({
      category: "instance",
      action: "attachment.delete",
      actorId: authenticated.actor.id,
      actorName: authenticated.actor.name,
      resourceType: "attachment",
      resourceId: stored.record.id,
      summary: `删除附件 ${stored.record.name}`,
      details: { instanceId: stored.record.instanceId, fieldId: stored.record.fieldId },
    });
    return apiNoContent(request);
  } catch (error) {
    return storageProblem(request, error);
  }
});

const replaceAttachmentHandler = http.put(`${API_BASE}/process-instances/:instanceId/fields/:fieldId/attachment`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request, true);
  if (scenarioResponse) return scenarioResponse;
  const authenticated = requireActor(request);
  if (authenticated.response) return authenticated.response;
  if (scenarioOf(request) === "upload-fail") {
    return apiProblem(request, 503, "UPLOAD_STORAGE_UNAVAILABLE", "附件替换失败", "模拟附件存储服务当前不可用，原文件保持不变。 ");
  }

  return withIdempotency(request, async () => {
    const instanceIdValue = pathParam(params.instanceId);
    const fieldIdValue = pathParam(params.fieldId);
    const scopeResult = findAttachmentScope(request, authenticated.actor, instanceIdValue, fieldIdValue);
    if (scopeResult instanceof Response) return scopeResult;
    const etagProblem = checkIfMatch(request, scopeResult.instance);
    if (etagProblem) return etagProblem;
    const parsed = await parseUpload(request);
    if (parsed instanceof Response) return parsed;
    if ((parsed.instanceId && parsed.instanceId !== instanceIdValue) || (parsed.fieldId && parsed.fieldId !== fieldIdValue)) {
      return apiProblem(request, 422, "ATTACHMENT_SCOPE_MISMATCH", "附件范围不一致", "路径中的实例/字段与 multipart 表单中的范围不一致。 ");
    }
    const validation = await validateFile(request, parsed.file, scopeResult.field);
    if (validation) return validation;

    try {
      const existingRecords = (await getAttachmentRecords()).filter((record) =>
        record.instanceId === instanceIdValue && record.fieldId === fieldIdValue,
      );
      const backups = (await Promise.all(existingRecords.map((record) => getStoredAttachment(record.id))))
        .filter((stored): stored is NonNullable<typeof stored> => Boolean(stored));
      const record = attachmentRecord(parsed.file, authenticated.actor, { instanceId: instanceIdValue, fieldId: fieldIdValue });
      await putAttachment({ record, blob: parsed.file }, { instanceId: instanceIdValue, fieldId: fieldIdValue });
      if (!synchronizeInstanceAttachment(instanceIdValue, scopeResult.version, fieldIdValue, [attachmentReference(record)], record.size)) {
        await deleteAttachment(record.id);
        await Promise.all(backups.map((stored) => putAttachment(stored)));
        return apiProblem(request, 409, "INSTANCE_CHANGED", "流程实例已变化", "附件替换已回滚，请刷新流程实例后重试。 ");
      }
      recordAudit({
        category: "instance",
        action: "attachment.replace",
        actorId: authenticated.actor.id,
        actorName: authenticated.actor.name,
        resourceType: "attachment",
        resourceId: record.id,
        summary: `将 ${scopeResult.field.label} 替换为 ${record.name}`,
        details: { instanceId: instanceIdValue, fieldId: fieldIdValue, replacedAttachmentIds: existingRecords.map((item) => item.id) },
      });
      return apiOk(request, record, { headers: { ETag: entityEtag(record) } });
    } catch (error) {
      return storageProblem(request, error);
    }
  });
});

const emailOutboxHandler = http.get(`${API_BASE}/email-outbox`, async ({ request }) => {
  const scenarioResponse = await applyMockScenario(request);
  if (scenarioResponse) return scenarioResponse;
  const authorized = requirePermission(request, "system-monitor:查看");
  if (authorized.response) return authorized.response;
  const pagination = pageQuery(request);
  if ("response" in pagination) return pagination.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !["queued", "sent", "failed"].includes(status)) {
    return apiProblem(request, 400, "INVALID_EMAIL_STATUS", "邮件状态无效", "status 仅支持 queued、sent 或 failed。 ");
  }
  const keyword = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  try {
    const items = readStoredOutbox()
      .filter((item) => !status || item.status === status)
      .filter((item) => !keyword || [item.recipientName, item.email, item.instanceId, item.taskId, item.nodeId]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .sort((left, right) => compareDomainTimestamps(right.createdAt, left.createdAt));
    return apiOk(request, paginate(items, pagination.number, pagination.size));
  } catch (error) {
    return outboxStorageProblem(request, error);
  }
});

const emailOutboxDetailHandler = http.get(`${API_BASE}/email-outbox/:deliveryId`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request);
  if (scenarioResponse) return scenarioResponse;
  const authorized = requirePermission(request, "system-monitor:查看");
  if (authorized.response) return authorized.response;
  try {
    const delivery = readStoredOutbox().find((item) => item.id === pathParam(params.deliveryId));
    return delivery
      ? apiOk(request, delivery, { headers: { ETag: entityEtag(delivery) } })
      : apiProblem(request, 404, "EMAIL_DELIVERY_NOT_FOUND", "邮件投递记录不存在", "未找到指定的邮件投递记录。 ");
  } catch (error) {
    return outboxStorageProblem(request, error);
  }
});

const retryEmailHandler = http.post(`${API_BASE}/email-outbox/:deliveryId/retry`, async ({ params, request }) => {
  const scenarioResponse = await applyMockScenario(request, true);
  if (scenarioResponse) return scenarioResponse;
  const authorized = requirePermission(request, "system-monitor:查看");
  if (authorized.response) return authorized.response;

  return withIdempotency(request, () => {
    try {
      const items = readStoredOutbox();
      const delivery = items.find((item) => item.id === pathParam(params.deliveryId));
      if (!delivery) return apiProblem(request, 404, "EMAIL_DELIVERY_NOT_FOUND", "邮件投递记录不存在", "未找到指定的邮件投递记录。 ");
      if (delivery.status === "sent") {
        return apiProblem(request, 409, "EMAIL_ALREADY_SENT", "邮件已经发送", "成功邮件无需再次重试。 ");
      }
      const failed = scenarioOf(request) === "mail-fail";
      const next: EmailOutboxItem = failed
        ? { ...delivery, status: "failed", attempts: delivery.attempts + 1, sentAt: undefined, lastError: "模拟邮件网关连接失败" }
        : { ...delivery, status: "sent", attempts: delivery.attempts + 1, sentAt: new Date().toISOString(), lastError: undefined };
      updateOutboxItem(next);
      recordAudit({
        category: next.kind === "task-activated" ? "task" : "instance",
        action: failed ? "email.retry-failed" : "email.retry-sent",
        actorId: authorized.actor.id,
        actorName: authorized.actor.name,
        resourceType: "email-delivery",
        resourceId: next.id,
        summary: failed ? `重试发送给 ${next.recipientName} 的邮件失败` : `已重试发送给 ${next.recipientName} 的邮件`,
        details: { attempts: next.attempts, email: next.email, instanceId: next.instanceId },
      });
      if (failed) {
        return apiProblem(request, 424, "EMAIL_DELIVERY_FAILED", "邮件发送失败", "模拟邮件网关连接失败，投递记录已保留为失败状态。 ");
      }
      return apiOk(request, next);
    } catch (error) {
      return outboxStorageProblem(request, error);
    }
  });
});

export const attachmentNotificationHandlers = [
  uploadHandler,
  attachmentMetadataHandler,
  attachmentContentHandler,
  deleteAttachmentHandler,
  replaceAttachmentHandler,
  emailOutboxHandler,
  emailOutboxDetailHandler,
  retryEmailHandler,
];
