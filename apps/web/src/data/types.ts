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
  type: "created" | "reply" | "assigned" | "closed" | "reopened" | "form-edited" | "reassigned";
  actor: string;
  time: string;
  content?: string;
  assignee?: string;
  previousAssignee?: string;
  editedAt?: string;
  revisions?: FreeFlowRevision[];
  fieldChanges?: Array<{ field: string; before: string; after: string }>;
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

export interface ProcessInstance {
  workflowType?: "approval" | "free";
  id: string;
  definitionId?: string;
  versionId?: string;
  code: string;
  title: string;
  template: string;
  templateVersion: string;
  status: InstanceStatus;
  initiator: string;
  initiatorId?: string;
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
  pdfName: string;
  pdfSize: string;
  documentCode: string;
  documentType: string;
  documentLevel: string;
  revision: string;
  productModel?: string;
  testType?: string;
  testConclusion?: string;
  category?: string;
  currentAssignee?: string;
  currentAssigneeId?: string;
  participants?: string[];
  participantIds?: string[];
  freeTimeline?: FreeFlowEntry[];
  formValues?: Record<string, unknown>;
  attachmentNames?: string[];
  attachmentIds?: string[];
  attachmentIdsByField?: Record<string, string[]>;
  reviewers: ReviewerProgress[];
}

export interface WorkflowTask {
  id: string;
  instanceId: string;
  definitionId: string;
  versionId: string;
  nodeId: string;
  nodeName: string;
  permissionGroupId: string;
  status: WorkflowTaskStatus;
  defaultAssigneeId?: string;
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
