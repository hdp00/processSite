export type InstanceStatus = "审核中" | "驳回待处理" | "已完成" | "已关闭";
export type ReviewStatus = "待审核" | "已通过" | "已驳回" | "已取消";

export interface ReviewerProgress {
  key: string;
  name: string;
  group: string;
  shortGroup: string;
  status: ReviewStatus;
  actionAt?: string;
  comment?: string;
  substitute?: boolean;
}

export interface ProcessInstance {
  id: string;
  code: string;
  title: string;
  template: string;
  templateVersion: string;
  status: InstanceStatus;
  initiator: string;
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
  reviewers: ReviewerProgress[];
}

export interface NoticeItem {
  id: string;
  title: string;
  detail: string;
  time: string;
  read: boolean;
  instanceId?: string;
}
