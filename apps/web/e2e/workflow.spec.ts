import type { Page } from "@playwright/test";
import { expect, gotoApp, isMockTarget, loginAs, test } from "./fixtures/app";

const personaOptions = {
  wangmin: { label: "王敏 · 流程管理员、文控专员", name: "王敏" },
  zhangwei: { label: "张伟 · 研发审核员", name: "张伟" },
  lina: { label: "林晓 · 质量审核员", name: "林晓" },
  zhaolei: { label: "赵磊 · 生产审核员", name: "赵磊" },
} as const;

async function switchPersona(page: Page, personaId: keyof typeof personaOptions) {
  const persona = personaOptions[personaId];
  const selector = page.getByLabel("切换演示身份");
  await selector.click();
  await selector.fill(personaId);
  await selector.press("Enter");
  await expect(page.locator(".user-copy strong")).toHaveText(persona.name);
}

async function openTaskByTitle(page: Page, title: string) {
  await gotoApp(page, "tasks");
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: new RegExp(`进入审核：${title}$`) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function passCurrentTask(page: Page, personaId: "zhangwei" | "lina" | "zhaolei", title: string) {
  await switchPersona(page, personaId);
  await openTaskByTitle(page, title);
  await page.getByRole("button", { name: /通过并提交$/ }).click();
  const dialog = page.getByRole("dialog", { name: "确认通过本节点？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认通过" }).click();
  await expect(page.getByText("审核已通过", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/flowpilot\/tasks$/);
}

test("发起自由协作事项并在刷新后保留数据", async ({ page }) => {
  test.skip(!isMockTarget, "确定性演示流程只适用于本地 Mock API。");
  test.setTimeout(60_000);
  const title = "E2E 异常协作事项";
  await loginAs(page, "wangmin");
  await gotoApp(page, "launch");

  await page.getByRole("button", { name: "发起异常协作事项" }).click();
  await expect(page.getByText("异常协作事项", { exact: true }).first()).toBeVisible();
  await page.locator(".start-form-grid").getByRole("textbox").first().fill(title);
  await page.getByRole("button", { name: /提交$/ }).click();
  await expect(page.getByText("请选择首位受理人", { exact: true })).toBeVisible();

  const assignee = page.locator(".start-reviewer-card").getByRole("combobox");
  await assignee.fill("张伟");
  const visibleOption = page.locator(".ant-select-dropdown:visible").getByText("张伟 · 研发 / 软件 · 员工", { exact: true });
  await expect(visibleOption).toBeVisible();
  await visibleOption.click();
  await page.getByRole("button", { name: /提交$/ }).click();
  const dialog = page.getByRole("dialog", { name: "确认提交" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认提交" }).click();

  await expect(page.getByText("事项已创建并生成首位受理人的待办", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/flowpilot\/launch$/);
  await gotoApp(page, "tasks");
  await page.getByText("我的发起", { exact: false }).click();
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  await expect(page.getByRole("row", { name: new RegExp(title) })).toBeVisible();

  await page.reload();
  await page.getByText("我的发起", { exact: false }).click();
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  await expect(page.getByRole("row", { name: new RegExp(title) })).toBeVisible();
});

test("自由协作发起、详情和编辑始终使用锁定版本的完整初始表单", async ({ page }) => {
  test.skip(!isMockTarget, "确定性演示流程只适用于本地 Mock API。");
  test.setTimeout(60_000);
  const title = "E2E 自由协作表单一致性";
  await loginAs(page, "wangmin");
  await gotoApp(page, "launch");
  await page.getByRole("button", { name: "发起异常协作事项" }).click();

  const launchForm = page.locator(".start-form-grid");
  const lockedFieldLabels = ["标题", "历史字段 2", "历史字段 3", "历史字段 4", "历史字段 5"];
  for (const label of lockedFieldLabels) await expect(launchForm.getByText(label, { exact: true })).toBeVisible();
  await launchForm.getByRole("textbox").first().fill(title);

  const assignee = page.locator(".start-reviewer-card").getByRole("combobox");
  await assignee.fill("张伟");
  await page.locator(".ant-select-dropdown:visible").getByText("张伟 · 研发 / 软件 · 员工", { exact: true }).click();
  await page.getByRole("button", { name: /提交$/ }).click();
  await page.getByRole("dialog", { name: "确认提交" }).getByRole("button", { name: "确认提交" }).click();

  await gotoApp(page, "tasks");
  await page.getByText("我的发起", { exact: false }).click();
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: new RegExp(`查看流程：${title}$`) }).click();

  const initialCard = page.locator(".free-initial-card");
  for (const label of lockedFieldLabels) await expect(initialCard.getByText(label, { exact: true })).toBeVisible();
  await expect(initialCard.getByText("问题描述", { exact: true })).toHaveCount(0);
  await expect(initialCard.getByText("优先级", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "编辑初始表单" }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑初始表单" });
  await expect(editDialog).toBeVisible();
  for (const label of lockedFieldLabels) await expect(editDialog.getByText(label, { exact: true })).toBeVisible();
  await editDialog.getByRole("button", { name: /取\s*消/ }).click();
});

test("审核人必须填写驳回意见并可完成驳回", async ({ page }) => {
  test.skip(!isMockTarget, "确定性演示待办只适用于本地 Mock API。");
  const title = "MTR-320 步进电机装配作业指导书";
  await loginAs(page, "lina");

  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: new RegExp(`进入审核：${title}`) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.getByRole("button", { name: /驳回$/ }).click();
  await expect(page.getByText("驳回时必须填写审核意见", { exact: true })).toBeVisible();
  await page.getByPlaceholder("填写审核意见；通过时可选，驳回时必填").fill("E2E：装配复检步骤需要补充量具编号。");
  await page.getByRole("button", { name: /驳回$/ }).click();

  const dialog = page.getByRole("dialog", { name: "确认驳回本轮审核？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认驳回" }).click();
  await expect(page.getByText("已驳回，等待发起方处理", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/flowpilot\/tasks$/);
});

test("发起人重新提交后三个并行审核节点全部通过并完成流程", async ({ page }) => {
  test.skip(!isMockTarget, "确定性演示流程只适用于本地 Mock API。");
  test.setTimeout(120_000);
  const title = "E2E 重新提交并行审核闭环";
  await loginAs(page, "wangmin");
  await gotoApp(page, "launch/pdf-review");

  await page.locator(".start-form-grid").getByRole("textbox").first().fill(title);
  const reviewerLabels = [
    "张伟 · 研发 / 软件 · 员工",
    "林晓 · 质量 / 体系 · 员工",
    "赵磊 · 生产 / 一车间 · 员工",
  ];
  for (const [index, label] of reviewerLabels.entries()) {
    await page.locator(".start-reviewer-item").nth(index).getByRole("combobox").click();
    await page.locator(".ant-select-dropdown:visible").getByText(label, { exact: true }).click();
  }
  await page.getByRole("button", { name: /提交$/ }).click();
  const submitDialog = page.getByRole("dialog", { name: "确认提交" });
  await expect(submitDialog).toBeVisible();
  await submitDialog.getByRole("button", { name: "确认提交" }).click();
  await expect(page.getByText("流程已提交，审批或确认节点已按条件和发布版本生成待办", { exact: true })).toBeVisible();

  await gotoApp(page, "tasks");
  await page.getByText("我的发起", { exact: false }).click();
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  const initiatedRow = page.getByRole("row", { name: new RegExp(title) });
  await expect(initiatedRow).toBeVisible();
  await initiatedRow.getByRole("button", { name: new RegExp(`查看流程：${title}$`) }).click();
  await expect(page).toHaveURL(/\/flowpilot\/processes\/[^/?]+$/);
  const instancePath = new URL(page.url()).pathname.replace(/^\/flowpilot\//, "");

  await switchPersona(page, "lina");
  await openTaskByTitle(page, title);
  await page.getByPlaceholder("填写审核意见；通过时可选，驳回时必填").fill("E2E：请补充质量复核记录后重新提交。");
  await page.getByRole("button", { name: /驳回$/ }).click();
  const rejectDialog = page.getByRole("dialog", { name: "确认驳回本轮审核？" });
  await expect(rejectDialog).toBeVisible();
  await rejectDialog.getByRole("button", { name: "确认驳回" }).click();
  await expect(page.getByText("已驳回，等待发起方处理", { exact: true })).toBeVisible();

  await switchPersona(page, "wangmin");
  await gotoApp(page, "tasks");
  await page.getByPlaceholder("搜索编号、标题或发起人").fill(title);
  const rejectedRow = page.getByRole("row", { name: new RegExp(title) });
  await expect(rejectedRow).toBeVisible();
  await rejectedRow.getByRole("button", { name: new RegExp(`处理驳回并重新提交：${title}$`) }).click();
  await expect(page.getByText("流程已驳回，发起内容现已解锁", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /重新提交$/ }).click();
  const republishDialog = page.getByRole("dialog", { name: /确认重新提交并开启第 2 轮审核/ });
  await expect(republishDialog).toBeVisible();
  await republishDialog.getByRole("button", { name: "确认重新提交" }).click();
  await expect(page.getByText("流程已重新提交，全部分支待办已重新生成", { exact: true })).toBeVisible();
  await expect(page.locator(".detail-title-row").getByText("审核中", { exact: true })).toBeVisible();

  await passCurrentTask(page, "zhangwei", title);
  await passCurrentTask(page, "lina", title);
  await passCurrentTask(page, "zhaolei", title);

  await switchPersona(page, "wangmin");
  await gotoApp(page, instancePath);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".detail-title-row").getByText("已完成", { exact: true })).toBeVisible();
  await expect(page.locator(".detail-node-indicator strong")).toHaveText("流程结束");
  await expect(page.getByText("第 2 轮", { exact: true })).toBeVisible();
});
