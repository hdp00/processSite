// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  extractInstancePrefix,
  formatInstanceNumber,
  issueNextInstanceNumber,
  normalizeLegacyInstanceNumber,
  previewNextInstanceNumber,
  resetInstanceNumberSequences,
} from "./instanceNumber";

describe("实例编号", () => {
  const date = new Date(2026, 7, 31, 10, 0, 0);

  beforeEach(() => window.localStorage.clear());

  it("按前缀、年月和四位序号格式化并从已有最大值继续", () => {
    expect(formatInstanceNumber(" DOC ", 7, date)).toBe("DOC26080007");
    expect(previewNextInstanceNumber("DOC", ["DOC26080003", "DOC26080009", "OTHER26089999"], date))
      .toBe("DOC26080010");
  });

  it("预览不占号，正式取号持久化并可定向重置", () => {
    expect(previewNextInstanceNumber("A/B", [], date)).toBe("A/B26080001");
    expect(previewNextInstanceNumber("A/B", [], date)).toBe("A/B26080001");
    expect(issueNextInstanceNumber("A/B", [], date)).toBe("A/B26080001");
    expect(issueNextInstanceNumber("A/B", [], date)).toBe("A/B26080002");
    window.localStorage.setItem("unrelated", "keep");

    resetInstanceNumberSequences();

    expect(issueNextInstanceNumber("A/B", [], date)).toBe("A/B26080001");
    expect(window.localStorage.getItem("unrelated")).toBe("keep");
  });

  it("解析合法前缀并兼容旧编号格式", () => {
    expect(extractInstancePrefix("DOC26080001")).toBe("DOC");
    expect(extractInstancePrefix("26080001")).toBeUndefined();
    expect(extractInstancePrefix("DOC26130001")).toBeUndefined();
    expect(extractInstancePrefix("DOC-invalid")).toBeUndefined();
    expect(normalizeLegacyInstanceNumber("PDF-202608-0012")).toBe("DOC26080012");
    expect(normalizeLegacyInstanceNumber("TR-202608-0013")).toBe("DOC26080013");
    expect(normalizeLegacyInstanceNumber("ISSUE-202608-0014")).toBe("ISSUE26080014");
    expect(normalizeLegacyInstanceNumber("CURRENT26080015")).toBe("CURRENT26080015");
  });
});
