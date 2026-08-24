import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AppstoreOutlined,
  BarsOutlined,
  CheckCircleOutlined,
  CheckSquareOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DragOutlined,
  EditOutlined,
  EyeOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  InboxOutlined,
  PlusOutlined,
  SaveOutlined,
  SettingOutlined,
  TableOutlined,
  TagsOutlined,
  RedoOutlined,
  UndoOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Cascader,
  Checkbox,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import type { TableColumnsType, UploadFile } from "antd";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { cacheProcessVersion } from "../api/entityCache";
import { flowPilotApi } from "../api/flowPilotApi";
import {
  ProcessWizardNextButton,
  ProcessWizardPreviousButton,
} from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { RichTextEditor } from "../components/RichTextEditor";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { useUndoRedoHistory } from "../hooks/useUndoRedoHistory";
import {
  cloneDefaultSystemListFields,
  type SystemListFieldConfig,
} from "../data/listFieldConfig";
import { canEditVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  conditionOperatorLabel,
  ensureProcessTitleField,
  isDesignerFieldVisible,
  normalizeStoredCondition,
  normalizeDesignerInputPermission,
  PROCESS_TITLE_FIELD_ID,
  type ConditionOperator,
  type DesignerInputPermission,
  type StoredFieldDisplayCondition,
} from "../utils/designerStorage";
import {
  appendDesignerChoiceOption,
  createDesignerChoiceOption,
  designerChoiceOptionsToAntd,
  flattenDesignerChoiceOptions,
  normalizeDesignerChoiceOptions,
  normalizeDesignerChoiceValue,
  removeDesignerChoiceOption,
  updateDesignerChoiceOption,
  type DesignerChoiceOption,
} from "../utils/designerOptions";
import { formatDisplayDateTime } from "../utils/domainTime";
import "./form-designer.css";

const { Text, Title, Paragraph } = Typography;

type FieldType = "text" | "richtext" | "select" | "cascader" | "radio" | "checkbox" | "attachment" | "table";
type TableColumnType = "text" | "radio" | "checkbox" | "select";
type ColumnAlign = "left" | "center" | "right";

interface TableColumnConfig {
  id: string;
  label: string;
  type: TableColumnType;
  required: boolean;
  defaultValue: string | string[];
  width: number;
  align: ColumnAlign;
  reviewEditable: boolean;
  options?: DesignerChoiceOption[];
}

interface AttachmentConfig {
  maxSizeMb: number;
  maxCount: number;
  inlinePdf: boolean;
  allowedExtensions: string[];
  excelToPdf: boolean;
  maxPreviewPages: number;
}

interface DesignerField {
  id: string;
  type: FieldType;
  label: string;
  description: string;
  placeholder: string;
  multiline?: boolean;
  required: boolean;
  defaultValue: string | string[];
  listVisible: boolean;
  queryable: boolean;
  exportVisible?: boolean;
  taskVisible?: boolean;
  reviewEditable: boolean;
  inputStage: DesignerInputPermission;
  displayCondition?: StoredFieldDisplayCondition;
  options?: DesignerChoiceOption[];
  attachment?: AttachmentConfig;
  columns?: TableColumnConfig[];
}

const typeLabel: Record<FieldType, string> = {
  text: "文本框",
  richtext: "富文本编辑框",
  select: "下拉框",
  cascader: "多级下拉",
  radio: "单选框",
  checkbox: "复选框",
  attachment: "附件上传",
  table: "明细表格",
};

const typeIcon: Record<FieldType, ReactNode> = {
  text: <FileTextOutlined />,
  richtext: <EditOutlined />,
  select: <BarsOutlined />,
  cascader: <AppstoreOutlined />,
  radio: <CheckCircleOutlined />,
  checkbox: <CheckSquareOutlined />,
  attachment: <UploadOutlined />,
  table: <TableOutlined />,
};

const tableTypeLabel: Record<TableColumnType, string> = {
  text: "文本",
  radio: "单选",
  checkbox: "复选",
  select: "下拉",
};

const makeId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const displayConditionOperators = (type?: FieldType): ConditionOperator[] => type === "checkbox"
  ? ["contains", "not-contains", "empty", "not-empty"]
  : type === "text"
    ? ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not-empty"]
    : ["eq", "neq", "empty", "not-empty"];

const makeChoiceOptions = (labels: string[], scope: string, hierarchical = false) =>
  normalizeDesignerChoiceOptions(labels, scope, hierarchical);

const INITIAL_FIELDS: DesignerField[] = [
  {
    id: "field-document-name",
    type: "text",
    label: "文档名称",
    description: "请填写与正式文件一致的完整名称",
    placeholder: "",
    required: true,
    defaultValue: "MTR-320 步进电机装配作业指导书",
    listVisible: true,
    queryable: true,
    taskVisible: true,
    reviewEditable: false,
    inputStage: "initiator",
  },
  {
    id: "field-document-code",
    type: "text",
    label: "文档编号",
    description: "正式流程编号由后台生成，此处为受控文件编号",
    placeholder: "",
    required: true,
    defaultValue: "WI-MTR-320",
    listVisible: true,
    queryable: true,
    taskVisible: true,
    reviewEditable: false,
    inputStage: "initiator",
  },
  {
    id: "field-category",
    type: "cascader",
    label: "文档分类",
    description: "按公司文件体系选择所属层级",
    placeholder: "",
    required: true,
    defaultValue: ["质量体系", "作业指导书"],
    listVisible: true,
    queryable: true,
    taskVisible: true,
    reviewEditable: false,
    inputStage: "initiator",
    options: makeChoiceOptions(["质量体系/作业指导书", "质量体系/检验规范", "研发体系/设计规范", "生产体系/工艺文件"], "field-category", true),
  },
  {
    id: "field-document-level",
    type: "select",
    label: "文件级别",
    description: "质量审核节点可根据内容调整",
    placeholder: "",
    required: true,
    defaultValue: "受控文件",
    listVisible: true,
    queryable: true,
    reviewEditable: true,
    inputStage: "initiator",
    options: makeChoiceOptions(["受控文件", "内部文件", "公开文件"], "field-document-level"),
  },
  {
    id: "field-department",
    type: "checkbox",
    label: "适用部门",
    description: "可选择多个适用部门",
    placeholder: "",
    required: true,
    defaultValue: ["研发中心", "质量中心", "生产中心"],
    listVisible: false,
    queryable: true,
    reviewEditable: true,
    inputStage: "initiator",
    options: makeChoiceOptions(["研发中心", "质量中心", "生产中心", "供应链中心"], "field-departments"),
  },
  {
    id: "field-revision-type",
    type: "radio",
    label: "修订类型",
    description: "用于评估本次文件变更范围",
    placeholder: "",
    required: true,
    defaultValue: "局部修订",
    listVisible: true,
    queryable: true,
    reviewEditable: false,
    inputStage: "initiator",
    options: makeChoiceOptions(["首次发布", "局部修订", "全面修订"], "field-change-type"),
  },
  {
    id: "field-revision-note",
    type: "text",
    label: "修订说明",
    description: "概述本次修订内容，详细差异以 PDF 为准",
    placeholder: "",
    required: true,
    defaultValue: "新增扭矩复检步骤，并统一关键尺寸标注方式。",
    listVisible: false,
    queryable: false,
    reviewEditable: true,
    inputStage: "initiator",
  },
  {
    id: "field-review-checklist",
    type: "table",
    label: "审核检查清单",
    description: "发起人可增删、复制行；审核人仅能修改被授权的现有单元格",
    placeholder: "",
    required: true,
    defaultValue: "",
    listVisible: false,
    queryable: false,
    reviewEditable: true,
    inputStage: "initiator",
    columns: [
      {
        id: "col-item",
        label: "检查项目",
        type: "text",
        required: true,
        defaultValue: "关键尺寸与技术参数",
        width: 220,
        align: "left",
        reviewEditable: false,
      },
      {
        id: "col-result",
        label: "审核结论",
        type: "radio",
        required: true,
        defaultValue: "符合",
        width: 170,
        align: "center",
        reviewEditable: true,
        options: makeChoiceOptions(["符合", "不符合"], "field-change-table.rd-result"),
      },
      {
        id: "col-risk",
        label: "风险等级",
        type: "select",
        required: true,
        defaultValue: "低",
        width: 140,
        align: "center",
        reviewEditable: true,
        options: makeChoiceOptions(["低", "中", "高"], "field-change-table.quality-risk"),
      },
      {
        id: "col-corrective",
        label: "纠正措施",
        type: "checkbox",
        required: false,
        defaultValue: [],
        width: 170,
        align: "center",
        reviewEditable: true,
        options: makeChoiceOptions(["需要跟进"], "field-change-table.production-follow"),
      },
    ],
  },
  {
    id: "field-pdf",
    type: "attachment",
    label: "正式审核文件",
    description: "仅上传待审核的正式版本，PDF 将在流程详情页内嵌展示",
    placeholder: "",
    required: true,
    defaultValue: "WI-MTR-320_装配作业指导书_R07.pdf",
    listVisible: false,
    queryable: false,
    reviewEditable: false,
    inputStage: "initiator",
    attachment: { maxSizeMb: 100, maxCount: 1, inlinePdf: true, allowedExtensions: ["pdf"], excelToPdf: false, maxPreviewPages: 1 },
  },
];

const createField = (type: FieldType): DesignerField => {
  const base: DesignerField = {
    id: makeId("field"),
    type,
    label: `新建${typeLabel[type]}`,
    description: "",
    placeholder: "",
    multiline: false,
    required: false,
    defaultValue: type === "checkbox" ? [] : "",
    listVisible: false,
    queryable: false,
    taskVisible: false,
    reviewEditable: false,
    inputStage: "initiator",
  };

  if (["select", "radio", "checkbox"].includes(type)) {
    base.options = makeChoiceOptions(["选项一", "选项二", "选项三"], base.id);
  }
  if (type === "cascader") {
    base.options = makeChoiceOptions(["一级选项/二级选项 A", "一级选项/二级选项 B"], base.id, true);
    base.defaultValue = [];
  }
  if (type === "attachment") {
    base.attachment = { maxSizeMb: 100, maxCount: 1, inlinePdf: true, allowedExtensions: ["pdf"], excelToPdf: false, maxPreviewPages: 1 };
  }
  if (type === "table") {
    const conclusionColumnId = makeId("col");
    const conclusionOptions = makeChoiceOptions(["符合", "不符合"], `${base.id}.${conclusionColumnId}`);
    base.reviewEditable = false;
    base.columns = [
      {
        id: makeId("col"),
        label: "内容",
        type: "text",
        required: true,
        defaultValue: "",
        width: 200,
        align: "left",
        reviewEditable: false,
      },
      {
        id: conclusionColumnId,
        label: "结论",
        type: "select",
        required: true,
        defaultValue: conclusionOptions[0]?.id ?? "",
        width: 150,
        align: "center",
        reviewEditable: true,
        options: conclusionOptions,
      },
    ];
  }
  return base;
};

const fieldDefaultText = (field: DesignerField) =>
  typeof field.defaultValue === "string" ? field.defaultValue : undefined;

const renderTableCell = (column: TableColumnConfig, interactive: boolean, rowIndex: number) => {
  const key = `${column.id}-${rowIndex}`;
  if (column.type === "radio") {
    return (
      <Radio.Group
        key={key}
        size="small"
        disabled={!interactive}
        defaultValue={typeof column.defaultValue === "string" ? column.defaultValue : undefined}
        options={designerChoiceOptionsToAntd(column.options)}
      />
    );
  }
  if (column.type === "checkbox") {
    return (
      <Checkbox.Group
        key={key}
        disabled={!interactive}
        defaultValue={Array.isArray(column.defaultValue) ? column.defaultValue : []}
        options={designerChoiceOptionsToAntd(column.options)}
      />
    );
  }
  if (column.type === "select") {
    return (
      <Select
        key={key}
        size="small"
        disabled={!interactive}
        defaultValue={typeof column.defaultValue === "string" ? column.defaultValue : undefined}
        options={designerChoiceOptionsToAntd(column.options)}
        style={{ width: "100%" }}
      />
    );
  }
  return (
    <Input
      key={key}
      size="small"
      disabled={!interactive}
      defaultValue={typeof column.defaultValue === "string" ? column.defaultValue : ""}
    />
  );
};

const FieldControl = ({
  field,
  interactive = false,
  value,
  onChange,
}: {
  field: DesignerField;
  interactive?: boolean;
  value?: unknown;
  onChange?: (value: unknown) => void;
}) => {
  if (field.type === "richtext") {
    return (
      <RichTextEditor
        value={typeof value === "string" ? value : fieldDefaultText(field) ?? ""}
        onChange={(nextValue) => onChange?.(nextValue)}
        placeholder={field.placeholder}
        minHeight={interactive ? 180 : 120}
        disabled={!interactive}
      />
    );
  }
  if (field.type === "select") {
    return (
      <Select
        disabled={!interactive}
        value={value === undefined ? fieldDefaultText(field) || undefined : value}
        onChange={(nextValue) => onChange?.(nextValue)}
        placeholder={field.placeholder}
        options={designerChoiceOptionsToAntd(field.options)}
        style={{ width: "100%" }}
      />
    );
  }
  if (field.type === "cascader") {
    return (
      <Cascader
        disabled={!interactive}
        value={Array.isArray(value) ? value : Array.isArray(field.defaultValue) ? field.defaultValue : undefined}
        onChange={(nextValue) => onChange?.(nextValue)}
        options={designerChoiceOptionsToAntd(field.options)}
        placeholder={field.placeholder}
        style={{ width: "100%" }}
      />
    );
  }
  if (field.type === "radio") {
    return (
      <Radio.Group
        disabled={!interactive}
        value={value === undefined ? fieldDefaultText(field) || undefined : value}
        onChange={(event) => onChange?.(event.target.value)}
        options={designerChoiceOptionsToAntd(field.options)}
      />
    );
  }
  if (field.type === "checkbox") {
    return (
      <Checkbox.Group
        disabled={!interactive}
        value={Array.isArray(value) ? value : Array.isArray(field.defaultValue) ? field.defaultValue : []}
        onChange={(nextValue) => onChange?.(nextValue)}
        options={designerChoiceOptionsToAntd(field.options)}
      />
    );
  }
  if (field.type === "attachment") {
    const inlinePdf = field.attachment?.inlinePdf ?? true;
    const effectiveMaxCount = inlinePdf ? 1 : field.attachment?.maxCount ?? 20;
    return (
      <Upload.Dragger
        accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
        beforeUpload={() => false}
        disabled={!interactive}
        maxCount={effectiveMaxCount}
        multiple={!inlinePdf}
        showUploadList={false}
        fileList={Array.isArray(value) ? value as UploadFile[] : []}
        onChange={({ fileList }) => onChange?.(fileList)}
        className="fd-upload"
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">{field.placeholder || "拖拽或点击上传附件"}</p>
        <p className="ant-upload-hint">
          单个不超过 {field.attachment?.maxSizeMb ?? 100} MB，最多 {effectiveMaxCount} 个
          {inlinePdf ? "；继续上传将替换原文件" : ""}
        </p>
        {field.defaultValue ? <Tag icon={<FilePdfOutlined />} color="red">{String(field.defaultValue)}</Tag> : null}
      </Upload.Dragger>
    );
  }
  if (field.type === "table") {
    const tableColumns: TableColumnsType<Record<string, unknown>> = (field.columns ?? []).map((column) => ({
      title: (
        <Space size={4}>
          <span>{column.label}</span>
          {column.required ? <Text type="danger">*</Text> : null}
          {column.reviewEditable ? <Tag className="fd-mini-tag" color="blue">审核可输入</Tag> : null}
        </Space>
      ),
      key: column.id,
      width: column.width,
      align: column.align,
      render: (_value: unknown, _record: Record<string, unknown>, rowIndex: number) =>
        renderTableCell(column, interactive, rowIndex),
    }));
    return (
      <div className="fd-table-preview">
        <Table<Record<string, unknown>>
          columns={tableColumns}
          dataSource={[{ key: "sample-1" }, { key: "sample-2" }]}
          pagination={false}
          scroll={{ x: "max-content" }}
          size="small"
        />
        <Space className="fd-row-actions" size={8}>
          <Button disabled={!interactive} icon={<PlusOutlined />} size="small">新增行</Button>
          <Button disabled={!interactive} size="small">复制行</Button>
        </Space>
      </div>
    );
  }
  const textValue = value === undefined ? fieldDefaultText(field) : String(value ?? "");
  return field.multiline ? (
    <Input.TextArea
      disabled={!interactive}
      value={textValue}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={field.placeholder}
      autoSize={{ minRows: 3, maxRows: 8 }}
    />
  ) : (
    <Input
      disabled={!interactive}
      value={textValue}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={field.placeholder}
    />
  );
};

interface SortableFieldProps {
  field: DesignerField;
  selected: boolean;
  locked?: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<DesignerField>) => void;
  onDelete: () => void;
}

interface ChoiceOptionsEditorProps {
  options: DesignerChoiceOption[];
  hierarchical?: boolean;
  compact?: boolean;
  onChange: (options: DesignerChoiceOption[]) => void;
}

const ChoiceOptionsEditor = ({ options, hierarchical, compact, onChange }: ChoiceOptionsEditorProps) => {
  const renderOptions = (items: DesignerChoiceOption[], depth = 0): ReactNode => items.map((option) => (
    <div className="fd-choice-option-node" key={option.id} style={{ marginLeft: depth * 16 }}>
      <div className="fd-choice-option-row">
        <Input
          aria-label="选项名称"
          size={compact ? "small" : "middle"}
          value={option.label}
          maxLength={60}
          onChange={(event) => onChange(updateDesignerChoiceOption(options, option.id, { label: event.target.value }))}
        />
        {hierarchical ? <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          aria-label={`在${option.label}下新增子项`}
          onClick={() => onChange(appendDesignerChoiceOption(options, "新建子项", option.id))}
        /> : null}
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          aria-label={`删除选项${option.label}`}
          onClick={() => onChange(removeDesignerChoiceOption(options, option.id))}
        />
      </div>
      {option.children?.length ? renderOptions(option.children, depth + 1) : null}
    </div>
  ));

  return <div className={`fd-choice-options-editor${compact ? " is-compact" : ""}`}>
    {options.length ? renderOptions(options) : <Text type="secondary">暂无选项</Text>}
    <Button
      type="dashed"
      size="small"
      block
      icon={<PlusOutlined />}
      onClick={() => onChange([...options, createDesignerChoiceOption(hierarchical ? "新建一级选项" : "新建选项")])}
    >{hierarchical ? "新增一级选项" : "新增选项"}</Button>
  </div>;
};

const sanitizeFieldDefault = (field: DesignerField, options: DesignerChoiceOption[]) => {
  const validIds = new Set(flattenDesignerChoiceOptions(options).map((option) => option.id));
  if (field.type === "checkbox") {
    return Array.isArray(field.defaultValue) ? field.defaultValue.filter((value) => validIds.has(value)) : [];
  }
  if (field.type === "cascader") {
    return Array.isArray(field.defaultValue) && field.defaultValue.every((value) => validIds.has(value))
      ? field.defaultValue
      : [];
  }
  return typeof field.defaultValue === "string" && validIds.has(field.defaultValue) ? field.defaultValue : "";
};

const sanitizeChoiceDefault = (
  type: TableColumnType | "cascader",
  value: string | string[],
  options: DesignerChoiceOption[],
) => type === "text" ? value : sanitizeFieldDefault({ type, defaultValue: value } as DesignerField, options);

const SortableField = ({ field, selected, locked, onSelect, onPatch, onDelete }: SortableFieldProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const updateOptions = (options: DesignerChoiceOption[]) => onPatch({
    options,
    defaultValue: sanitizeFieldDefault(field, options),
  });
  return (
    <div
      ref={setNodeRef}
      className={`fd-field-card${selected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
    >
      <div className="fd-field-card__toolbar">
        <Space size={6}>
          <Tooltip title="拖动排序">
            <button
              type="button"
              className="fd-drag-handle"
              aria-label={`拖动${field.label}`}
              {...attributes}
              {...listeners}
              onClick={(event) => event.stopPropagation()}
            >
              <DragOutlined />
            </button>
          </Tooltip>
          <Tag bordered={false} icon={typeIcon[field.type]}>{typeLabel[field.type]}</Tag>
          {locked ? <Tag bordered={false} color="gold">固定字段</Tag> : null}
          {field.displayCondition ? <Tag bordered={false} color="cyan">条件显示</Tag> : null}
          {field.inputStage === "reviewer" ? <Tag variant="filled" color="purple">审核人输入</Tag> : null}
          {field.inputStage === "both" ? <Tag bordered={false} color="blue">发起人/审核人</Tag> : null}
        </Space>
        {locked ? (
          <Tooltip title="标题是所有流程必备字段，不能删除">
            <Button aria-label="标题字段不可删除" disabled icon={<DeleteOutlined />} size="small" type="text" />
          </Tooltip>
        ) : (
          <Popconfirm title="删除这个字段？" description="删除后可从左侧组件库重新添加。" onConfirm={onDelete}>
            <Button
              aria-label={`删除${field.label}`}
              danger
              icon={<DeleteOutlined />}
              size="small"
              type="text"
              onClick={(event) => event.stopPropagation()}
            />
          </Popconfirm>
        )}
      </div>
      <div className="fd-field-card__content">
        <div className="fd-field-label">
          {field.required ? <Text type="danger">*</Text> : null}
          <Input
            aria-label="字段标题"
            className="fd-inline-title"
            value={field.label}
            maxLength={50}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            onFocus={onSelect}
            onChange={(event) => onPatch({ label: event.target.value })}
          />
        </div>
        <div className="fd-inline-settings" onClick={(event) => event.stopPropagation()}>
          {field.options ? (
            <div className="fd-inline-options">
              <Text type="secondary">选项</Text>
              <ChoiceOptionsEditor options={field.options} hierarchical={field.type === "cascader"} compact onChange={updateOptions} />
            </div>
          ) : null}
          <Space size={18} wrap>
            <Checkbox
              checked={Boolean(field.required)}
              disabled={locked}
              onChange={(event) => onPatch({ required: event.target.checked })}
            >必填</Checkbox>
            {field.type === "text" ? (
              <Checkbox
                checked={Boolean(field.multiline)}
                disabled={locked}
                onChange={(event) => onPatch({ multiline: event.target.checked })}
              >多行显示</Checkbox>
            ) : null}
          </Space>
        </div>
        {field.description ? <Paragraph className="fd-field-description">{field.description}</Paragraph> : null}
        <FieldControl field={field} />
      </div>
    </div>
  );
};

const FormDesignerWorkspace = ({ definitionId, versionId }: { definitionId: string; versionId: string }) => {
  const navigate = useNavigate();
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === definitionId));
  const version = definition?.versions.find((item) => item.id === versionId);
  const [versionEtag, setVersionEtag] = useState<string>();
  const workflowName = version?.basic.name ?? definition?.name ?? "流程";
  const [messageApi, messageHolder] = message.useMessage();
  const fallbackFields = useMemo(
    () => ensureProcessTitleField(version?.snapshot.form.fields).map((field) => ({
      ...field,
      inputStage: field.id === PROCESS_TITLE_FIELD_ID && normalizeDesignerInputPermission(field) === "reviewer"
        ? "initiator"
        : normalizeDesignerInputPermission(field),
      displayCondition: field.id === PROCESS_TITLE_FIELD_ID
        ? undefined
        : normalizeStoredCondition(field.displayCondition),
      attachment: field.type === "attachment" ? {
        maxSizeMb: field.attachment?.maxSizeMb ?? 100,
        maxCount: (field.attachment?.inlinePdf ?? true) ? 1 : field.attachment?.maxCount ?? 20,
        inlinePdf: field.attachment?.inlinePdf ?? true,
        allowedExtensions: field.attachment?.allowedExtensions ?? ((field.attachment?.inlinePdf ?? true) ? ["pdf"] : []),
        excelToPdf: field.attachment?.excelToPdf ?? false,
        maxPreviewPages: field.attachment?.maxPreviewPages ?? 1,
      } : field.attachment,
    })) as DesignerField[],
    [version],
  );
  const initialDraft = useMemo(
    () => ({
      fields: fallbackFields,
      savedAt: version?.snapshot.form.savedAt,
    }),
    [version, fallbackFields],
  );
  const [fields, setFields] = useState<DesignerField[]>(initialDraft.fields);
  const [selectedId, setSelectedId] = useState(initialDraft.fields[0]?.id ?? "");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewForm] = Form.useForm();
  const previewValues = Form.useWatch([], previewForm) as Record<string, unknown> | undefined;
  const [propertyMode, setPropertyMode] = useState<"field" | "system">("field");
  const [systemListFields, setSystemListFields] = useState<SystemListFieldConfig[]>(() =>
    structuredClone(version?.snapshot.systemFields ?? cloneDefaultSystemListFields())
      .filter((field) => String(field.key) !== "title")
      .map((field) => ({
        ...field,
        exportVisible: field.exportVisible ?? field.processListVisible,
      })),
  );
  const [saveState, setSaveState] = useState<"dirty" | "saved">("saved");
  const skipDirtyEffect = useRef(true);
  const [savedAt, setSavedAt] = useState(initialDraft.savedAt ?? formatDisplayDateTime(new Date().toISOString()));
  const designerHistoryValue = useMemo(
    () => ({ fields, systemListFields }),
    [fields, systemListFields],
  );
  const { canUndo, canRedo, undo, redo } = useUndoRedoHistory(
    designerHistoryValue,
    (snapshot) => {
      setFields(snapshot.fields);
      setSystemListFields(snapshot.systemListFields);
      setSelectedId((current) => snapshot.fields.some((field) => field.id === current)
        ? current
        : snapshot.fields[0]?.id ?? "");
    },
    { historyKey: `${definitionId}:${versionId}:form` },
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedField = fields.find((field) => field.id === selectedId);
  const selectedFieldIndex = fields.findIndex((field) => field.id === selectedId);
  const displayConditionFieldOptions = fields
    .slice(0, Math.max(0, selectedFieldIndex))
    .filter((field) => ["text", "select", "cascader", "radio", "checkbox"].includes(field.type))
    .map((field) => ({
      value: field.id,
      label: field.label,
      type: field.type,
      choiceOptions: flattenDesignerChoiceOptions(field.options),
    }));
  const selectedDisplayCondition = normalizeStoredCondition(selectedField?.displayCondition);
  const previewFields = useMemo(
    () => fields.filter((field) => field.inputStage !== "reviewer"),
    [fields],
  );
  const previewInitialValues = useMemo(
    () => Object.fromEntries(previewFields.map((field) => [
      field.id,
      field.type === "table"
        ? [{ key: "sample-1" }, { key: "sample-2" }]
        : field.type === "attachment"
          ? []
          : field.defaultValue,
    ])),
    [previewFields],
  );
  const visiblePreviewFields = useMemo(
    () => previewFields.filter((field) => isDesignerFieldVisible(field, previewValues ?? previewInitialValues)),
    [previewFields, previewInitialValues, previewValues],
  );
  const isTitleField = selectedField?.id === PROCESS_TITLE_FIELD_ID;

  useEffect(() => {
    if (skipDirtyEffect.current) {
      skipDirtyEffect.current = false;
      return;
    }
    setSaveState("dirty");
  }, [fields, systemListFields]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (previewOpen || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redo();
      } else if (key === "z") {
        event.preventDefault();
        undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [previewOpen, redo, undo]);

  const updateSystemListField = (
    key: SystemListFieldConfig["key"],
    patch: Partial<Pick<SystemListFieldConfig, "taskVisible" | "processListVisible" | "exportVisible">>,
  ) => {
    setSystemListFields((current) =>
      current.map((field) => (field.key === key ? { ...field, ...patch } : field)),
    );
  };

  const addField = (type: FieldType) => {
    const field = createField(type);
    setFields((current) => [...current, field]);
    setSelectedId(field.id);
    setPropertyMode("field");
    messageApi.success(`${typeLabel[type]}已添加到表单底部`);
  };

  const deleteField = (id: string) => {
    if (id === PROCESS_TITLE_FIELD_ID) {
      messageApi.warning("标题是所有流程必备字段，不能删除");
      return;
    }
    setFields((current) => {
      const next = current.filter((field) => field.id !== id);
      if (selectedId === id) setSelectedId(next[0]?.id ?? "");
      return next;
    });
  };

  const updateField = (patch: Partial<DesignerField>) => {
    if (!selectedId) return;
    setFields((current) => current.map((field) => (field.id === selectedId
      ? { ...field, ...patch, ...(field.id === PROCESS_TITLE_FIELD_ID ? { queryable: true } : {}) }
      : field)));
  };

  const updateFieldById = (id: string, patch: Partial<DesignerField>) => {
    setFields((current) => current.map((field) => (field.id === id
      ? {
          ...field,
          ...patch,
          ...(field.id === PROCESS_TITLE_FIELD_ID
            ? { queryable: true, required: true, multiline: false }
            : {}),
        }
      : field)));
  };

  const updateColumn = (columnId: string, patch: Partial<TableColumnConfig>) => {
    if (!selectedField?.columns) return;
    updateField({
      columns: selectedField.columns.map((column) => (column.id === columnId ? { ...column, ...patch } : column)),
    });
  };

  const addColumn = () => {
    if (!selectedField) return;
    const column: TableColumnConfig = {
      id: makeId("col"),
      label: "新字段",
      type: "text",
      required: false,
      defaultValue: "",
      width: 160,
      align: "left",
      reviewEditable: false,
    };
    updateField({ columns: [...(selectedField.columns ?? []), column] });
  };

  const deleteColumn = (columnId: string) => {
    updateField({ columns: (selectedField?.columns ?? []).filter((column) => column.id !== columnId) });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setFields((current) => {
      const oldIndex = current.findIndex((field) => field.id === active.id);
      const newIndex = current.findIndex((field) => field.id === over.id);
      return arrayMove(current, oldIndex, newIndex);
    });
  };

  useEffect(() => {
    let cancelled = false;
    void flowPilotApi.definitions.versionResource(definitionId, versionId).then((resource) => {
      if (cancelled) return;
      cacheProcessVersion(definitionId, resource.data);
      setVersionEtag(resource.etag);
    }).catch((error) => {
      if (!cancelled) messageApi.error(error instanceof Error ? error.message : "流程版本加载失败");
    });
    return () => { cancelled = true; };
  }, [definitionId, messageApi, versionId]);

  const saveVersion = async () => {
    const time = formatDisplayDateTime(new Date().toISOString());
    skipDirtyEffect.current = true;
    setSavedAt(time);
    try {
      if (!versionEtag) throw new Error("流程版本尚未加载完成，请稍后重试");
      const saved = await flowPilotApi.definitions.saveFormDesignerResource(definitionId, versionId, {
        form: { fields: ensureProcessTitleField(fields), savedAt: time },
        systemFields: systemListFields,
      }, versionEtag);
      cacheProcessVersion(definitionId, saved.data.version);
      setVersionEtag(saved.etag);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "当前版本不可编辑，请返回版本记录确认发布状态和实例数量");
      return false;
    }
    setSaveState("saved");
    messageApi.success("版本已保存并自动完成校验");
    return true;
  };

  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty: saveState === "dirty",
    onSave: saveVersion,
    title: "初始表单尚未保存",
    description: "可以先保存表单和列表字段配置再离开，也可以放弃本次修改。",
  });

  const goPrevious = async () => {
    if (saveState === "dirty" && !await saveVersion()) return;
    allowNextNavigation();
    navigate(`/admin/processes/${definitionId}/basic?versionId=${versionId}`);
  };

  const goNext = async () => {
    const invalidField = fields.find((field) => !field.label.trim());
    if (invalidField) {
      setSelectedId(invalidField.id);
      setPropertyMode("field");
      messageApi.error("存在未命名字段，请补充后继续");
      return;
    }
    if (saveState === "dirty" && !await saveVersion()) return;
    allowNextNavigation();
    navigate(definition?.type === "free"
      ? `/admin/processes/${definitionId}/publish?versionId=${versionId}`
      : `/admin/processes/${definitionId}/flow?versionId=${versionId}`);
  };

  const renderDefaultValueEditor = (field: DesignerField) => {
    if (field.type === "checkbox") {
      return (
        <Select
          mode="multiple"
          value={Array.isArray(field.defaultValue) ? field.defaultValue : []}
          options={designerChoiceOptionsToAntd(field.options)}
          onChange={(value) => updateField({ defaultValue: value })}
          placeholder="请选择默认项"
        />
      );
    }
    if (field.type === "cascader") {
      return (
        <Cascader
          value={Array.isArray(field.defaultValue) ? field.defaultValue : undefined}
          options={designerChoiceOptionsToAntd(field.options)}
          onChange={(value) => updateField({ defaultValue: value.map(String) })}
          placeholder="请选择默认路径"
        />
      );
    }
    if (["select", "radio"].includes(field.type)) {
      return (
        <Select
          allowClear
          value={typeof field.defaultValue === "string" && field.defaultValue ? field.defaultValue : undefined}
          options={designerChoiceOptionsToAntd(field.options)}
          onChange={(value) => updateField({ defaultValue: value ?? "" })}
          placeholder="请选择默认值"
        />
      );
    }
    if (field.type === "richtext") {
      return (
        <RichTextEditor
          value={typeof field.defaultValue === "string" ? field.defaultValue : ""}
          onChange={(defaultValue) => updateField({ defaultValue })}
          placeholder="可选的默认富文本内容"
          minHeight={150}
        />
      );
    }
    return (
      <Input
        value={typeof field.defaultValue === "string" ? field.defaultValue : ""}
        onChange={(event) => updateField({ defaultValue: event.target.value })}
        placeholder="可选"
      />
    );
  };

  return (
    <div className="form-designer-page">
      {messageHolder}
      {guard}
      <div className="fd-page-header">
        <div className="fd-page-header__identity">
          <div className="fd-page-header__icon">{definitionId === "pdf-review" ? <FilePdfOutlined /> : <FileTextOutlined />}</div>
          <div>
            <Space align="center" size={10}>
              <Title level={4}>{version?.basic.name ?? definition?.name ?? "流程配置"}</Title>
              <Tag color="blue">正式版本 {version?.version ?? "未指定"}</Tag>
            </Space>
            <Text type="secondary">初始表单 · 单列布局 · 配置发起时需要填写的内容</Text>
          </div>
        </div>
        <Space wrap>
          <div className="fd-save-status">
            <CheckCircleFilled />
            <span>{saveState === "dirty" ? "有未保存修改" : `版本已保存 · ${savedAt}`}</span>
          </div>
          <ProcessWizardPreviousButton step="基本信息" onClick={goPrevious} />
          <Space.Compact>
            <Tooltip title="撤销（Ctrl+Z）">
              <Button aria-label="撤销" disabled={!canUndo} icon={<UndoOutlined />} onClick={undo} />
            </Tooltip>
            <Tooltip title="重做（Ctrl+Shift+Z / Ctrl+Y）">
              <Button aria-label="重做" disabled={!canRedo} icon={<RedoOutlined />} onClick={redo} />
            </Tooltip>
          </Space.Compact>
          <Button icon={<EyeOutlined />} onClick={() => setPreviewOpen(true)}>预览</Button>
          <Button icon={<SaveOutlined />} onClick={saveVersion}>保存</Button>
          <ProcessWizardNextButton step={definition?.type === "free" ? "发布" : "流程设计"} onClick={goNext} />
        </Space>
      </div>

      <div className="fd-wizard-steps">
        <ProcessWizardSteps workflowType={definition?.type ?? "approval"} current={1} />
      </div>

      <div className="fd-workspace">
        <aside className="fd-panel fd-component-panel">
          <div className="fd-panel-title">
            <div><TagsOutlined /> 组件库</div>
            <Text type="secondary">点击添加</Text>
          </div>
          <div className="fd-component-list">
            {(Object.keys(typeLabel) as FieldType[]).map((type) => (
              <button key={type} type="button" className="fd-component-item" onClick={() => addField(type)}>
                <span className={`fd-component-icon is-${type}`}>{typeIcon[type]}</span>
                <span>
                  <strong>{typeLabel[type]}</strong>
                  <small>
                    {type === "table"
                      ? "自定义列和权限"
                      : type === "attachment"
                        ? "文件与 PDF 预览"
                        : type === "cascader"
                          ? "层级选项"
                          : type === "richtext"
                            ? "文字、图片与视频"
                            : "基础表单组件"}
                  </small>
                </span>
                <PlusOutlined className="fd-component-add" />
              </button>
            ))}
          </div>
          <Alert
            className="fd-component-tip"
            type="info"
            showIcon
            message="输入权限"
            description="选择“发起人/审核人”或“审核人”后，再到审批节点分配具体可输入字段。"
          />
        </aside>

        <main className="fd-panel fd-canvas-panel">
          <div className="fd-canvas-toolbar">
            <Text type="secondary">{workflowName} · 初始表单</Text>
            <Space size={8}>
              <Tag bordered={false}>{fields.length} 个字段</Tag>
              <Tag bordered={false} color="blue">单列布局</Tag>
            </Space>
          </div>
          <div className="fd-canvas-scroll">
            <div className="fd-form-sheet">
              <div className="fd-form-sheet__header">
                <div className="fd-form-mark">{definitionId === "pdf-review" ? <FilePdfOutlined /> : <FileTextOutlined />}</div>
                <div>
                  <Title level={4}>{workflowName}</Title>
                  <Text type="secondary">初始表单 · 发起时填写</Text>
                </div>
              </div>
              {fields.length ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                    <div className="fd-field-list">
                      {fields.map((field) => (
                        <SortableField
                          key={field.id}
                          field={field}
                          selected={selectedId === field.id}
                          locked={field.id === PROCESS_TITLE_FIELD_ID}
                          onSelect={() => {
                            setSelectedId(field.id);
                            setPropertyMode("field");
                          }}
                          onPatch={(patch) => updateFieldById(field.id, patch)}
                          onDelete={() => deleteField(field.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧添加第一个字段" />
              )}
            </div>
          </div>
        </main>

        <aside className="fd-panel fd-property-panel">
          <div className="fd-panel-title">
            <div><SettingOutlined /> 属性配置</div>
            {propertyMode === "field" && selectedField ? <Tag>{typeLabel[selectedField.type]}</Tag> : <Tag color="blue">流程级</Tag>}
          </div>
          <div className="fd-property-mode">
            <Segmented
              block
              value={propertyMode}
              onChange={(value) => setPropertyMode(value as "field" | "system")}
              options={[
                { label: "字段属性", value: "field" },
                { label: "系统字段", value: "system" },
              ]}
            />
          </div>
          <div className="fd-property-scroll">
            {propertyMode === "field" && selectedField ? (
              <Form layout="vertical" size="middle">
                <div className="fd-property-section">
                  <div className="fd-property-section__title">基础信息</div>
                  {isTitleField ? (
                    <Alert
                      type="info"
                      showIcon
                      message="流程标题字段"
                      description="字段标识、文本框类型和必填规则由系统固定；字段名称、说明、提示、输入权限以及任务中心和流程清单的展示位置可在此配置。"
                    />
                  ) : null}
                  <Form.Item label="字段名称" required>
                    <Input value={selectedField.label} onChange={(event) => updateField({ label: event.target.value })} />
                  </Form.Item>
                  <Form.Item label="字段说明">
                    <Input.TextArea
                      autoSize={{ minRows: 2, maxRows: 4 }}
                      value={selectedField.description}
                      onChange={(event) => updateField({ description: event.target.value })}
                      placeholder="展示在字段名称下方"
                    />
                  </Form.Item>
                  {!["table"].includes(selectedField.type) ? (
                    <Form.Item label="提示文字">
                      <Input value={selectedField.placeholder} onChange={(event) => updateField({ placeholder: event.target.value })} />
                    </Form.Item>
                  ) : null}
                </div>

                {selectedField.options ? (
                  <div className="fd-property-section">
                    <div className="fd-property-section__title">选项设置</div>
                    <Form.Item label={selectedField.type === "cascader" ? "多级选项" : "可选项"}>
                      <ChoiceOptionsEditor
                        options={selectedField.options}
                        hierarchical={selectedField.type === "cascader"}
                        onChange={(options) => updateField({
                          options,
                          defaultValue: sanitizeFieldDefault(selectedField, options),
                        })}
                      />
                    </Form.Item>
                    <Form.Item label="默认值">{renderDefaultValueEditor(selectedField)}</Form.Item>
                  </div>
                ) : null}

                {["text", "richtext"].includes(selectedField.type) ? (
                  <div className="fd-property-section">
                    <div className="fd-property-section__title">{selectedField.type === "richtext" ? "默认富文本内容" : "默认内容"}</div>
                    {selectedField.type === "text" ? (
                      <div className="fd-switch-row">
                        <div>
                          <Text strong>多行显示</Text>
                          <Text type="secondary">适合备注、说明等较长内容；流程标题固定为单行。</Text>
                        </div>
                        <Switch
                          checked={Boolean(selectedField.multiline)}
                          disabled={isTitleField}
                          onChange={(checked) => updateField({ multiline: checked })}
                        />
                      </div>
                    ) : null}
                    <Form.Item label="默认值">{renderDefaultValueEditor(selectedField)}</Form.Item>
                  </div>
                ) : null}

                {selectedField.type === "attachment" ? (
                  <div className="fd-property-section">
                    <div className="fd-property-section__title">附件规则</div>
                    <div className="fd-two-column">
                      <Form.Item label="单文件上限">
                        <InputNumber
                          min={1}
                          max={100}
                          addonAfter="MB"
                          value={selectedField.attachment?.maxSizeMb ?? 100}
                          onChange={(value) => updateField({
                            attachment: { ...selectedField.attachment!, maxSizeMb: value ?? 100 },
                          })}
                        />
                      </Form.Item>
                      <Form.Item label="最多文件数">
                        <InputNumber
                          disabled={selectedField.attachment?.inlinePdf ?? true}
                          min={1}
                          max={20}
                          addonAfter="个"
                          value={(selectedField.attachment?.inlinePdf ?? true) ? 1 : selectedField.attachment?.maxCount ?? 20}
                          onChange={(value) => updateField({
                            attachment: { ...selectedField.attachment!, maxCount: value ?? 20 },
                          })}
                        />
                      </Form.Item>
                    </div>
                    <Form.Item label="允许的扩展名" extra="不填写表示允许除危险类型外的常见业务文件；无需输入点号。">
                      <Select
                        mode="tags"
                        tokenSeparators={[",", "，", " "]}
                        placeholder="例如 pdf、docx、xlsx"
                        value={selectedField.attachment?.allowedExtensions ?? []}
                        onChange={(values) => updateField({
                          attachment: {
                            ...selectedField.attachment!,
                            allowedExtensions: [...new Set(values.map((value) => value.trim().replace(/^\./, "").toLowerCase()).filter(Boolean))],
                          },
                        })}
                        options={["pdf", "docx", "xlsx", "xls", "png", "jpg", "zip"].map((value) => ({ value }))}
                      />
                    </Form.Item>
                    <div className="fd-switch-row">
                      <div>
                        <Text strong>PDF 页面内嵌展示</Text>
                        <Text type="secondary">审核时无需下载即可查看</Text>
                      </div>
                      <Switch
                        checked={selectedField.attachment?.inlinePdf ?? true}
                        onChange={(checked) => updateField({
                          attachment: {
                            maxSizeMb: selectedField.attachment?.maxSizeMb ?? 100,
                            maxCount: checked ? 1 : selectedField.attachment?.maxCount ?? 20,
                            inlinePdf: checked,
                            allowedExtensions: selectedField.attachment?.allowedExtensions ?? (checked ? ["pdf"] : []),
                            excelToPdf: selectedField.attachment?.excelToPdf ?? false,
                            maxPreviewPages: selectedField.attachment?.maxPreviewPages ?? 1,
                          },
                        })}
                      />
                    </div>
                    <div className="fd-switch-row">
                      <div>
                        <Text strong>Excel 转 PDF 后展示</Text>
                        <Text type="secondary">选择 xlsx 后在浏览器生成并预览 PDF；确认后只上传 PDF。</Text>
                      </div>
                      <Switch
                        disabled={!(selectedField.attachment?.inlinePdf ?? true)}
                        checked={Boolean(selectedField.attachment?.excelToPdf)}
                        onChange={(excelToPdf) => updateField({
                          attachment: {
                            ...selectedField.attachment!,
                            inlinePdf: true,
                            maxCount: 1,
                            excelToPdf,
                            maxPreviewPages: selectedField.attachment?.maxPreviewPages ?? 1,
                            allowedExtensions: excelToPdf
                              ? [...new Set([...(selectedField.attachment?.allowedExtensions ?? []).filter((extension) => extension !== "xls"), "pdf", "xlsx"])]
                              : selectedField.attachment?.allowedExtensions ?? ["pdf"],
                          },
                        })}
                      />
                    </div>
                    {selectedField.attachment?.excelToPdf ? (
                      <Form.Item label="转换最大页数" extra="浏览器优先按工作簿打印区域、纸张方向和缩放设置分页，超过时只生成设定页数。">
                        <InputNumber
                          min={1}
                          max={50}
                          addonAfter="页"
                          value={selectedField.attachment?.maxPreviewPages ?? 1}
                          onChange={(value) => updateField({ attachment: { ...selectedField.attachment!, maxPreviewPages: value ?? 1 } })}
                        />
                      </Form.Item>
                    ) : null}
                    <Alert
                      type="warning"
                      showIcon
                      message={(selectedField.attachment?.inlinePdf ?? true) ? "PDF 单文件替换规则" : "安全限制"}
                      description={(selectedField.attachment?.inlinePdf ?? true)
                        ? "开启内嵌展示后固定只保留 1 个文件；继续上传会删除原文件并保留新文件。"
                        : "可上传任意业务附件；系统默认阻止可执行文件和脚本类型。"}
                    />
                  </div>
                ) : null}

                {selectedField.type === "table" ? (
                  <div className="fd-property-section fd-table-settings">
                    <div className="fd-property-section__title fd-title-with-action">
                      <span>表格字段</span>
                      <Button icon={<PlusOutlined />} size="small" onClick={addColumn}>添加列</Button>
                    </div>
                    <Alert
                      type="info"
                      showIcon
                      message="行操作规则"
                      description="发起人可新增、删除、复制行；审批节点仅可修改授权单元格。"
                    />
                    {(selectedField.columns ?? []).map((column, index) => (
                      <Card
                        key={column.id}
                        className="fd-column-card"
                        size="small"
                        title={`第 ${index + 1} 列`}
                        extra={
                          <Popconfirm title="删除此列？" onConfirm={() => deleteColumn(column.id)}>
                            <Button danger icon={<DeleteOutlined />} size="small" type="text" aria-label={`删除表格列：${column.label}`} />
                          </Popconfirm>
                        }
                      >
                        <Form.Item label="列名称">
                          <Input value={column.label} onChange={(event) => updateColumn(column.id, { label: event.target.value })} />
                        </Form.Item>
                        <div className="fd-two-column">
                          <Form.Item label="字段类型">
                            <Select
                              value={column.type}
                              options={(Object.keys(tableTypeLabel) as TableColumnType[]).map((type) => ({
                                label: tableTypeLabel[type], value: type,
                              }))}
                              onChange={(value: TableColumnType) => updateColumn(column.id, {
                                type: value,
                                options: value === "text" ? undefined : column.options ?? makeChoiceOptions(["选项一", "选项二"], `${selectedField.id}.${column.id}`),
                                defaultValue: value === "checkbox" ? [] : "",
                              })}
                            />
                          </Form.Item>
                          <Form.Item label="列宽">
                            <InputNumber
                              min={80}
                              max={600}
                              addonAfter="px"
                              value={column.width}
                              onChange={(value) => updateColumn(column.id, { width: value ?? 160 })}
                            />
                          </Form.Item>
                        </div>
                        {column.type !== "text" ? (
                          <Form.Item label="可选项">
                            <ChoiceOptionsEditor
                              options={column.options ?? []}
                              onChange={(options) => updateColumn(column.id, {
                                options,
                                defaultValue: sanitizeChoiceDefault(column.type, column.defaultValue, options),
                              })}
                            />
                          </Form.Item>
                        ) : null}
                        <Form.Item label="默认值">
                          {column.type === "checkbox" ? (
                            <Select
                              mode="multiple"
                              value={Array.isArray(column.defaultValue) ? column.defaultValue : []}
                              options={designerChoiceOptionsToAntd(column.options)}
                              onChange={(value) => updateColumn(column.id, { defaultValue: value })}
                              placeholder="可选"
                            />
                          ) : column.type === "text" ? (
                            <Input
                              value={typeof column.defaultValue === "string" ? column.defaultValue : ""}
                              onChange={(event) => updateColumn(column.id, { defaultValue: event.target.value })}
                              placeholder="可选"
                            />
                          ) : (
                            <Select
                              allowClear
                              value={typeof column.defaultValue === "string" && column.defaultValue ? column.defaultValue : undefined}
                              options={designerChoiceOptionsToAntd(column.options)}
                              onChange={(value) => updateColumn(column.id, { defaultValue: value ?? "" })}
                              placeholder="可选"
                            />
                          )}
                        </Form.Item>
                        <Form.Item label="对齐方式">
                          <Segmented
                            block
                            options={[
                              { label: "左", value: "left" },
                              { label: "中", value: "center" },
                              { label: "右", value: "right" },
                            ]}
                            value={column.align}
                            onChange={(value) => updateColumn(column.id, { align: value as ColumnAlign })}
                          />
                        </Form.Item>
                        <div className="fd-inline-switches">
                          <span><Switch size="small" checked={column.required} onChange={(checked) => updateColumn(column.id, { required: checked })} /> 必填</span>
                          <span><Switch size="small" checked={column.reviewEditable} onChange={(checked) => updateColumn(column.id, { reviewEditable: checked })} /> 审核人可输入</span>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : null}

                {!isTitleField ? (
                  <div className="fd-property-section fd-display-condition">
                    <div className="fd-property-section__title">条件显示</div>
                    <div className="fd-switch-row">
                      <div>
                        <Text strong>按条件显示此项</Text>
                        <Text type="secondary">仅当之前字段满足规则时显示；隐藏时不校验必填。</Text>
                      </div>
                      <Switch
                        checked={Boolean(selectedDisplayCondition)}
                        disabled={!displayConditionFieldOptions.length}
                        onChange={(checked) => updateField({
                          displayCondition: checked ? {
                            mode: "all",
                            rules: [{
                              id: makeId("display-condition"),
                              fieldId: displayConditionFieldOptions[0]?.value ?? "",
                              operator: "eq",
                              value: displayConditionFieldOptions[0]?.choiceOptions?.[0]?.id ?? "",
                            }],
                          } : undefined,
                        })}
                      />
                    </div>
                    {!displayConditionFieldOptions.length ? (
                      <Text type="secondary">请先在当前项之前添加文本框、下拉框、多级下拉、单选框或复选框。</Text>
                    ) : null}
                    {selectedDisplayCondition ? (
                      <>
                        <Segmented
                          block
                          value={selectedDisplayCondition.mode}
                          options={[
                            { label: "全部满足（AND）", value: "all" },
                            { label: "任一满足（OR）", value: "any" },
                          ]}
                          onChange={(mode) => updateField({
                            displayCondition: { ...selectedDisplayCondition, mode: mode as "all" | "any" },
                          })}
                        />
                        <div className="fd-display-condition__rules">
                          {selectedDisplayCondition.rules.map((rule) => {
                            const sourceField = displayConditionFieldOptions.find((field) => field.value === rule.fieldId);
                            const operators = displayConditionOperators(sourceField?.type);
                            const updateRule = (rulePatch: Partial<typeof rule>) => updateField({
                              displayCondition: {
                                ...selectedDisplayCondition,
                                rules: selectedDisplayCondition.rules.map((item) => item.id === rule.id ? { ...item, ...rulePatch } : item),
                              },
                            });
                            return (
                              <div className="fd-display-condition__rule" key={rule.id}>
                                <Select
                                  showSearch
                                  value={rule.fieldId || undefined}
                                  placeholder="选择条件字段"
                                  optionFilterProp="label"
                                  options={displayConditionFieldOptions}
                                  onChange={(fieldId) => {
                                    const nextField = displayConditionFieldOptions.find((field) => field.value === fieldId);
                                    updateRule({ fieldId, operator: "eq", value: nextField?.choiceOptions?.[0]?.id ?? "" });
                                  }}
                                />
                                <div>
                                  <Select
                                    value={rule.operator}
                                    options={operators.map((operator) => ({ value: operator, label: conditionOperatorLabel(operator) }))}
                                    onChange={(operator) => updateRule({ operator })}
                                  />
                                  {!(["empty", "not-empty"] as ConditionOperator[]).includes(rule.operator) ? (
                                    sourceField?.choiceOptions?.length ? (
                                      <Select
                                        value={typeof rule.value === "string" ? rule.value || undefined : undefined}
                                        placeholder="选择比较值"
                                        options={sourceField.choiceOptions.map((option) => ({ value: option.id, label: option.label }))}
                                        onChange={(value) => updateRule({ value })}
                                      />
                                    ) : (
                                      <Input
                                        value={typeof rule.value === "string" ? rule.value : ""}
                                        placeholder="输入比较值"
                                        onChange={(event) => updateRule({ value: event.target.value })}
                                      />
                                    )
                                  ) : <span />}
                                  <Button
                                    danger
                                    type="text"
                                    icon={<DeleteOutlined />}
                                    aria-label="删除显示条件"
                                    onClick={() => updateField({
                                      displayCondition: selectedDisplayCondition.rules.length === 1
                                        ? undefined
                                        : {
                                            ...selectedDisplayCondition,
                                            rules: selectedDisplayCondition.rules.filter((item) => item.id !== rule.id),
                                          },
                                    })}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <Button
                          block
                          type="dashed"
                          icon={<PlusOutlined />}
                          onClick={() => updateField({
                            displayCondition: {
                              ...selectedDisplayCondition,
                              rules: [...selectedDisplayCondition.rules, {
                                id: makeId("display-condition"),
                                fieldId: displayConditionFieldOptions[0]?.value ?? "",
                                operator: "eq",
                                value: displayConditionFieldOptions[0]?.choiceOptions?.[0]?.id ?? "",
                              }],
                            },
                          })}
                        >添加条件</Button>
                      </>
                    ) : null}
                  </div>
                ) : null}

                <div className="fd-property-section">
                  <div className="fd-property-section__title">权限与展示</div>
                  <Form.Item label="输入权限">
                    <Select
                      disabled={definition?.type === "free"}
                      value={selectedField.inputStage}
                      options={[
                        { label: "发起人", value: "initiator" },
                        { label: "发起人/审核人", value: "both" },
                        { label: "审核人", value: "reviewer", disabled: isTitleField },
                      ]}
                      onChange={(inputStage) => updateField({
                        inputStage: inputStage as DesignerField["inputStage"],
                        reviewEditable: inputStage !== "initiator",
                      })}
                    />
                    <Text type="secondary">
                      {definition?.type === "free"
                        ? "自由流程的初始表单由发起人填写。"
                        : selectedField.inputStage === "reviewer"
                          ? "发起页面不显示此字段；流程创建后按设计位置显示，由授权审批节点填写。"
                          : selectedField.inputStage === "both"
                            ? "发起人创建时填写，之后可由授权审批节点修改。"
                            : "发起人创建流程时填写，审核人不能修改。"}
                    </Text>
                  </Form.Item>
                  <div className="fd-switch-row">
                    <div><Text strong>必填项</Text><Text type="secondary">{selectedField.inputStage === "reviewer" ? "负责此字段的审批节点提交时必须填写" : "发起时必须填写"}</Text></div>
                    <Switch disabled={isTitleField} checked={isTitleField || selectedField.required} onChange={(checked) => updateField({ required: checked })} />
                  </div>
                  <div className="fd-switch-row">
                    <div><Text strong>在流程清单显示</Text><Text type="secondary">作为“流程清单”的表格列</Text></div>
                    <Switch disabled={selectedField.type === "richtext"} checked={selectedField.listVisible} onChange={(checked) => updateField({ listVisible: checked })} />
                  </div>
                  <div className="fd-switch-row">
                    <div><Text strong>作为查询条件</Text><Text type="secondary">{isTitleField ? "标题固定用于流程清单的基础查询，不能关闭" : "用于流程清单的高级查询"}</Text></div>
                    <Switch disabled={isTitleField || selectedField.type === "richtext"} checked={isTitleField || selectedField.queryable} onChange={(checked) => updateField({ queryable: checked })} />
                  </div>
                  <div className="fd-switch-row">
                    <div><Text strong>导出到 Excel</Text><Text type="secondary">作为流程清单导出文件中的字段</Text></div>
                    <Switch checked={selectedField.exportVisible ?? selectedField.listVisible} onChange={(checked) => updateField({ exportVisible: checked })} />
                  </div>
                  <div className="fd-switch-row">
                    <div><Text strong>在任务中心显示</Text><Text type="secondary">列名使用字段名称，并按表单顺序自动排列</Text></div>
                    <Switch disabled={selectedField.type === "richtext"} checked={Boolean(selectedField.taskVisible)} onChange={(checked) => updateField({ taskVisible: checked })} />
                  </div>
                </div>
              </Form>
            ) : propertyMode === "field" ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个字段后配置属性" />
            ) : (
              <div className="fd-system-fields-panel">
                <Alert
                  type="info"
                  showIcon
                  message="系统字段展示"
                  description="分别控制系统自动生成的信息在任务中心、流程清单和 Excel 导出中的使用。配置跟随流程版本保存。"
                />
                <div className="fd-system-field-list">
                  {systemListFields.map((field) => (
                    <div className="fd-system-field-card" key={field.key}>
                      <div className="fd-system-field-card__head">
                        <Text strong>{field.label}</Text>
                        <Tag bordered={false}>系统生成</Tag>
                      </div>
                      <Text className="fd-system-field-card__description" type="secondary">{field.description}</Text>
                      <div className="fd-system-field-targets">
                        <label>
                          <span>任务中心</span>
                          <Switch
                            size="small"
                            checked={field.taskVisible}
                            onChange={(taskVisible) => updateSystemListField(field.key, { taskVisible })}
                          />
                        </label>
                        <label>
                          <span>流程清单</span>
                          <Switch
                            size="small"
                            checked={field.processListVisible}
                            onChange={(processListVisible) => updateSystemListField(field.key, { processListVisible })}
                          />
                        </label>
                        <label>
                          <span>Excel 导出</span>
                          <Switch
                            size="small"
                            checked={field.exportVisible ?? field.processListVisible}
                            onChange={(exportVisible) => updateSystemListField(field.key, { exportVisible })}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
                <Text className="fd-system-fields-note" type="secondary">
                  操作列始终保留。系统字段不属于发起表单，发起人和审核人不能修改。
                </Text>
              </div>
            )}
          </div>
        </aside>
      </div>

      <Modal
        className="fd-preview-modal"
        width={960}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        afterOpenChange={(open) => {
          if (!open) return;
          previewForm.resetFields();
          previewForm.setFieldsValue(previewInitialValues);
        }}
        title={
          <Space>
            <EyeOutlined />
            <span>表单预览</span>
            <Tag color="blue">发起人视角</Tag>
          </Space>
        }
        footer={
          <Space>
            <Button onClick={() => setPreviewOpen(false)}>返回编辑</Button>
            <Button
              type="primary"
              onClick={async () => {
                try {
                  await previewForm.validateFields();
                  messageApi.success("表单校验通过，本次预览不会创建流程实例");
                } catch {
                  messageApi.warning("请先完成必填项后再校验");
                }
              }}
            >
              校验表单
            </Button>
          </Space>
        }
      >
        <div className="fd-preview-sheet">
          <div className="fd-preview-heading">
            <div>
              <Title level={3}>{workflowName}</Title>
              <Text type="secondary">流程编号将在提交后由系统自动生成</Text>
            </div>
            <Tag color="processing">{workflowName}</Tag>
          </div>
          <Divider />
          <Form form={previewForm} initialValues={previewInitialValues} layout="vertical">
            {visiblePreviewFields.map((field) => (
              <Form.Item
                key={field.id}
                name={field.id}
                label={field.label}
                required={field.required}
                extra={field.description || undefined}
                rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
              >
                <FieldControl field={field} interactive />
              </Form.Item>
            ))}
          </Form>
        </div>
      </Modal>
    </div>
  );
};

const FormDesignerPage = () => {
  const navigate = useNavigate();
  const { definitionId = "" } = useParams<{ definitionId: string }>();
  const [searchParams] = useSearchParams();
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === definitionId));
  const versionId = searchParams.get("versionId") ?? definition?.versions[0]?.id ?? "";
  const version = definition?.versions.find((item) => item.id === versionId);
  if (!definition || !version) {
    return <Alert type="error" showIcon message="流程版本不存在" description="表单设计必须绑定到一个明确的正式版本。" action={<AppBackButton onClick={() => navigate("/admin/processes")} />} />;
  }
  if (!canEditVersion(definition, version)) {
    return <Alert type="info" showIcon message={`${version.version} 为只读版本`} description={definition.publishedVersionId === version.id ? "已发布版本不能直接修改。没有实例时可先取消发布；已有实例时请复制新建版本。" : "该版本已经创建过流程实例，只能查看或复制新建版本。"} action={<AppBackButton onClick={() => navigate(`/admin/processes/${definitionId}/versions`)} />} />;
  }
  return <FormDesignerWorkspace key={`${definitionId}-${versionId}`} definitionId={definitionId} versionId={versionId} />;
};

export default FormDesignerPage;
