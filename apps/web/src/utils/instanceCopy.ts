import type { StoredDesignerField, StoredDesignerTableColumn } from "./designerStorage";
import { PROCESS_TITLE_FIELD_ID } from "./designerStorage";

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
            ? cloneValue(sourceCell)
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
    return [targetField.id, sourceValue === undefined ? defaultFieldValue(targetField) : cloneValue(sourceValue)];
  }));
};
