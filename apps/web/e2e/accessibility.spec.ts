import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, gotoApp, loginAs, test } from "./fixtures/app";

const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  const violations = results.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }));
  expect(violations, `发现 WCAG A/AA 严重问题：\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

test("登录页不存在严重 WCAG A/AA 问题", async ({ page }) => {
  await gotoApp(page, "login");
  await expect(page.getByRole("heading", { name: "登录流程中心" })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});

test("真实后端任务中心不存在严重 WCAG A/AA 问题", async ({ page }) => {
  await loginAs(page);
  await expect(page.getByRole("heading", { name: "任务中心", level: 4 })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);
});
