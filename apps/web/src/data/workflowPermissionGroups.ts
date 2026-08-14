export const workflowPermissionGroups = [
  "PDF审核_文控_流程权限组",
  "PDF审核_研发_流程权限组",
  "PDF审核_质量_流程权限组",
  "PDF审核_生产_流程权限组",
  "测试报告_发起_流程权限组",
  "测试报告_研发_流程权限组",
  "测试报告_质量_流程权限组",
  "测试报告_生产_流程权限组",
  "自由协作_发起_流程权限组",
  "自由协作_受理_流程权限组",
  "供应商变更_发起_流程权限组",
  "供应商变更_评审_流程权限组",
  "技术文件只读_流程权限组",
] as const;

export const workflowPermissionGroupOptions = workflowPermissionGroups.map((value) => ({
  value,
  label: value,
}));
