import type { InstanceStatus, ProcessInstance, WorkflowTask } from "../data/types";
import type { DomainRole, DomainUser, WorkflowPermissionGroup } from "../state/useIdentityStore";
import type {
  DefinitionType,
  ProcessBasicConfig,
  ProcessDefinition,
  ProcessVersion,
} from "../state/useProcessDefinitionStore";
import type { CompleteDesignerSnapshot } from "../utils/designerStorage";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { useIdentityStore } from "../state/useIdentityStore";
import { apiDownload, apiRequest, apiResource, createIdempotencyKey, writeApiAccessToken } from "./client";
import type {
  ApiHealth,
  AttachmentRecord,
  AuditEvent,
  AuthSession,
  DepartmentRecord,
  DirectorySnapshot,
  DirectoryUser,
  EmailOutboxItem,
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
}

export interface WorkflowTaskQuery extends PageQuery {
  view?: "pending" | "completed" | "all";
  definitionId?: string;
}

const mutation = () => ({ idempotencyKey: createIdempotencyKey() });

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
  writeApiAccessToken(session.accessToken ?? readCurrentToken());
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
      const session = await apiRequest<AuthSession>("/auth/login", { method: "POST", body, ...mutation() });
      return applySession(session);
    },
    me: async () => {
      const session = await apiRequest<AuthSession | DirectoryUser>("/auth/me");
      const normalized: AuthSession = "user" in session
        ? session
        : { user: session, operatorUser: session };
      return applySession(normalized);
    },
    impersonationCandidates: (query: PageQuery = {}) =>
      apiRequest<PageResult<DirectoryUser>>("/auth/impersonation/candidates", { query }),
    startImpersonation: async (targetUserId: string, reason: string) => applySession(
      await apiRequest<AuthSession>("/auth/impersonation", {
        method: "POST",
        body: { targetUserId, reason },
        ...mutation(),
      }),
    ),
    stopImpersonation: async () => applySession(
      await apiRequest<AuthSession>("/auth/impersonation", { method: "DELETE", ...mutation() }),
    ),
    logout: async () => {
      try {
        await apiRequest<void>("/auth/logout", { method: "POST", ...mutation() });
      } finally {
        writeApiAccessToken();
        usePrototypeStore.getState().logout();
      }
    },
  },
  directory: {
    snapshot: () => apiRequest<DirectorySnapshot>("/directory"),
    users: (query: PageQuery & { status?: "启用" | "停用"; hasEmail?: boolean } = {}) =>
      apiRequest<PageResult<DirectoryUser>>("/users", { query }),
    user: (userId: string) => apiRequest<DirectoryUser>(`/users/${encodeURIComponent(userId)}`),
    userResource: (userId: string) => apiResource<DirectoryUser>(`/users/${encodeURIComponent(userId)}`),
    createUser: (input: Omit<DomainUser, "id" | "lastLogin">) =>
      apiRequest<DirectoryUser>("/users", { method: "POST", body: input, ...mutation() }),
    updateUser: (userId: string, patch: Partial<DomainUser>, ifMatch?: string) =>
      apiRequest<DirectoryUser>(`/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: patch, ifMatch }),
    updateUserStatus: (userId: string, status: "启用" | "停用", ifMatch: string) =>
      apiRequest<DirectoryUser>(`/users/${encodeURIComponent(userId)}/status`, { method: "PUT", body: { status }, ifMatch }),
    resetPassword: (userId: string) =>
      apiRequest<{ temporaryPassword: string }>(`/users/${encodeURIComponent(userId)}/reset-password`, { method: "POST", ...mutation() }),
    roles: (query: PageQuery = {}) => apiRequest<PageResult<DomainRole>>("/roles", { query }),
    roleResource: (roleId: string) => apiResource<DomainRole>(`/roles/${encodeURIComponent(roleId)}`),
    createRole: (input: Omit<DomainRole, "id" | "code" | "pagePermissions" | "actionPermissions" | "users">) =>
      apiRequest<DomainRole>("/roles", { method: "POST", body: input, ...mutation() }),
    updateRole: (roleId: string, patch: Partial<DomainRole>, ifMatch?: string) =>
      apiRequest<DomainRole>(`/roles/${encodeURIComponent(roleId)}`, { method: "PATCH", body: patch, ifMatch }),
    groups: (query: PageQuery & { purpose?: string } = {}) =>
      apiRequest<PageResult<WorkflowPermissionGroup>>("/workflow-permission-groups", { query }),
    groupResource: (groupId: string) => apiResource<WorkflowPermissionGroup>(`/workflow-permission-groups/${encodeURIComponent(groupId)}`),
    createGroup: (input: Pick<WorkflowPermissionGroup, "name" | "purposes" | "directMembers" | "linkedRoles" | "status">) =>
      apiRequest<WorkflowPermissionGroup>("/workflow-permission-groups", { method: "POST", body: input, ...mutation() }),
    updateGroup: (groupId: string, patch: Partial<WorkflowPermissionGroup>, ifMatch?: string) =>
      apiRequest<WorkflowPermissionGroup>(`/workflow-permission-groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body: patch, ifMatch }),
  },
  organization: {
    departments: (q?: string) => apiRequest<DepartmentRecord[]>("/departments", { query: { q } }),
    department: (departmentId: string) => apiResource<DepartmentRecord>(`/departments/${encodeURIComponent(departmentId)}`),
    createDepartment: (input: { name: string; parentId?: string; sortOrder?: number; description?: string }) => apiRequest<DepartmentRecord>("/departments", { method: "POST", body: input, ...mutation() }),
    updateDepartment: (departmentId: string, patch: Partial<DepartmentRecord>, ifMatch: string) => apiRequest<DepartmentRecord>(`/departments/${encodeURIComponent(departmentId)}`, { method: "PATCH", body: patch, ifMatch }),
    removeDepartment: (departmentId: string, ifMatch: string) => apiRequest<void>(`/departments/${encodeURIComponent(departmentId)}`, { method: "DELETE", ifMatch }),
    positions: () => apiRequest<PositionRecord[]>("/positions"),
    position: (positionId: string) => apiResource<PositionRecord>(`/positions/${encodeURIComponent(positionId)}`),
    createPosition: (input: { name: string; description?: string; sortOrder?: number }) => apiRequest<PositionRecord>("/positions", { method: "POST", body: input, ...mutation() }),
    updatePosition: (positionId: string, patch: Partial<PositionRecord>, ifMatch: string) => apiRequest<PositionRecord>(`/positions/${encodeURIComponent(positionId)}`, { method: "PATCH", body: patch, ifMatch }),
    removePosition: (positionId: string, ifMatch: string) => apiRequest<void>(`/positions/${encodeURIComponent(positionId)}`, { method: "DELETE", ifMatch }),
    permissionCatalog: () => apiRequest<PermissionCatalogItem[]>("/permissions"),
    rolePermissions: (roleId: string) => apiResource<string[]>(`/roles/${encodeURIComponent(roleId)}/permissions`),
    updateRolePermissions: (roleId: string, permissions: string[], ifMatch: string) => apiRequest<string[]>(`/roles/${encodeURIComponent(roleId)}/permissions`, { method: "PUT", body: { permissions }, ifMatch }),
    roleImpact: (roleId: string) => apiRequest<ImpactPreview>(`/roles/${encodeURIComponent(roleId)}/change-impact`, { method: "POST", ...mutation() }),
    groupEffectiveMembers: (groupId: string, query: PageQuery = {}) => apiRequest<PageResult<{ id: string; account: string; name: string; email: string; departmentPath: string; sources: string[] }>>(`/workflow-permission-groups/${encodeURIComponent(groupId)}/effective-members`, { query }),
    groupImpact: (groupId: string) => apiRequest<ImpactPreview>(`/workflow-permission-groups/${encodeURIComponent(groupId)}/change-impact`, { method: "POST", ...mutation() }),
  },
  definitions: {
    launchable: () => apiRequest<LaunchableProcessDefinition[]>("/me/launchable-process-definitions"),
    visible: (query: PageQuery = {}) =>
      apiRequest<PageResult<ProcessDefinitionListItem>>("/me/visible-process-definitions", { query }),
    list: (query: PageQuery & { type?: DefinitionType; status?: string } = {}) =>
      apiRequest<PageResult<ProcessDefinitionListItem>>("/process-definitions", { query }),
    launchConfig: (definitionId: string) =>
      apiResource<ProcessLaunchConfig>(`/process-definitions/${encodeURIComponent(definitionId)}/launch-config`),
    get: (definitionId: string) => apiRequest<ProcessDefinition>(`/process-definitions/${encodeURIComponent(definitionId)}`),
    getResource: (definitionId: string) => apiResource<ProcessDefinition>(`/process-definitions/${encodeURIComponent(definitionId)}`),
    create: (input: { basic: ProcessBasicConfig }) =>
      apiRequest<ProcessDefinitionVersionResult>("/process-definitions", { method: "POST", body: input, ...mutation() }),
    copy: (definitionId: string, sourceVersionId?: string) =>
      apiRequest<ProcessDefinitionVersionResult>(`/process-definitions/${encodeURIComponent(definitionId)}/copies`, { method: "POST", body: { sourceVersionId }, ...mutation() }),
    updateAvailability: (definitionId: string, disabled: boolean, ifMatch?: string) =>
      apiRequest<ProcessDefinition>(`/process-definitions/${encodeURIComponent(definitionId)}`, { method: "PATCH", body: { disabled }, ifMatch }),
    remove: (definitionId: string, ifMatch?: string) =>
      apiRequest<void>(`/process-definitions/${encodeURIComponent(definitionId)}`, { method: "DELETE", ifMatch }),
    versions: (definitionId: string) => apiRequest<ProcessVersion[]>(`/process-definitions/${encodeURIComponent(definitionId)}/versions`),
    version: (definitionId: string, versionId: string) => apiRequest<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`),
    versionResource: (definitionId: string, versionId: string) => apiResource<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`),
    createVersion: (definitionId: string, sourceVersionId: string) =>
      apiRequest<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions`, { method: "POST", body: { sourceVersionId }, ...mutation() }),
    saveBasic: (definitionId: string, versionId: string, basic: ProcessBasicConfig, ifMatch?: string) =>
      apiRequest<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/basic`, { method: "PUT", body: basic, ifMatch }),
    saveDesigner: (definitionId: string, versionId: string, snapshot: Partial<CompleteDesignerSnapshot>, ifMatch?: string) =>
      apiRequest<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/designer`, { method: "PUT", body: snapshot, ifMatch }),
    saveFormDesigner: (definitionId: string, versionId: string, input: Pick<CompleteDesignerSnapshot, "form" | "systemFields">, ifMatch?: string) =>
      apiRequest<SavedProcessVersionResult>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/form-designer`, { method: "PUT", body: input, ifMatch }),
    saveFlowDesigner: (definitionId: string, versionId: string, input: { basicPatch?: Pick<ProcessBasicConfig, "name" | "starterGroups">; flow: CompleteDesignerSnapshot["flow"] }, ifMatch?: string) =>
      apiRequest<SavedProcessVersionResult>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/flow-designer`, { method: "PUT", body: input, ifMatch }),
    validate: (definitionId: string, versionId: string, ifMatch?: string) =>
      apiRequest<ProcessVersion>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/validate`, { method: "POST", ifMatch, ...mutation() }),
    publish: (definitionId: string, versionId: string, changeNote: string, ifMatch?: string) =>
      apiRequest<ProcessDefinitionVersionResult>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/publish`, { method: "POST", body: { changeNote }, ifMatch, ...mutation() }),
    unpublish: (definitionId: string, versionId: string, reason: string, ifMatch?: string) =>
      apiRequest<ProcessDefinitionVersionResult>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/unpublish`, { method: "POST", body: { reason }, ifMatch, ...mutation() }),
    removeVersion: (definitionId: string, versionId: string, ifMatch?: string) =>
      apiRequest<void>(`/process-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE", ifMatch }),
  },
  instances: {
    list: (query: ProcessInstanceQuery = {}) => apiRequest<PageResult<ProcessInstance>>("/process-instances", { query }),
    get: (instanceId: string) => apiRequest<ProcessInstanceDetail>(`/process-instances/${encodeURIComponent(instanceId)}`),
    getResource: (instanceId: string) => apiResource<ProcessInstanceDetail>(`/process-instances/${encodeURIComponent(instanceId)}`),
    create: (input: { definitionId: string; formValues: Record<string, unknown>; copySourceInstanceId?: string; assigneeByNode?: Record<string, string | undefined>; firstAssigneeId?: string; attachmentIds?: string[]; attachmentIdsByField?: Record<string, string[]> }) =>
      apiRequest<ProcessInstanceDetail>("/process-instances", { method: "POST", body: input, ...mutation() }),
    updateSubmission: (instanceId: string, input: { formValues: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]>; assigneeByNode?: Record<string, string> }, ifMatch?: string) =>
      apiRequest<ProcessInstanceDetail>(`/process-instances/${encodeURIComponent(instanceId)}/submission`, { method: "PATCH", body: input, ifMatch }),
    resubmit: (instanceId: string, input: { formValues: Record<string, unknown>; attachmentNames?: string[]; attachmentIdsByField?: Record<string, string[]> }, ifMatch?: string) =>
      apiRequest<ProcessInstanceDetail>(`/process-instances/${encodeURIComponent(instanceId)}/resubmissions`, { method: "POST", body: input, ifMatch, ...mutation() }),
    close: (instanceId: string, reason: string, ifMatch?: string) =>
      apiRequest<ProcessInstanceDetail>(`/process-instances/${encodeURIComponent(instanceId)}/close`, { method: "POST", body: { reason }, ifMatch, ...mutation() }),
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
    listMine: (query: WorkflowTaskQuery = {}) => apiRequest<PageResult<WorkflowTaskListItem>>("/me/workflow-tasks", { query }),
    get: (taskId: string) => apiRequest<WorkflowTaskListItem>(`/workflow-tasks/${encodeURIComponent(taskId)}`),
    getResource: (taskId: string) => apiResource<WorkflowTaskListItem>(`/workflow-tasks/${encodeURIComponent(taskId)}`),
    decide: (taskId: string, input: { action: "pass" | "confirm" | "reject"; comment?: string; fieldValues?: Record<string, unknown>; attachmentIdsByField?: Record<string, string[]> }, ifMatch?: string) =>
      apiRequest<WorkflowDecisionResult>(`/workflow-tasks/${encodeURIComponent(taskId)}/decision`, { method: "POST", body: input, ifMatch, ...mutation() }),
    reviseFields: (taskId: string, fieldValues: Record<string, unknown>, comment?: string, ifMatch?: string, attachmentIdsByField?: Record<string, string[]>) =>
      apiRequest<WorkflowRevisionResult>(`/workflow-tasks/${encodeURIComponent(taskId)}/field-revisions`, { method: "POST", body: { fieldValues, comment, attachmentIdsByField }, ifMatch, ...mutation() }),
  },
  freeFlows: {
    create: async (input: { definitionId: string; title: string; category: string; priority: "普通" | "紧急"; description: string; initialContent: string; attachmentIds?: string[]; assigneeId: string }) => {
      const result = await apiRequest<ProcessInstanceDetail>("/process-instances", {
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
      return result.instance;
    },
    reply: (instanceId: string, content: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/replies`, { method: "POST", body: { content }, ...mutation() }),
    transfer: (instanceId: string, content: string, nextAssigneeId: string, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/transfers`, { method: "POST", body: { content, nextAssigneeId }, ifMatch, ...mutation() }),
    editReply: (instanceId: string, entryId: string, content: string, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/replies/${encodeURIComponent(entryId)}`, { method: "PATCH", body: { content }, ifMatch }),
    updateSubmission: (instanceId: string, input: { title: string; category: string; priority: "普通" | "紧急"; description: string; initialContent: string }, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/initial-form`, { method: "PUT", body: input, ifMatch }),
    reassign: (instanceId: string, reason: string, assigneeId: string, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/reassignments`, { method: "POST", body: { reason, assigneeId }, ifMatch, ...mutation() }),
    close: (instanceId: string, reason: string, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/close`, { method: "POST", body: { reason }, ifMatch, ...mutation() }),
    reopen: (instanceId: string, reason: string, assigneeId: string, ifMatch?: string) =>
      apiRequest<ProcessInstance>(`/process-instances/${encodeURIComponent(instanceId)}/free-collaboration/reopen`, { method: "POST", body: { reason, assigneeId }, ifMatch, ...mutation() }),
  },
  attachments: {
    upload: (file: File, input: { instanceId?: string; definitionId?: string; versionId?: string; fieldId?: string } = {}) => {
      const form = new FormData();
      form.set("file", file);
      if (input.instanceId) form.set("instanceId", input.instanceId);
      if (input.definitionId) form.set("definitionId", input.definitionId);
      if (input.versionId) form.set("versionId", input.versionId);
      if (input.fieldId) form.set("fieldId", input.fieldId);
      return apiRequest<AttachmentRecord>("/attachments", { method: "POST", body: form, ...mutation(), timeoutMs: 60_000 });
    },
    get: (attachmentId: string) => apiRequest<AttachmentRecord>(`/attachments/${encodeURIComponent(attachmentId)}`),
    replaceFieldAttachment: (instanceId: string, fieldId: string, file: File, ifMatch?: string) => {
      const form = new FormData();
      form.set("file", file);
      return apiRequest<AttachmentRecord>(`/process-instances/${encodeURIComponent(instanceId)}/fields/${encodeURIComponent(fieldId)}/attachment`, {
        method: "PUT",
        body: form,
        ifMatch,
        ...mutation(),
        timeoutMs: 60_000,
      });
    },
    content: (attachmentId: string) => apiDownload(`/attachments/${encodeURIComponent(attachmentId)}/content`),
    remove: (attachmentId: string) => apiRequest<void>(`/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }),
  },
  notifications: {
    emailOutbox: (query: PageQuery & { status?: EmailOutboxItem["status"] } = {}) =>
      apiRequest<PageResult<EmailOutboxItem>>("/email-outbox", { query }),
    emailDelivery: (deliveryId: string) => apiRequest<EmailOutboxItem>(`/email-outbox/${encodeURIComponent(deliveryId)}`),
    retryEmail: (deliveryId: string) =>
      apiRequest<EmailOutboxItem>(`/email-outbox/${encodeURIComponent(deliveryId)}/retry`, { method: "POST", ...mutation() }),
  },
  audit: {
    events: (query: PageQuery & { category?: AuditEvent["category"]; from?: string; to?: string } = {}) =>
      apiRequest<PageResult<AuditEvent>>("/audit-events", { query }),
    event: (eventId: string) => apiRequest<AuditEvent>(`/audit-events/${encodeURIComponent(eventId)}`),
  },
};

export type FlowPilotApi = typeof flowPilotApi;
