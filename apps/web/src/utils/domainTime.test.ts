import { describe, expect, it } from "vitest";
import { compareDomainTimestamps, formatDomainTimestamp } from "./domainTime";

describe("领域时间", () => {
  it("uses a fixed-width sortable display format", () => {
    expect(formatDomainTimestamp(new Date(2026, 8, 2, 3, 4, 5))).toBe("2026-09-02 03:04:05");
  });

  it("sorts legacy and normalized timestamps correctly across months", () => {
    expect(compareDomainTimestamps("2026/10/1 08:00", "2026/9/30 18:00")).toBeGreaterThan(0);
  });
});
