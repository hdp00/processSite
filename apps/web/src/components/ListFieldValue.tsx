import { FileOutlined, TableOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import type { StoredDesignerField } from "../utils/designerStorage";
import { displayDesignerChoiceValue } from "../utils/designerOptions";

interface ListFieldValueProps {
  field: StoredDesignerField;
  value: unknown;
}

const isEmptyValue = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export function ListFieldValue({ field, value: rawValue }: ListFieldValueProps) {
  // 列配置来自当前发布版本；历史实例没有该字段时必须保持为空，
  // 不能把当前版本的默认值伪装成历史业务数据。
  const value = rawValue;

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
      const text = displayDesignerChoiceValue(field.options, value, { hierarchical: true, omitUnknown: true });
      return text
        ? <span className="list-field-value" title={text}>{text}</span>
        : <span className="list-field-value is-empty">—</span>;
    }
    if (field.type === "checkbox") {
      const labels = value.map((item) => displayDesignerChoiceValue(field.options, item, { omitUnknown: true })).filter(Boolean);
      if (!labels.length) return <span className="list-field-value is-empty">—</span>;
      return (
        <div className="list-field-options">
          {labels.slice(0, 2).map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
          {labels.length > 2 ? <small>+{labels.length - 2}</small> : null}
        </div>
      );
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
    const label = displayDesignerChoiceValue(field.options, text, { omitUnknown: true });
    return label
      ? <span className="list-field-choice" title={label}>{label}</span>
      : <span className="list-field-value is-empty">—</span>;
  }
  return <span className="list-field-value" title={text}>{text}</span>;
}
