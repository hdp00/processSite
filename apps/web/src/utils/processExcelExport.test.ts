// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { initialInstances } from "../data/mock";
import type { ProcessInstance } from "../data/types";
import type { SystemListFieldConfig } from "../data/listFieldConfig";
import type { StoredDesignerField } from "./designerStorage";
import { buildProcessExcelDataset, createProcessListXlsxFile } from "./processExcelExport";

const systemField = (key: SystemListFieldConfig["key"], label: string): SystemListFieldConfig => ({
  key,
  label,
  description: label,
  taskVisible: true,
  processListVisible: true,
  exportVisible: true,
});

const field = (
  value: Partial<StoredDesignerField> & Pick<StoredDesignerField, "id" | "type" | "label">,
): StoredDesignerField => value;

describe("流程清单 Excel 数据", () => {
  it("输出系统字段、选择项、富文本和表格的业务可读值", () => {
    const instance = {
      ...initialInstances[0],
      definitionId: "definition",
      versionId: "version",
      initiatorId: "initiator",
      workflowType: "approval",
      round: 2,
      department: "研发部",
      formValues: {
        summary: "<p>测试 <strong>内容</strong></p>",
        priorityField: "high",
        tags: ["a", "b"],
        detailTable: [{ product: "A", result: "pass" }],
      },
    } as ProcessInstance;
    const dataset = buildProcessExcelDataset({
      definitionId: "definition",
      definitionName: "导出/测试",
      versionId: "version",
      versionLabel: "V2",
      systemFields: [
        systemField("code", "编号"),
        systemField("round", "轮次"),
        systemField("initiator", "发起人"),
      ],
      formFields: [
        field({ id: "summary", type: "richtext", label: "摘要", exportVisible: true }),
        field({
          id: "priorityField",
          type: "select",
          label: "优先级",
          exportVisible: true,
          options: [{ id: "high", label: "高" }],
        }),
        field({
          id: "tags",
          type: "checkbox",
          label: "标签",
          exportVisible: true,
          options: [{ id: "a", label: "甲" }, { id: "b", label: "乙" }],
        }),
        field({
          id: "detailTable",
          type: "table",
          label: "明细",
          exportVisible: true,
          columns: [
            { id: "product", label: "产品", type: "text" },
            { id: "result", label: "结论", type: "select", options: [{ id: "pass", label: "通过" }] },
          ],
        }),
        field({ id: "hidden", type: "text", label: "隐藏", exportVisible: false }),
      ],
      instances: [instance],
    });

    expect(dataset.rowCount).toBe(1);
    expect(dataset.columns.map((column) => column.label)).toEqual([
      "编号", "轮次", "发起人", "摘要", "优先级", "标签", "明细",
    ]);
    expect(dataset.rows[0]).toEqual([
      instance.code,
      "第 2 轮",
      `${instance.initiator}（研发部）`,
      "测试 内容",
      "高",
      "甲、乙",
      "第 1 行：产品：A；结论：通过",
    ]);
  });

  it("没有列时不生成文件，有列时生成安全文件名和非空 xlsx", async () => {
    const empty = buildProcessExcelDataset({
      definitionId: "definition",
      definitionName: "空流程",
      versionId: "version",
      versionLabel: "V1",
      systemFields: [],
      formFields: [],
      instances: [],
    });
    expect(await createProcessListXlsxFile(empty)).toBeNull();

    const dataset = {
      ...empty,
      definitionName: "流程/清单:*?",
      generatedAt: "2026-08-31T00:00:00.000Z",
      rowCount: 1,
      columns: [{ key: "created", label: "创建时间", dataType: "date" as const }],
      rows: [["2026年08月31日 10:20:30"]],
    };
    const file = await createProcessListXlsxFile(dataset);

    expect(file?.fileName).toMatch(/^流程_清单____查询结果_\d{8}_\d{6}\.xlsx$/);
    expect(file?.blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(file?.blob.size).toBeGreaterThan(1000);
  });
});
