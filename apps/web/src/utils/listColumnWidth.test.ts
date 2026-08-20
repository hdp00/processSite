import { describe, expect, it } from "vitest";
import { getBusinessListColumnWidth, getSystemListColumnWidth } from "./listColumnWidth";

describe("列表自动列宽", () => {
  it("uses field type and name while keeping business columns within bounds", () => {
    const shortText = getBusinessListColumnWidth({ type: "text", label: "说明" });
    const longText = getBusinessListColumnWidth({ type: "text", label: "这是一个非常长的业务字段名称用于验证最大列宽" });
    const attachment = getBusinessListColumnWidth({ type: "attachment", label: "附件" });

    expect(shortText).toBeGreaterThanOrEqual(150);
    expect(longText).toBe(280);
    expect(attachment).toBeGreaterThan(shortText);
  });

  it("keeps shared system columns stable across task and process lists", () => {
    expect(getSystemListColumnWidth("code", "实例编号")).toBe(176);
    expect(getSystemListColumnWidth("status", "状态")).toBe(112);
    expect(getSystemListColumnWidth("title", "标题")).toBe(320);
  });
});
