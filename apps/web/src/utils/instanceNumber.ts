const SEQUENCE_STORAGE_PREFIX = "flowpilot-instance-sequence-v1:";

const periodText = (date: Date) => {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
};

const sequenceStorageKey = (prefix: string, period: string) =>
  `${SEQUENCE_STORAGE_PREFIX}${encodeURIComponent(prefix)}:${period}`;

const maxExistingSequence = (prefix: string, period: string, existingCodes: string[]) => {
  const head = `${prefix}${period}`;
  return Math.max(
    0,
    ...existingCodes
      .filter((code) => code.startsWith(head) && code.length === head.length + 4)
      .map((code) => Number(code.slice(-4)))
      .filter(Number.isFinite),
  );
};

const storedSequence = (prefix: string, period: string) => {
  if (typeof window === "undefined") return 0;
  return Number(window.localStorage.getItem(sequenceStorageKey(prefix, period)) ?? 0) || 0;
};

export const formatInstanceNumber = (prefix: string, sequence: number, date = new Date()) =>
  `${prefix.trim()}${periodText(date)}${String(sequence).padStart(4, "0")}`;

export const previewNextInstanceNumber = (
  prefix: string,
  existingCodes: string[] = [],
  date = new Date(),
) => {
  const normalizedPrefix = prefix.trim();
  const period = periodText(date);
  const sequence = Math.max(
    storedSequence(normalizedPrefix, period),
    maxExistingSequence(normalizedPrefix, period, existingCodes),
  ) + 1;
  return formatInstanceNumber(normalizedPrefix, sequence, date);
};

export const issueNextInstanceNumber = (
  prefix: string,
  existingCodes: string[] = [],
  date = new Date(),
) => {
  const normalizedPrefix = prefix.trim();
  const period = periodText(date);
  const nextSequence = Math.max(
    storedSequence(normalizedPrefix, period),
    maxExistingSequence(normalizedPrefix, period, existingCodes),
  ) + 1;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(sequenceStorageKey(normalizedPrefix, period), String(nextSequence));
  }
  return formatInstanceNumber(normalizedPrefix, nextSequence, date);
};

export const extractInstancePrefix = (code: string) => {
  const suffix = code.slice(-8);
  if (!/^\d{8}$/.test(suffix)) return undefined;
  const month = Number(suffix.slice(2, 4));
  return month >= 1 && month <= 12 ? code.slice(0, -8) || undefined : undefined;
};

export const normalizeLegacyInstanceNumber = (code: string) => {
  const legacy = /^(PDF|TR|ISSUE)-(\d{4})(\d{2})-(\d{4})$/.exec(code);
  if (!legacy) return code;
  const [, legacyPrefix, year, month, sequence] = legacy;
  const prefix = legacyPrefix === "PDF" || legacyPrefix === "TR" ? "DOC" : legacyPrefix;
  return `${prefix}${year.slice(-2)}${month}${sequence}`;
};

export const resetInstanceNumberSequences = () => {
  if (typeof window === "undefined") return;
  Object.keys(window.localStorage)
    .filter((key) => key.startsWith(SEQUENCE_STORAGE_PREFIX))
    .forEach((key) => window.localStorage.removeItem(key));
};
