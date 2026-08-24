// @vitest-environment jsdom

import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertXlsxToPdf } from "./excelToPdf";

const pdfState = vi.hoisted(() => ({ constructorOptions: [] as unknown[], addedPages: [] as unknown[] }));

vi.mock("jspdf", () => ({
  jsPDF: class MockJsPdf {
    internal = { pageSize: { getWidth: () => 842, getHeight: () => 595 } };
    constructor(options: unknown) {
      pdfState.constructorOptions.push(options);
    }
    addPage(...args: unknown[]) {
      pdfState.addedPages.push(args);
    }
    addImage() {}
    output() {
      return new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" });
    }
  },
}));

const fillText = vi.fn();
const drawingContext = {
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
  font: "",
  textBaseline: "middle",
  textAlign: "left",
  fillRect: () => undefined,
  strokeRect: () => undefined,
  fillText,
  measureText: (text: string) => ({ width: text.length * 12 }),
  save: () => undefined,
  beginPath: () => undefined,
  rect: () => undefined,
  clip: () => undefined,
  restore: () => undefined,
  scale: () => undefined,
  setLineDash: () => undefined,
  moveTo: () => undefined,
  lineTo: () => undefined,
  stroke: () => undefined,
  translate: () => undefined,
  rotate: () => undefined,
  drawImage: () => undefined,
} as unknown as CanvasRenderingContext2D;

describe("浏览器 Excel 转 PDF", () => {
  beforeEach(() => {
    pdfState.constructorOptions.length = 0;
    pdfState.addedPages.length = 0;
    fillText.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(drawingContext);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AA==");
  });

  afterEach(() => vi.restoreAllMocks());

  it("读取 xlsx、限制输出页数并只生成 PDF 文件", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("发布清单");
    worksheet.addRow(["编号", "标题", "状态"]);
    Array.from({ length: 80 }, (_, index) => worksheet.addRow([index + 1, `发布项目 ${index + 1}`, "待审核"]));
    const source = new File([await workbook.xlsx.writeBuffer()], "软件发布单.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await convertXlsxToPdf(source, 1);

    expect(result.file.name).toBe("软件发布单.pdf");
    expect(result.file.type).toBe("application/pdf");
    expect(result.generatedPages).toBe(1);
    expect(result.worksheetCount).toBe(1);
    expect(pdfState.addedPages).toHaveLength(0);
  });

  it("拒绝旧式 xls 文件", async () => {
    await expect(convertXlsxToPdf(new File(["xls"], "旧格式.xls"), 1)).rejects.toThrow("仅支持转换 .xlsx");
  });

  it("拒绝通过打印区域声明的异常超大工作表", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("异常打印区域");
    worksheet.getCell("A1").value = "内容";
    worksheet.pageSetup.printArea = "A1:Z10000";
    const source = new File([await workbook.xlsx.writeBuffer()], "异常打印区域.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await expect(convertXlsxToPdf(source, 1)).rejects.toThrow("Excel 内容过大");
  });

  it("采用工作表打印设置，并只绘制合并区域主单元格的富文本", async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Summary", {
      pageSetup: {
        orientation: "portrait",
        paperSize: 9,
        printArea: "A1:G12",
        scale: 72,
        horizontalCentered: true,
      },
    });
    worksheet.mergeCells("B2:D4");
    worksheet.getCell("B2").value = { richText: [{ text: "第一行" }, { text: "\n第二行" }] };
    worksheet.getCell("B2").alignment = { vertical: "top", wrapText: true };
    const source = new File([await workbook.xlsx.writeBuffer()], "打印设置.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await convertXlsxToPdf(source, 1);

    expect(result.generatedPages).toBe(1);
    expect(pdfState.constructorOptions[0]).toMatchObject({ orientation: "portrait", format: [595.28, 841.89] });
    expect(fillText.mock.calls.filter(([text]) => text === "第一行")).toHaveLength(1);
    expect(fillText.mock.calls.flat().some((value) => value === "[object Object]")).toBe(false);
  });
});
