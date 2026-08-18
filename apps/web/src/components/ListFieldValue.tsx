import { FileOutlined, TableOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import type { StoredDesignerField } from "../utils/designerStorage";

interface ListFieldValueProps {
  field: StoredDesignerField;
  value: unknown;
}

const isEmptyValue = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export function ListFieldValue({ field, value: rawValue }: ListFieldValueProps) {
  const value = isEmptyValue(rawValue) ? field.defaultValue ?? rawValue : rawValue;

  if (isEmptyValue(value)) {
    return <span className="list-field-value is-empty">—</span>;
  }

  if (field.type === "table") {
    const rowCount = Array.isArray(value) ? value.length : 0;
    return (
      <span className="list-field-summary">
        <TableOutlined />
        {rowCount ? `${rowCount} 行数据` : "已填写"}
      </span>
    );
  }

  if (field.type === "attachment") {
    const names = Array.isArray(value)
      ? value.map((item) => typeof item === "string" ? item : String((item as { name?: string })?.name ?? "")).filter(Boolean)
      : [String(value)];
    const display = names[0] ?? "已上传";
    return (
      <Tooltip title={names.join("、")}>
        <span className="list-field-summary is-attachment">
          <FileOutlined />
          <span>{display}</span>
          {names.length > 1 ? <small>+{names.length - 1}</small> : null}
        </span>
      </Tooltip>
    );
  }

  if (Array.isArray(value)) {
    if (field.type === "cascader") {
      const text = value.map(String).join(" / ");
      return <span className="list-field-value" title={text}>{text}</span>;
    }
    return (
      <div className="list-field-options">
        {value.slice(0, 2).map((item, index) => <span key={`${String(item)}-${index}`}>{String(item)}</span>)}
        {value.length > 2 ? <small>+{value.length - 2}</small> : null}
      </div>
    );
  }

  if (typeof value === "object") {
    return <span className="list-field-summary">已填写</span>;
  }

  const text = String(value);
  if (field.type === "select" || field.type === "radio") {
    return <span className="list-field-choice" title={text}>{text}</span>;
  }
  return <span className="list-field-value" title={text}>{text}</span>;
}
