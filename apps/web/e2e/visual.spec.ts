import { expect, gotoApp, isMockTarget, loginAs, stabilizeVisualPage, test } from "./fixtures/app";

test.describe("@visual 关键页面视觉基线", () => {
  test.skip(!isMockTarget, "视觉基线固定使用 Windows Debug Mock 环境。");
  test.setTimeout(60_000);

  test("登录页", async ({ page }) => {
    await gotoApp(page, "login");
    await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
    await stabilizeVisualPage(page);

    await expect(page).toHaveScreenshot("login-page.png", { fullPage: true });
  });

  test("任务中心", async ({ page }) => {
    await loginAs(page, "lina");
    await expect(page.getByRole("row", { name: /MTR-320 步进电机装配作业指导书/ })).toBeVisible();
    await stabilizeVisualPage(page);

    await expect(page).toHaveScreenshot("task-center.png", { fullPage: true });
  });

  test("流程发起中心", async ({ page }) => {
    await loginAs(page, "wangmin");
    await gotoApp(page, "launch");
    await expect(page.getByRole("heading", { name: "选择要发起的流程" })).toBeVisible();
    await stabilizeVisualPage(page);

    await expect(page).toHaveScreenshot("launch-center.png", { fullPage: true });
  });

  test("流程管理", async ({ page }) => {
    await loginAs(page, "superadmin");
    await gotoApp(page, "admin/processes");
    await expect(page.getByRole("heading", { name: "流程定义概览" })).toBeVisible();
    await stabilizeVisualPage(page);

    await expect(page).toHaveScreenshot("process-management.png", { fullPage: true });
  });
});
