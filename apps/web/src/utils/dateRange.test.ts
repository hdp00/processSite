import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { createDefaultDateRange, formatDateOnlyQuery, isDateTimeInRange, normalizeDayRange } from "./dateRange";

describe("日期范围", () => {
  it("默认范围覆盖最近三十天并规范化到整日边界", () => {
    const [from, to] = createDefaultDateRange();

    expect(to.diff(from, "day")).toBe(30);
    expect(from.hour()).toBe(0);
    expect(to.hour()).toBe(23);

    const normalized = normalizeDayRange([
      dayjs("2026-08-01T12:30:00"),
      dayjs("2026-08-02T08:00:00"),
    ]);
    expect(normalized[0].format("YYYY-MM-DD HH:mm:ss")).toBe("2026-08-01 00:00:00");
    expect(normalized[1].format("YYYY-MM-DD HH:mm:ss")).toBe("2026-08-02 23:59:59");
  });

  it("包含起止边界并拒绝无效或范围外时间", () => {
    const range = normalizeDayRange([
      dayjs("2026-08-01"),
      dayjs("2026-08-02"),
    ]);

    expect(isDateTimeInRange("2026-08-01T00:00:00", range)).toBe(true);
    expect(isDateTimeInRange("2026-08-02T23:59:59", range)).toBe(true);
    expect(isDateTimeInRange("2026-07-31T23:59:59", range)).toBe(false);
    expect(isDateTimeInRange("not-a-date", range)).toBe(false);
  });

  it("为只接受日期的接口生成不含时间的查询参数", () => {
    expect(formatDateOnlyQuery(dayjs("2026-08-31T15:24:18+08:00"))).toBe("2026-08-31");
  });
});
