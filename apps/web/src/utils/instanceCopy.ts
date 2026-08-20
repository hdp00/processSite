import { normalizeDesignerFieldValue, type StoredDesignerField, type StoredDesignerTableColumn } from "./designerStorage";
import { PROCESS_TITLE_FIELD_ID } from "./designerStorage";
import { flattenDesignerChoiceOptions, normalizeDesignerChoiceValue } from "./designerOptions";

const cloneValue = <T,>(value: T): T => structuredClone(value);

const defaultColumnValue = (column: StoredDesignerTableColumn) =>
  cloneValue(column.defaultValue ?? (column.type === "checkbox" ? [] : ""));

const defaultFieldValue = (field: StoredDesignerField): unknown => {
  if (field.type === "attachment") return [];
  if (field.type === "checkbox") return cloneValue(field.defaultValue ?? []);
  if (field.type === "table") {
    return [{
      key: "copy-row-0",
      ...Object.fromEntries((field.columns ?? []).map((column) => [column.id, defaultColumnValue(column)])),
    }];
  }
  return cloneValue(field.defaultValue ?? "");
};

const copiedChoiceValue = (field: StoredDesignerField, value: unknown) => {
  const normalized = normalizeDesignerFieldValue(field, value);
  const validIds = new Set(flattenDesignerChoiceOptions(field.options).map((option) => option.id));
  if (field.type === "checkbox") return Array.isArray(normalized) ? normalized.filter((item) => validIds.has(String(item))) : [];
  if (field.type === "cascader") return Array.isArray(normalized) && normalized.every((item) => validIds.has(String(item)))
    ? normalized
    : defaultFieldValue(field);
  return typeof normalized === "string" && validIds.has(normalized) ? normalized : defaultFieldValue(field);
};

const copiedColumnValue = (column: StoredDesignerTableColumn, value: unknown) => {
  if (!column.type || column.type === "text") return cloneValue(value);
  const validIds = new Set(flattenDesignerChoiceOptions(column.options).map((option) => option.id));
  const normalized = normalizeDesignerChoiceValue(column.options, value, { multiple: column.type === "checkbox" });
  if (column.type === "checkbox") return Array.isArray(normalized) ? normalized.filter((item) => validIds.has(String(item))) : [];
  return typeof normalized === "string" && validIds.has(normalized) ? normalized : defaultColumnValue(column);
};

const copyTableValue = (
  targetField: StoredDesignerField,
  sourceField: StoredDesignerField,
  sourceValue: unknown,
) => {
  if (!Array.isArray(sourceValue) || sourceValue.length === 0) return defaultFieldValue(targetField);
  const sourceColumns = new Map((sourceField.columns ?? []).map((column) => [column.id, column]));
  return sourceValue.map((sourceRow, rowIndex) => {
    const row = sourceRow && typeof sourceRow === "object" ? sourceRow as Record<string, unknown> : {};
    return {
      key: `copy-row-${rowIndex}`,
      ...Object.fromEntries((targetField.columns ?? []).map((targetColumn) => {
        const sourceColumn = sourceColumns.get(targetColumn.id);
        const sourceCell = row[targetColumn.id];
        return [
          targetColumn.id,
          sourceColumn?.type === targetColumn.type && sourceCell !== undefined
            ? copiedColumnValue(targetColumn, sourceCell)
            : defaultColumnValue(targetColumn),
        ];
      })),
    };
  });
};

export const buildCopiedInstanceInitialValues = (
  targetFields: StoredDesignerField[],
  sourceFields: StoredDesignerField[],
  sourceValues: Record<string, unknown>,
  sourceTitle: string,
) => {
  const sourceFieldMap = new Map(sourceFields.map((field) => [field.id, field]));
  return Object.fromEntries(targetFields.map((targetField) => {
    if (targetField.type === "attachment") return [targetField.id, []];
    const sourceField = sourceFieldMap.get(targetField.id);
    if (!sourceField || sourceField.type !== targetField.type) {
      return [targetField.id, defaultFieldValue(targetField)];
    }
    if (targetField.id === PROCESS_TITLE_FIELD_ID) {
      return [targetField.id, `${sourceTitle}（复制）`];
    }
    if (targetField.type === "table") {
      return [targetField.id, copyTableValue(targetField, sourceField, sourceValues[targetField.id])];
    }
    const sourceValue = sourceValues[targetField.id];
    if (["select", "radio", "checkbox", "cascader"].includes(targetField.type)) {
      return [targetField.id, sourceValue === undefined ? defaultFieldValue(targetField) : copiedChoiceValue(targetField, sourceValue)];
    }
    return [targetField.id, sourceValue === undefined ? defaultFieldValue(targetField) : cloneValue(sourceValue)];
  }));
};
