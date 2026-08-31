import { expect, gotoApp, isMockTarget, loginAs, test } from "./fixtures/app";

const superAdminRoutes = [
  { path: "tasks", title: "任务中心" },
  { path: "launch", title: "流程发起" },
  { path: "processes?definitionId=pdf-review", title: "PDF 文件审核" },
  { path: "admin/processes", title: "流程管理" },
  { path: "admin/processes/pdf-review/basic?versionId=pdf-v3", title: "流程基本信息" },
  { path: "admin/processes/pdf-review/form?versionId=pdf-v3", title: "初始表单设计" },
  { path: "admin/processes/pdf-review/flow?versionId=pdf-v3", title: "可视化流程设计" },
  { path: "admin/processes/pdf-review/publish?versionId=pdf-v3", title: "预览、校验与发布" },
  { path: "admin/processes/pdf-review/versions", title: "流程版本记录" },
  { path: "admin/users", title: "用户管理" },
  { path: "admin/departments", title: "部门管理" },
  { path: "admin/roles", title: "角色管理" },
  { path: "admin/permissions", title: "权限管理" },
  { path: "admin/workflow-groups", title: "流程权限组" },
  { path: "ops/instances", title: "流程实例监控" },
  { path: "ops/audit-logs", title: "操作审计日志" },
] as const;

test("超级管理员可遍历全部主要路由且页面正常加载", async ({ page }) => {
  test.skip(!isMockTarget, "演示定义和超级管理员账号只适用于本地 Mock API。");
  test.setTimeout(90_000);
  await loginAs(page, "superadmin");

  for (const route of superAdminRoutes) {
    await test.step(`${route.title}：/${route.path}`, async () => {
      await gotoApp(page, route.path);
      await expect(page.locator(".page-identity h4")).toHaveText(route.title);
      await expect(page.locator(".route-loading")).toHaveCount(0);
      await expect(page.getByText("当前身份无权访问", { exact: true })).toHaveCount(0);
      await expect(page.locator(".ant-alert-error")).toHaveCount(0);
    });
  }
});

test("新增用户默认选择员工职务", async ({ page }) => {
  test.skip(!isMockTarget, "该用例只校验本地演示目录中的默认职务。");
  await loginAs(page, "superadmin");
  await gotoApp(page, "admin/users");

  await page.getByRole("button", { name: "新增用户" }).click();

  await expect(page.getByRole("dialog", { name: "新增用户" }).getByText("员工", { exact: true })).toBeVisible();
});
