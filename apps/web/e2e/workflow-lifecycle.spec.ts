import type { Locator, Page } from "@playwright/test";
import { expect, gotoApp, loginAs, test } from "./fixtures/app";
import { createPublishedWorkflow, unpublishWorkflow } from "./fixtures/workflow";

test.skip(
  Boolean(process.env.FLOWPILOT_TEST_BASE_URL),
  "会写入数据的浏览器链路只在自动创建的隔离测试数据库中执行。",
);

async function selectAntOption(page: Page, select: Locator, optionText: string) {
  await select.click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: optionText })
    .click();
}

async function launchWorkflow(
  page: Page,
  workflow: Awaited<ReturnType<typeof createPublishedWorkflow>>,
  title: string,
  type: "approval" | "free",
) {
  await gotoApp(page, `launch/${workflow.definitionId}`);
  await page.locator(".ant-form-item").filter({ hasText: "标题" }).locator("input").fill(title);
  await selectAntOption(
    page,
    type === "approval"
      ? page.locator(".start-reviewer-item .ant-select")
      : page.locator(".ant-form-item").filter({ hasText: "选择受理人" }).locator(".ant-select"),
    workflow.primaryUser.name,
  );

  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith("/api/flowpilot/v1/process-instances"),
  );
  await page.locator(".process-start-toolbar button.ant-btn-primary").click();
  await page.locator(".ant-modal:visible .ant-modal-footer button.ant-btn-primary").click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  return await createResponse.json() as { id: string };
}

async function submitApproval(
  page: Page,
  action: "pass" | "reject",
  comment: string,
) {
  await page.getByPlaceholder("填写审核意见；通过时可选，驳回时必填").fill(comment);
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/flowpilot\/v1\/workflow-tasks\/[^/]+\/decision$/.test(response.url()),
  );
  await page.locator(".approval-actions button")
    .filter({ hasText: action === "pass" ? "通过并提交" : "驳回" })
    .click();
  await page.locator(".ant-modal:visible .ant-modal-footer button")
    .filter({ hasText: action === "pass" ? "确认通过" : "确认驳回" })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  return await response.json() as { instance: { status: string; code: string } };
}

test("固定审批从发布版本发起、提交授权字段审核并打印实例数据", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "approval");

  const instance = await launchWorkflow(
    page,
    workflow,
    "浏览器固定审批完整链路",
    "approval",
  );

  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByRole("heading", { name: "浏览器固定审批完整链路" })).toBeVisible();
  await page.locator(".ant-form-item").filter({ hasText: "审核补充" }).locator("input").fill("浏览器已填写授权审核字段");
  const decision = await submitApproval(page, "pass", "浏览器审核通过");
  expect(decision.instance.status).toBe("completed");
  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("浏览器审核通过")).toBeVisible();

  await gotoApp(page, `processes/${instance.id}/print`);
  await expect(page.locator(".process-print-code strong")).toHaveText(decision.instance.code);
  const reviewRow = page.locator(".print-review-table tbody tr").first();
  await expect(reviewRow.locator("td").nth(3)).toHaveText(workflow.primaryUser.name);
  await expect(reviewRow.locator("td").nth(3)).not.toHaveText("组内共享");

  await gotoApp(page, `launch/${workflow.definitionId}?copyFrom=${instance.id}`);
  await expect(page.locator(".start-reviewer-item .ant-select"))
    .toContainText(workflow.primaryUser.name);
});

test("自由协作可以只变更受理人且时间线立即更新", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "free");

  const instance = await launchWorkflow(
    page,
    workflow,
    "浏览器自由协作仅改派链路",
    "free",
  );

  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByText(workflow.primaryUser.name, { exact: true }).first()).toBeVisible();
  await selectAntOption(
    page,
    page.locator(".free-compose-actions .ant-select"),
    workflow.secondaryUser.name,
  );

  const transferResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/flowpilot\/v1\/process-instances\/[^/]+\/free-collaboration\/transfers$/.test(response.url()),
  );
  await page.locator(".free-compose-actions button.ant-btn-primary").click();
  const transferResponse = await transferResponsePromise;
  expect(transferResponse.ok()).toBe(true);
  const transferred = await transferResponse.json() as {
    currentAssignee: { id: string };
    freeTimeline: Array<{ type: string; assignee?: { id: string } }>;
  };
  expect(transferred.currentAssignee.id).toBe(workflow.secondaryUser.id);
  expect(transferred.freeTimeline.at(-1)).toMatchObject({
    type: "transferred",
    assignee: { id: workflow.secondaryUser.id },
  });
  await expect(page.getByText(workflow.secondaryUser.name, { exact: true }).first()).toBeVisible();
});

test("受理权限组普通成员无需当前受理或历史参与即可回复并变更受理人", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "free", {
    userPermissions: ["work-task:查看", "work-task:审核", "work-list:查看"],
  });
  const instance = await launchWorkflow(
    page,
    workflow,
    "普通权限成员自由协作链路",
    "free",
  );

  const origin = new URL(page.url()).origin;
  const logoutResponse = await page.request.post("/api/flowpilot/v1/auth/logout", {
    headers: { Origin: origin },
  });
  expect(logoutResponse.ok()).toBe(true);
  await page.reload();
  await loginAs(page, workflow.secondaryUser.loginName, workflow.secondaryUser.password);

  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByRole("heading", { name: "普通权限成员自由协作链路" })).toBeVisible();
  await page.locator(".free-compose .ProseMirror").fill("普通权限组成员直接参与处理");
  await selectAntOption(
    page,
    page.locator(".free-compose-actions .ant-select"),
    workflow.secondaryUser.name,
  );

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/flowpilot\/v1\/process-instances\/[^/]+\/free-collaboration\/transfers$/.test(response.url()),
  );
  await page.locator(".free-compose-actions button.ant-btn-primary")
    .filter({ hasText: "回复并变更" })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const updated = await response.json() as {
    currentAssignee: { id: string };
    freeTimeline: Array<{ type: string; content?: string; assignee?: { id: string } }>;
  };
  expect(updated.currentAssignee.id).toBe(workflow.secondaryUser.id);
  expect(updated.freeTimeline).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "reply", content: expect.stringContaining("普通权限组成员直接参与处理") }),
    expect.objectContaining({
      type: "transferred",
      assignee: expect.objectContaining({ id: workflow.secondaryUser.id }),
    }),
  ]));
  await expect(page.getByText("普通权限组成员直接参与处理")).toBeVisible();
  await expect(page.getByText(workflow.secondaryUser.name, { exact: true }).first()).toBeVisible();
});

test("自由协作编辑回复后按编辑时间重排且不显示独立编辑事件", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "free");
  const instance = await launchWorkflow(page, workflow, "自由协作回复编辑链路", "free");

  await gotoApp(page, `processes/${instance.id}`);
  await page.locator(".free-compose .ProseMirror").fill("稍后需要编辑的回复");
  const replyResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith(`/api/flowpilot/v1/process-instances/${instance.id}/free-collaboration/replies`),
  );
  await page.locator(".free-compose-actions button.ant-btn-primary")
    .filter({ hasText: "发表回复" })
    .click();
  expect((await replyResponsePromise).ok()).toBe(true);

  await selectAntOption(
    page,
    page.locator(".free-compose-actions .ant-select"),
    workflow.secondaryUser.name,
  );
  const transferResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/flowpilot\/v1\/process-instances\/[^/]+\/free-collaboration\/transfers$/.test(response.url()),
  );
  await page.locator(".free-compose-actions button.ant-btn-primary")
    .filter({ hasText: "变更受理人" })
    .click();
  expect((await transferResponsePromise).ok()).toBe(true);

  const replyCard = page.locator(".free-reply-card").filter({ hasText: "稍后需要编辑的回复" });
  await replyCard.getByRole("button", { name: "编辑" }).click();
  const editModal = page.locator(".ant-modal:visible").filter({ hasText: "编辑我的回复" });
  await editModal.locator(".ProseMirror").fill("已经更新的回复内容");
  const editResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "PATCH" &&
    /\/api\/flowpilot\/v1\/process-instances\/[^/]+\/free-collaboration\/replies\/[^/]+$/.test(response.url()),
  );
  await editModal.getByRole("button", { name: "保存修改" }).click();
  expect((await editResponsePromise).ok()).toBe(true);

  await expect(page.getByText("更新了一条回复内容", { exact: true })).toHaveCount(0);
  const timelineItems = page.locator(".free-timeline .ant-timeline-item");
  await expect(timelineItems.last()).toContainText("已经更新的回复内容");
  await expect(timelineItems.nth((await timelineItems.count()) - 2)).toContainText("变更受理人");

  await page.getByRole("button", { name: "编辑初始表单" }).click();
  const initialFormModal = page.locator(".ant-modal:visible").filter({ hasText: "编辑初始表单" });
  const nativeFileInputs = initialFormModal.locator("input.rich-editor__file-input");
  await expect(nativeFileInputs).toHaveCount(2);
  await expect(nativeFileInputs.first()).toBeHidden();
  await expect(nativeFileInputs.last()).toBeHidden();
});

test("固定审批驳回后修改并重新提交可进入新一轮完成", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "approval");
  const instance = await launchWorkflow(
    page,
    workflow,
    "浏览器驳回重新提交链路",
    "approval",
  );

  await gotoApp(page, `processes/${instance.id}`);
  const rejected = await submitApproval(page, "reject", "浏览器验证驳回");
  expect(rejected.instance.status).toBe("rejected-pending");

  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByText("驳回待处理", { exact: true }).first()).toBeVisible();
  await page.locator(".ant-form-item").filter({ hasText: "标题" }).locator("input").fill("浏览器驳回后已修改");
  const resubmitResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith(`/api/flowpilot/v1/process-instances/${instance.id}/resubmissions`),
  );
  await page.locator(".detail-topbar-actions button").filter({ hasText: "重新提交" }).click();
  await page.locator(".ant-modal-confirm:visible button.ant-btn-primary").click();
  const resubmitResponse = await resubmitResponsePromise;
  expect(resubmitResponse.ok()).toBe(true);
  const resubmitted = await resubmitResponse.json() as { status: string; round: number };
  expect(resubmitted).toMatchObject({ status: "reviewing", round: 2 });

  await expect(page.getByText("第 2 轮", { exact: true }).first()).toBeVisible();
  const completed = await submitApproval(page, "pass", "浏览器第二轮审核通过");
  expect(completed.instance.status).toBe("completed");
  await gotoApp(page, `processes/${instance.id}`);
  await expect(page.getByText("浏览器驳回后已修改", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("已完成", { exact: true }).first()).toBeVisible();
});

test("任务中心保留全部流程分类计数并在切换视图时清除失效筛选", async ({ page }) => {
  await loginAs(page);
  const firstWorkflow = await createPublishedWorkflow(page, "approval");
  const secondWorkflow = await createPublishedWorkflow(page, "free");
  await launchWorkflow(page, firstWorkflow, "任务中心审批流程", "approval");
  await launchWorkflow(page, secondWorkflow, "任务中心自由流程", "free");

  await gotoApp(page, "tasks");
  const allFlows = page.locator(".task-flow-item").filter({ hasText: "全部待办" });
  await expect(allFlows.locator(".task-flow-item__count")).toHaveText("2");
  const firstCategory = page.locator(".task-flow-item").filter({ hasText: firstWorkflow.name });
  const secondCategory = page.locator(".task-flow-item").filter({ hasText: secondWorkflow.name });
  await expect(firstCategory.locator(".task-flow-item__count")).toHaveText("1");
  await expect(secondCategory.locator(".task-flow-item__count")).toHaveText("1");
  await expect(page.getByText("任务中心审批流程", { exact: true })).toBeVisible();
  await expect(page.getByText("任务中心自由流程", { exact: true })).toBeVisible();

  await firstCategory.click();
  await expect(page.getByText("任务中心审批流程", { exact: true })).toBeVisible();
  await expect(page.getByText("任务中心自由流程", { exact: true })).toHaveCount(0);
  await expect(secondCategory).toBeVisible();

  await page.locator(".task-tabs .ant-segmented-item").filter({ hasText: "可代办" }).click();
  await expect(page.getByText("当前组内没有可代办任务", { exact: true })).toBeVisible();
  await expect(page.locator(".task-list-context strong")).toHaveText("全部待办");
  await expect(page.locator(".task-list-context")).not.toContainText(firstWorkflow.definitionId);
});

test("初始表单和流程设计器再次进入保持已保存状态", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "approval");
  await unpublishWorkflow(page, workflow);
  const query = `versionId=${workflow.versionId}`;

  await gotoApp(page, `admin/processes/${workflow.definitionId}/form?${query}`);
  await expect(page.locator(".fd-save-status")).toContainText("版本已保存 ·");
  await expect(page.locator(".fd-save-status")).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await expect(page.locator(".fd-save-status")).not.toContainText("有未保存修改");
  await expect(page.locator(".fd-property-panel")).not.toContainText("选项设置");

  await gotoApp(page, `admin/processes/${workflow.definitionId}/flow?${query}`);
  await expect(page.locator(".flow-designer-save-state")).toContainText("版本已保存 ·");
  await expect(page.locator(".flow-designer-save-state")).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await expect(page.locator(".flow-designer-save-state")).not.toContainText(/有未保存修改|尚未保存/);

  await gotoApp(page, `admin/processes/${workflow.definitionId}/form?${query}`);
  await expect(page.locator(".fd-save-status")).toContainText("版本已保存 ·");
  await expect(page.locator(".fd-save-status")).not.toContainText("有未保存修改");
  await expect(page.locator(".fd-property-panel")).not.toContainText("选项设置");
});

test("复制创建的流程定义在版本记录中显示来源版本", async ({ page }) => {
  await loginAs(page);
  const workflow = await createPublishedWorkflow(page, "approval");
  const origin = new URL(page.url()).origin;
  const copyResponse = await page.request.post(
    `/api/flowpilot/v1/process-definitions/${workflow.definitionId}/copies`,
    {
      headers: {
        Origin: origin,
        "Idempotency-Key": `e2e-copy-definition-${Date.now()}`,
      },
      data: {
        sourceVersionId: workflow.versionId,
        name: `${workflow.name}-副本`,
      },
    },
  );
  expect(copyResponse.status()).toBe(201);
  const copied = await copyResponse.json() as { definition: { id: string } };

  await gotoApp(page, `admin/processes/${copied.definition.id}/versions`);
  const versionRow = page.locator(".ant-table-tbody tr.ant-table-row").first();
  await expect(versionRow.locator("td").nth(2)).toHaveText("V1");
  await expect(versionRow.locator("td").nth(2)).not.toHaveText("首次创建");
});
