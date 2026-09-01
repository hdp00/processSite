export type SystemListFieldKey =
  | "code"
  | "template"
  | "templateVersion"
  | "status"
  | "currentNode"
  | "round"
  | "initiator"
  | "createdAt"
  | "updatedAt";

export interface SystemListFieldConfig {
  key: SystemListFieldKey;
  label: string;
  description: string;
  taskVisible: boolean;
  processListVisible: boolean;
  exportVisible: boolean;
}

export const DEFAULT_SYSTEM_LIST_FIELDS: SystemListFieldConfig[] = [
  { key: "code", label: "实例编号", description: "系统自动生成的流程实例编号", taskVisible: true, processListVisible: true, exportVisible: true },
  { key: "template", label: "流程名称", description: "实例所属的流程定义名称", taskVisible: false, processListVisible: false, exportVisible: false },
  { key: "templateVersion", label: "版本", description: "实例发起时固定使用的流程版本", taskVisible: false, processListVisible: false, exportVisible: false },
  { key: "status", label: "状态", description: "审核中、已完成、已关闭等运行状态", taskVisible: true, processListVisible: true, exportVisible: true },
  { key: "currentNode", label: "当前节点", description: "当前正在处理的流程节点或受理人", taskVisible: true, processListVisible: true, exportVisible: true },
  { key: "round", label: "当前轮次", description: "驳回后重新提交产生的审核轮次", taskVisible: false, processListVisible: false, exportVisible: false },
  { key: "initiator", label: "发起人", description: "创建该流程实例的用户", taskVisible: true, processListVisible: true, exportVisible: true },
  { key: "createdAt", label: "发起时间", description: "流程实例首次创建的时间", taskVisible: true, processListVisible: true, exportVisible: true },
  { key: "updatedAt", label: "更新时间", description: "流程实例最近一次发生变化的时间", taskVisible: false, processListVisible: false, exportVisible: false },
];

export const cloneDefaultSystemListFields = () =>
  DEFAULT_SYSTEM_LIST_FIELDS.map((field) => ({ ...field }));

export function isSystemFieldVisible(
  fields: SystemListFieldConfig[],
  key: SystemListFieldKey,
  target: "task" | "processList",
) {
  const field = fields.find((item) => item.key === key);
  return target === "task" ? Boolean(field?.taskVisible) : Boolean(field?.processListVisible);
}
