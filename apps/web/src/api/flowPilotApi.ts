import type { InstanceStatus, ProcessInstance, WorkflowTask } from "../data/types";
import type { DomainRole, DomainUser, WorkflowPermissionGroup } from "../state/useIdentityStore";
import type {
  DefinitionType,
  ProcessBasicConfig,
  ProcessDefinition,
  ProcessVersion,
} from "../state/useProcessDefinitionStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  designerTableColumnSupportsOptions,
  normalizeStoredDesignerField,
  type CompleteDesignerSnapshot,
  type StoredDesignerField,
  type StoredDesignerTableColumn,
  type StoredFlowDesignerSnapshot,
  type StoredNodeCondition,
} from "../utils/designerStorage";
import type { DesignerChoiceOption } from "../utils/designerOptions";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useIdentityStore } from "../state/useIdentityStore";
import { useOrganizationStore } from "../state/useOrganizationStore";
import { apiDownload, apiRequest, apiResource, createIdempotencyKey, writeApiAccessToken } from "./client";
import type { ApiResourceResult } from "./client";
import {
  normalizeAttachmentRecord,
  normalizeAuditEvent,
  normalizeEmailOutboxItem,
  normalizeAuthSession,
  normalizeDepartments,
  normalizeDirectoryUser,
  normalizeDomainRole,
  normalizeLaunchableDefinition,
  normalizePageResult,
  normalizePermissionCatalog,
  normalizePositions,
  normalizeProcessDefinition,
  normalizeProcessInstance,
  normalizeProcessVersion,
  normalizeRolePermissions,
  normalizeWorkflowTask,
  normalizeWorkflowGroup,
} from "./remoteAdapters";
import type {
  ApiHealth,
  AttachmentRecord,
  AuditEvent,
  AuthSession,
  DepartmentRecord,
  DirectoryUser,
  EmailOutboxItem,
  EffectiveWorkflowMember,
  ImpactPreview,
  MockApiSettings,
  PageResult,
  PermissionCatalogItem,
  PositionRecord,
  ProcessExcelDataFilter,
  ProcessExcelDataset,
  ProcessDefinitionListItem,
  ProcessDefinitionVersionResult,
  ProcessLaunchConfig,
  ProcessInstanceDetail,
  LaunchableProcessDefinition,
  SavedProcessVersionResult,
  WorkflowDecisionResult,
  WorkflowRevisionResult,
  WorkflowTaskDetailItem,
  WorkflowTaskListItem,
} from "./contracts";

export interface PageQuery {
  page?: number;
  pageSize?: number;
  q?: string;
}

export interface ProcessInstanceQuery extends PageQuery {
  definitionId?: string;
  status?: InstanceStatus;
  createdFrom?: string;
  createdTo?: string;
  initiatorId?: string;
  dynamicFilters?: Record<string, unknown>;
  activeOnly?: boolean;
}

export interface WorkflowTaskQuery extends PageQuery {
  view?: "pending" | "substitutable" | "completed" | "all";
  definitionId?: string;
}

const mutation = () => ({ idempotencyKey: createIdempotencyKey() });
const remoteMode = import.meta.env.VITE_API_MODE === "remote";

export const clearRemoteApplicationCache = () => {
  useIdentityStore.setState({ users: [], roles: [], workflowGroups: [] });
  useProcessDefinitionStore.setState({ definitions: [] });
  usePrototypeStore.setState({ instances: [], tasks: [] });
  useOrganizationStore.setState({ departments: [], jobTitles: [] });
};

const mappedResource = async <T>(resource: Promise<ApiResourceResult<unknown>>, map: (value: unknown) => T) => {
  const result = await resource;
  return { ...result, data: map(result.data) };
};

const pageRequest = async <T>(path: string, query: object, map: (value: unknown) => T) =>
  normalizePageResult(await apiRequest<unknown>(path, { query }), map);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const processDefinitionStatus = (definition: ProcessDefinition): ProcessDefinitionListItem["status"] =>
  definition.disabled ? "disabled" : definition.publishedVersionId ? "published" : "unpublished";

const fullVersionsRequest = async (definitionId: string, supplied?: unknown[]): Promise<ProcessVersion[]> => {
  const values = supplied ?? await apiRequest<unknown[]>(`/process-definitions/${encodeURIComponent(definitionId)}/versions`);
  return Promise.all(values.map(async (value) => {
    if (isRecord(value) && value.snapshot && value.basic) return normalizeProcessVersion(value);
    if (!isRecord(value)) throw new Error("流程版本摘要格式不正确");
    return normalizeProcessVersion(await apiRequest<unknown>(
      `/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(String(value.id ?? ""))}`,
    ));
  }));
};

const definitionPageRequest = async (path: string, query: object): Promise<PageResult<ProcessDefinitionListItem>> => {
  const raw = await apiRequest<unknown>(path, { query });
  const page = normalizePageResult(raw, (item) => item);
  const items = await Promise.all(page.items.map(async (item) => {
    let versions: ProcessVersion[] | undefined;
    if (isRecord(item) && Array.isArray(item.versions)) {
      versions = await fullVersionsRequest(String(item.id ?? ""), item.versions);
    }
    const definition = normalizeProcessDefinition(item, versions);
    return { ...definition, status: processDefinitionStatus(definition) };
  }));
  return { items, page: page.page };
};

const normalizeDefinitionVersionResult = (value: unknown): ProcessDefinitionVersionResult => {
  if (!isRecord(value)) throw new Error("流程定义写入响应格式不正确");
  const version = normalizeProcessVersion(value.version ?? value.publishedVersion);
  if (!isRecord(value.definition)) throw new Error("流程定义写入响应缺少定义信息");
  const definitionId = String(value.definition.id ?? "");
  const currentVersions = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId)?.versions ?? [];
  const versions = [version, ...currentVersions.filter((item) => item.id !== version.id)];
  return {
    definition: normalizeProcessDefinition(value.definition, versions),
    version,
  };
};

const normalizeSavedVersionResult = (value: unknown): SavedProcessVersionResult => {
  if (!isRecord(value)) throw new Error("流程设计保存响应格式不正确");
  return {
    version: normalizeProcessVersion(value.version),
    removedReferences: Array.isArray(value.removedReferences)
      ? value.removedReferences as SavedProcessVersionResult["removedReferences"]
      : [],
  };
};

const normalizeSavedVersion = (value: unknown) =>
  normalizeProcessVersion(isRecord(value) && value.version ? value.version : value);

const normalizeInstanceDetail = (value: unknown): ProcessInstanceDetail => {
  if (!isRecord(value)) throw new Error("流程实例详情响应格式不正确");
  const source = isRecord(value.instance) ? value.instance : value;
  const tasks = Array.isArray(value.tasks) ? value.tasks : Array.isArray(source.tasks) ? source.tasks : [];
  return {
    instance: normalizeProcessInstance(source),
    tasks: tasks.map(normalizeWorkflowTask),
  };
};

const normalizeTaskFromEnvelope = (source: unknown, envelope: Record<string, unknown>): WorkflowTask => {
  const task = normalizeWorkflowTask(source);
  const handlingMode = envelope.handlingMode === "confirmation" || task.handlingMode === "confirmation"
    ? "confirmation"
    : task.handlingMode;
  const allowedActions = Array.isArray(envelope.allowedActions)
    ? envelope.allowedActions.filter((action): action is NonNullable<WorkflowTask["allowedActions"]>[number] =>
      typeof action === "string" && ["pass", "confirm", "reject", "revise-fields", "reply", "change-assignee", "resubmit"].includes(action))
    : task.allowedActions;
  return { ...task, handlingMode, allowedActions };
};

const normalizeTaskListItem = async (value: unknown): Promise<WorkflowTaskListItem> => {
  if (!isRecord(value)) throw new Error("任务列表响应格式不正确");
  const taskSources = Array.isArray(value.tasks)
    ? value.tasks
    : [isRecord(value.task) ? value.task : value];
  const tasks = taskSources.map((task) => normalizeTaskFromEnvelope(task, value));
  const firstTask = tasks[0];
  if (!firstTask) throw new Error("任务列表响应缺少任务数据");
  const instance = value.instance
    ? normalizeProcessInstance(value.instance)
    : normalizeInstanceDetail(await apiRequest<unknown>(`/process-instances/${encodeURIComponent(firstTask.instanceId)}`)).instance;
  return { tasks, instance };
};

const normalizeTaskDetailItem = async (value: unknown): Promise<WorkflowTaskDetailItem> => {
  if (!isRecord(value)) throw new Error("任务详情响应格式不正确");
  const task = normalizeTaskFromEnvelope(isRecord(value.task) ? value.task : value, value);
  const instance = value.instance
    ? normalizeProcessInstance(value.instance)
    : normalizeInstanceDetail(await apiRequest<unknown>(`/process-instances/${encodeURIComponent(task.instanceId)}`)).instance;
  return { task, instance };
};

const taskPageRequest = async (query: object): Promise<PageResult<WorkflowTaskListItem>> => {
  const raw = await apiRequest<unknown>("/me/workflow-tasks", {
    query,
  });
  const page = normalizePageResult(raw, (item) => item);
  return {
    items: await Promise.all(page.items.map(normalizeTaskListItem)),
    page: page.page,
    categories: page.categories,
  };
};

const remoteStatus = (status: "启用" | "停用") => status === "启用" ? "enabled" : "disabled";
const remoteInstanceStatus: Record<InstanceStatus, string> = {
  审核中: "reviewing",
  驳回待处理: "rejected-pending",
  已完成: "completed",
  进行中: "in-progress",
  已关闭: "closed",
};
const remoteDefinitionStatus: Record<string, string> = {
  未发布: "unpublished",
  已发布: "published",
  已停用: "disabled",
};
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const defaultInstanceDateRange = () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return { dateFrom: isoDate(start), dateTo: isoDate(end) };
};
const remotePurpose = (purpose: string) => purpose === "发起" ? "start" : purpose === "关闭" ? "close" : "review-or-accept";
const positionIdByName = (name: string) => useOrganizationStore.getState().jobTitles.find((item) => item.name === name)?.id;
const roleIdsByNames = (names: string[]) => {
  const roles = useIdentityStore.getState().roles;
  return names.map((name) => roles.find((role) => role.name === name)?.id).filter((id): id is string => Boolean(id));
};
const userIdsByNames = (names: string[]) => {
  const users = useIdentityStore.getState().users;
  return names.map((name) => users.find((user) => user.name === name)?.id).filter((id): id is string => Boolean(id));
};

const normalizeEffectiveWorkflowMember = (value: unknown): EffectiveWorkflowMember => {
  if (!isRecord(value)) throw new Error("流程权限组成员响应格式不正确");
  if (typeof value.name === "string") return value as unknown as EffectiveWorkflowMember;
  const user = isRecord(value.user) ? value.user : {};
  const sources = Array.isArray(value.sources) ? value.sources.filter(isRecord).map((source) => {
    const role = isRecord(source.role) ? source.role : undefined;
    return source.kind === "direct" ? "direct" : `role:${String(role?.name ?? role?.id ?? "")}`;
  }) : [];
  return {
    id: String(user.id ?? ""),
    account: String(user.loginName ?? user.account ?? ""),
    name: String(user.name ?? ""),
    email: String(user.email ?? ""),
    departmentPath: String(user.departmentPath ?? ""),
    sources,
  };
};

const normalizeImpactPreview = (value: unknown): ImpactPreview => {
  if (!isRecord(value)) throw new Error("变更影响响应格式不正确");
  if (typeof value.affectedUsers === "number" && typeof value.affectedOpenTasks === "number") {
    return {
      affectedUsers: value.affectedUsers,
      affectedOpenTasks: value.affectedOpenTasks,
      references: Array.isArray(value.references) ? value.references.filter((item): item is string => typeof item === "string") : [],
    };
  }
  const losingUsers = Array.isArray(value.losingUsers) ? value.losingUsers.filter(isRecord) : [];
  return {
    affectedUsers: typeof value.losingEffectiveMemberCount === "number" ? value.losingEffectiveMemberCount : losingUsers.length,
    affectedOpenTasks: typeof value.affectedPendingTaskCount === "number" ? value.affectedPendingTaskCount : 0,
    references: losingUsers.map((user) => String(user.name ?? "")).filter(Boolean),
  };
};

const remoteUserInput = (input: Partial<DomainUser> & { password?: string; newPassword?: string }) => ({
  ...(input.account !== undefined ? { loginName: input.account } : {}),
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.email !== undefined ? { email: input.email } : {}),
  ...(input.authenticationMode !== undefined ? { authenticationMode: input.authenticationMode } : {}),
  ...(input.department !== undefined ? { departmentId: input.department.at(-1) ?? null } : {}),
  ...(input.jobTitle !== undefined ? { positionId: input.jobTitle ? positionIdByName(input.jobTitle) ?? null : null } : {}),
  ...(input.roles !== undefined ? { roleIds: roleIdsByNames(input.roles) } : {}),
  ...(input.status !== undefined ? { status: remoteStatus(input.status) } : {}),
  ...(input.password ? { initialPassword: input.password } : {}),
  ...(input.newPassword ? { newPassword: input.newPassword } : {}),
});

const remoteRoleInput = (input: Partial<DomainRole>) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.status !== undefined ? { status: remoteStatus(input.status) } : {}),
  ...((input.memberUserIds || input.members) ? { memberIds: input.memberUserIds ?? userIdsByNames(input.members ?? []) } : {}),
});

const remoteGroupInput = (input: Partial<WorkflowPermissionGroup>) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.purposes !== undefined ? { purposes: input.purposes.map(remotePurpose) } : {}),
  ...(input.status !== undefined ? { status: remoteStatus(input.status) } : {}),
  ...((input.directMemberUserIds || input.directMembers) ? { directUserIds: input.directMemberUserIds ?? userIdsByNames(input.directMembers ?? []) } : {}),
  ...((input.linkedRoleIds || input.linkedRoles) ? { roleIds: input.linkedRoleIds ?? roleIdsByNames(input.linkedRoles ?? []) } : {}),
});

const remoteBasicInput = (input: ProcessBasicConfig) => ({
  name: input.name,
  instancePrefix: input.instancePrefix,
  type: input.type,
  description: input.description,
  starterGroupIds: input.starterGroups,
  assigneeGroupIds: input.assigneeGroups ?? [],
  closeGroupIds: input.closeGroups,
  visibleRoleIds: input.visibleRoles,
  visibleUserIds: input.visibleUsers,
});

const remoteDesignerOptions = (options?: DesignerChoiceOption[]): DesignerChoiceOption[] =>
  (options ?? []).map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.children?.length ? { children: remoteDesignerOptions(option.children) } : {}),
  }));

const remoteDesignerCondition = (condition?: StoredNodeCondition) => {
  if (!condition?.rules.length) return undefined;
  return {
    mode: condition.mode,
    rules: condition.rules.map((rule) => ({
      id: rule.id,
      fieldId: rule.fieldId,
      operator: rule.operator,
      ...(rule.value !== undefined ? { value: structuredClone(rule.value) } : {}),
    })),
  };
};

const remoteTableColumn = (column: StoredDesignerTableColumn) => ({
  id: column.id,
  label: column.label,
  type: column.type ?? "text",
  required: column.required ?? false,
  ...(column.defaultValue !== undefined ? { defaultValue: structuredClone(column.defaultValue) } : {}),
  ...(column.width !== undefined ? { width: column.width } : {}),
  ...(column.align !== undefined ? { align: column.align } : {}),
  reviewEditable: column.reviewEditable ?? false,
  ...(designerTableColumnSupportsOptions(column.type) && column.options !== undefined
    ? { options: remoteDesignerOptions(column.options) }
    : {}),
});

const remoteDesignerFieldType = (field: StoredDesignerField) => {
  if (field.type === "richtext") return "rich-text";
  if (field.type === "text" && field.multiline) return "textarea";
  return field.type;
};

const remoteDesignerField = (source: StoredDesignerField) => {
  const field = normalizeStoredDesignerField(source);
  const displayCondition = remoteDesignerCondition(field.displayCondition);
  return {
    id: field.id,
    type: remoteDesignerFieldType(field),
    label: field.label,
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    required: field.required ?? false,
    ...(field.defaultValue !== undefined ? { defaultValue: structuredClone(field.defaultValue) } : {}),
    listVisible: field.listVisible ?? false,
    taskVisible: field.taskVisible ?? false,
    queryable: field.queryable ?? false,
    exportVisible: field.exportVisible ?? field.listVisible ?? false,
    inputStage: field.inputStage ?? (field.reviewEditable ? "both" : "initiator"),
    ...(displayCondition ? { displayCondition } : {}),
    ...(field.options !== undefined ? { options: remoteDesignerOptions(field.options) } : {}),
    ...(field.attachment ? {
      attachment: {
        ...(field.attachment.maxSizeMb !== undefined ? { maxSizeMb: field.attachment.maxSizeMb } : {}),
        ...(field.attachment.maxCount !== undefined ? { maxCount: field.attachment.maxCount } : {}),
        ...(field.attachment.inlinePdf !== undefined ? { inlinePdf: field.attachment.inlinePdf } : {}),
        ...(field.attachment.allowedExtensions !== undefined
          ? { allowedExtensions: [...field.attachment.allowedExtensions] }
          : {}),
        ...(field.attachment.excelToPdf !== undefined ? { excelToPdf: field.attachment.excelToPdf } : {}),
        ...(field.attachment.maxPreviewPages !== undefined
          ? { maxPreviewPages: field.attachment.maxPreviewPages }
          : {}),
      },
    } : {}),
    ...(field.columns !== undefined ? { columns: field.columns.map(remoteTableColumn) } : {}),
  };
};

const remoteSystemFieldKey = (key: CompleteDesignerSnapshot["systemFields"][number]["key"]) => ({
  code: "instanceCode",
  template: "processName",
  templateVersion: "processVersion",
  status: "status",
  currentNode: "currentNode",
  round: "currentRound",
  initiator: "initiator",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
} as const)[key];

const remoteFormDesignerInput = (input: Pick<CompleteDesignerSnapshot, "form" | "systemFields">) => ({
  form: {
    fields: input.form.fields.map(remoteDesignerField),
    ...(input.form.savedAt !== undefined ? { savedAt: input.form.savedAt } : {}),
  },
  systemFields: input.systemFields.map((field) => ({
    key: remoteSystemFieldKey(field.key),
    label: field.label,
    taskVisible: field.taskVisible,
    processListVisible: field.processListVisible,
    exportVisible: field.exportVisible,
  })),
});

const remoteFlowDesignerSnapshot = (flow: StoredFlowDesignerSnapshot) => ({
  ...(flow.savedAt !== undefined ? { savedAt: flow.savedAt } : {}),
  nodes: flow.nodes.map((node) => {
    const data = node.data;
    const activationCondition = remoteDesignerCondition(data?.activationCondition);
    return {
      id: node.id,
      position: {
        x: node.position?.x ?? 0,
        y: node.position?.y ?? 0,
      },
      data: {
        kind: data?.kind,
        label: data?.label,
        ...(data?.description !== undefined ? { description: data.description } : {}),
        ...(data?.permissionGroup !== undefined ? { permissionGroupId: data.permissionGroup } : {}),
        ...(data?.permissionGroups !== undefined ? { permissionGroupIds: [...data.permissionGroups] } : {}),
        ...(data?.specifyAssignee !== undefined ? { specifyAssignee: data.specifyAssignee } : {}),
        ...(data?.editableFields !== undefined ? { editableFieldIds: [...data.editableFields] } : {}),
        ...(data?.handlingMode !== undefined ? { handlingMode: data.handlingMode } : {}),
        ...(data?.allowRepeatedEditing !== undefined ? { allowRepeatedEditing: data.allowRepeatedEditing } : {}),
        ...(activationCondition ? { activationCondition } : {}),
        ...(data?.emailNotification ? {
          emailNotification: {
            enabled: data.emailNotification.enabled,
            notifyReviewers: data.emailNotification.notifyReviewers ?? false,
            notifyInitiator: data.emailNotification.notifyInitiator ?? false,
            extraUserIds: [...data.emailNotification.extraUserIds],
          },
        } : {}),
      },
    };
  }),
  edges: flow.edges.map((edge, index) => ({
    id: edge.id ?? `edge-${index + 1}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
  })),
  meta: {
    rejectionHandling: flow.meta?.rejectionHandling ?? "resubmit-or-close",
  },
});

const remoteFlowDesignerInput = (input: {
  basicPatch: Pick<ProcessBasicConfig, "name" | "starterGroups">;
  flow: CompleteDesignerSnapshot["flow"];
}) => ({
  basicPatch: {
    name: input.basicPatch.name,
    starterGroupIds: [...input.basicPatch.starterGroups],
  },
  flow: remoteFlowDesignerSnapshot(input.flow),
});

const remoteDepartmentInput = (input: Partial<DepartmentRecord> & { name?: string }) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
  ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  ...(input.status !== undefined ? { status: remoteStatus(input.status) } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
});

const remotePositionInput = (input: Partial<PositionRecord> & { name?: string }) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  ...(input.status !== undefined ? { status: remoteStatus(input.status) } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
});

interface MockSystemApi {
  getMockSettings: () => Promise<MockApiSettings>;
  updateMockSettings: (settings: Partial<MockApiSettings>) => Promise<MockApiSettings>;
  resetDemo: () => Promise<{ reset: true }>;
}

const mockSystemApi = (import.meta.env.VITE_API_MODE === "remote" ? {} : {
  getMockSettings: () => apiRequest<MockApiSettings>("/mock/settings"),
  updateMockSettings: (settings: Partial<MockApiSettings>) =>
    apiRequest<MockApiSettings>("/mock/settings", { method: "PATCH", body: settings }),
  resetDemo: () => apiRequest<{ reset: true }>("/mock/reset", { method: "POST", ...mutation() }),
}) as MockSystemApi;

const applySession = (session: AuthSession) => {
  writeApiAccessToken(remoteMode ? undefined : session.accessToken ?? readCurrentToken());
  const sessionUsers = [session.operatorUser, session.user].filter((user): user is DirectoryUser => Boolean(user));
  useIdentityStore.getState().setUsers((users) => {
    const byId = new Map(users.map((user) => [user.id, user]));
    sessionUsers.forEach((user) => {
      const current = byId.get(user.id);
      byId.set(user.id, { ...current, ...user, password: current?.password ?? "" });
    });
    return [...byId.values()];
  });
  usePrototypeStore.getState().applyAuthSession(session);
  return session;
};

const readCurrentToken = () => window.sessionStorage.getItem("flowpilot-api-access-token") ?? undefined;

export const flowPilotApi = {
  system: {
    health: () => apiRequest<ApiHealth>("/health"),
    ...mockSystemApi,
  },
  auth: {
    login: async (account: string, password: string) => {
      const body = import.meta.env.VITE_API_MODE === "remote"
        ? { loginName: account, password }
        : { account, password };
      const session = normalizeAuthSession(await apiRequest<unknown>("/auth/login", { method: "POST", body, ...mutation() }));
      return applySession(session);
    },
    me: async () => {
      const response = await apiRequest<unknown>("/auth/me");
      const normalized = response && typeof response === "object" && "user" in response
        ? normalizeAuthSession(response)
        : { user: normalizeDirectoryUser(response), operatorUser: normalizeDirectoryUser(response) };
      return applySession(normalized);
    },
    impersonationCandidates: (query: PageQuery = {}) =>
      pageRequest("/auth/impersonation/candidates", query, normalizeDirectoryUser),
    startImpersonation: async (targetUserId: string, reason: string) => applySession(
      normalizeAuthSession(await apiRequest<unknown>("/auth/impersonation", {
        method: "POST",
        body: { targetUserId, reason },
        ...mutation(),
      })),
    ),
    stopImpersonation: async () => applySession(
      normalizeAuthSession(await apiRequest<unknown>("/auth/impersonation", { method: "DELETE", ...mutation() })),
    ),
    logout: async (options: { clearCache?: boolean } = {}) => {
      try {
        await apiRequest<void>("/auth/logout", { method: "POST", ...mutation() });
      } finally {
        writeApiAccessToken();
        if (remoteMode && options.clearCache !== false) clearRemoteApplicationCache();
        usePrototypeStore.getState().logout();
      }
    },
  },
  directory: {
    users: (query: PageQuery & { status?: "启用" | "停用"; hasEmail?: boolean; departmentId?: string; positionId?: string; roleId?: string; authenticationMode?: string } = {}) =>
      pageRequest("/users", {
        ...query,
        status: query.status && remoteMode ? remoteStatus(query.status) : query.status,
      }, normalizeDirectoryUser),
    user: async (userId: string) => normalizeDirectoryUser(await apiRequest<unknown>(`/users/${encodeURIComponent(userId)}`)),
    userResource: (userId: string) => mappedResource(apiResource<unknown>(`/users/${encodeURIComponent(userId)}`), normalizeDirectoryUser),
    createUser: async (input: Omit<DomainUser, "id" | "lastLogin" | "password"> & { password?: string }) =>
      normalizeDirectoryUser(await apiRequest<unknown>("/users", { method: "POST", body: remoteMode ? remoteUserInput(input) : input, ...mutation() })),
    updateUser: async (userId: string, patch: Partial<DomainUser> & { newPassword?: string }, ifMatch?: string) =>
      normalizeDirectoryUser(await apiRequest<unknown>(`/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: remoteMode ? remoteUserInput(patch) : patch, ifMatch })),
    updateUserStatus: (userId: string, status: "启用" | "停用", ifMatch: string) =>
      apiRequest<unknown>(`/users/${encodeURIComponent(userId)}/status`, { method: "PUT", body: { status: remoteMode ? remoteStatus(status) : status }, ifMatch }).then(normalizeDirectoryUser),
    deleteUser: (userId: string, ifMatch: string) =>
      apiRequest<void>(`/users/${encodeURIComponent(userId)}`, { method: "DELETE", ifMatch }),
    resetPassword: async (userId: string, newPassword = "", ifMatch?: string) => {
      const result = await apiRequest<unknown>(`/users/${encodeURIComponent(userId)}/reset-password`, {
        method: "POST",
        body: remoteMode ? { newPassword } : undefined,
        ifMatch,
        ...mutation(),
      });
      return isRecord(result) && typeof result.temporaryPassword === "string"
        ? { temporaryPassword: result.temporaryPassword }
        : {};
    },
    roles: (query: PageQuery = {}) => pageRequest("/roles", query, normalizeDomainRole),
    roleResource: (roleId: string) => mappedResource(apiResource<unknown>(`/roles/${encodeURIComponent(roleId)}`), normalizeDomainRole),
    createRole: (input: Pick<DomainRole, "name" | "description" | "status"> & Pick<Partial<DomainRole>, "members" | "memberUserIds">) =>
      apiRequest<unknown>("/roles", { method: "POST", body: remoteMode ? remoteRoleInput(input) : input, ...mutation() }).then(normalizeDomainRole),
    updateRole: (roleId: string, patch: Partial<DomainRole>, ifMatch?: string) =>
      apiRequest<unknown>(`/roles/${encodeURIComponent(roleId)}`, { method: "PATCH", body: remoteMode ? remoteRoleInput(patch) : patch, ifMatch }).then(normalizeDomainRole),
    deleteRole: (roleId: string, ifMatch: string) =>
      apiRequest<void>(`/roles/${encodeURIComponent(roleId)}`, { method: "DELETE", ifMatch }),
    groups: (query: PageQuery & { purpose?: string } = {}) =>
      pageRequest("/workflow-permission-groups", query, normalizeWorkflowGroup),
    groupResource: (groupId: string) => mappedResource(apiResource<unknown>(`/workflow-permission-groups/${encodeURIComponent(groupId)}`), normalizeWorkflowGroup),
    createGroup: (input: Pick<WorkflowPermissionGroup, "name" | "purposes" | "status"> & Pick<Partial<WorkflowPermissionGroup>, "directMembers" | "linkedRoles" | "directMemberUserIds" | "linkedRoleIds">) =>
      apiRequest<unknown>("/workflow-permission-groups", { method: "POST", body: remoteMode ? remoteGroupInput(input) : input, ...mutation() }).then(normalizeWorkflowGroup),
    updateGroup: (groupId: string, patch: Partial<WorkflowPermissionGroup>, ifMatch?: string) =>
      apiRequest<unknown>(`/workflow-permission-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: remoteMode ? remoteGroupInput(patch) : patch, ifMatch }).then(normalizeWorkflowGroup),
    deleteGroup: (groupId: string, ifMatch: string) =>
      apiRequest<void>(`/workflow-permission-groups/${encodeURIComponent(groupId)}`, { method: "DELETE", ifMatch }),
  },
  organization: {
    departments: async (q?: string) => normalizeDepartments(await apiRequest<unknown>("/departments", { query: { q, includeDisabled: remoteMode ? true : undefined } })),
    department: async (departmentId: string) => mappedResource(apiResource<unknown>(`/departments/${encodeURIComponent(departmentId)}`), (value) => normalizeDepartments([value])[0]),
    createDepartment: async (input: { name: string; parentId?: string; sortOrder?: number; description?: string }) =>
      normalizeDepartments([await apiRequest<unknown>("/departments", {
        method: "POST",
        body: remoteMode ? remoteDepartmentInput({ ...input, status: "启用", sortOrder: input.sortOrder ?? 10 }) : input,
        ...mutation(),
      })])[0],
    updateDepartment: async (departmentId: string, patch: Partial<DepartmentRecord>, ifMatch: string) =>
      normalizeDepartments([await apiRequest<unknown>(`/departments/${encodeURIComponent(departmentId)}`, {
        method: "PATCH",
        body: remoteMode ? remoteDepartmentInput(patch) : patch,
        ifMatch,
      })])[0],
    removeDepartment: (departmentId: string, ifMatch: string) => apiRequest<void>(`/departments/${encodeURIComponent(departmentId)}`, { method: "DELETE", ifMatch }),
    positions: async () => normalizePositions(await apiRequest<unknown>("/positions", { query: { pageSize: 100 } })),
    position: (positionId: string) => mappedResource(apiResource<unknown>(`/positions/${encodeURIComponent(positionId)}`), (value) => normalizePositions([value])[0]),
    createPosition: async (input: { name: string; description?: string; sortOrder?: number }) =>
      normalizePositions([await apiRequest<unknown>("/positions", {
        method: "POST",
        body: remoteMode ? remotePositionInput({ ...input, status: "启用", sortOrder: input.sortOrder ?? 10 }) : input,
        ...mutation(),
      })])[0],
    updatePosition: async (positionId: string, patch: Partial<PositionRecord>, ifMatch: string) =>
      normalizePositions([await apiRequest<unknown>(`/positions/${encodeURIComponent(positionId)}`, {
        method: "PATCH",
        body: remoteMode ? remotePositionInput(patch) : patch,
        ifMatch,
      })])[0],
    removePosition: (positionId: string, ifMatch: string) => apiRequest<void>(`/positions/${encodeURIComponent(positionId)}`, { method: "DELETE", ifMatch }),
    permissionCatalog: async () => normalizePermissionCatalog(await apiRequest<unknown>("/permissions")),
    rolePermissions: (roleId: string) => mappedResource(apiResource<unknown>(`/roles/${encodeURIComponent(roleId)}/permissions`), normalizeRolePermissions),
    updateRolePermissions: async (roleId: string, permissions: string[], ifMatch: string) => normalizeRolePermissions(await apiRequest<unknown>(`/roles/${encodeURIComponent(roleId)}/permissions`, { method: "PUT", body: remoteMode ? { permissionCodes: permissions } : { permissions }, ifMatch })),
    roleImpact: async (roleId: string, nextMemberIds: string[], nextStatus: "启用" | "停用") => normalizeImpactPreview(await apiRequest<unknown>(`/roles/${encodeURIComponent(roleId)}/change-impact`, {
      method: "POST",
      body: remoteMode ? { nextMemberIds, nextStatus: remoteStatus(nextStatus) } : { nextMemberIds, nextStatus },
      ...mutation(),
    })),
    groupEffectiveMembers: (groupId: string, query: PageQuery = {}) =>
      pageRequest(`/workflow-permission-groups/${encodeURIComponent(groupId)}/effective-members`, query, normalizeEffectiveWorkflowMember),
    groupImpact: (groupId: string) => apiRequest<ImpactPreview>(`/workflow-permission-groups/${encodeURIComponent(groupId)}/change-impact`, { method: "POST", ...mutation() }),
  },
  definitions: {
    launchable: async () => (await apiRequest<unknown[]>("/me/launchable-process-definitions")).map(normalizeLaunchableDefinition),
    visible: (query: PageQuery = {}) => definitionPageRequest("/me/visible-process-definitions", query),
    list: (query: PageQuery & { type?: DefinitionType; status?: string } = {}) => definitionPageRequest("/process-definitions", {
      ...query,
      status: remoteMode && query.status ? remoteDefinitionStatus[query.status] ?? query.status : query.status,
    }),
    launchConfig: async (definitionId: string) => {
      const resource = await apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/launch-config`);
      if (!isRecord(resource.data)) throw new Error("流程发起配置响应格式不正确");
      const version = normalizeProcessVersion(resource.data.version);
      const candidateEntries = isRecord(resource.data.assigneeCandidatesByNode) ? Object.entries(resource.data.assigneeCandidatesByNode) : [];
      const assigneeCandidatesByNode = Object.fromEntries(candidateEntries.map(([nodeId, candidates]) => [
        nodeId,
        Array.isArray(candidates) ? candidates.map(normalizeDirectoryUser) : [],
      ]));
      return {
        ...resource,
        data: {
          definition: normalizeProcessDefinition(resource.data.definition, [version]),
          version,
          assigneeCandidatesByNode,
          firstAssigneeCandidates: Array.isArray(resource.data.firstAssigneeCandidates) ? resource.data.firstAssigneeCandidates.map(normalizeDirectoryUser) : [],
        } satisfies ProcessLaunchConfig,
      };
    },
    get: async (definitionId: string) => {
      const value = await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}`);
      return normalizeProcessDefinition(value, await fullVersionsRequest(definitionId));
    },
    getResource: async (definitionId: string) => {
      const resource = await apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}`);
      return { ...resource, data: normalizeProcessDefinition(resource.data, await fullVersionsRequest(definitionId)) };
    },
    create: (input: { basic: ProcessBasicConfig }) =>
      apiRequest<unknown>("/process-definitions", { method: "POST", body: { basic: remoteMode ? remoteBasicInput(input.basic) : input.basic }, ...mutation() }).then(normalizeDefinitionVersionResult),
    import: async (document: unknown) => {
      const value = await apiRequest<unknown>("/process-definitions/imports", { method: "POST", body: { document }, ...mutation() });
      const definition = normalizeProcessDefinition(value);
      return definition.versions.length ? definition : normalizeProcessDefinition(value, await fullVersionsRequest(definition.id));
    },
    copy: (definitionId: string, sourceVersionId?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/copies`, { method: "POST", body: { sourceVersionId }, ...mutation() }).then(normalizeDefinitionVersionResult),
    export: (definitionId: string) =>
      apiDownload(`/process-definitions/${encodeURIComponent(definitionId)}/export`),
    updateAvailability: async (definitionId: string, disabled: boolean, ifMatch?: string) => {
      const value = await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}`, { method: "PATCH", body: { disabled }, ifMatch });
      const versions = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId)?.versions;
      return normalizeProcessDefinition(value, versions);
    },
    remove: (definitionId: string, ifMatch?: string) =>
      apiRequest<void>(`/process-definitions/${encodeURIComponent(definitionId)}`, { method: "DELETE", ifMatch }),
    versions: (definitionId: string) => fullVersionsRequest(definitionId),
    version: (definitionId: string, versionId: string) => apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`).then(normalizeProcessVersion),
    versionResource: (definitionId: string, versionId: string) => mappedResource(apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`), normalizeProcessVersion),
    createVersion: (definitionId: string, sourceVersionId: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions`, { method: "POST", body: { sourceVersionId }, ...mutation() }).then(normalizeProcessVersion),
    saveBasic: (definitionId: string, versionId: string, basic: ProcessBasicConfig, ifMatch?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/basic`, { method: "PUT", body: remoteMode ? remoteBasicInput(basic) : basic, ifMatch }).then(normalizeSavedVersion),
    saveBasicResource: (definitionId: string, versionId: string, basic: ProcessBasicConfig, ifMatch?: string) =>
      mappedResource(apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/basic`, { method: "PUT", body: remoteMode ? remoteBasicInput(basic) : basic, ifMatch }), normalizeSavedVersion),
    saveDesigner: (definitionId: string, versionId: string, snapshot: Partial<CompleteDesignerSnapshot>, ifMatch?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/designer`, { method: "PUT", body: snapshot, ifMatch }).then(normalizeSavedVersion),
    saveFormDesigner: (definitionId: string, versionId: string, input: Pick<CompleteDesignerSnapshot, "form" | "systemFields">, ifMatch?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/form-designer`, { method: "PUT", body: remoteMode ? remoteFormDesignerInput(input) : input, ifMatch }).then(normalizeSavedVersionResult),
    saveFormDesignerResource: (definitionId: string, versionId: string, input: Pick<CompleteDesignerSnapshot, "form" | "systemFields">, ifMatch?: string) =>
      mappedResource(apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/form-designer`, { method: "PUT", body: remoteMode ? remoteFormDesignerInput(input) : input, ifMatch }), normalizeSavedVersionResult),
    saveFlowDesigner: (definitionId: string, versionId: string, input: { basicPatch: Pick<ProcessBasicConfig, "name" | "starterGroups">; flow: CompleteDesignerSnapshot["flow"] }, ifMatch?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/flow-designer`, { method: "PUT", body: remoteMode ? remoteFlowDesignerInput(input) : input, ifMatch }).then(normalizeSavedVersionResult),
    saveFlowDesignerResource: (definitionId: string, versionId: string, input: { basicPatch: Pick<ProcessBasicConfig, "name" | "starterGroups">; flow: CompleteDesignerSnapshot["flow"] }, ifMatch?: string) =>
      mappedResource(apiResource<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/flow-designer`, { method: "PUT", body: remoteMode ? remoteFlowDesignerInput(input) : input, ifMatch }), normalizeSavedVersionResult),
    validate: async (definitionId: string, versionId: string, ifMatch?: string) => {
      const value = await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/validate`, { method: "POST", ifMatch, ...mutation() });
      if (isRecord(value) && value.snapshot && value.basic) return normalizeProcessVersion(value);
      return normalizeProcessVersion(await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`));
    },
    publish: (definitionId: string, versionId: string, changeNote: string, ifMatch?: string) =>
      apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/publish`, { method: "POST", body: { changeNote }, ifMatch, ...mutation() }).then(normalizeDefinitionVersionResult),
    unpublish: async (definitionId: string, versionId: string, reason: string, ifMatch?: string) => {
      const value = await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/unpublish`, { method: "POST", body: { reason }, ifMatch, ...mutation() });
      if (isRecord(value) && value.definition && (value.version || value.publishedVersion)) return normalizeDefinitionVersionResult(value);
      const version = normalizeProcessVersion(await apiRequest<unknown>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`));
      const currentVersions = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definitionId)?.versions ?? [];
      return {
        definition: normalizeProcessDefinition(value, [version, ...currentVersions.filter((item) => item.id !== version.id)]),
        version,
      };
    },
    removeVersion: (definitionId: string, versionId: string, ifMatch?: string) =>
      apiRequest<void>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE", ifMatch }),
  },
  instances: {
    list: (query: ProcessInstanceQuery = {}) => pageRequest("/process-instances", {
      ...(remoteMode ? {
        page: query.page,
        pageSize: query.pageSize,
        q: query.q,
        definitionId: query.definitionId,
        status: query.status ? remoteInstanceStatus[query.status] : undefined,
        initiatorId: query.initiatorId,
        dynamicFilters: query.dynamicFilters,
        activeOnly: query.activeOnly,
        ...defaultInstanceDateRange(),
        dateFrom: query.createdFrom ?? defaultInstanceDateRange().dateFrom,
        dateTo: query.createdTo ?? defaultInstanceDateRange().dateTo,
      } : query),
    }, normalizeProcessInstance),
    get: (instanceId: string) => apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}`).then(normalizeInstanceDetail),
    getResource: (instanceId: string) => mappedResource(apiResource<unknown>(`/process-instances/${encodeURIComponent(instanceId)}`), normalizeInstanceDetail),
    create: (input: { definitionId: string; formValues: Record<string, unknown>; copySourceInstanceId?: string; assigneeByNode?: Record<string, string | undefined>; firstAssigneeId?: string; attachmentIds?: string[]; attachmentIdsByField?: Record<string, string[]> }) =>
      apiRequest<unknown>("/process-instances", { method: "POST", body: input, ...mutation() }).then(normalizeInstanceDetail),
    updateSubmission: (instanceId: string, input: { formValues: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]>; assigneeByNode?: Record<string, string> }, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/submission`, { method: "PATCH", body: remoteMode ? { formValues: input.formValues, attachmentIdsByField: input.attachmentIdsByField ?? {}, assigneeByNode: input.assigneeByNode } : input, ifMatch }).then(normalizeInstanceDetail),
    resubmit: (instanceId: string, input: { formValues: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]> }, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/resubmissions`, { method: "POST", body: remoteMode ? { formValues: input.formValues, attachmentIdsByField: input.attachmentIdsByField ?? {} } : input, ifMatch, ...mutation() }).then(normalizeInstanceDetail),
    close: (instanceId: string, reason: string, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/close`, { method: "POST", body: { reason }, ifMatch, ...mutation() }).then(normalizeInstanceDetail),
  },
  exports: {
    processInstanceData: (filter: ProcessExcelDataFilter) =>
      apiRequest<ProcessExcelDataset>("/exports/process-instances/data", {
        method: "POST",
        body: { filter },
        timeoutMs: 60_000,
      }),
  },
  tasks: {
    listMine: (query: WorkflowTaskQuery = {}) => taskPageRequest(query),
    get: (taskId: string) => apiRequest<unknown>(`/workflow-tasks/${encodeURIComponent(taskId)}`).then(normalizeTaskDetailItem),
    getResource: async (taskId: string) => {
      const resource = await apiResource<unknown>(`/workflow-tasks/${encodeURIComponent(taskId)}`);
      return { ...resource, data: await normalizeTaskDetailItem(resource.data) };
    },
    decide: async (taskId: string, input: { action: "pass" | "confirm" | "reject"; comment?: string; fieldValues?: Record<string, unknown>; attachmentIdsByField?: Record<string, string[]> }, ifMatch?: string) => {
      const task = usePrototypeStore.getState().tasks.find((item) => item.id === taskId);
      const instance = usePrototypeStore.getState().instances.find((item) => item.id === task?.instanceId);
      const fieldIds = task?.editableFieldIds ?? [];
      const canEditField = (fieldId: string) => fieldIds.includes(fieldId) || fieldIds.some((id) => id.startsWith(`${fieldId}.`));
      const fieldValues = Object.fromEntries(Object.entries(input.fieldValues ?? {}).filter(([fieldId]) => canEditField(fieldId)));
      const attachmentIdsByField = Object.fromEntries(Object.entries(input.attachmentIdsByField ?? {}).filter(([fieldId]) => fieldIds.includes(fieldId)));
      const revisedFieldIds = [...new Set([...Object.keys(fieldValues), ...Object.keys(attachmentIdsByField)])];
      const baseFieldRevisions = Object.fromEntries(revisedFieldIds.map((fieldId) => [fieldId, instance?.fieldRevisions?.[fieldId] ?? 0]));
      const value = await apiRequest<unknown>(`/workflow-tasks/${encodeURIComponent(taskId)}/decision`, {
        method: "POST",
        body: remoteMode ? { ...input, fieldValues, baseFieldRevisions, attachmentIdsByField } : input,
        ifMatch,
        ...mutation(),
      });
      if (!isRecord(value)) throw new Error("任务提交响应格式不正确");
      return {
        instance: normalizeProcessInstance(value.instance),
        task: normalizeWorkflowTask(value.task),
        activatedTaskIds: Array.isArray(value.activatedTaskIds) ? value.activatedTaskIds.filter((id): id is string => typeof id === "string") : [],
        cancelledTaskIds: Array.isArray(value.cancelledTaskIds) ? value.cancelledTaskIds.filter((id): id is string => typeof id === "string") : [],
      } satisfies WorkflowDecisionResult;
    },
    reviseFields: async (taskId: string, fieldValues: Record<string, unknown>, comment?: string, ifMatch?: string, attachmentIdsByField?: Record<string, string[]>) => {
      const task = usePrototypeStore.getState().tasks.find((item) => item.id === taskId);
      const instance = usePrototypeStore.getState().instances.find((item) => item.id === task?.instanceId);
      const allowedIds = task?.editableFieldIds ?? [];
      const canEditField = (fieldId: string) => allowedIds.includes(fieldId) || allowedIds.some((id) => id.startsWith(`${fieldId}.`));
      const allowedValues = Object.fromEntries(Object.entries(fieldValues).filter(([fieldId]) => canEditField(fieldId)));
      const allowedAttachmentIds = Object.fromEntries(Object.entries(attachmentIdsByField ?? {}).filter(([fieldId]) => allowedIds.includes(fieldId)));
      const revisedFieldIds = [...new Set([...Object.keys(allowedValues), ...Object.keys(allowedAttachmentIds)])];
      const baseFieldRevisions = Object.fromEntries(revisedFieldIds.map((fieldId) => [fieldId, instance?.fieldRevisions?.[fieldId] ?? 0]));
      const value = await apiRequest<unknown>(`/workflow-tasks/${encodeURIComponent(taskId)}/field-revisions`, {
        method: "POST",
        body: remoteMode ? { fieldValues: allowedValues, baseFieldRevisions, comment, attachmentIdsByField: allowedAttachmentIds } : { fieldValues, comment, attachmentIdsByField },
        ifMatch,
        ...mutation(),
      });
      if (!isRecord(value)) throw new Error("任务字段修改响应格式不正确");
      return {
        instance: normalizeProcessInstance(value.instance),
        task: normalizeWorkflowTask(value.task),
      } satisfies WorkflowRevisionResult;
    },
  },
  freeFlows: {
    create: async (input: { definitionId: string; title: string; category: string; priority: "普通" | "紧急"; description: string; initialContent: string; attachmentIds?: string[]; assigneeId: string }) => {
      const result = await apiRequest<unknown>("/process-instances", {
        method: "POST",
        body: {
          definitionId: input.definitionId,
          firstAssigneeId: input.assigneeId,
          attachmentIds: input.attachmentIds,
          formValues: {
            title: input.title,
            category: input.category,
            priority: input.priority,
            description: input.description,
            initialContent: input.initialContent,
          },
        },
        ...mutation(),
      });
      return normalizeInstanceDetail(result).instance;
    },
    reply: async (instanceId: string, content: string, ifMatch?: string) => {
      const result = await apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/replies`, { method: "POST", body: { content }, ifMatch, ...mutation() });
      return remoteMode
        ? normalizeInstanceDetail(await apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}`)).instance
        : normalizeProcessInstance(result);
    },
    transfer: (instanceId: string, nextAssigneeId: string, content?: string, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/transfers`, { method: "POST", body: { nextAssigneeId, content }, ifMatch, ...mutation() })
        .then((value) => normalizeInstanceDetail(value).instance),
    editReply: async (instanceId: string, entryId: string, content: string, ifMatch?: string) => {
      const result = await apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/replies/${encodeURIComponent(entryId)}`, { method: "PATCH", body: { content }, ifMatch });
      return remoteMode
        ? normalizeInstanceDetail(await apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}`)).instance
        : normalizeProcessInstance(result);
    },
    updateSubmission: (instanceId: string, input: {
      formValues: Record<string, unknown>;
      attachmentIdsByField?: Record<string, string[]>;
    }, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/initial-form`, {
        method: "PATCH",
        body: {
          formValues: input.formValues,
          attachmentIdsByField: input.attachmentIdsByField ?? {},
        },
        ifMatch,
      })
        .then((value) => normalizeInstanceDetail(value).instance),
    close: (instanceId: string, reason: string, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/close`, { method: "POST", body: { reason }, ifMatch, ...mutation() })
        .then((value) => normalizeInstanceDetail(value).instance),
    reopen: (instanceId: string, reason: string, assigneeId: string, ifMatch?: string) =>
      apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/reopen`, { method: "POST", body: { reason, assigneeId }, ifMatch, ...mutation() })
        .then((value) => normalizeInstanceDetail(value).instance),
  },
  attachments: {
    upload: (file: File, input: { instanceId?: string; definitionId?: string; versionId?: string; fieldId?: string; purpose?: "form-field" | "free-reply" } = {}) => {
      const form = new FormData();
      form.set("file", file);
      if (input.instanceId) form.set("instanceId", input.instanceId);
      if (input.definitionId) form.set("definitionId", input.definitionId);
      if (input.versionId) form.set("versionId", input.versionId);
      if (input.fieldId) form.set("fieldId", input.fieldId);
      if (input.purpose) form.set("purpose", input.purpose);
      return apiRequest<unknown>("/attachments", { method: "POST", body: form, ...mutation(), timeoutMs: 60_000 }).then(normalizeAttachmentRecord);
    },
    get: (attachmentId: string) => apiRequest<unknown>(`/attachments/${encodeURIComponent(attachmentId)}`).then(normalizeAttachmentRecord),
    replaceFieldAttachment: (instanceId: string, fieldId: string, file: File, ifMatch?: string) => {
      const form = new FormData();
      form.set("file", file);
      return apiRequest<unknown>(`/process-instances/${encodeURIComponent(instanceId)}/fields/${encodeURIComponent(fieldId)}/attachment`, {
        method: "PUT",
        body: form,
        ifMatch,
        ...mutation(),
        timeoutMs: 60_000,
      }).then(normalizeAttachmentRecord);
    },
    content: (attachmentId: string) => apiDownload(`/attachments/${encodeURIComponent(attachmentId)}/content`),
    remove: async (attachmentId: string) => {
      const resource = await apiResource<unknown>(`/attachments/${encodeURIComponent(attachmentId)}`);
      return apiRequest<void>(`/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE", ifMatch: resource.etag });
    },
  },
  notifications: {
    emailOutbox: (query: PageQuery & { status?: EmailOutboxItem["status"]; dateFrom?: string; dateTo?: string } = {}) => {
      const today = new Date();
      const dateTo = today.toISOString().slice(0, 10);
      today.setDate(today.getDate() - 30);
      const dateFrom = today.toISOString().slice(0, 10);
      const remoteStatus = query.status === "sent" ? "sent" : query.status === "failed" ? "dead-letter" : query.status === "queued" ? "pending" : undefined;
      return pageRequest("/email-outbox", {
        ...query,
        status: remoteMode ? remoteStatus : query.status,
        dateFrom: query.dateFrom ?? dateFrom,
        dateTo: query.dateTo ?? dateTo,
      }, normalizeEmailOutboxItem);
    },
    emailDelivery: (deliveryId: string) =>
      apiRequest<unknown>(`/email-outbox/${encodeURIComponent(deliveryId)}`).then(normalizeEmailOutboxItem),
    retryEmail: async (deliveryId: string) => {
      if (!remoteMode) {
        return apiRequest<unknown>(`/email-outbox/${encodeURIComponent(deliveryId)}/retry`, { method: "POST", ...mutation() }).then(normalizeEmailOutboxItem);
      }
      const resource = await apiResource<unknown>(`/email-outbox/${encodeURIComponent(deliveryId)}`);
      return apiRequest<unknown>(`/email-outbox/${encodeURIComponent(deliveryId)}/retry`, {
        method: "POST",
        ifMatch: resource.etag,
        ...mutation(),
      }).then(normalizeEmailOutboxItem);
    },
  },
  audit: {
    events: (query: PageQuery & { category?: AuditEvent["category"]; result?: "success" | "failure"; dateFrom?: string; dateTo?: string } = {}) =>
      pageRequest("/audit-events", query, normalizeAuditEvent),
    event: (eventId: string) => apiRequest<unknown>(`/audit-events/${encodeURIComponent(eventId)}`).then(normalizeAuditEvent),
  },
};

export type FlowPilotApi = typeof flowPilotApi;
