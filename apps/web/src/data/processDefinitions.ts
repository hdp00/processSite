import type { ProcessInstance } from "./types";

export interface TaskListFieldDefinition {
  key: keyof ProcessInstance;
  label: string;
  width: number;
}

export const processDefinitions = [
  {
    id: "pdf-review",
    label: "PDF审核",
    template: "PDF 文件审核流程",
    taskFields: [
      { key: "documentCode", label: "文件编号", width: 150 },
      { key: "documentType", label: "文件类型", width: 125 },
      { key: "revision", label: "修订版本", width: 105 },
    ] satisfies TaskListFieldDefinition[],
  },
  {
    id: "test-report-review",
    label: "测试报告审核",
    template: "测试报告审核流程",
    taskFields: [
      { key: "documentCode", label: "报告编号", width: 150 },
      { key: "productModel", label: "产品型号", width: 120 },
      { key: "testType", label: "测试类型", width: 140 },
      { key: "testConclusion", label: "测试结论", width: 110 },
    ] satisfies TaskListFieldDefinition[],
  },
  {
    id: "free-collaboration",
    label: "自由协作",
    template: "自由协作事项流程",
    workflowType: "free",
    taskFields: [
      { key: "category", label: "事项分类", width: 140 },
      { key: "priority", label: "优先级", width: 100 },
      { key: "currentAssignee", label: "当前受理人", width: 120 },
    ] satisfies TaskListFieldDefinition[],
  },
] as const;

export type ProcessDefinitionId = (typeof processDefinitions)[number]["id"];

export const defaultProcessDefinition = processDefinitions[0];

export function getProcessDefinition(id: string | null) {
  return processDefinitions.find((item) => item.id === id);
}
