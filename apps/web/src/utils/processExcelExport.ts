import type { ProcessExcelDataset, ProcessExcelDatasetColumn } from "../api/contracts";
import type { SystemListFieldConfig, SystemListFieldKey } from "../data/listFieldConfig";
import type { ProcessInstance } from "../data/types";
import type { StoredDesignerField } from "./designerStorage";

export interface ProcessExcelDatasetOptions {
  definitionId: string;
  definitionName: string;
  versionId: string;
  versionLabel: string;
  systemFields: SystemListFieldConfig[];
  formFields: StoredDesignerField[];
  instances: ProcessInstance[];
}

interface ExportColumn extends ProcessExcelDatasetColumn {
  value: (instance: ProcessInstance) => string | number | boolean | null;
}

type ExportableDesignerField = StoredDesignerField & { exportVisible?: boolean };

const plainText = (value: string) => {
  if (typeof document === "undefined") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
};

const scalarValue = (value: unknown): string | number | boolean | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => scalarValue(item)).filter((item) => item !== null);
    return items.join("、");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const tableText = (value: unknown, field: StoredDesignerField) => {
  if (!Array.isArray(value) || !value.length) return null;
  const columns = field.columns ?? [];
  return value.map((row, index) => {
    if (!row || typeof row !== "object") return String(scalarValue(row) ?? "");
    const values = row as Record<string, unknown>;
    const content = columns.length
      ? columns.map((column) => `${column.label}：${scalarValue(values[column.id]) ?? ""}`).join("；")
      : Object.entries(values).map(([key, item]) => `${key}：${scalarValue(item) ?? ""}`).join("；");
    return `第 ${index + 1} 行：${content}`;
  }).join("\n");
};

const formFieldValue = (instance: ProcessInstance, field: StoredDesignerField) => {
  if (!Object.prototype.hasOwnProperty.call(instance.formValues ?? {}, field.id)) return null;
  const value = instance.formValues?.[field.id];
  if (field.type === "table") return tableText(value, field);
  if (field.type === "richtext" && typeof value === "string") return plainText(value);
  return scalarValue(value);
};

const systemFieldValue = (key: SystemListFieldKey, instance: ProcessInstance): string | number | null => {
  switch (key) {
    case "code": return instance.code;
    case "template": return instance.template;
    case "templateVersion": return instance.templateVersion;
    case "status": return instance.status;
    case "currentNode":
      return instance.workflowType === "free"
        ? (instance.status === "进行中" ? instance.currentAssignee ?? null : null)
        : instance.currentNode;
    case "round": return instance.round;
    case "initiator": return instance.department ? `${instance.initiator}（${instance.department}）` : instance.initiator;
    case "createdAt": return instance.createdAt;
    case "updatedAt": return instance.updatedAt;
  }
};

const systemDataType = (key: SystemListFieldKey): ProcessExcelDatasetColumn["dataType"] => {
  if (key === "round") return "number";
  if (key === "createdAt" || key === "updatedAt") return "date";
  return "text";
};

const buildExportColumns = (systemFields: SystemListFieldConfig[], formFields: StoredDesignerField[]): ExportColumn[] => [
  ...systemFields
    .filter((field) => field.exportVisible ?? field.processListVisible)
    .map((field) => ({
      key: `system-${field.key}`,
      label: field.label,
      dataType: systemDataType(field.key),
      value: (instance: ProcessInstance) => systemFieldValue(field.key, instance),
    })),
  ...formFields
    .filter((field) => {
      const exportable = field as ExportableDesignerField;
      return exportable.exportVisible ?? field.listVisible ?? false;
    })
    .map((field) => ({
      key: `form-${field.id}`,
      label: field.label,
      dataType: "text" as const,
      value: (instance: ProcessInstance) => formFieldValue(instance, field),
    })),
];

export const buildProcessExcelDataset = ({
  definitionId,
  definitionName,
  versionId,
  versionLabel,
  systemFields,
  formFields,
  instances,
}: ProcessExcelDatasetOptions): ProcessExcelDataset => {
  const exportColumns = buildExportColumns(systemFields, formFields);
  return {
    definitionId,
    definitionName,
    versionId,
    versionLabel,
    generatedAt: new Date().toISOString(),
    rowCount: instances.length,
    columns: exportColumns.map(({ key, label, dataType }) => ({ key, label, dataType })),
    rows: instances.map((instance) => exportColumns.map((column) => column.value(instance))),
  };
};

const timestampText = (date = new Date()) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const safeFileName = (value: string) => value.trim().replace(/[\\/:*?"<>|]/g, "_") || "流程清单";

const parseExcelDate = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return value;
  const normalized = value.replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : value;
};

export const createProcessListXlsxFile = async (dataset: ProcessExcelDataset) => {
  if (!dataset.columns.length) return null;
  const excelJsModule = await import("exceljs");
  const WorkbookConstructor = excelJsModule.Workbook ?? excelJsModule.default.Workbook;
  const workbook = new WorkbookConstructor();
  workbook.creator = "流程审核平台";
  workbook.created = new Date(dataset.generatedAt);
  const worksheet = workbook.addWorksheet("流程清单", {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { defaultRowHeight: 22 },
  });

  worksheet.columns = dataset.columns.map((column) => ({
    key: column.key,
    width: Math.min(42, Math.max(12, Array.from(column.label).length * 2 + 4)),
  }));
  const headerRow = worksheet.addRow(dataset.columns.map((column) => column.label));
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { name: "Microsoft YaHei", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1677FF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFB7C9E2" } },
      left: { style: "thin", color: { argb: "FFB7C9E2" } },
      bottom: { style: "thin", color: { argb: "FFB7C9E2" } },
      right: { style: "thin", color: { argb: "FFB7C9E2" } },
    };
  });

  dataset.rows.forEach((sourceRow) => {
    const row = worksheet.addRow(sourceRow.map((value, index) =>
      dataset.columns[index]?.dataType === "date" ? parseExcelDate(value) : value,
    ));
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { name: "Microsoft YaHei", size: 10 };
    row.eachCell((cell, index) => {
      if (dataset.columns[index - 1]?.dataType === "date" && cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm";
    });
  });

  if (dataset.rows.length) worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: dataset.rows.length + 1, column: dataset.columns.length } };
  const output = await workbook.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(output)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { blob, fileName: `${safeFileName(dataset.definitionName)}_查询结果_${timestampText()}.xlsx` };
};

export const downloadProcessListXlsx = async (dataset: ProcessExcelDataset) => {
  const file = await createProcessListXlsxFile(dataset);
  if (!file) return false;
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
};
