import { Steps, type StepsProps } from "antd";
import type { DefinitionType } from "../state/useProcessDefinitionStore";

const approvalItems = [
  { title: "基本信息" },
  { title: "初始表单" },
  { title: "流程设计" },
  { title: "发布" },
];

const freeItems = [
  { title: "基本信息" },
  { title: "初始表单" },
  { title: "发布" },
];

interface ProcessWizardStepsProps extends Omit<StepsProps, "items"> {
  workflowType: DefinitionType;
}

/** 流程创建与版本编辑共用的步骤定义，避免各页名称和顺序漂移。 */
export function ProcessWizardSteps({ workflowType, size = "small", ...props }: ProcessWizardStepsProps) {
  return <Steps {...props} size={size} items={workflowType === "approval" ? approvalItems : freeItems} />;
}
