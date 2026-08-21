import { expect, gotoApp, isMockTarget, loginAs, test } from "./fixtures/app";

test("只读身份无法进入任务和流程配置页面 @smoke", async ({ page }) => {
  test.skip(!isMockTarget, "演示身份与默认权限只适用于本地 Mock API。");
  await loginAs(page, "hejing");

  await expect(page.getByText("当前身份无权访问", { exact: true })).toBeVisible();
  await expect(page.locator(".app-menu").getByText("流程管理", { exact: true })).toHaveCount(0);

  await gotoApp(page, "admin/processes");
  await expect(page).toHaveURL(/\/flowpilot\/admin\/processes$/);
  await expect(page.getByText("当前身份无权访问", { exact: true })).toBeVisible();
  await expect(page.getByText("当前角色未获得此页面的查看权限。", { exact: true })).toBeVisible();
});

test("审核身份不能通过直达地址查看越权实例", async ({ page }) => {
  test.skip(!isMockTarget, "演示实例和可见范围只适用于本地 Mock API。");
  await loginAs(page, "lina");

  await gotoApp(page, "processes/free-12");
  await expect(page.getByText("无权查看此流程", { exact: true })).toBeVisible();
  await expect(page.getByText("流程数据范围会在每次打开详情时重新校验。", { exact: true })).toBeVisible();
});

test("超级管理员可以打开流程管理入口", async ({ page }) => {
  test.skip(!isMockTarget, "演示账号只适用于本地 Mock API。");
  await loginAs(page, "superadmin");

  await page.getByText("流程管理", { exact: true }).click();
  await expect(page).toHaveURL(/\/flowpilot\/admin\/processes$/);
  await expect(page.getByRole("heading", { name: "流程定义概览" })).toBeVisible();
});

test("Debug 中真实超级管理员切换任何演示身份后仍可重置", async ({ page }) => {
  test.skip(!isMockTarget, "演示数据重置入口只适用于本地 Mock API。");
  await loginAs(page, "admin");

  await page.locator("button.user-button").click();
  await expect(page.getByRole("menuitem", { name: "重置演示数据" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("切换演示身份").click();
  await page.locator(".ant-select-dropdown:visible").getByText("超级管理员 · 系统内置 · 全部权限", { exact: true }).click();
  await expect(page.locator(".user-copy strong")).toHaveText("超级管理员");
  await page.locator("button.user-button").click();
  await expect(page.getByRole("menuitem", { name: "重置演示数据" })).toBeVisible();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();

  await loginAs(page, "superadmin");
  const selector = page.getByLabel("切换演示身份");
  await selector.click();
  await selector.fill("王敏");
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "王敏 · 流程管理员、文控专员" }).click();
  await expect(page.locator(".user-copy strong")).toHaveText("王敏");
  await page.locator("button.user-button").click();
  await expect(page.getByRole("menuitem", { name: "重置演示数据" })).toBeVisible();
});
