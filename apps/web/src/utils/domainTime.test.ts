import { describe, expect, it } from "vitest";
import { compareDomainTimestamps, formatDisplayDateTime, formatDomainTimestamp } from "./domainTime";

describe("领域时间", () => {
  it("uses a fixed-width sortable display format", () => {
    expect(formatDomainTimestamp(new Date(2026, 8, 2, 3, 4, 5))).toBe("2026-09-02 03:04:05");
  });

  it("sorts legacy and normalized timestamps correctly across months", () => {
    expect(compareDomainTimestamps("2026/10/1 08:00", "2026/9/30 18:00")).toBeGreaterThan(0);
  });

  it("formats an ISO timestamp as local business text", () => {
    const isoTimestamp = "2026-08-21T06:27:07.751Z";
    expect(formatDisplayDateTime(isoTimestamp)).toBe(formatDomainTimestamp(new Date(isoTimestamp)).slice(0, 16));
    expect(formatDisplayDateTime(isoTimestamp)).not.toMatch(/[TZ]/);
    expect(formatDisplayDateTime(isoTimestamp)).not.toMatch(/ \d{2}:\d{2}:\d{2}$/);
  });

  it("keeps invalid legacy text visible and provides an empty fallback", () => {
    expect(formatDisplayDateTime("待同步")).toBe("待同步");
    expect(formatDisplayDateTime("  ")).toBe("—");
  });
});
