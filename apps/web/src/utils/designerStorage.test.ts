import { describe, expect, it } from "vitest";
import {
  applyDesignerFieldVisibility,
  ensureProcessTitleField,
  isDesignerFieldVisible,
  normalizeStoredCondition,
  type StoredDesignerField,
} from "./designerStorage";

const field = (value: Partial<StoredDesignerField> & Pick<StoredDesignerField, "id" | "type" | "label">): StoredDesignerField => value;

describe("表单字段条件显示", () => {
  it("always restores the fixed title query capability from legacy snapshots", () => {
    const [title] = ensureProcessTitleField([
      field({ id: "title", type: "text", label: "标题", queryable: false }),
    ]);

    expect(title.queryable).toBe(true);
  });

  it("supports option, text and checkbox comparisons", () => {
    const dependent = field({
      id: "field-b",
      type: "text",
      label: "字段 B",
      displayCondition: {
        mode: "all",
        rules: [
          { id: "rule-1", fieldId: "field-a", operator: "eq", value: "需要" },
          { id: "rule-2", fieldId: "departments", operator: "contains", value: "生产" },
        ],
      },
    });

    expect(isDesignerFieldVisible(dependent, { "field-a": "需要", departments: ["研发", "生产"] })).toBe(true);
    expect(isDesignerFieldVisible(dependent, { "field-a": "不需要", departments: ["研发", "生产"] })).toBe(false);
  });

  it("clears hidden values in form order so hidden fields cannot drive later conditions", () => {
    const fields: StoredDesignerField[] = [
      field({ id: "field-a", type: "select", label: "字段 A" }),
      field({
        id: "field-b",
        type: "text",
        label: "字段 B",
        displayCondition: { mode: "all", rules: [{ id: "rule-b", fieldId: "field-a", operator: "eq", value: "显示" }] },
      }),
      field({
        id: "field-c",
        type: "text",
        label: "字段 C",
        displayCondition: { mode: "all", rules: [{ id: "rule-c", fieldId: "field-b", operator: "not-empty" }] },
      }),
    ];

    expect(applyDesignerFieldVisibility(fields, {
      "field-a": "隐藏",
      "field-b": "旧值",
      "field-c": "不应保留",
    })).toEqual({
      "field-a": "隐藏",
      "field-b": "",
      "field-c": "",
    });
  });

  it("normalizes legacy or incomplete condition snapshots without crashing", () => {
    expect(normalizeStoredCondition({ mode: "all", rules: undefined } as never)).toEqual({ mode: "all", rules: [] });
    expect(normalizeStoredCondition(undefined)).toBeUndefined();
  });
});
