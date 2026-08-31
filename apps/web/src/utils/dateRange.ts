import dayjs, { type Dayjs } from "dayjs";

export type RequiredDateRange = [Dayjs, Dayjs];

export const createDefaultDateRange = (): RequiredDateRange => [
  dayjs().subtract(30, "day").startOf("day"),
  dayjs().endOf("day"),
];

export const normalizeDayRange = (range: RequiredDateRange): RequiredDateRange => [
  range[0].startOf("day"),
  range[1].endOf("day"),
];

export const formatDateOnlyQuery = (value: Dayjs) => value.format("YYYY-MM-DD");

export const isDateTimeInRange = (value: string, range: RequiredDateRange) => {
  const parsed = dayjs(value);
  if (!parsed.isValid()) return false;
  const timestamp = parsed.valueOf();
  return timestamp >= range[0].valueOf() && timestamp <= range[1].valueOf();
};
