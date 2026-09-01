import type { UploadFile } from "antd";
import { describe, expect, it } from "vitest";
import type { AttachmentRecord } from "../api/contracts";
import { cleanupTemporaryAttachments, temporaryAttachmentRecords } from "./attachmentLifecycle";

const attachment = (id: string, lifecycle: AttachmentRecord["lifecycle"]): UploadFile<AttachmentRecord> => ({
  uid: id,
  name: `${id}.pdf`,
  response: {
    id,
    name: `${id}.pdf`,
    size: 1,
    contentType: "application/pdf",
    uploadedById: "user-1",
    uploadedAt: "2026-08-31T00:00:00Z",
    lifecycle,
  },
});

describe("附件生命周期筛选", () => {
  it("只返回尚未生效的临时附件", () => {
    expect(temporaryAttachmentRecords([
      attachment("temporary", "temporary"),
      attachment("active", "active"),
      attachment("cleanup", "cleanup-pending"),
    ]).map((item) => item.id)).toEqual(["temporary"]);
  });

  it("空文件列表返回空数组", () => {
    expect(temporaryAttachmentRecords()).toEqual([]);
  });

  it("清理操作只调用临时附件并等待全部结果", async () => {
    const removed: string[] = [];
    const results = await cleanupTemporaryAttachments([
      attachment("temporary-1", "temporary"),
      attachment("active", "active"),
      attachment("temporary-2", "temporary"),
    ], async (id) => {
      removed.push(id);
      if (id === "temporary-2") throw new Error("模拟清理失败");
    });

    expect(removed).toEqual(["temporary-1", "temporary-2"]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  });
});
