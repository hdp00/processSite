import { expect, gotoApp, loginAs, test } from "./fixtures/app";

test("应用不依赖浏览器业务存储 @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new Error("localStorage is disabled"); } });
    Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("sessionStorage is disabled"); } });
    Object.defineProperty(window, "indexedDB", { get: () => { throw new Error("indexedDB is disabled"); } });
  });
  await loginAs(page);
  await expect(page.getByRole("heading", { name: "任务中心", level: 4 })).toBeVisible();
});

test("超级管理员治理页面均从后端完成加载", async ({ page }) => {
  await loginAs(page);
  const pages = [
    ["admin/users", "用户管理"],
    ["admin/departments", "部门管理"],
    ["admin/roles", "角色管理"],
    ["admin/permissions", "权限管理"],
    ["admin/workflow-groups", "流程权限组"],
    ["admin/processes", "流程管理"],
    ["ops/instances", "流程实例监控"],
    ["ops/audit-logs", "操作审计日志"],
  ] as const;

  for (const [path, heading] of pages) {
    await gotoApp(page, path);
    await expect(page.getByRole("heading", { name: heading, level: 4 })).toBeVisible();
    await expect(page.getByText(/加载失败|服务器处理请求时发生错误/)).toHaveCount(0);
  }
});

test("治理列表响应格式错误后会结束加载并显示反馈", async ({ page }) => {
  await loginAs(page);

  await page.route("**/api/flowpilot/v1/users?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
  await gotoApp(page, "admin/users");
  await expect(page.getByText("用户列表加载失败，请重试", { exact: true })).toBeVisible();
  await expect(page.locator(".ant-table-wrapper .ant-spin-spinning")).toHaveCount(0);
  await page.unroute("**/api/flowpilot/v1/users?**");

  await page.route("**/api/flowpilot/v1/audit-events?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
  await gotoApp(page, "ops/audit-logs");
  await expect(page.getByText("审计日志加载失败，请稍后重试", { exact: true })).toBeVisible();
  await expect(page.locator(".ant-table-wrapper .ant-spin-spinning")).toHaveCount(0);
});

test("新增用户默认职务为员工且可选信息不阻止编辑", async ({ page }) => {
  await loginAs(page);
  await gotoApp(page, "admin/users");
  await page.getByRole("button", { name: "新增用户" }).click();

  const drawer = page.getByRole("dialog", { name: "新增用户" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("员工", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: /账号/ })).toBeEnabled();
  await expect(drawer.getByRole("textbox", { name: /邮箱/ })).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("富文本图片作为后端长期附件上传、读取且不能按暂存附件删除", async ({ page }) => {
  await loginAs(page);
  const origin = new URL(page.url()).origin;
  const upload = await page.request.post("/api/flowpilot/v1/attachments", {
    headers: {
      Origin: origin,
      "Idempotency-Key": "e2e-rich-text-media-pixel-v1",
    },
    multipart: {
      purpose: "rich-text-media",
      file: {
        name: "pixel.png",
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const attachment = await upload.json() as { id: string; status: string };
  expect(attachment.status).toBe("active");

  const content = await page.request.get(`/api/flowpilot/v1/attachments/${attachment.id}/content?disposition=inline`);
  expect(content.ok()).toBe(true);
  expect(content.headers()["content-type"]).toContain("image/png");

  const metadata = await page.request.get(`/api/flowpilot/v1/attachments/${attachment.id}`);
  const etag = metadata.headers().etag;
  expect(etag).toBeTruthy();
  const removed = await page.request.delete(`/api/flowpilot/v1/attachments/${attachment.id}`, { headers: { Origin: origin, "If-Match": etag! } });
  expect(removed.status()).toBe(409);
  expect((await removed.json() as { code: string }).code).toBe("RICH_TEXT_MEDIA_ACTIVE");

  const disguisedExecutable = await page.request.post("/api/flowpilot/v1/attachments", {
    headers: {
      Origin: origin,
      "Idempotency-Key": "e2e-rich-text-media-invalid-signature-v1",
    },
    multipart: {
      purpose: "rich-text-media",
      file: {
        name: "not-an-image.png",
        mimeType: "image/png",
        buffer: Buffer.from("not an image"),
      },
    },
  });
  expect(disguisedExecutable.status()).toBe(415);
  expect((await disguisedExecutable.json() as { code: string }).code).toBe("RICH_TEXT_MEDIA_TYPE_INVALID");
});
