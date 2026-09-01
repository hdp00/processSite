import { expect, gotoApp, stabilizeVisualPage, test } from "./fixtures/app";

test("@visual 登录页视觉基线", async ({ page }) => {
  await gotoApp(page, "login");
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
  await stabilizeVisualPage(page);

  await expect(page).toHaveScreenshot("login-page.png", { fullPage: true });
});
