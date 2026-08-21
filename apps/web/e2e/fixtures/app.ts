import { expect, test as base, type Page } from "@playwright/test";

type ConsoleAuditFixture = {
  consoleAudit: void;
};

const ignoredConsoleErrors = [
  /favicon\.ico/i,
];

export const test = base.extend<ConsoleAuditFixture>({
  consoleAudit: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      const source = message.location().url;
      const searchable = `${text} ${source}`;
      if (!ignoredConsoleErrors.some((pattern) => pattern.test(searchable))) {
        errors.push(`console.error: ${text}${source ? ` (${source})` : ""}`);
      }
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await use();

    expect(errors, `页面不应产生未处理错误：\n${errors.join("\n")}`).toEqual([]);
  }, { auto: true }],
});

export { expect } from "@playwright/test";

export const isMockTarget = (process.env.FLOWPILOT_TEST_TARGET ?? "mock") === "mock";

export async function gotoApp(page: Page, path: string) {
  await page.goto(path.replace(/^\//, ""));
}

export async function loginAs(page: Page, username: string, password = "1") {
  await gotoApp(page, "login");
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
  await page.getByLabel("账号").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.locator("button.login-submit").click();
  await expect(page).toHaveURL(/\/flowpilot\/tasks$/);
  await expect(page.locator(".app-header")).toBeVisible();
}

export async function stabilizeVisualPage(page: Page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      .ant-message,
      .ant-notification,
      .ant-wave { display: none !important; }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
}
