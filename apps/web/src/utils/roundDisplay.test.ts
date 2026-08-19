import { describe, expect, it } from "vitest";
import { formatRoundLabel, formatRoundStartLabel, prefixWithRound } from "./roundDisplay";

describe("round display", () => {
  it("hides the first round", () => {
    expect(formatRoundLabel(1)).toBe("");
    expect(prefixWithRound(1, "研发审核 · 已通过")).toBe("研发审核 · 已通过");
    expect(formatRoundStartLabel(1)).toBe("流程发起");
  });

  it("shows the second and later rounds", () => {
    expect(formatRoundLabel(2)).toBe("第 2 轮");
    expect(prefixWithRound(3, "质量审核 · 已通过")).toBe("第 3 轮 · 质量审核 · 已通过");
    expect(formatRoundStartLabel(2)).toBe("第 2 轮发起");
  });
});
