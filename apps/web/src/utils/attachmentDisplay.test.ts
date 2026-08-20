import { describe, expect, it } from "vitest";
import { pdfPreviewBlob, resolveRuntimeAttachmentNames, resolveRuntimeAttachments, shouldReplaceUploadedAttachment } from "./attachmentDisplay";

describe("runtime attachment display", () => {
  it("pairs legacy file-name values with field attachment ids", () => {
    expect(resolveRuntimeAttachments({
      fieldId: "pdf-field",
      value: ["软件发布说明.pdf"],
      attachmentIdsByField: { "pdf-field": ["attachment-1"] },
    })).toEqual([{
      id: "attachment-1",
      name: "软件发布说明.pdf",
      sourceIndex: 0,
    }]);
  });

  it("falls back to instance-level attachment ids for the primary attachment field", () => {
    expect(resolveRuntimeAttachments({
      fieldId: "pdf-field",
      value: [],
      fallbackNames: ["固件发布单.pdf"],
      attachmentIds: ["attachment-2"],
      primaryField: true,
    })[0]).toMatchObject({ id: "attachment-2", name: "固件发布单.pdf" });
  });

  it("normalizes an uploaded PDF blob with an imprecise Windows MIME type", () => {
    const source = new Blob(["%PDF-1.7"], { type: "application/octet-stream" });
    const normalized = pdfPreviewBlob(source, "固件发布单.pdf");

    expect(normalized.type).toBe("application/pdf");
    expect(normalized.size).toBe(source.size);
  });

  it("treats every single-file field as replacement instead of rejecting another upload", () => {
    expect(shouldReplaceUploadedAttachment(false, 1)).toBe(true);
    expect(shouldReplaceUploadedAttachment(true, 20)).toBe(true);
    expect(shouldReplaceUploadedAttachment(false, 2)).toBe(false);
  });

  it("reads current attachment names from locked-version form fields for printing", () => {
    expect(resolveRuntimeAttachmentNames({
      fields: [{ id: "report-file", type: "attachment" }, { id: "title", type: "text" }],
      values: { "report-file": [{ id: "attachment-2", name: "ADT测试报告-复核版.pdf" }] },
      fallbackNames: ["旧附件名称.pdf"],
    })).toEqual(["ADT测试报告-复核版.pdf"]);
  });

  it("uses legacy instance names only when the locked form has no attachment value", () => {
    expect(resolveRuntimeAttachmentNames({
      fields: [{ id: "report-file", type: "attachment" }],
      values: {},
      fallbackNames: ["历史测试报告.pdf", "无附件"],
    })).toEqual(["历史测试报告.pdf"]);
    expect(resolveRuntimeAttachmentNames({
      fields: [{ id: "title", type: "text" }],
      values: {},
      fallbackNames: ["不应显示.pdf"],
    })).toEqual([]);
  });
});
