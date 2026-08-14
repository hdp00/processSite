import { ArrowLeftOutlined } from "@ant-design/icons";
import { Button, type ButtonProps } from "antd";

export type AppBackButtonProps = Omit<ButtonProps, "children" | "icon">;

/**
 * 页面级返回入口。目标页面仍由调用方决定，避免改变现有业务导航；
 * 文案、图标、尺寸和视觉状态在此统一。
 */
export function AppBackButton({ className, type = "default", ...props }: AppBackButtonProps) {
  return (
    <Button
      {...props}
      type={type}
      icon={<ArrowLeftOutlined />}
      className={["app-back-button", className].filter(Boolean).join(" ")}
    >
      返回
    </Button>
  );
}
