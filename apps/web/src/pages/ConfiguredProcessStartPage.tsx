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
import { RichTextEditor } from "../components/RichTextEditor";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import type { AttachmentRecord } from "../api/contracts";
import type { ProcessInstance } from "../data/types";
import { flowPilotApi } from "../api/flowPilotApi";
import { effectiveGroupMemberIds, useIdentityStore } from "../state/useIdentityStore";
import type { ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import {
  applyDesignerFieldVisibility,
  ensureProcessTitleField,
  isDesignerFieldVisible,
  rejectionHandlingLabel,
  type StoredDesignerField,
  type StoredDesignerTableColumn,
} from "../utils/designerStorage";
import { buildCopiedInstanceInitialValues } from "../utils/instanceCopy";

type DynamicRow = Record<string, string | string[] | undefined> & { key: string };
type DynamicFormValues = Record<string, unknown> & { firstAssignee?: string };

interface ConfiguredProcessStartPageProps {
  definition: ProcessDefinition;
  version: ProcessVersion;
  copySource?: ProcessInstance;
  copySourceVersion?: ProcessVersion;
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
  const options = (column.options ?? []).map((item) => ({ value: item, label: item }));
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

function DynamicFieldControl({
  field,
  value,
  onChange,
}: {
  field: StoredDesignerField;
  value?: unknown;
  onChange?: (value: unknown) => void;
}) {
  const options = (field.options ?? []).map((item) => ({ value: item, label: item }));
  if (field.type === "richtext") {
    return <RichTextEditor value={typeof value === "string" ? value : ""} onChange={(next) => onChange?.(next)} placeholder={field.placeholder || "请输入内容"} minHeight={180} />;
  }
  if (field.type === "select") return <Select value={typeof value === "string" ? value : undefined} options={options} placeholder={field.placeholder || "请选择"} onChange={onChange} />;
  if (field.type === "cascader") return <Cascader value={Array.isArray(value) ? value as string[] : undefined} options={options} placeholder={field.placeholder || "请选择"} onChange={onChange} />;
  if (field.type === "radio") return <Radio.Group value={value} options={options} onChange={(event) => onChange?.(event.target.value)} />;
  if (field.type === "checkbox") return <Checkbox.Group value={Array.isArray(value) ? value as string[] : []} options={options} onChange={onChange} />;
  if (field.type === "attachment") {
    const inlinePdf = field.attachment?.inlinePdf ?? true;
    const maxCount = inlinePdf ? 1 : field.attachment?.maxCount ?? 20;
    const uploadProps: UploadProps = {
      multiple: !inlinePdf && maxCount > 1,
      maxCount,
      beforeUpload: (file) => {
        const maxSize = field.attachment?.maxSizeMb ?? 100;
        if (file.size / 1024 / 1024 > maxSize) {
          message.error(`${file.name} 超过 ${maxSize} MB 限制`);
          return Upload.LIST_IGNORE;
        }
        if (inlinePdf && (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type !== "application/pdf"))) {
          message.error(`${file.name} 不是有效的 PDF 文件`);
          return Upload.LIST_IGNORE;
        }
        return false;
      },
    };
    return (
      <Upload.Dragger
        {...uploadProps}
        fileList={Array.isArray(value) ? value as UploadProps["fileList"] : []}
        onChange={({ fileList }) => onChange?.(inlinePdf ? fileList.slice(-1) : fileList)}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">{inlinePdf && Array.isArray(value) && value.length ? "点击或拖拽上传新文件并替换原文件" : "点击或拖拽上传附件"}</p>
        <p className="ant-upload-hint">{inlinePdf ? "仅保留 1 个文件，继续上传将替换原文件" : `最多 ${maxCount} 个`}，单个不超过 {field.attachment?.maxSizeMb ?? 100} MB{inlinePdf ? "；PDF 可在流程页面预览" : ""}</p>
      </Upload.Dragger>
    );
  }
  if (field.type === "table") return <ConfiguredTableInput field={field} value={Array.isArray(value) ? value as DynamicRow[] : undefined} onChange={onChange as ((value: DynamicRow[]) => void) | undefined} />;
  return <Input value={typeof value === "string" ? value : ""} placeholder={field.placeholder || "请输入"} maxLength={500} onChange={(event) => onChange?.(event.target.value)} />;
}

export function ConfiguredProcessStartPage({ definition, version, copySource, copySourceVersion }: ConfiguredProcessStartPageProps) {
  const navigate = useNavigate();
  const identityUsers = useIdentityStore((state) => state.users);
  useIdentityStore((state) => state.workflowGroups);
  const formSnapshot = version.snapshot.form;
  const flowSnapshot = version.snapshot.flow;
  const fields = ensureProcessTitleField(formSnapshot.fields);
  const initiatorFields = fields.filter((field) => (field.inputStage ?? "initiator") !== "reviewer");
  const approvalNodes = useMemo(
    () => flowSnapshot.nodes.filter((node) => node.data?.kind === "approval" && node.data.label),
    [flowSnapshot],
  );
  const peopleOptions = (groupIds: string[]) => {
    const memberIds = new Set(groupIds.flatMap(effectiveGroupMemberIds));
    return identityUsers
      .filter((user) => memberIds.has(user.id))
      .map((user) => ({ value: user.id, label: `${user.name} · ${user.departmentPath} · ${user.jobTitle}` }));
  };
  const [form] = Form.useForm<DynamicFormValues>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedValues, setSubmittedValues] = useState<DynamicFormValues>({});
  const [dirty, setDirty] = useState(Boolean(copySource));
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
          : field.defaultValue ?? (field.type === "checkbox" ? [] : ""),
    ]));
  }, [copySource, copySourceVersion, initiatorFields]);
  const watchedValues = Form.useWatch([], form) as DynamicFormValues | undefined;
  const visibleInitiatorFields = initiatorFields.filter((field) =>
    isDesignerFieldVisible(field, watchedValues ?? initialValues),
  );

  const runtimeValues = (values: DynamicFormValues, uploadedByField: Record<string, AttachmentRecord[]>) => applyDesignerFieldVisibility(
    fields,
    Object.fromEntries(fields.map((field) => {
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
    })),
  );

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
        <DynamicFieldControl field={field} />
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
        const files = Array.isArray(submittedValues[field.id]) ? submittedValues[field.id] as UploadFile[] : [];
        const records: AttachmentRecord[] = [];
        for (const file of files) {
          const source = file.originFileObj;
          if (!source) throw new Error(`无法读取附件“${file.name}”，请重新选择文件`);
          const record = await flowPilotApi.attachments.upload(source);
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
      await flowPilotApi.instances.create({
        definitionId: definition.id,
        formValues: values,
        copySourceInstanceId: copySource?.id,
        assigneeByNode,
        firstAssigneeId: submittedValues.firstAssignee,
        attachmentIds: uploadedRecords.map((record) => record.id),
        attachmentIdsByField,
      });
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
          <Divider type="vertical" />
          <div>
            <strong>{version.basic.name}</strong>
            <span>{version.version} · {version.basic.starterGroups.join("、")}</span>
          </div>
        </div>
        <Button type="primary" icon={<SendOutlined />} onClick={() => form.submit()}>提交</Button>
      </div>

      {copySource ? <Alert
        type="info"
        showIcon
        message={`正在复制新建：${copySource.code}`}
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
                { title: "填写并提交", description: version.basic.starterGroups.join("、") },
                {
                  title: approvalNodes.length > 0 && approvalNodes.every((node) => node.data?.handlingMode === "confirmation") ? "流程确认" : "流程处理",
                  description: approvalNodes.map((node) => `${node.data?.label}${node.data?.handlingMode === "confirmation" ? "（确认）" : "（审批）"}`).join(" / ") || "按当前拓扑",
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
              {initiatorFields.length ? <div className="start-form-grid">{visibleInitiatorFields.map(renderField)}</div> : <Alert type="warning" showIcon message="当前发布版本没有可由发起人填写的字段" />}
            </Card>
          </main>

          <aside className="process-start-aside">
            {definition.type === "approval" ? (
              <Card className="approval-card start-reviewer-card" title="审批与确认节点" extra={<TeamOutlined />}>
                <Alert type="info" showIcon message={`将按当前版本创建 ${approvalNodes.length} 个处理节点`} description="指定人员仅是默认责任人，同一流程权限组的其他成员仍可代办。" />
                <div className="start-reviewer-list">
                  {approvalNodes.map((node) => (
                    <div className="start-reviewer-item" key={node.id}>
                      <div className="start-reviewer-head">
                        <span><CheckCircleOutlined /><strong>{node.data?.label}</strong></span>
                        <Space size={4}>
                          <Tag bordered={false} color={node.data?.handlingMode === "confirmation" ? "cyan" : "blue"}>{node.data?.handlingMode === "confirmation" ? "确认" : "审批"}</Tag>
                          <Tag bordered={false}>{node.data?.specifyAssignee ? "可指定人员" : "组内任一人"}</Tag>
                        </Space>
                      </div>
                      {node.data?.specifyAssignee && (
                        <Form.Item name={`reviewer-${node.id}`} rules={[{ required: true, message: `请选择${node.data.label}默认责任人` }]}>
                          <Select showSearch optionFilterProp="label" placeholder="搜索符合权限组的人员" options={peopleOptions(node.data?.permissionGroup ? [node.data.permissionGroup] : [])} />
                        </Form.Item>
                      )}
                      <span className="start-permission-name"><TeamOutlined /> {node.data?.permissionGroup || "尚未配置流程权限组"}</span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : (
              <Card className="approval-card start-reviewer-card" title="首位受理人" extra={<TeamOutlined />}>
                <Alert type="info" showIcon message="受理后可继续选择下一位受理人" description={`候选人来自：${version.basic.assigneeGroups?.join("、") || "尚未配置受理流程权限组"}`} />
                <Form.Item name="firstAssignee" label="选择受理人" rules={[{ required: true, message: "请选择首位受理人" }]}>
                  <Select showSearch optionFilterProp="label" placeholder="搜索并选择首位受理人" options={peopleOptions(version.basic.assigneeGroups ?? [])} />
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
      {guard}
    </div>
  );
}
