import { describe, expect, it } from "vitest";
import { formatInstanceNumber } from "./instanceNumber";

describe("formatInstanceNumber", () => {
  it("formats only a preview and does not allocate a browser-side sequence", () => {
    expect(formatInstanceNumber("DOC", 7, new Date(2026, 8, 1))).toBe("DOC26090007");
  });
});
