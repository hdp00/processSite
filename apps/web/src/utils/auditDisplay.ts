import type { AuditEvent } from "../api/contracts";

const moduleLabels: Record<AuditEvent["category"], string> = {
  authentication: "登录认证",
  definition: "流程配置",
  instance: "流程实例",
  task: "审批任务",
  identity: "用户与权限",
};

const actionLabels: Record<string, string> = {
  "authentication:auth.login": "登录",
  "authentication:auth.logout": "退出登录",
  "authentication:auth.login-failed": "登录失败",
  "authentication:auth.impersonation-started": "切换演示身份",
  "authentication:auth.impersonation-stopped": "结束演示身份",
  "definition:create": "创建流程",
  "definition:import": "导入流程",
  "definition:disable": "停用流程",
  "definition:enable": "启用流程",
  "definition:delete": "删除流程",
  "definition:copy": "复制流程",
  "definition:create-version": "创建版本",
  "definition:save-basic": "保存基本信息",
  "definition:save-designer": "保存流程配置",
  "definition:save-form-designer": "保存初始表单",
  "definition:save-flow-designer": "保存流程设计",
  "definition:publish": "发布版本",
  "definition:unpublish": "取消发布",
  "definition:delete-version": "删除版本",
  "instance:create": "发起流程",
  "instance:resubmit": "重新提交",
  "instance:reply": "发表回复",
  "instance:transfer": "变更受理人",
  "instance:assigned": "变更受理人",
  "instance:edit-reply": "编辑回复",
  "instance:update-submission": "修改初始表单",
  "instance:form-edited": "修改初始表单",
  "instance:reassign": "变更受理人",
  "instance:reassigned": "变更受理人",
  "instance:close": "关闭流程",
  "instance:closed": "关闭流程",
  "instance:reopen": "重新打开",
  "instance:reopened": "重新打开",
  "instance:request-export-data": "导出流程数据",
  "instance:attachment.upload": "上传附件",
  "instance:attachment.delete": "删除附件",
  "instance:attachment.replace": "替换附件",
  "instance:email.delivery-created": "生成邮件通知",
  "instance:email.retry-failed": "重试邮件失败",
  "instance:email.retry-sent": "重试发送邮件",
  "task:pass": "审批通过",
  "task:confirm": "确认完成",
  "task:reject": "审批驳回",
  "task:revise-fields": "修改审核字段",
  "task:email.delivery-created": "生成待办邮件",
  "task:email.retry-failed": "重试邮件失败",
  "task:email.retry-sent": "重试发送邮件",
  "identity:user.created": "创建用户",
  "identity:user.updated": "修改用户",
  "identity:user.deleted": "删除用户",
  "identity:user.password-reset": "重置密码",
  "identity:role.created": "创建角色",
  "identity:role.updated": "修改角色",
  "identity:role.deleted": "删除角色",
  "identity:workflow-group.created": "创建流程权限组",
  "identity:workflow-group.updated": "修改流程权限组",
  "identity:workflow-group.deleted": "删除流程权限组",
  "identity:update-user-status": "修改用户状态",
  "identity:create-department": "创建部门",
  "identity:update-department": "修改部门",
  "identity:delete-department": "删除部门",
  "identity:create-position": "创建职务",
  "identity:update-position": "修改职务",
  "identity:delete-position": "删除职务",
  "identity:update-role-permissions": "修改角色权限",
};

const formalActionLabels: Record<string, string> = {
  "process-definition.created": "创建流程",
  "process-definition.updated": "修改流程",
  "process-definition.disabled": "停用流程",
  "process-definition.enabled": "启用流程",
  "process-definition.deleted": "删除流程",
  "process-definition.imported": "导入流程",
  "process-definition.copied": "复制流程",
  "process-version.created": "创建版本",
  "process-version.updated": "保存流程版本",
  "process-version.validated": "校验流程版本",
  "process-version.published": "发布版本",
  "process-version.unpublished": "取消发布",
  "process-version.deleted": "删除版本",
  "process-instance.created": "发起流程",
  "process-instance.updated": "修改流程内容",
  "process-instance.resubmitted": "重新提交",
  "process-instance.closed": "关闭流程",
  "process-instance.reopened": "重新打开",
  "workflow-task.passed": "审批通过",
  "workflow-task.confirmed": "确认完成",
  "workflow-task.rejected": "审批驳回",
  "workflow-task.fields-revised": "修改审核字段",
  "free-collaboration.replied": "发表回复",
  "free-collaboration.transferred": "变更受理人",
  "free-collaboration.reply-edited": "编辑回复",
  "attachment.uploaded": "上传附件",
  "attachment.deleted": "删除附件",
  "attachment.replaced": "替换附件",
  "user.created": "创建用户",
  "user.updated": "修改用户",
  "user.deleted": "删除用户",
  "user.status-updated": "修改用户状态",
  "user.password-reset": "重置密码",
  "role.created": "创建角色",
  "role.updated": "修改角色",
  "role.deleted": "删除角色",
  "role.permissions-updated": "修改角色权限",
  "workflow-permission-group.created": "创建流程权限组",
  "workflow-permission-group.updated": "修改流程权限组",
  "workflow-permission-group.deleted": "删除流程权限组",
};

const detailFieldLabels: Record<string, string> = {
  name: "名称",
  account: "登录名",
  email: "邮箱",
  authenticationMode: "登录方式",
  department: "部门",
  departmentPath: "部门",
  jobTitle: "职务",
  roles: "角色",
  status: "状态",
  description: "说明",
  purposes: "用途",
  processes: "关联流程",
  directMembers: "直接成员",
  linkedRoles: "关联角色",
  permissions: "动作权限",
  disabled: "启停状态",
};

const technicalIdentifierPatterns = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[A-Z]{2,}(?:[-_]?[A-Z0-9]+)+\b/g,
  /\b(?:auth|runtime|workflow|process|attachment|email)[._-][a-z0-9._-]+\b/gi,
];

const cleanText = (value: string) => technicalIdentifierPatterns.reduce(
  (text, pattern) => text.replace(pattern, ""),
  value,
).replace(/\s+/g, " ").replace(/\s+([，。；：])/g, "$1").trim().replace(/[，、：-]+$/, "").trim();

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const changedFieldLabels = (before: Record<string, unknown>, after: Record<string, unknown>) => [
  ...new Set([...Object.keys(before), ...Object.keys(after)]
    .filter((key) => detailFieldLabels[key] && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => detailFieldLabels[key])),
];

export const auditModuleLabel = (category: AuditEvent["category"]) => moduleLabels[category];

export const auditActionLabel = (event: Pick<AuditEvent, "category" | "action">) =>
  actionLabels[`${event.category}:${event.action}`] ?? formalActionLabels[event.action] ?? "其他操作";

export const auditResultLabel = (event: Pick<AuditEvent, "action" | "result">): "成功" | "失败" =>
  event.result === "failure" || event.action.includes("failed") ? "失败" : "成功";

export const auditSummaryText = (event: Pick<AuditEvent, "summary" | "category" | "action">) => {
  const summary = cleanText(event.summary);
  return summary && /[\u4e00-\u9fff]/.test(summary) ? summary : auditActionLabel(event);
};

export const auditDetailText = (event: Pick<AuditEvent, "details" | "summary" | "category" | "action">) => {
  const details = event.details;
  if (!details) return auditSummaryText(event);
  const before = recordValue(details.before);
  const after = recordValue(details.after);
  if (before && after) {
    const labels = changedFieldLabels(before, after);
    return labels.length ? `修改了：${labels.join("、")}` : "保存了配置，业务内容没有变化";
  }
  if (after) {
    const labels = Object.keys(after).flatMap((key) => detailFieldLabels[key] ? [detailFieldLabels[key]] : []);
    return labels.length ? `已创建并设置：${[...new Set(labels)].join("、")}` : auditSummaryText(event);
  }
  if (before) return "已删除原有配置";
  const reason = typeof details.reason === "string" ? details.reason : "";
  if (reason === "invalid-credentials") return "登录名或密码不正确";
  if (reason === "account-disabled") return "账号已停用";
  if (reason && /[\u4e00-\u9fff]/.test(reason)) return `原因：${cleanText(reason)}`;
  const fields = Array.isArray(details.fields) ? details.fields : Array.isArray(details.modifiedFields) ? details.modifiedFields : [];
  const fieldLabels = fields.flatMap((field) => {
    const record = recordValue(field);
    return typeof record?.label === "string" ? [cleanText(record.label)] : [];
  }).filter(Boolean);
  if (fieldLabels.length) return `修改字段：${[...new Set(fieldLabels)].join("、")}`;
  if (typeof details.assignee === "string" && details.assignee.trim()) return `受理人变更为 ${cleanText(details.assignee)}`;
  if (typeof details.rowCount === "number") return `导出 ${details.rowCount} 条流程记录`;
  if (details.passwordReset === true) return "用户密码已重置";
  if (typeof details.round === "number") return `流程进入第 ${details.round} 轮`;
  return auditSummaryText(event);
};
