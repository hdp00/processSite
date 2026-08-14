import { ArrowLeftOutlined, ArrowRightOutlined } from "@ant-design/icons";
import { Button, type ButtonProps } from "antd";

type ProcessWizardNavigationButtonProps = Omit<ButtonProps, "children" | "icon" | "iconPosition"> & {
  step: string;
};

export function ProcessWizardPreviousButton({
  step,
  type = "default",
  ...buttonProps
}: ProcessWizardNavigationButtonProps) {
  return (
    <Button {...buttonProps} type={type} icon={<ArrowLeftOutlined />}>
      上一步：{step}
    </Button>
  );
}

export function ProcessWizardNextButton({
  step,
  type = "primary",
  ...buttonProps
}: ProcessWizardNavigationButtonProps) {
  return (
    <Button
      {...buttonProps}
      type={type}
      icon={<ArrowRightOutlined />}
      iconPosition="end"
    >
      下一步：{step}
    </Button>
  );
}
