import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  InboxOutlined,
  PlusOutlined,
  SendOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Cascader,
  Checkbox,
  Divider,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  Upload,
  message,
  type TableProps,
  type UploadFile,
  type UploadProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { ExcelPdfPreviewModal } from "../components/ExcelPdfPreviewModal";
import { RichTextEditor } from "../components/RichTextEditor";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import type { AttachmentRecord, DirectoryUser } from "../api/contracts";
import type { ProcessInstance } from "../data/types";
import { flowPilotApi } from "../api/flowPilotApi";
import { cacheProcessRuntime } from "../api/entityCache";
import { effectiveGroupMemberIds, resolveWorkflowGroupLabel, resolveWorkflowGroupLabels, useIdentityStore } from "../state/useIdentityStore";
import type { ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import {
  applyDesignerFieldVisibility,
  buildFlowLevels,
  ensureProcessTitleField,
  isDesignerFieldVisible,
  normalizeDesignerFormValues,
  normalizeDesignerFieldValue,
  rejectionHandlingLabel,
  type StoredDesignerField,
  type StoredDesignerTableColumn,
} from "../utils/designerStorage";
import { designerChoiceOptionsToAntd } from "../utils/designerOptions";
import { buildCopiedInstanceInitialValues } from "../utils/instanceCopy";
import { convertXlsxToPdf, type ExcelPdfConversionResult } from "../utils/excelToPdf";

type DynamicRow = Record<string, string | string[] | undefined> & { key: string };
type DynamicFormValues = Record<string, unknown> & { firstAssignee?: string };

interface ConfiguredProcessStartPageProps {
  definition: ProcessDefinition;
  version: ProcessVersion;
  copySource?: ProcessInstance;
  copySourceVersion?: ProcessVersion;
  assigneeCandidatesByNode?: Record<string, DirectoryUser[]>;
  firstAssigneeCandidates?: DirectoryUser[];
}

const createRow = (columns: StoredDesignerTableColumn[]): DynamicRow => ({
  key: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  ...Object.fromEntries(columns.map((column) => [column.id, column.defaultValue ?? (column.type === "checkbox" ? [] : "")])),
});

function TableCellEditor({
  column,
  value,
  onChange,
}: {
  column: StoredDesignerTableColumn;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  const options = designerChoiceOptionsToAntd(column.options);
  if (column.type === "select") {
    return <Select value={typeof value === "string" ? value : undefined} options={options} placeholder="请选择" onChange={onChange} />;
  }
  if (column.type === "radio") {
    return <Radio.Group value={value} options={options} onChange={(event) => onChange(event.target.value)} />;
  }
  if (column.type === "checkbox") {
    return <Checkbox.Group value={Array.isArray(value) ? value : []} options={options} onChange={(next) => onChange(next as string[])} />;
  }
  return <Input value={typeof value === "string" ? value : ""} placeholder="请输入" onChange={(event) => onChange(event.target.value)} />;
}

function ConfiguredTableInput({
  field,
  value,
  onChange,
}: {
  field: StoredDesignerField;
  value?: DynamicRow[];
  onChange?: (value: DynamicRow[]) => void;
}) {
  const columns = field.columns ?? [];
  const rows = value?.length ? value : [createRow(columns)];
  const updateCell = (key: string, columnId: string, nextValue: string | string[]) => {
    onChange?.(rows.map((row) => row.key === key ? { ...row, [columnId]: nextValue } : row));
  };
  const tableColumns: TableProps<DynamicRow>["columns"] = [
    { title: "序号", width: 58, align: "center", render: (_, __, index) => index + 1 },
    ...columns.map((column) => ({
      title: column.required ? `${column.label} *` : column.label,
      dataIndex: column.id,
      width: column.width ?? 160,
      align: column.align ?? "left",
      render: (cellValue: string | string[] | undefined, row: DynamicRow) => (
        <TableCellEditor column={column} value={cellValue} onChange={(nextValue) => updateCell(row.key, column.id, nextValue)} />
      ),
    })),
    {
      title: "操作",
      width: 92,
      fixed: "right",
      align: "center",
      render: (_: unknown, row: DynamicRow) => (
        <Space size={2}>
          <Button
            type="text"
            icon={<CopyOutlined />}
            aria-label="复制此行"
            onClick={() => {
              const index = rows.findIndex((item) => item.key === row.key);
              const next = [...rows];
              next.splice(index + 1, 0, { ...row, key: `row-${Date.now()}` });
              onChange?.(next);
            }}
          />
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除此行"
            disabled={rows.length === 1}
            onClick={() => onChange?.(rows.filter((item) => item.key !== row.key))}
          />
        </Space>
      ),
    },
  ];

  return (
    <div className="configured-table-field">
      <Table<DynamicRow> rowKey="key" columns={tableColumns} dataSource={rows} pagination={false} size="small" scroll={{ x: 760 }} />
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => onChange?.([...rows, createRow(columns)])}>新增一行</Button>
    </div>
  );
}

export function DynamicFieldControl({
  field,
  value,
  onChange,
  convertingExcel,
  onConvertExcel,
  onRemoveUploadedAttachment,
}: {
  field: StoredDesignerField;
  value?: unknown;
  onChange?: (value: unknown) => void;
  convertingExcel?: boolean;
  onConvertExcel?: (field: StoredDesignerField, file: File) => void;
  onRemoveUploadedAttachment?: (file: UploadFile<AttachmentRecord>) => Promise<boolean>;
}) {
  const options = designerChoiceOptionsToAntd(field.options);
  if (field.type === "richtext") {
    return <RichTextEditor value={typeof value === "string" ? value : ""} onChange={(next) => onChange?.(next)} placeholder={field.placeholder} minHeight={180} />;
  }
  if (field.type === "select") return <Select value={typeof value === "string" ? value : undefined} options={options} placeholder={field.placeholder} onChange={onChange} />;
  if (field.type === "cascader") return <Cascader value={Array.isArray(value) ? value as string[] : undefined} options={options} placeholder={field.placeholder} onChange={onChange} />;
  if (field.type === "radio") return <Radio.Group value={value} options={options} onChange={(event) => onChange?.(event.target.value)} />;
  if (field.type === "checkbox") return <Checkbox.Group value={Array.isArray(value) ? value as string[] : []} options={options} onChange={onChange} />;
  if (field.type === "attachment") {
    const inlinePdf = field.attachment?.inlinePdf ?? true;
    const excelToPdf = Boolean(field.attachment?.excelToPdf);
    const allowedExtensions = field.attachment?.allowedExtensions ?? (inlinePdf ? ["pdf"] : []);
    const maxCount = inlinePdf ? 1 : field.attachment?.maxCount ?? 20;
    const uploadProps: UploadProps = {
      multiple: !inlinePdf && maxCount > 1,
      maxCount,
      beforeUpload: (file) => {
        const maxSize = field.attachment?.maxSizeMb ?? 100;
        const extension = file.name.toLowerCase().split(".").pop() ?? "";
        if (file.size / 1024 / 1024 > maxSize) {
          message.error(`${file.name} 超过 ${maxSize} MB 限制`);
          return Upload.LIST_IGNORE;
        }
        if (extension === "xls") {
          message.error("浏览器端转换仅支持 .xlsx，请先用 Excel 另存为 .xlsx 文件");
          return Upload.LIST_IGNORE;
        }
        if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
          message.error(`${file.name} 的格式不在允许范围内（${allowedExtensions.join("、")}）`);
          return Upload.LIST_IGNORE;
        }
        if (inlinePdf && extension !== "pdf" && !(excelToPdf && ["xls", "xlsx"].includes(extension))) {
          message.error(`${file.name} 不是有效的 PDF 或可转换 Excel 文件`);
          return Upload.LIST_IGNORE;
        }
        if (excelToPdf && extension === "xlsx") {
          onConvertExcel?.(field, file);
          return Upload.LIST_IGNORE;
        }
        return false;
      },
      onRemove: onRemoveUploadedAttachment,
    };
    return (
      <Upload.Dragger
        {...uploadProps}
        disabled={convertingExcel}
        fileList={Array.isArray(value) ? value as UploadProps["fileList"] : []}
        onChange={({ fileList }) => onChange?.(inlinePdf ? fileList.slice(-1) : fileList)}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">{convertingExcel ? "正在转换 Excel…" : inlinePdf && Array.isArray(value) && value.length ? "点击或拖拽上传新文件并替换原文件" : "点击或拖拽上传附件"}</p>
        <p className="ant-upload-hint">{inlinePdf ? "仅保留 1 个文件，继续上传将替换原文件" : `最多 ${maxCount} 个`}，单个不超过 {field.attachment?.maxSizeMb ?? 100} MB{excelToPdf ? `；.xlsx 在浏览器转为 PDF 并预览（源文件不超过 ${Math.min(field.attachment?.maxSizeMb ?? 100, 25)} MB），最多 ${field.attachment?.maxPreviewPages ?? 1} 页` : inlinePdf ? "；PDF 可在流程页面预览" : ""}</p>
      </Upload.Dragger>
    );
  }
  if (field.type === "table") return <ConfiguredTableInput field={field} value={Array.isArray(value) ? value as DynamicRow[] : undefined} onChange={onChange as ((value: DynamicRow[]) => void) | undefined} />;
  if (field.type === "text" && field.multiline) {
    return <Input.TextArea value={typeof value === "string" ? value : ""} placeholder={field.placeholder} maxLength={2000} autoSize={{ minRows: 3, maxRows: 8 }} onChange={(event) => onChange?.(event.target.value)} />;
  }
  return <Input value={typeof value === "string" ? value : ""} placeholder={field.placeholder} maxLength={500} onChange={(event) => onChange?.(event.target.value)} />;
}

export function ConfiguredProcessStartPage({
  definition,
  version,
  copySource,
  copySourceVersion,
  assigneeCandidatesByNode,
  firstAssigneeCandidates,
}: ConfiguredProcessStartPageProps) {
  const navigate = useNavigate();
  const identityUsers = useIdentityStore((state) => state.users);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const starterGroupLabels = resolveWorkflowGroupLabels(workflowGroups, version.basic.starterGroups);
  const assigneeGroupLabels = resolveWorkflowGroupLabels(workflowGroups, version.basic.assigneeGroups ?? []);
  const formSnapshot = version.snapshot.form;
  const flowSnapshot = version.snapshot.flow;
  const fields = ensureProcessTitleField(formSnapshot.fields);
  const initiatorFields = fields.filter((field) => (field.inputStage ?? "initiator") !== "reviewer");
  const approvalStages = useMemo(() => {
    const nodeById = new Map(flowSnapshot.nodes.map((node) => [node.id, node]));
    return buildFlowLevels(flowSnapshot.nodes, flowSnapshot.edges)
      .map((level) => level.flatMap((nodeId) => {
        const node = nodeById.get(nodeId);
        return node?.data?.kind === "approval" && node.data.label ? [node] : [];
      }))
      .filter((level) => level.length > 0);
  }, [flowSnapshot]);
  const approvalNodes = useMemo(() => approvalStages.flat(), [approvalStages]);
  const approvalStageText = useMemo(() => approvalStages.map((stage, index) => {
    const nodeText = stage.map((node) => {
      const handling = node.data?.handlingMode === "confirmation" ? "确认" : "审批";
      const conditional = node.data?.activationCondition?.rules.length ? " · 条件执行" : "";
      return `${node.data?.label}（${handling}${conditional}）`;
    }).join("、");
    return `阶段${index + 1}${stage.length > 1 ? "（并行）" : ""}：${nodeText}`;
  }), [approvalStages]);
  const peopleOptions = (groupIds: string[], candidates?: DirectoryUser[]) => {
    const memberIds = new Set(groupIds.flatMap(effectiveGroupMemberIds));
    const users = candidates ?? identityUsers.filter((user) => memberIds.has(user.id));
    return users.map((user) => ({
      value: user.id,
      label: [user.name, user.departmentPath, user.jobTitle].filter(Boolean).join(" · "),
    }));
  };
  const [form] = Form.useForm<DynamicFormValues>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedValues, setSubmittedValues] = useState<DynamicFormValues>({});
  const [dirty, setDirty] = useState(Boolean(copySource));
  const [excelDialog, setExcelDialog] = useState<{
    field: StoredDesignerField;
    sourceName: string;
    result?: ExcelPdfConversionResult;
    error?: string;
    converting: boolean;
  }>();
  const [confirmingExcelUpload, setConfirmingExcelUpload] = useState(false);
  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty,
    title: "发起内容尚未提交",
    description: "离开后，当前填写的表单、附件和人员选择将丢失。",
  });
  const initialValues = useMemo(() => {
    if (copySource && copySourceVersion) {
      return buildCopiedInstanceInitialValues(
        initiatorFields,
        copySourceVersion.snapshot.form.fields,
        copySource.formValues ?? {},
        copySource.title,
      );
    }
    return Object.fromEntries(initiatorFields.map((field) => [
      field.id,
      field.type === "attachment"
        ? []
        : field.type === "table"
          ? [createRow(field.columns ?? [])]
          : normalizeDesignerFieldValue(field, field.defaultValue ?? (field.type === "checkbox" ? [] : "")),
    ]));
  }, [copySource, copySourceVersion, initiatorFields]);
  const watchedValues = Form.useWatch([], form) as DynamicFormValues | undefined;
  const visibleInitiatorFields = initiatorFields.filter((field) =>
    isDesignerFieldVisible(field, watchedValues ?? initialValues),
  );

  const runtimeValues = (values: DynamicFormValues, uploadedByField: Record<string, AttachmentRecord[]>) => applyDesignerFieldVisibility(
    fields,
    normalizeDesignerFormValues(fields, Object.fromEntries(fields.map((field) => {
      const key = field.id;
      const value = (field.inputStage ?? "initiator") === "reviewer"
        ? field.type === "table" || field.type === "attachment"
          ? []
          : field.defaultValue ?? (field.type === "checkbox" ? [] : "")
        : values[key];
      if (field?.type === "attachment") {
        return [key, uploadedByField[key] ?? []];
      }
      return [key, value && typeof value === "object" && "toJSON" in value
        ? (value as { toJSON: () => unknown }).toJSON()
        : value];
    }))),
  );

  const beginExcelConversion = async (field: StoredDesignerField, file: File) => {
    setExcelDialog({ field, sourceName: file.name, converting: true });
    try {
      const result = await convertXlsxToPdf(file, field.attachment?.maxPreviewPages ?? 1);
      setExcelDialog({ field, sourceName: file.name, result, converting: false });
    } catch (error) {
      setExcelDialog({ field, sourceName: file.name, error: error instanceof Error ? error.message : "Excel 转 PDF 失败", converting: false });
    }
  };

  const confirmExcelUpload = async () => {
    if (!excelDialog?.result) return;
    const maxSizeMb = excelDialog.field.attachment?.maxSizeMb ?? 100;
    if (excelDialog.result.file.size > maxSizeMb * 1024 * 1024) {
      message.error(`生成的 PDF 超过 ${maxSizeMb} MB 限制，请减少工作表内容或最大页数`);
      return;
    }
    setConfirmingExcelUpload(true);
    try {
      const record = await flowPilotApi.attachments.upload(excelDialog.result.file, {
        definitionId: definition.id,
        versionId: version.id,
        fieldId: excelDialog.field.id,
      });
      const current = form.getFieldValue(excelDialog.field.id) as UploadFile<AttachmentRecord>[] | undefined;
      const replacedRecords = (current ?? []).flatMap((file) => file.response?.id ? [file.response] : []);
      form.setFieldValue(excelDialog.field.id, [{
        uid: record.id,
        name: record.name,
        size: record.size,
        type: record.contentType,
        status: "done",
        response: record,
      } satisfies UploadFile<AttachmentRecord>]);
      setDirty(true);
      setExcelDialog(undefined);
      await Promise.allSettled(replacedRecords.map((item) => flowPilotApi.attachments.remove(item.id)));
      message.success("PDF 已确认并暂存，提交流程后正式生效");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "PDF 上传失败，请稍后重试");
    } finally {
      setConfirmingExcelUpload(false);
    }
  };

  const removeUploadedAttachment = async (file: UploadFile<AttachmentRecord>) => {
    if (!file.response?.id) return true;
    try {
      await flowPilotApi.attachments.remove(file.response.id);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : "暂存附件删除失败");
      return false;
    }
  };

  const renderField = (field: StoredDesignerField) => {
    const wide = ["richtext", "attachment", "table"].includes(field.type);
    const rules = field.type === "table"
      ? [{
          validator: async (_: unknown, rows?: DynamicRow[]) => {
            if (field.required && !rows?.length) throw new Error(`请填写${field.label}`);
            const missing = rows?.some((row) => (field.columns ?? []).some((column) => column.required && !row[column.id]?.length));
            if (missing) throw new Error(`请完整填写${field.label}中的必填列`);
          },
        }]
      : [{ required: field.required, message: `请填写${field.label}` }];
    return (
      <Form.Item
        key={field.id}
        className={wide ? "field-wide" : undefined}
        name={field.id}
        label={field.label}
        extra={field.description}
        rules={rules}
      >
        <DynamicFieldControl
          field={field}
          convertingExcel={excelDialog?.field.id === field.id && excelDialog.converting}
          onConvertExcel={(targetField, file) => void beginExcelConversion(targetField, file)}
          onRemoveUploadedAttachment={removeUploadedAttachment}
        />
      </Form.Item>
    );
  };

  const prepareSubmit = (values: DynamicFormValues) => {
    setSubmittedValues(values);
    setConfirmOpen(true);
  };

  const confirmSubmit = async () => {
    setSubmitting(true);
    const uploadedRecords: AttachmentRecord[] = [];
    try {
      const uploadedByField: Record<string, AttachmentRecord[]> = {};
      for (const field of fields.filter((item) => item.type === "attachment" && isDesignerFieldVisible(item, submittedValues))) {
        const files = Array.isArray(submittedValues[field.id]) ? submittedValues[field.id] as UploadFile<AttachmentRecord>[] : [];
        const records: AttachmentRecord[] = [];
        for (const file of files) {
          if (file.response?.id) {
            records.push(file.response);
            continue;
          }
          const source = file.originFileObj;
          if (!source) throw new Error(`无法读取附件“${file.name}”，请重新选择文件`);
          const record = await flowPilotApi.attachments.upload(source, {
            definitionId: definition.id,
            versionId: version.id,
            fieldId: field.id,
          });
          records.push(record);
          uploadedRecords.push(record);
        }
        uploadedByField[field.id] = records;
      }
      const values = runtimeValues(submittedValues, uploadedByField);
      const assigneeByNode = Object.fromEntries(
        approvalNodes.map((node) => [node.id, String(submittedValues[`reviewer-${node.id}`] ?? "") || undefined]),
      );
      const attachmentIdsByField = Object.fromEntries(
        Object.entries(uploadedByField).map(([fieldId, records]) => [fieldId, records.map((record) => record.id)]),
      );
      const created = await flowPilotApi.instances.create({
        definitionId: definition.id,
        formValues: values,
        copySourceInstanceId: copySource?.id,
        assigneeByNode,
        firstAssigneeId: submittedValues.firstAssignee,
        attachmentIds: Object.values(uploadedByField).flatMap((records) => records.map((record) => record.id)),
        attachmentIdsByField,
      });
      cacheProcessRuntime(created.instance, created.tasks);
      setSubmitting(false);
      setConfirmOpen(false);
      setDirty(false);
      allowNextNavigation();
      message.success(definition.type === "free"
        ? "事项已创建并生成首位受理人的待办"
        : "流程已提交，审批或确认节点已按条件和发布版本生成待办");
      navigate("/launch");
    } catch (error) {
      await Promise.allSettled(uploadedRecords.map((record) => flowPilotApi.attachments.remove(record.id)));
      setSubmitting(false);
      message.error(error instanceof Error ? error.message : "流程提交失败，请稍后重试");
    }
  };

  return (
    <div className="page-stack process-start-page">
      <div className="process-start-toolbar">
        <div className="process-start-title">
          <AppBackButton onClick={() => navigate(copySource ? `/processes?definitionId=${encodeURIComponent(definition.id)}` : "/launch")} />
          <Divider orientation="vertical" />
          <div>
            <strong>{version.basic.name}</strong>
            <span>{version.version} · {starterGroupLabels.join("、")}</span>
          </div>
        </div>
        <Button type="primary" icon={<SendOutlined />} onClick={() => form.submit()}>提交</Button>
      </div>

      {copySource ? <Alert
        type="info"
        showIcon
        title={`正在复制新建：${copySource.code}`}
        description="已带入来源流程中与当前发布版本兼容的最终表单内容，附件、审批记录和人员选择未复制。当前尚未创建新流程，也未占用实例编号；请修改并确认无误后点击提交。"
      /> : null}

      <Card className="start-progress-card">
        <div className="start-progress-copy">
          <Tag color="processing">发布版本 {version.version}</Tag>
          <Typography.Text>{version.basic.description}</Typography.Text>
        </div>
        <Steps
          current={0}
          responsive={false}
          items={definition.type === "free"
            ? [
                { title: "填写并创建", description: "选择首位受理人" },
                { title: "持续协作", description: "回复并选择下一人" },
                { title: "手动关闭", description: "允许填写理由后重开" },
              ]
            : [
                { title: "填写并提交", description: starterGroupLabels.join("、") },
                {
                  title: approvalNodes.length > 0 && approvalNodes.every((node) => node.data?.handlingMode === "confirmation") ? "流程确认" : "流程处理",
                  description: approvalStageText.length ? (
                    <span className="start-flow-route" title={approvalStageText.join(" → ")}>
                      {approvalStageText.map((stage, index) => (
                        <span key={stage}>
                          {index > 0 ? <i aria-hidden="true">→</i> : null}
                          <span>{stage}</span>
                        </span>
                      ))}
                    </span>
                  ) : "按当前拓扑",
                },
                { title: "流程结束", description: "全部前置节点通过或确认" },
              ]}
        />
      </Card>

      <Form<DynamicFormValues>
        form={form}
        layout="vertical"
        initialValues={initialValues}
        onValuesChange={() => setDirty(true)}
        onFinish={prepareSubmit}
      >
        <div className="process-start-layout">
          <main className="process-start-main">
            <Card className="form-card" title="初始表单" extra={<Typography.Text type="secondary">实例编号提交后由系统生成</Typography.Text>}>
              {initiatorFields.length ? <div className="start-form-grid">{visibleInitiatorFields.map(renderField)}</div> : <Alert type="warning" showIcon title="当前发布版本没有可由发起人填写的字段" />}
            </Card>
          </main>

          <aside className="process-start-aside">
            {definition.type === "approval" ? (
              <Card className="approval-card start-reviewer-card" title="审批与确认节点" extra={<TeamOutlined />}>
                <Alert type="info" showIcon title={`将按当前版本创建 ${approvalNodes.length} 个处理节点`} description="指定人员仅是默认责任人，同一流程权限组的其他成员仍可代办。" />
                <div className="start-reviewer-list">
                  {approvalNodes.map((node) => (
                    <div className="start-reviewer-item" key={node.id}>
                      <div className="start-reviewer-head">
                        <span><CheckCircleOutlined /><strong>{node.data?.label}</strong></span>
                        <Space size={4}>
                          <Tag variant="filled" color={node.data?.handlingMode === "confirmation" ? "cyan" : "blue"}>{node.data?.handlingMode === "confirmation" ? "确认" : "审批"}</Tag>
                          <Tag variant="filled">{node.data?.specifyAssignee ? "可指定人员" : "组内任一人"}</Tag>
                        </Space>
                      </div>
                      {node.data?.specifyAssignee && (
                        <Form.Item name={`reviewer-${node.id}`} rules={[{ required: true, message: `请选择${node.data.label}默认责任人` }]}>
                          <Select
                            showSearch
                            optionFilterProp="label"
                            placeholder="搜索符合权限组的人员"
                            options={peopleOptions(
                              node.data?.permissionGroup ? [node.data.permissionGroup] : [],
                              assigneeCandidatesByNode?.[node.id],
                            )}
                          />
                        </Form.Item>
                      )}
                      <span className="start-permission-name"><TeamOutlined /> {node.data?.permissionGroup ? resolveWorkflowGroupLabel(workflowGroups, node.data.permissionGroup) : "尚未配置流程权限组"}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : (
              <Card className="approval-card start-reviewer-card" title="首位受理人" extra={<TeamOutlined />}>
                <Alert type="info" showIcon title="受理后可继续选择下一位受理人" description={`候选人来自：${assigneeGroupLabels.join("、") || "尚未配置受理流程权限组"}`} />
                <Form.Item name="firstAssignee" label="选择受理人" rules={[{ required: true, message: "请选择首位受理人" }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="搜索并选择首位受理人"
                    options={peopleOptions(version.basic.assigneeGroups ?? [], firstAssigneeCandidates)}
                  />
                </Form.Item>
              </Card>
            )}

            <Card className="approval-card start-rule-card" title="当前版本规则">
              <ul>
                {definition.type === "approval" ? (
                  <>
                    <li><strong>实际拓扑</strong><span>按流程设计器保存的节点与连线创建待办。</span></li>
                    <li><strong>驳回处理</strong><span>{rejectionHandlingLabel(flowSnapshot?.meta?.rejectionHandling)}</span></li>
                    <li><strong>内容锁定</strong><span>首位审核人提交前可修改；出现审核动作后自动锁定。</span></li>
                  </>
                ) : (
                  <>
                    <li><strong>连续流转</strong><span>每位受理人处理后可以选择下一位受理人。</span></li>
                    <li><strong>手动关闭</strong><span>关闭后锁定；填写理由重新打开后恢复编辑。</span></li>
                    <li><strong>历史可改</strong><span>每个人可以继续编辑自己此前提交的内容。</span></li>
                  </>
                )}
              </ul>
            </Card>
          </aside>
        </div>
      </Form>

      <Modal
        open={confirmOpen}
        title="确认提交"
        okText="确认提交"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={confirmSubmit}
        onCancel={() => setConfirmOpen(false)}
      >
        <Typography.Paragraph style={{ marginBottom: 0 }}>确定提交当前填写内容吗？</Typography.Paragraph>
      </Modal>
      <ExcelPdfPreviewModal
        sourceName={excelDialog?.sourceName}
        result={excelDialog?.result}
        converting={Boolean(excelDialog?.converting)}
        confirming={confirmingExcelUpload}
        error={excelDialog?.error}
        onCancel={() => setExcelDialog(undefined)}
        onConfirm={() => void confirmExcelUpload()}
      />
      {guard}
    </div>
  );
}
