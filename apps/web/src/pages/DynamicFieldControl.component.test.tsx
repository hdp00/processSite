// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StoredDesignerField } from "../utils/designerStorage";
import { DynamicFieldControl } from "./ConfiguredProcessStartPage";

const attachmentField: StoredDesignerField = {
  id: "evidence",
  type: "attachment",
  label: "受控附件",
  attachment: {
    maxSizeMb: 25,
    maxCount: 1,
    inlinePdf: true,
    allowedExtensions: ["pdf", "xlsx"],
    excelToPdf: true,
    maxPreviewPages: 12,
  },
};

describe("动态表单附件设置", () => {
  it("启用 Excel 转 PDF 时把 xlsx 交给当前页面的转换处理器", async () => {
    const onConvertExcel = vi.fn();
    const { container } = render(
      <DynamicFieldControl field={attachmentField} onConvertExcel={onConvertExcel} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const source = new File(["xlsx"], "受控清单.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    fireEvent.change(input!, { target: { files: [source] } });

    await waitFor(() => expect(onConvertExcel).toHaveBeenCalledWith(attachmentField, source));
  });

  it("旧版 xls 不进入转换处理器", async () => {
    const onConvertExcel = vi.fn();
    const { container } = render(
      <DynamicFieldControl field={attachmentField} onConvertExcel={onConvertExcel} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

    fireEvent.change(input, { target: { files: [new File(["xls"], "旧清单.xls")] } });

    await waitFor(() => expect(onConvertExcel).not.toHaveBeenCalled());
  });
});
