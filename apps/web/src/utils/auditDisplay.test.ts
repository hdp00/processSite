import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../api/contracts";
import { auditActionLabel, auditDetailText, auditResultLabel, auditSummaryText } from "./auditDisplay";

const event = (overrides: Partial<AuditEvent>): AuditEvent => ({
  id: "event-id",
  category: "authentication",
  action: "auth.login",
  resourceType: "session",
  resourceId: "lina",
  occurredAt: "2026-08-21T06:27:07.751Z",
  summary: "林晓 登录系统",
  ...overrides,
});

describe("审计日志中文展示", () => {
  it("将英文动作转换为简洁中文并正确区分失败结果", () => {
    const failed = event({ action: "auth.login-failed", summary: "本地账号登录失败", details: { reason: "invalid-credentials" } });
    expect(auditActionLabel(failed)).toBe("登录失败");
    expect(auditResultLabel(failed)).toBe("失败");
    expect(auditDetailText(failed)).toBe("登录名或密码不正确");
  });

  it("从摘要中移除业务编码和技术标识", () => {
    const created = event({ category: "instance", action: "create", summary: "王敏发起流程 DOC26080042，事件 auth.login" });
    expect(auditSummaryText(created)).toBe("王敏发起流程，事件");
    expect(auditSummaryText(created)).not.toMatch(/DOC|auth\.login/);
  });

  it("英文摘要使用中文动作名称兜底", () => {
    expect(auditSummaryText(event({ summary: "User login succeeded" }))).toBe("登录");
  });

  it("变更详情只展示中文字段名称，不暴露对象编码和值", () => {
    const updated = event({
      category: "identity",
      action: "user.updated",
      summary: "用户 林晓 已更新",
      details: {
        before: { id: "lina", name: "林晓", roleIds: ["ROLE-005"], status: "启用", email: "old@example.test" },
        after: { id: "lina", name: "林晓", roleIds: ["ROLE-007"], status: "停用", email: "new@example.test" },
      },
    });
    expect(auditDetailText(updated)).toBe("修改了：状态、邮箱");
    expect(auditDetailText(updated)).not.toMatch(/lina|ROLE|example/);
  });
});
