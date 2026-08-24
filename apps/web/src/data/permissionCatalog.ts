export interface PermissionCatalogPage {
  key: string;
  module: string;
  page: string;
  description: string;
  actions: string[];
}

export const permissionCatalogPages: PermissionCatalogPage[] = [
  { key: "work-launch", module: "员工工作区", page: "流程发起", description: "进入发起中心并提交流程权限组授权的流程", actions: ["查看", "发起"] },
  { key: "work-task", module: "员工工作区", page: "任务中心", description: "查看和处理待办，并按独立权限关闭流程", actions: ["查看", "审核", "关闭"] },
  { key: "work-list", module: "员工工作区", page: "流程清单", description: "查看已获授权的流程实例", actions: ["查看", "复制新建", "打印"] },
  { key: "config-definition", module: "流程配置", page: "流程定义", description: "创建、维护、发布和删除流程版本", actions: ["查看", "编辑", "发布", "删除"] },
  { key: "config-form", module: "流程配置", page: "表单设计器", description: "配置初始表单与列表字段", actions: ["查看", "编辑", "预览"] },
  { key: "org-user", module: "用户与权限", page: "用户管理", description: "维护域登录、本地密码用户及多角色关系", actions: ["查看", "编辑", "重置密码"] },
  { key: "org-department", module: "用户与权限", page: "部门管理", description: "维护两级组织架构与职务字典", actions: ["查看", "编辑"] },
  { key: "org-role", module: "用户与权限", page: "角色管理", description: "配置系统页面及动作权限", actions: ["查看", "编辑", "授权"] },
  { key: "org-group", module: "用户与权限", page: "流程权限组", description: "维护流程节点处理成员", actions: ["查看", "编辑"] },
  { key: "system-monitor", module: "系统运维", page: "流程实例监控", description: "只读查看全部流程实例", actions: ["查看", "导出"] },
  { key: "system-audit", module: "系统运维", page: "操作审计", description: "查看敏感操作记录", actions: ["查看", "导出"] },
];

export const allPermissionCodes = permissionCatalogPages.flatMap((row) =>
  row.actions.map((action) => `${row.key}:${action}`));
