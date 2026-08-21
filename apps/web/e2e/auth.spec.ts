import { expect, gotoApp, isMockTarget, loginAs, test } from "./fixtures/app";

test("未登录访问受保护页面会回到登录页 @smoke", async ({ page }) => {
  await gotoApp(page, "tasks");

  await expect(page).toHaveURL(/\/flowpilot\/login$/);
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
});

test("Debug 登录页固定超级管理员并拒绝错误凭据", async ({ page }) => {
  test.skip(!isMockTarget, "错误凭据断言只适用于本地 Mock API。");
  await gotoApp(page, "login");

  await expect(page.getByLabel("账号")).toHaveValue("superadmin");
  await expect(page.getByLabel("账号")).toHaveAttribute("readonly", "");
  await expect(page.getByRole("combobox", { name: "切换演示身份" })).toHaveCount(0);
  await page.getByLabel("密码").fill("");
  await page.locator("button.login-submit").click();
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();

  await page.getByLabel("密码").fill("wrong-password");
  await page.locator("button.login-submit").click();
  await expect(page.getByText("账号或密码错误。", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/flowpilot\/login$/);
});

test("有效账号登录后刷新仍保持会话 @smoke", async ({ page }) => {
  test.skip(!isMockTarget, "演示账号只适用于本地 Mock API。");
  await loginAs(page, "lina");

  await expect(page.getByRole("heading", { name: "任务中心", level: 4 })).toBeVisible();
  await expect(page.locator(".user-copy strong")).toHaveText("林晓");
  await page.reload();

  await expect(page).toHaveURL(/\/flowpilot\/tasks$/);
  await expect(page.getByRole("heading", { name: "任务中心", level: 4 })).toBeVisible();
  await expect(page.locator(".user-copy strong")).toHaveText("林晓");
});
