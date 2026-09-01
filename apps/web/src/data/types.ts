export type InstanceStatus = "审核中" | "驳回待处理" | "已完成" | "进行中" | "已关闭";
export type ReviewStatus = "待审核" | "已通过" | "已确认" | "已驳回" | "已取消" | "已跳过";
export type WorkflowTaskStatus = "未激活" | "待处理" | "已完成" | "已取消" | "已跳过";

export interface WorkflowFieldChange {
  fieldId: string;
  label: string;
  before: string;
  after: string;
}

export interface WorkflowFieldRevision {
  id: string;
  editedById: string;
  editedByName: string;
  editedAt: string;
  comment?: string;
  changes: WorkflowFieldChange[];
}

export interface FreeFlowRevision {
  content: string;
  editedAt: string;
}

export interface FreeFlowEntry {
  id: string;
  type: "created" | "reply" | "reply-edited" | "assigned" | "closed" | "reopened" | "form-edited" | "reassigned";
  actor: string;
  time: string;
  content?: string;
  assignee?: string;
  previousAssignee?: string;
  editedAt?: string;
  /** 仅用于初始表单的旧内容记录；回复编辑不得写入此字段。 */
  revisions?: FreeFlowRevision[];
  attachments?: Array<{
    id: string;
    name: string;
    size: number;
    contentType: string;
  }>;
  fieldChanges?: Array<{ field: string; before?: string; after?: string }>;
}

export interface ReviewerProgress {
  key: string;
  name: string;
  group: string;
  shortGroup: string;
  status: ReviewStatus;
  actionAt?: string;
  comment?: string;
  substitute?: boolean;
  conditionSummary?: string;
}

export interface ProcessResubmissionRecord {
  round: number;
  submittedAt: string;
  submittedById: string;
  submittedByName: string;
  modifiedFields: Array<{ fieldId: string; label: string }>;
}

export interface ProcessInstance {
  workflowType?: "approval" | "free";
  id: string;
  definitionId: string;
  versionId: string;
  code: string;
  title: string;
  template: string;
  templateVersion: string;
  status: InstanceStatus;
  initiator: string;
  initiatorId: string;
  department: string;
  createdAt: string;
  updatedAt: string;
  round: number;
  currentNode: string;
  priority: "普通" | "紧急";
  designatedReviewer?: string;
  designatedReviewerId?: string;
  dueText?: string;
  description: string;
  /** @deprecated PDF 文件审核的历史快捷字段；新流程只使用 formValues。 */
  pdfName?: string;
  /** @deprecated PDF 文件审核的历史快捷字段；新流程只使用 formValues。 */
  pdfSize?: string;
  /** @deprecated 动态表单字段不应继续扩展到通用实例。 */
  documentCode?: string;
  /** @deprecated 动态表单字段不应继续扩展到通用实例。 */
  documentType?: string;
  /** @deprecated 动态表单字段不应继续扩展到通用实例。 */
  documentLevel?: string;
  /** @deprecated 动态表单字段不应继续扩展到通用实例。 */
  revision?: string;
  productModel?: string;
  testType?: string;
  testConclusion?: string;
  category?: string;
  currentAssignee?: string;
  currentAssigneeId?: string;
  participants?: string[];
  participantIds?: string[];
  /** 正式后端根据当前登录人及锁定版本权限组计算的变更受理人权限。 */
  canTransferFree?: boolean;
  /** 正式后端根据锁定版本受理权限组计算的有效候选人。 */
  freeAssigneeCandidates?: Array<{
    id: string;
    name: string;
    departmentPath?: string;
  }>;
  freeTimeline?: FreeFlowEntry[];
  formValues?: Record<string, unknown>;
  /** 正式后端返回的字段并发版本，用于审核字段级乐观锁。 */
  fieldRevisions?: Record<string, number>;
  attachmentNames?: string[];
  attachmentIds?: string[];
  attachmentIdsByField?: Record<string, string[]>;
  resubmissions?: ProcessResubmissionRecord[];
  /** @deprecated 仅作为旧数据与展示快照；审批状态的唯一事实源是 WorkflowTask。 */
  reviewers: ReviewerProgress[];
}

/** 仅供一次性持久化迁移和内置旧演示数据使用；业务运行时不得继续产生此类型。 */
export type LegacyProcessInstance = Omit<ProcessInstance, "definitionId" | "versionId" | "initiatorId"> & Partial<
  Pick<ProcessInstance, "definitionId" | "versionId" | "initiatorId">
>;

export interface WorkflowTask {
  id: string;
  taskType?: "approval" | "free-collaboration" | "resubmission";
  instanceId: string;
  definitionId: string;
  versionId: string;
  nodeId: string;
  nodeName: string;
  permissionGroupId: string;
  handlingMode?: "approval" | "confirmation";
  editableFieldIds?: string[];
  allowedActions?: Array<"pass" | "confirm" | "reject" | "revise-fields" | "reply" | "change-assignee" | "resubmit">;
  status: WorkflowTaskStatus;
  assigneeId?: string;
  assigneeName?: string;
  defaultAssigneeId?: string;
  defaultAssigneeName?: string;
  completedById?: string;
  completedByName?: string;
  action?: "通过" | "确认" | "驳回";
  comment?: string;
  createdAt: string;
  completedAt?: string;
  round: number;
  conditionSummary?: string;
  conditionEvaluatedAt?: string;
  submittedFieldChanges?: WorkflowFieldChange[];
  fieldRevisions?: WorkflowFieldRevision[];
}
