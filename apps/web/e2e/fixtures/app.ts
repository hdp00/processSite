import { expect, test as base, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type ConsoleAuditFixture = {
  consoleAudit: void;
};

const ignoredConsoleErrors = [
  /favicon\.ico/i,
  // 会话探测和“错误密码”用例预期后端返回 401；浏览器会把预期 HTTP
  // 状态写成 console.error，但应用已经通过 ApiError 正常处理。
  /Failed to load resource:.*status of 401.*\/api\/flowpilot\/v1\/auth\/(?:me|login)/i,
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

export async function gotoApp(page: Page, path: string) {
  await page.goto(path.replace(/^\//, ""));
}

interface LocalDevelopmentConfiguration {
  FlowPilot?: { Bootstrap?: { SuperAdminPassword?: string } };
}

export function getTestCredentials() {
  const username = process.env.FLOWPILOT_E2E_USERNAME ?? "superadmin";
  if (process.env.FLOWPILOT_E2E_PASSWORD) {
    return { username, password: process.env.FLOWPILOT_E2E_PASSWORD };
  }
  const candidates = [
    resolve(process.cwd(), "../api/config/appsettings.Development.local.json"),
    resolve(process.cwd(), "apps/api/config/appsettings.Development.local.json"),
  ];
  const path = candidates.find(existsSync);
  const password = path
    ? (JSON.parse(readFileSync(path, "utf8")) as LocalDevelopmentConfiguration).FlowPilot?.Bootstrap?.SuperAdminPassword
    : undefined;
  if (!password) {
    throw new Error("请设置 FLOWPILOT_E2E_PASSWORD，或在后端本地配置中填写 FlowPilot:Bootstrap:SuperAdminPassword。");
  }
  return { username, password };
}

export async function loginAs(page: Page, username?: string, password?: string) {
  const configured = getTestCredentials();
  await gotoApp(page, "login");
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
  await page.getByLabel("账号").fill(username ?? configured.username);
  await page.getByLabel("密码").fill(password ?? configured.password);
  await page.locator("button.login-submit").click();
  await expect(page.locator(".app-header")).toBeVisible();
  await expect(page).not.toHaveURL(/\/flowpilot\/login(?:[/?#]|$)/);
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
