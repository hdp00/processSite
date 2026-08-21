const pad = (value: number) => String(value).padStart(2, "0");

export const formatDomainTimestamp = (date: Date) => [
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
].join(" ");

export const nowDomainTimestamp = () => formatDomainTimestamp(new Date());

export const domainTimestampEpoch = (value: string) => {
  const normalized = value
    .replace(/年|\//g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const localMatch = hasExplicitTimezone
    ? null
    : normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  const epoch = localMatch
    ? new Date(
        Number(localMatch[1]),
        Number(localMatch[2]) - 1,
        Number(localMatch[3]),
        Number(localMatch[4]),
        Number(localMatch[5]),
        Number(localMatch[6] ?? 0),
      ).getTime()
    : Date.parse(normalized);
  return Number.isFinite(epoch) ? epoch : Number.NEGATIVE_INFINITY;
};

export const formatDisplayDateTime = (value?: string, fallback = "—") => {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  const epoch = domainTimestampEpoch(normalized);
  return Number.isFinite(epoch) ? formatDomainTimestamp(new Date(epoch)).slice(0, 16) : normalized;
};

export const formatDisplayDateTimeToMinute = (value?: string, fallback = "—") =>
  formatDisplayDateTime(value, fallback);

export const compareDomainTimestamps = (left: string, right: string) =>
  domainTimestampEpoch(left) - domainTimestampEpoch(right);
