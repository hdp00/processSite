import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, gotoApp, isMockTarget, loginAs, test } from "./fixtures/app";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(wcagTags)
    .analyze();
  const violations = results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious",
  );
  const summary = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target.join(" "),
      html: node.html,
      failureSummary: node.failureSummary,
      checks: [...node.any, ...node.all, ...node.none]
        .filter((check) => check.data)
        .map((check) => ({ message: check.message, data: check.data })),
    })),
  }));

  expect(summary, `发现 WCAG A/AA 严重问题：\n${JSON.stringify(summary, null, 2)}`).toEqual([]);
}

test("登录页不存在严重 WCAG A/AA 问题", async ({ page }) => {
  await gotoApp(page, "login");
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();

  await expectNoSeriousAccessibilityViolations(page);
});

test("任务中心不存在严重 WCAG A/AA 问题", async ({ page }) => {
  test.skip(!isMockTarget, "演示账号只适用于本地 Mock API。");
  await loginAs(page, "lina");
  await expect(page.getByRole("row", { name: /MTR-320 步进电机装配作业指导书/ })).toBeVisible();

  await expectNoSeriousAccessibilityViolations(page);
});

test("流程发起页可通过键盘到达并不存在严重 WCAG A/AA 问题", async ({ page }) => {
  test.skip(!isMockTarget, "演示账号只适用于本地 Mock API。");
  await loginAs(page, "wangmin");
  await gotoApp(page, "launch");

  const brand = page.locator("button.brand");
  await brand.focus();
  await expect(brand).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
  await expect(brand).not.toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
});
