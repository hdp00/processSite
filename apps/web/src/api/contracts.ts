import type { ProcessInstance, WorkflowTask } from "../data/types";
import type {
  DomainRole,
  DomainUser,
  WorkflowPermissionGroup,
} from "../state/useIdentityStore";
import type {
  ProcessDefinition,
  ProcessVersion,
} from "../state/useProcessDefinitionStore";

export type DirectoryUser = Omit<DomainUser, "password">;

export interface ApiMeta {
  requestId: string;
  timestamp: string;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface PageInfo {
  number: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface PageResult<T> {
  items: T[];
  page: PageInfo;
}

export interface ValidationProblemField {
  path: string;
  code: string;
  message: string;
}

export interface ApiProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  traceId: string;
  errors?: ValidationProblemField[];
  currentEtag?: string;
}

export type MockScenario = "normal" | "slow" | "offline" | "server-error" | "conflict" | "mail-fail" | "upload-fail";

export interface MockApiSettings {
  scenario: MockScenario;
  readDelayMs: number;
  writeDelayMs: number;
}

export interface ApiHealth {
  status: "ok";
  service: "flowpilot-mock-api";
  version: "v1";
  mode: "mock";
  time: string;
}

export interface AuthSession {
  accessToken?: string;
  tokenType?: "Bearer";
  expiresIn?: number;
  /** 当前请求实际生效的用户；所有权限和数据范围均以此用户为准。 */
  user: DirectoryUser;
  /** 建立登录会话的真实操作者；模拟身份期间不会改变。 */
  operatorUser?: DirectoryUser;
  roleIds?: string[];
  permissions?: string[];
  /** 当前生效用户是否为超级管理员。 */
  superAdmin?: boolean;
  /** 真实操作者是否允许发起和结束模拟身份。 */
  operatorSuperAdmin?: boolean;
  impersonation?: ImpersonationContext;
  expiresAt?: string;
}

export interface ImpersonationContext {
  id: string;
  operatorUserId: string;
  targetUserId: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
}

export interface ProcessDefinitionListItem extends ProcessDefinition {
  status: "unpublished" | "published" | "disabled";
}

export interface ProcessDefinitionVersionResult {
  definition: ProcessDefinition;
  version: ProcessVersion;
}

export interface SavedProcessVersionResult {
  version: ProcessVersion;
  removedReferences: Array<{
    kind: string;
    ownerId: string;
    referencedId: string;
    reason: string;
  }>;
}

export interface LaunchableProcessDefinition {
  definitionId: string;
  code: string;
  name: string;
  type: "approval" | "free";
  versionId: string;
  versionLabel: string;
  description: string;
  starterGroups: string[];
}

export interface ProcessLaunchConfig {
  definition: ProcessDefinition;
  version: ProcessVersion;
  assigneeCandidatesByNode: Record<string, DirectoryUser[]>;
  firstAssigneeCandidates: DirectoryUser[];
}

export interface ProcessInstanceListItem {
  instance: ProcessInstance;
}

export interface ProcessInstanceDetail {
  instance: ProcessInstance;
  tasks: WorkflowTask[];
}

export interface WorkflowTaskListItem {
  tasks: WorkflowTask[];
  instance: ProcessInstance;
}

export interface WorkflowTaskDetailItem {
  task: WorkflowTask;
  instance: ProcessInstance;
}

export interface WorkflowDecisionResult {
  instance: ProcessInstance;
  task: WorkflowTask;
  activatedTaskIds: string[];
  cancelledTaskIds: string[];
}

export interface WorkflowRevisionResult {
  instance: ProcessInstance;
  task: WorkflowTask;
}

export interface AttachmentRecord {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedById: string;
  uploadedAt: string;
  instanceId?: string;
  fieldId?: string;
  lifecycle?: "temporary" | "active" | "cleanup-pending";
  cleanupAfter?: string;
}

export interface EmailOutboxItem {
  id: string;
  kind: "task-activated" | "process-completed";
  instanceId: string;
  taskId?: string;
  nodeId?: string;
  recipientUserId: string;
  recipientName: string;
  email: string;
  status: "queued" | "sent" | "failed";
  attempts: number;
  createdAt: string;
  sentAt?: string;
  lastError?: string;
}

export interface AuditEvent {
  id: string;
  category: "authentication" | "definition" | "instance" | "task" | "identity";
  action: string;
  actorId?: string;
  actorName?: string;
  actorDepartmentPath?: string;
  operatorId?: string;
  operatorName?: string;
  operatorDepartmentPath?: string;
  impersonationId?: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  result?: "success" | "failure";
  summary: string;
  details?: Record<string, unknown>;
}

export interface DirectorySnapshot {
  users: DirectoryUser[];
  roles: DomainRole[];
  workflowGroups: WorkflowPermissionGroup[];
}

export interface DepartmentRecord {
  id: string;
  name: string;
  parentId?: string;
  path: string;
  status: "启用" | "停用";
  memberCount: number;
  sortOrder: number;
  description?: string;
}

export interface PositionRecord {
  id: string;
  name: string;
  description: string;
  status: "启用" | "停用";
  memberCount: number;
  sortOrder?: number;
}

export interface PermissionCatalogItem {
  key: string;
  page: string;
  action: string;
  name?: string;
  category?: string;
  description?: string;
  kind?: "page" | "action";
}

export interface ImpactPreview {
  affectedUsers: number;
  affectedOpenTasks: number;
  references: string[];
}

export interface EffectiveWorkflowMember {
  id: string;
  account: string;
  name: string;
  email: string;
  departmentPath: string;
  sources: string[];
}

export interface ProcessExcelDataFilter {
  dateFrom: string;
  dateTo: string;
  definitionId: string;
  q?: string;
  status?: string;
  initiatorId?: string;
  currentNode?: string;
  dynamicFilters?: Record<string, unknown>;
}

export interface ProcessExcelDatasetColumn {
  key: string;
  label: string;
  dataType: "text" | "number" | "date";
}

export interface ProcessExcelDataset {
  definitionId: string;
  definitionName: string;
  versionId: string;
  versionLabel: string;
  generatedAt: string;
  rowCount: number;
  columns: ProcessExcelDatasetColumn[];
  rows: Array<Array<string | number | boolean | null>>;
}
