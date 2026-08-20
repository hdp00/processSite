import { describe, expect, it } from "vitest";
import { pdfPreviewBlob, resolveRuntimeAttachments } from "./attachmentDisplay";

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
});
