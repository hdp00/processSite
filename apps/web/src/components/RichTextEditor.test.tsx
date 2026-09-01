// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flowPilotApi } from "../api/flowPilotApi";
import { RichTextEditor, sanitizeRichText } from "./RichTextEditor";

const attachmentId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeRichText", () => {
  it("keeps backend attachments and rebuilds their authenticated content URL", () => {
    const result = sanitizeRichText(
      `<p>正文</p><img data-attachment-id="${attachmentId}" src="blob:obsolete" title="示例.png">`,
    );

    expect(result).toContain(`data-attachment-id="${attachmentId}"`);
    expect(result).toContain(`/attachments/${attachmentId}/content?disposition=inline`);
    expect(result).not.toContain("blob:");
  });

  it("removes browser-only, external and malformed media sources", () => {
    const result = sanitizeRichText([
      "<p>保留文本</p>",
      "<img src=\"data:image/png;base64,AA==\">",
      "<video src=\"blob:temporary\"></video>",
      "<img src=\"https://outside.example/image.png\">",
      "<img data-attachment-id=\"not-an-id\" src=\"/api/flowpilot/v1/attachments/not-an-id/content\">",
    ].join(""));

    expect(result).toBe("<p>保留文本</p>");
  });

  it("recovers the attachment id from an existing backend content URL", () => {
    const result = sanitizeRichText(
      `<video src="/api/flowpilot/v1/attachments/${attachmentId}/content?disposition=inline"></video>`,
    );

    expect(result).toContain(`data-attachment-id="${attachmentId}"`);
    expect(result).toContain("<video");
  });

  it("uploads selected media to the backend and stores only its attachment reference", async () => {
    const onChange = vi.fn();
    const upload = vi.spyOn(flowPilotApi.attachments, "upload").mockResolvedValue({
      id: attachmentId,
      name: "pixel.png",
      size: 68,
      contentType: "image/png",
      uploadedById: "00000000-0000-4000-8000-000000000001",
      uploadedAt: "2026-09-01T00:00:00Z",
      purpose: "rich-text-media",
      lifecycle: "active",
    });
    const { container } = render(<RichTextEditor value="" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "上传图片" }));
    const input = container.querySelector<HTMLInputElement>('input[accept="image/*"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "pixel.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pixel.png", type: "image/png" }),
      { purpose: "rich-text-media" },
    ));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining(`data-attachment-id="${attachmentId}"`)));
    const storedHtml = onChange.mock.calls.at(-1)?.[0] as string;
    expect(storedHtml).toContain(`/attachments/${attachmentId}/content?disposition=inline`);
    expect(storedHtml).not.toMatch(/blob:|data:image|pixel\.png/);
  });
});
