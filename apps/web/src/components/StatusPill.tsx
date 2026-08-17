import type { ReactNode } from "react";

type StatusTone = "processing" | "danger" | "success" | "neutral" | "draft";

const toneByStatus: Record<string, StatusTone> = {
  审核中: "processing",
  进行中: "processing",
  待审核: "processing",
  驳回待处理: "danger",
  已驳回: "danger",
  失败: "danger",
  已完成: "success",
  已通过: "success",
  已发布: "success",
  可发布: "processing",
  校验未通过: "danger",
  生效: "success",
  启用: "success",
  成功: "success",
  已关闭: "neutral",
  已取消: "neutral",
  已停用: "neutral",
  未发布: "neutral",
  失效: "neutral",
  停用: "neutral",
  草稿: "draft",
};

interface StatusPillProps {
  status: string;
  label?: ReactNode;
  className?: string;
  ariaLabel?: string;
  compact?: boolean;
}

/** 跨页面统一的业务状态标签；分类、版本号等非状态信息仍使用普通 Tag。 */
export function StatusPill({ status, label, className, ariaLabel, compact = false }: StatusPillProps) {
  const tone = toneByStatus[status] ?? "neutral";
  return (
    <span
      className={["status-pill", `is-${tone}`, compact && "is-compact", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel ?? `状态：${status}`}
    >
      <span className="status-pill-dot" />
      {label ?? status}
    </span>
  );
}
