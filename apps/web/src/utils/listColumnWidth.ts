import type { StoredDesignerField } from "./designerStorage";

interface WidthRule {
  base: number;
  min: number;
  max: number;
}

const businessWidthRules: Record<string, WidthRule> = {
  text: { base: 180, min: 150, max: 280 },
  select: { base: 140, min: 120, max: 210 },
  cascader: { base: 190, min: 160, max: 280 },
  radio: { base: 140, min: 120, max: 210 },
  checkbox: { base: 170, min: 140, max: 250 },
  attachment: { base: 210, min: 180, max: 300 },
  table: { base: 140, min: 120, max: 190 },
};

const systemWidthRules: Record<string, WidthRule> = {
  code: { base: 176, min: 160, max: 220 },
  title: { base: 320, min: 260, max: 380 },
  template: { base: 180, min: 150, max: 240 },
  templateVersion: { base: 92, min: 82, max: 120 },
  status: { base: 112, min: 100, max: 140 },
  currentNode: { base: 190, min: 160, max: 250 },
  round: { base: 100, min: 90, max: 130 },
  initiator: { base: 128, min: 108, max: 180 },
  createdAt: { base: 154, min: 145, max: 190 },
  updatedAt: { base: 154, min: 145, max: 190 },
  taskOwner: { base: 150, min: 130, max: 210 },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const estimateHeaderWidth = (label: string) => {
  const units = Array.from(label.trim()).reduce((total, character) =>
    total + (/^[\u0000-\u00ff]$/.test(character) ? 0.62 : 1), 0);
  return Math.ceil(units * 15 + 48);
};

const resolveWidth = (label: string, rule: WidthRule) =>
  clamp(Math.max(rule.base, estimateHeaderWidth(label)), rule.min, rule.max);

export const getBusinessListColumnWidth = (field: Pick<StoredDesignerField, "label" | "type">) =>
  resolveWidth(field.label, businessWidthRules[field.type] ?? { base: 160, min: 130, max: 240 });

export const getSystemListColumnWidth = (key: string, label: string) =>
  resolveWidth(label, systemWidthRules[key] ?? { base: 150, min: 120, max: 220 });
