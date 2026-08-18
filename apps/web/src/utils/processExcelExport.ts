import type { SystemListFieldConfig, SystemListFieldKey } from "../data/listFieldConfig";
import type { ProcessInstance } from "../data/types";
import type { StoredDesignerField } from "./designerStorage";

export interface ProcessExcelExportOptions {
  definitionName: string;
  systemFields: SystemListFieldConfig[];
  formFields: StoredDesignerField[];
  instances: ProcessInstance[];
}

interface ExportColumn {
  key: string;
  label: string;
  value: (instance: ProcessInstance) => unknown;
}

type ExportableDesignerField = StoredDesignerField & { exportVisible?: boolean };

const escapeXml = (value: unknown) => String(value ?? "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

const plainText = (value: string) => {
  if (typeof document === "undefined") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
};

const scalarText = (value: unknown): string | number => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => scalarText(item)).filter((item) => item !== "").join("、");
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
  if (!Array.isArray(value) || !value.length) return "";
  const columns = field.columns ?? [];
  return value.map((row, index) => {
    if (!row || typeof row !== "object") return String(scalarText(row));
    const values = row as Record<string, unknown>;
    const content = columns.length
      ? columns.map((column) => `${column.label}：${scalarText(values[column.id])}`).join("；")
      : Object.entries(values).map(([key, item]) => `${key}：${scalarText(item)}`).join("；");
    return `第 ${index + 1} 行：${content}`;
  }).join("\n");
};

const formFieldValue = (instance: ProcessInstance, field: StoredDesignerField) => {
  if (!Object.prototype.hasOwnProperty.call(instance.formValues ?? {}, field.id)) return "";
  const value = instance.formValues?.[field.id];
  if (field.type === "table") return tableText(value, field);
  if (field.type === "richtext" && typeof value === "string") return plainText(value);
  return scalarText(value);
};

const systemFieldValue = (key: SystemListFieldKey, instance: ProcessInstance): string | number => {
  switch (key) {
    case "code": return instance.code;
    case "template": return instance.template;
    case "templateVersion": return instance.templateVersion;
    case "status": return instance.status;
    case "currentNode":
      return instance.workflowType === "free"
        ? (instance.status === "进行中" ? instance.currentAssignee ?? "" : "")
        : instance.currentNode;
    case "round": return instance.round;
    case "initiator": return instance.department ? `${instance.initiator}（${instance.department}）` : instance.initiator;
    case "createdAt": return instance.createdAt;
    case "updatedAt": return instance.updatedAt;
  }
};

const buildExportColumns = (systemFields: SystemListFieldConfig[], formFields: StoredDesignerField[]): ExportColumn[] => [
  ...systemFields
    .filter((field) => field.exportVisible ?? field.processListVisible)
    .map((field) => ({
      key: `system-${field.key}`,
      label: field.label,
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
      value: (instance: ProcessInstance) => formFieldValue(instance, field),
    })),
];

const cellXml = (value: unknown, styleId = "Text") => {
  const normalized = scalarText(value);
  const type = typeof normalized === "number" ? "Number" : "String";
  return `<Cell ss:StyleID="${styleId}"><Data ss:Type="${type}">${escapeXml(normalized)}</Data></Cell>`;
};

const workbookXml = (columns: ExportColumn[], instances: ProcessInstance[]) => {
  const columnDefinitions = columns.map((column) => {
    const width = Math.min(260, Math.max(90, Array.from(column.label).length * 16));
    return `<Column ss:AutoFitWidth="0" ss:Width="${width}"/>`;
  }).join("");
  const header = `<Row ss:StyleID="Header">${columns.map((column) => cellXml(column.label, "Header")).join("")}</Row>`;
  const rows = instances.map((instance) => `<Row>${columns.map((column) => cellXml(column.value(instance))).join("")}</Row>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Author>流程审核平台</Author><Created>${new Date().toISOString()}</Created></DocumentProperties>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Microsoft YaHei" ss:Size="10"/></Style>
  <Style ss:ID="Header"><Alignment ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Microsoft YaHei" ss:Size="10" ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Text"><Alignment ss:Vertical="Top" ss:WrapText="1"/><Font ss:FontName="Microsoft YaHei" ss:Size="10"/></Style>
 </Styles>
 <Worksheet ss:Name="流程清单">
  <Table>${columnDefinitions}${header}${rows}</Table>
  <AutoFilter x:Range="R1C1:R${instances.length + 1}C${columns.length}" xmlns="urn:schemas-microsoft-com:office:excel"/>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
 </Worksheet>
</Workbook>`;
};

const timestampText = () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

export const processExportColumnCount = (systemFields: SystemListFieldConfig[], formFields: StoredDesignerField[]) =>
  buildExportColumns(systemFields, formFields).length;

export const createProcessListExcelFile = ({ definitionName, systemFields, formFields, instances }: ProcessExcelExportOptions) => {
  const columns = buildExportColumns(systemFields, formFields);
  if (!columns.length) return null;

  const xml = workbookXml(columns, instances);
  const blob = new Blob(["\uFEFF", xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const safeName = definitionName.trim().replace(/[\\/:*?"<>|]/g, "_") || "流程清单";
  return { blob, fileName: `${safeName}_查询结果_${timestampText()}.xls` };
};

export const downloadProcessListExcel = (options: ProcessExcelExportOptions) => {
  const file = createProcessListExcelFile(options);
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
