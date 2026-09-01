import { expect, gotoApp, loginAs, test } from "./fixtures/app";

test("未登录访问受保护页面会回到登录页 @smoke", async ({ page }) => {
  await gotoApp(page, "tasks");
  await expect(page).toHaveURL(/\/flowpilot\/login$/);
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
});

test("登录页执行前端校验并显示后端认证失败", async ({ page }) => {
  await gotoApp(page, "login");
  await page.locator("button.login-submit").click();
  await expect(page.getByText("请输入账号", { exact: true })).toBeVisible();
  await expect(page.getByText("请输入密码", { exact: true })).toBeVisible();

  await page.getByLabel("账号").fill(`invalid-${Date.now()}`);
  await page.getByLabel("密码").fill("wrong-password");
  await page.locator("button.login-submit").click();
  await expect(page.getByText("账号或密码错误。", { exact: true })).toBeVisible();
});

test("真实后端会话在刷新后保持且可以退出 @smoke", async ({ page }) => {
  await loginAs(page);
  await page.reload();
  await expect(page).toHaveURL(/\/flowpilot\/tasks$/);
  await expect(page.locator(".app-header")).toBeVisible();
  await page.locator("button.user-button").click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/flowpilot\/login$/);
});
