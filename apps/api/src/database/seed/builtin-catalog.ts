export interface BuiltinPermissionSeed {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly name: string;
  readonly category: string;
  readonly module: string;
  readonly description: string;
  readonly kind: "page" | "action";
  readonly sortOrder: number;
}

interface PermissionPageSeed {
  readonly key: string;
  readonly category: string;
  readonly name: string;
  readonly description: string;
  readonly actions: readonly string[];
}

const pages: readonly PermissionPageSeed[] = [
  { key: "work-launch", category: "员工工作区", name: "流程发起", description: "进入发起中心并提交流程权限组授权的流程", actions: ["查看", "发起"] },
  { key: "work-task", category: "员工工作区", name: "任务中心", description: "查看和处理待办，并按独立权限关闭流程", actions: ["查看", "审核", "关闭"] },
  { key: "work-list", category: "员工工作区", name: "流程清单", description: "查看已获授权的流程实例", actions: ["查看", "复制新建", "打印"] },
  { key: "config-definition", category: "流程配置", name: "流程定义", description: "创建、维护、发布和删除流程版本", actions: ["查看", "编辑", "发布", "删除"] },
  { key: "config-form", category: "流程配置", name: "表单设计器", description: "配置初始表单与列表字段", actions: ["编辑"] },
  { key: "org-user", category: "用户与权限", name: "用户管理", description: "维护域登录、本地密码用户及多角色关系", actions: ["查看", "编辑", "重置密码", "删除"] },
  { key: "org-department", category: "用户与权限", name: "部门管理", description: "维护两级组织架构与职务字典", actions: ["查看", "编辑", "删除"] },
  { key: "org-role", category: "用户与权限", name: "角色管理", description: "配置系统页面及动作权限", actions: ["查看", "编辑", "授权", "删除"] },
  { key: "org-group", category: "用户与权限", name: "流程权限组", description: "维护流程节点处理成员", actions: ["查看", "编辑", "删除"] },
  { key: "system-monitor", category: "系统运维", name: "流程实例监控", description: "只读查看全部流程实例", actions: ["查看"] },
  { key: "system-audit", category: "系统运维", name: "操作审计", description: "查看敏感操作记录", actions: ["查看"] }
] as const;

export const BUILTIN_PERMISSION_SEEDS: readonly BuiltinPermissionSeed[] = pages.flatMap(
  (page, pageIndex) => page.actions.map((action, actionIndex) => ({
    code: `${page.key}:${action}`,
    resource: page.key,
    action,
    name: `${page.name} - ${action}`,
    category: page.category,
    module: page.category,
    description: page.description,
    kind: actionIndex === 0 ? "page" : "action",
    sortOrder: (pageIndex + 1) * 100 + actionIndex + 1
  }))
);

export const BUILTIN_SEED_VERSION = "2026-08-25.2";

export const BUILTIN_IDS = Object.freeze({
  systemDepartment: "00000000-0000-4000-8000-000000000001",
  systemPosition: "00000000-0000-4000-8000-000000000002",
  superAdminRole: "00000000-0000-4000-8000-000000000003",
  superAdminUser: "00000000-0000-4000-8000-000000000004",
  managerPosition: "00000000-0000-4000-8000-000000000005",
  employeePosition: "00000000-0000-4000-8000-000000000006"
});
