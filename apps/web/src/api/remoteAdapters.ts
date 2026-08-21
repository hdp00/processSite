import type { AuthSession, PageResult, PermissionCatalogItem, DepartmentRecord, DirectoryUser, PositionRecord, LaunchableProcessDefinition } from "./contracts";
import type { DomainRole, WorkflowGroupPurpose, WorkflowPermissionGroup } from "../state/useIdentityStore";
import type { ProcessBasicConfig, ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import type { CompleteDesignerSnapshot } from "../utils/designerStorage";
import type { ProcessInstance, WorkflowFieldChange, WorkflowTask } from "../data/types";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const enabledStatus = (value: unknown): "启用" | "停用" => value === "enabled" || value === "启用" ? "启用" : "停用";
const actorName = (value: unknown, fallback = "系统") => isRecord(value) ? text(value.name, fallback) : text(value, fallback);

export const normalizePageResult = <T>(value: unknown, map: (item: unknown) => T): PageResult<T> => {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("服务端分页响应格式不正确");
  const page = isRecord(value.page) ? value.page : isRecord(value.meta) ? value.meta : undefined;
  if (!page) throw new Error("服务端分页响应缺少分页信息");
  const pageNumber = number(page.number, number(page.page, 1));
  const pageSize = number(page.size, number(page.pageSize, value.items.length || 20));
  const totalElements = number(page.totalElements, number(page.total, value.items.length));
  return {
    items: value.items.map(map),
    page: {
      number: pageNumber,
      size: pageSize,
      totalElements,
      totalPages: number(page.totalPages, totalElements ? Math.ceil(totalElements / pageSize) : 0),
    },
  };
};

export const normalizeDirectoryUser = (value: unknown): DirectoryUser => {
  if (!isRecord(value)) throw new Error("用户响应格式不正确");
  if (typeof value.account === "string") return value as unknown as DirectoryUser;
  const department = isRecord(value.department) ? value.department : undefined;
  const position = isRecord(value.position) ? value.position : undefined;
  const roleRefs = Array.isArray(value.roles) ? value.roles.filter(isRecord) : [];
  return {
    id: text(value.id),
    account: text(value.loginName),
    email: text(value.email),
    name: text(value.name),
    authenticationMode: value.authenticationMode === "password" ? "password" : "domain",
    department: department ? [text(department.id)].filter(Boolean) : [],
    departmentPath: text(department?.path),
    jobTitle: text(position?.name),
    roles: roleRefs.map((role) => text(role.name)).filter(Boolean),
    roleIds: roleRefs.map((role) => text(role.id)).filter(Boolean),
    status: enabledStatus(value.status),
    lastLogin: text(value.lastLoginAt, "从未登录"),
    builtIn: value.superAdmin === true,
  };
};

export const normalizeAuthSession = (value: unknown): AuthSession => {
  if (!isRecord(value) || !value.user) throw new Error("会话响应格式不正确");
  return {
    accessToken: text(value.accessToken) || undefined,
    tokenType: value.tokenType === "Bearer" ? "Bearer" : undefined,
    expiresIn: typeof value.expiresIn === "number" ? value.expiresIn : undefined,
    user: normalizeDirectoryUser(value.user),
    operatorUser: value.operatorUser ? normalizeDirectoryUser(value.operatorUser) : undefined,
    roleIds: strings(value.roleIds),
    permissions: strings(value.permissions),
    superAdmin: value.superAdmin === true,
    operatorSuperAdmin: value.operatorSuperAdmin === true,
    impersonation: isRecord(value.impersonation) ? value.impersonation as unknown as AuthSession["impersonation"] : undefined,
    expiresAt: text(value.expiresAt) || undefined,
  };
};

export const normalizeDomainRole = (value: unknown): DomainRole => {
  if (!isRecord(value)) throw new Error("角色响应格式不正确");
  if (typeof value.users === "number") return value as unknown as DomainRole;
  return {
    id: text(value.id),
    name: text(value.name),
    code: text(value.code),
    description: text(value.description),
    pagePermissions: 0,
    actionPermissions: number(value.permissionCount),
    users: number(value.memberCount),
    status: enabledStatus(value.status),
    members: [],
    memberUserIds: strings(value.memberIds),
    builtIn: value.builtIn === true,
  };
};

const purposeMap: Record<string, WorkflowGroupPurpose> = {
  start: "发起",
  "review-or-accept": "审批/受理",
  close: "关闭",
  发起: "发起",
  "审批/受理": "审批/受理",
  关闭: "关闭",
};

export const normalizeWorkflowGroup = (value: unknown): WorkflowPermissionGroup => {
  if (!isRecord(value)) throw new Error("流程权限组响应格式不正确");
  if (Array.isArray(value.directMembers)) return value as unknown as WorkflowPermissionGroup;
  const references = Array.isArray(value.referencedProcesses) ? value.referencedProcesses.filter(isRecord) : [];
  return {
    id: text(value.id),
    code: text(value.code),
    name: text(value.name),
    processes: references.map((item) => text(item.name)).filter(Boolean),
    purposes: strings(value.purposes).map((item) => purposeMap[item]).filter((item): item is WorkflowGroupPurpose => Boolean(item)),
    directMembers: [],
    linkedRoles: [],
    directMemberUserIds: strings(value.directUserIds),
    linkedRoleIds: strings(value.roleIds),
    status: enabledStatus(value.status),
    referenced: references.length > 0,
    openTasks: number(value.openTaskCount),
    updatedAt: text(value.updatedAt),
  };
};

const flattenDepartments = (items: unknown[]): JsonRecord[] => items.flatMap((item) => {
  if (!isRecord(item)) return [];
  return [item, ...flattenDepartments(Array.isArray(item.children) ? item.children : [])];
});

export const normalizeDepartments = (value: unknown): DepartmentRecord[] => {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return flattenDepartments(items).map((item) => ({
    id: text(item.id),
    name: text(item.name),
    parentId: text(item.parentId) || undefined,
    path: text(item.path),
    status: enabledStatus(item.status),
    memberCount: number(item.memberCount, number(item.userCount)),
    sortOrder: number(item.sortOrder),
    description: text(item.description),
  }));
};

export const normalizePositions = (value: unknown): PositionRecord[] => {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.filter(isRecord).map((item) => ({
    id: text(item.id),
    name: text(item.name),
    description: text(item.description),
    status: enabledStatus(item.status),
    memberCount: number(item.memberCount, number(item.userCount)),
    sortOrder: number(item.sortOrder),
  }));
};

export const normalizePermissionCatalog = (value: unknown): PermissionCatalogItem[] => {
  if (!Array.isArray(value)) throw new Error("权限目录响应格式不正确");
  return value.filter(isRecord).map((item) => {
    if (typeof item.key === "string") return item as unknown as PermissionCatalogItem;
    const code = text(item.code);
    const separatorIndex = code.lastIndexOf(":");
    return {
      key: code,
      page: separatorIndex >= 0 ? code.slice(0, separatorIndex) : text(item.category),
      action: separatorIndex >= 0 ? code.slice(separatorIndex + 1) : text(item.name),
      name: text(item.name),
      category: text(item.category),
      description: text(item.description),
      kind: item.kind === "page" ? "page" : "action",
    };
  });
};

export const normalizeRolePermissions = (value: unknown): string[] => {
  if (Array.isArray(value)) return strings(value);
  if (isRecord(value)) return strings(value.permissionCodes);
  throw new Error("角色权限响应格式不正确");
};

export const normalizeProcessBasic = (value: unknown): ProcessBasicConfig => {
  if (!isRecord(value)) throw new Error("流程基本配置响应格式不正确");
  return {
    name: text(value.name),
    code: text(value.code),
    instancePrefix: text(value.instancePrefix),
    type: value.type === "free" ? "free" : "approval",
    description: text(value.description),
    starterGroups: strings(value.starterGroups).length ? strings(value.starterGroups) : strings(value.starterGroupIds),
    closeGroups: strings(value.closeGroups).length ? strings(value.closeGroups) : strings(value.closeGroupIds),
    assigneeGroups: strings(value.assigneeGroups).length ? strings(value.assigneeGroups) : strings(value.assigneeGroupIds),
    visibleRoles: strings(value.visibleRoles).length ? strings(value.visibleRoles) : strings(value.visibleRoleIds),
    visibleUsers: strings(value.visibleUsers).length ? strings(value.visibleUsers) : strings(value.visibleUserIds),
  };
};

export const normalizeProcessVersion = (value: unknown): ProcessVersion => {
  if (!isRecord(value)) throw new Error("流程版本响应格式不正确");
  const snapshot = isRecord(value.snapshot) ? value.snapshot as unknown as CompleteDesignerSnapshot : undefined;
  if (!snapshot || !value.basic) throw new Error("服务端未返回完整的流程版本快照");
  const validation = isRecord(value.validation) ? value.validation : {};
  const issueItems = Array.isArray(validation.issues) ? validation.issues : [];
  const basedOn = isRecord(value.basedOn) ? text(value.basedOn.versionLabel) : text(value.basedOn);
  return {
    id: text(value.id),
    version: text(value.version, text(value.versionLabel)),
    basedOn: basedOn || undefined,
    createdAt: text(value.createdAt),
    createdBy: actorName(value.createdBy),
    updatedAt: text(value.updatedAt),
    updatedBy: actorName(value.updatedBy),
    firstPublishedAt: text(value.firstPublishedAt) || undefined,
    firstPublishedBy: value.firstPublishedBy ? actorName(value.firstPublishedBy) : undefined,
    publishedAt: text(value.publishedAt) || undefined,
    lastUnpublishedAt: text(value.lastUnpublishedAt) || undefined,
    lastUnpublishedBy: value.lastUnpublishedBy ? actorName(value.lastUnpublishedBy) : undefined,
    lastUnpublishReason: text(value.lastUnpublishReason) || undefined,
    changeNote: text(value.changeNote),
    instanceCount: number(value.instanceCount),
    formFieldCount: number(value.formFieldCount, snapshot.form.fields.length),
    nodeCount: number(value.nodeCount, snapshot.flow.nodes.length),
    starterGroups: strings(value.starterGroups).length
      ? strings(value.starterGroups)
      : normalizeProcessBasic(value.basic).starterGroups,
    checksum: text(value.checksum),
    basic: normalizeProcessBasic(value.basic),
    snapshot,
    validation: {
      status: validation.status === "passed" || validation.status === "通过" ? "通过" : "未通过",
      checkedAt: text(validation.checkedAt),
      issues: issueItems.map((issue) => isRecord(issue) ? text(issue.message, text(issue.code)) : text(issue)).filter(Boolean),
    },
  };
};

export const normalizeProcessDefinition = (value: unknown, suppliedVersions?: ProcessVersion[]): ProcessDefinition => {
  if (!isRecord(value)) throw new Error("流程定义响应格式不正确");
  const versions = suppliedVersions ?? (Array.isArray(value.versions) ? value.versions.map(normalizeProcessVersion) : []);
  return {
    id: text(value.id),
    code: text(value.code),
    name: text(value.name),
    description: text(value.description),
    type: value.type === "free" ? "free" : "approval",
    disabled: value.disabled === true,
    publishedVersionId: text(value.publishedVersionId) || undefined,
    nextVersionNumber: number(value.nextVersionNumber, versions.length + 1),
    versions,
    updatedAt: text(value.updatedAt),
    updatedBy: actorName(value.updatedBy),
    instanceCount: number(value.instanceCount),
  };
};

export const normalizeLaunchableDefinition = (value: unknown): LaunchableProcessDefinition => {
  if (!isRecord(value)) throw new Error("可发起流程响应格式不正确");
  const starterGroups = Array.isArray(value.starterGroups) ? value.starterGroups : [];
  return {
    definitionId: text(value.definitionId),
    code: text(value.code),
    name: text(value.name),
    type: value.type === "free" ? "free" : "approval",
    versionId: text(value.versionId),
    versionLabel: text(value.versionLabel),
    description: text(value.description),
    starterGroups: starterGroups.map((group) => isRecord(group) ? text(group.name, text(group.id)) : text(group)).filter(Boolean),
  };
};

const instanceStatusMap: Record<string, ProcessInstance["status"]> = {
  reviewing: "审核中",
  "rejected-pending": "驳回待处理",
  completed: "已完成",
  "in-progress": "进行中",
  closed: "已关闭",
};

const taskStatusMap: Record<string, WorkflowTask["status"]> = {
  inactive: "未激活",
  pending: "待处理",
  completed: "已完成",
  cancelled: "已取消",
  skipped: "已跳过",
};

const taskActionMap: Record<string, NonNullable<WorkflowTask["action"]>> = {
  pass: "通过",
  confirm: "确认",
  reject: "驳回",
};

const displayValue = (value: unknown) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeFieldChange = (value: unknown): WorkflowFieldChange => {
  const item = isRecord(value) ? value : {};
  return {
    fieldId: text(item.fieldId),
    label: text(item.label, text(item.labelSnapshot)),
    before: text(item.before, text(item.beforeDisplay, displayValue(item.beforeValue))),
    after: text(item.after, text(item.afterDisplay, displayValue(item.afterValue))),
  };
};

export const normalizeWorkflowTask = (value: unknown): WorkflowTask => {
  if (!isRecord(value)) throw new Error("流程任务响应格式不正确");
  if (taskStatusMap[text(value.status)] === undefined) return value as unknown as WorkflowTask;
  const completedBy = isRecord(value.completedBy) ? value.completedBy : undefined;
  return {
    id: text(value.id),
    instanceId: text(value.instanceId),
    definitionId: text(value.definitionId),
    versionId: text(value.versionId),
    nodeId: text(value.nodeId),
    nodeName: text(value.nodeName),
    permissionGroupId: text(value.permissionGroupId),
    handlingMode: value.handlingMode === "confirmation" ? "confirmation" : "approval",
    editableFieldIds: strings(value.editableFieldIds),
    allowedActions: strings(value.allowedActions) as NonNullable<WorkflowTask["allowedActions"]>,
    status: taskStatusMap[text(value.status)],
    defaultAssigneeId: isRecord(value.defaultAssignee) ? text(value.defaultAssignee.id) || undefined : text(value.defaultAssigneeId) || undefined,
    completedById: completedBy ? text(completedBy.id) || undefined : undefined,
    completedByName: completedBy ? text(completedBy.name) || undefined : undefined,
    action: taskActionMap[text(value.action)],
    comment: text(value.comment) || undefined,
    createdAt: text(value.createdAt),
    completedAt: text(value.completedAt) || undefined,
    round: number(value.round, 1),
    conditionSummary: text(value.conditionSummary) || undefined,
    conditionEvaluatedAt: text(value.conditionEvaluatedAt) || undefined,
    submittedFieldChanges: Array.isArray(value.submittedFieldChanges) ? value.submittedFieldChanges.map(normalizeFieldChange) : [],
    fieldRevisions: Array.isArray(value.fieldRevisions) ? value.fieldRevisions.filter(isRecord).map((revision) => ({
      id: text(revision.id),
      editedById: isRecord(revision.editedBy) ? text(revision.editedBy.id) : text(revision.editedById),
      editedByName: isRecord(revision.editedBy) ? text(revision.editedBy.name) : text(revision.editedByName),
      editedAt: text(revision.editedAt),
      comment: text(revision.comment) || undefined,
      changes: Array.isArray(revision.changes) ? revision.changes.map(normalizeFieldChange) : [],
    })) : [],
  };
};

export const normalizeProcessInstance = (value: unknown): ProcessInstance => {
  if (!isRecord(value)) throw new Error("流程实例响应格式不正确");
  if (typeof value.template === "string") return value as unknown as ProcessInstance;
  const initiator = isRecord(value.initiator) ? value.initiator : undefined;
  const currentAssignee = isRecord(value.currentAssignee) ? value.currentAssignee : undefined;
  const formValues = isRecord(value.formValues) ? value.formValues : isRecord(value.listValues) ? value.listValues : {};
  const reviewProgress = Array.isArray(value.reviewProgress) ? value.reviewProgress.filter(isRecord) : [];
  const attachmentItems = Array.isArray(value.attachments) ? value.attachments.filter(isRecord) : [];
  const attachmentIdsByField = attachmentItems.reduce<Record<string, string[]>>((result, item) => {
    const fieldId = text(item.fieldId);
    if (fieldId) result[fieldId] = [...(result[fieldId] ?? []), text(item.id)].filter(Boolean);
    return result;
  }, {});
  return {
    workflowType: value.workflowType === "free" ? "free" : "approval",
    id: text(value.id),
    definitionId: text(value.definitionId),
    versionId: text(value.versionId),
    code: text(value.code),
    title: text(value.title),
    template: text(value.processName),
    templateVersion: text(value.versionLabel),
    status: instanceStatusMap[text(value.status)] ?? "进行中",
    initiator: actorName(initiator),
    initiatorId: initiator ? text(initiator.id) : "",
    department: initiator ? text(initiator.departmentPath) : "",
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    round: number(value.round, 1),
    currentNode: strings(value.currentNodeNames).join("、"),
    priority: formValues.priority === "紧急" ? "紧急" : "普通",
    currentAssignee: currentAssignee ? text(currentAssignee.name) || undefined : undefined,
    currentAssigneeId: currentAssignee ? text(currentAssignee.id) || undefined : undefined,
    description: text(formValues.description),
    category: text(formValues.category) || undefined,
    formValues,
    attachmentNames: attachmentItems.map((item) => text(item.name)).filter(Boolean),
    attachmentIds: attachmentItems.map((item) => text(item.id)).filter(Boolean),
    attachmentIdsByField,
    reviewers: reviewProgress.map((item) => ({
      key: text(item.nodeId),
      name: text(item.nodeName),
      group: text(item.nodeName),
      shortGroup: text(item.nodeName),
      status: item.status === "passed" ? "已通过" : item.status === "confirmed" ? "已确认" : item.status === "rejected" ? "已驳回" : item.status === "cancelled" ? "已取消" : item.status === "skipped" ? "已跳过" : "待审核",
      actionAt: text(item.actionAt) || undefined,
      comment: text(item.comment) || undefined,
      substitute: item.substitute === true,
      conditionSummary: text(item.conditionSummary) || undefined,
    })),
    freeTimeline: Array.isArray(value.freeTimeline) ? value.freeTimeline.filter(isRecord).map((item) => ({
      id: text(item.id),
      type: text(item.type) as NonNullable<ProcessInstance["freeTimeline"]>[number]["type"],
      actor: actorName(item.actor),
      time: text(item.occurredAt, text(item.time)),
      content: text(item.content, text(item.summary)) || undefined,
      assignee: isRecord(item.assignee) ? text(item.assignee.name) : text(item.assignee) || undefined,
    })) : [],
    fieldRevisions: isRecord(value.fieldRevisions) ? Object.fromEntries(Object.entries(value.fieldRevisions).flatMap(([fieldId, revision]) => typeof revision === "number" ? [[fieldId, revision] as const] : [])) : {},
  };
};
