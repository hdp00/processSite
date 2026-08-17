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
  type UploadProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { RichTextEditor } from "../components/RichTextEditor";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { effectiveGroupMemberIds, useIdentityStore } from "../state/useIdentityStore";
import type { ProcessDefinition, ProcessVersion } from "../state/useProcessDefinitionStore";
import {
  ensureProcessTitleField,
  rejectionHandlingLabel,
  type StoredDesignerField,
  type StoredDesignerTableColumn,
} from "../utils/designerStorage";

type DynamicRow = Record<string, string | string[] | undefined> & { key: string };
type DynamicFormValues = Record<string, unknown> & { firstAssignee?: string };

interface ConfiguredProcessStartPageProps {
  definition: ProcessDefinition;
  version: ProcessVersion;
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

const uploadValue = (event: { fileList?: unknown[] } | unknown[]) => Array.isArray(event) ? event : event?.fileList ?? [];

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
    const uploadProps: UploadProps = {
      multiple: (field.attachment?.maxCount ?? 20) > 1,
      maxCount: field.attachment?.maxCount ?? 20,
      beforeUpload: (file) => {
        const maxSize = field.attachment?.maxSizeMb ?? 100;
        if (file.size / 1024 / 1024 > maxSize) {
          message.error(`${file.name} 超过 ${maxSize} MB 限制`);
          return Upload.LIST_IGNORE;
        }
        return false;
      },
    };
    return (
      <Upload.Dragger {...uploadProps} fileList={Array.isArray(value) ? value as UploadProps["fileList"] : []} onChange={onChange}>
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖拽上传附件</p>
        <p className="ant-upload-hint">最多 {field.attachment?.maxCount ?? 20} 个，单个不超过 {field.attachment?.maxSizeMb ?? 100} MB{field.attachment?.inlinePdf ? "；PDF 可在流程页面预览" : ""}</p>
      </Upload.Dragger>
    );
  }
  if (field.type === "table") return <ConfiguredTableInput field={field} value={Array.isArray(value) ? value as DynamicRow[] : undefined} onChange={onChange as ((value: DynamicRow[]) => void) | undefined} />;
  return <Input value={typeof value === "string" ? value : ""} placeholder={field.placeholder || "请输入"} maxLength={500} onChange={(event) => onChange?.(event.target.value)} />;
}

export function ConfiguredProcessStartPage({ definition, version }: ConfiguredProcessStartPageProps) {
  const navigate = useNavigate();
  const createProcessInstance = usePrototypeStore((state) => state.createProcessInstance);
  const identityUsers = useIdentityStore((state) => state.users);
  useIdentityStore((state) => state.workflowGroups);
  const formSnapshot = version.snapshot.form;
  const flowSnapshot = version.snapshot.flow;
  const fields = ensureProcessTitleField(formSnapshot.fields);
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
  const [dirty, setDirty] = useState(false);
  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty,
    title: "发起内容尚未提交",
    description: "离开后，当前填写的表单、附件和人员选择将丢失。",
  });
  const initialValues = useMemo(() => {
    return Object.fromEntries(fields.map((field) => [
      field.id,
      field.type === "attachment"
        ? []
        : field.type === "table"
          ? [createRow(field.columns ?? [])]
          : field.defaultValue ?? (field.type === "checkbox" ? [] : ""),
    ]));
  }, [fields]);

  const runtimeValues = (values: DynamicFormValues) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const field = fields.find((item) => item.id === key);
      if (field?.type === "attachment") {
        return [key, (value as Array<{ name?: string }> | undefined)?.map((file) => file.name).filter(Boolean) ?? []];
      }
      return [key, value && typeof value === "object" && "toJSON" in value
        ? (value as { toJSON: () => unknown }).toJSON()
        : value];
    }),
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
    const itemProps = field.type === "attachment"
      ? { valuePropName: "fileList", getValueFromEvent: uploadValue }
      : {};
    return (
      <Form.Item
        {...itemProps}
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

  const confirmSubmit = () => {
    setSubmitting(true);
    window.setTimeout(() => {
      const values = runtimeValues(submittedValues);
      const assigneeByNode = Object.fromEntries(
        approvalNodes.map((node) => [node.id, String(submittedValues[`reviewer-${node.id}`] ?? "") || undefined]),
      );
      const createdId = createProcessInstance({
        definitionId: definition.id,
        formValues: values,
        assigneeByNode,
        firstAssigneeId: submittedValues.firstAssignee,
        attachmentNames,
      });
      setSubmitting(false);
      if (!createdId) {
        message.error("流程未创建：当前账号、流程权限组或发布版本已发生变化");
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      setDirty(false);
      allowNextNavigation();
      message.success(definition.type === "free"
        ? "事项已创建并生成首位受理人的待办"
        : `流程已发起，${approvalNodes.length} 个审批节点已按发布版本生成待办`);
      navigate("/launch");
    }, 450);
  };

  const attachmentNames = fields
    .filter((field) => field.type === "attachment")
    .flatMap((field) => (submittedValues[field.id] as Array<{ name?: string }> | undefined) ?? [])
    .map((file) => file.name)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="page-stack process-start-page">
      <div className="process-start-toolbar">
        <div className="process-start-title">
          <AppBackButton onClick={() => navigate("/launch")} />
          <Divider type="vertical" />
          <div>
            <strong>{version.basic.name}</strong>
            <span>{version.version} · {version.basic.starterGroups.join("、")}</span>
          </div>
        </div>
        <Button type="primary" icon={<SendOutlined />} onClick={() => form.submit()}>提交</Button>
      </div>

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
                { title: "流程审批", description: approvalNodes.map((node) => node.data?.label).join(" / ") || "按当前拓扑" },
                { title: "流程结束", description: "全部前置节点通过" },
              ]}
        />
      </Card>

      <Form<DynamicFormValues>
        form={form}
        layout="vertical"
        requiredMark="optional"
        initialValues={initialValues}
        onValuesChange={() => setDirty(true)}
        onFinish={prepareSubmit}
      >
        <div className="process-start-layout">
          <main className="process-start-main">
            <Card className="form-card" title="初始表单" extra={<Typography.Text type="secondary">实例编号提交后由系统生成</Typography.Text>}>
              {fields.length ? <div className="start-form-grid">{fields.map(renderField)}</div> : <Alert type="warning" showIcon message="当前发布版本没有可用的初始表单字段" />}
            </Card>
          </main>

          <aside className="process-start-aside">
            {definition.type === "approval" ? (
              <Card className="approval-card start-reviewer-card" title="审批节点" extra={<TeamOutlined />}>
                <Alert type="info" showIcon message={`将按当前版本创建 ${approvalNodes.length} 个审批节点`} description="指定人员仅是默认责任人，同一流程权限组的其他成员仍可代办。" />
                <div className="start-reviewer-list">
                  {approvalNodes.map((node) => (
                    <div className="start-reviewer-item" key={node.id}>
                      <div className="start-reviewer-head">
                        <span><CheckCircleOutlined /><strong>{node.data?.label}</strong></span>
                        <Tag bordered={false} color="blue">{node.data?.specifyAssignee ? "可指定人员" : "组内任一人"}</Tag>
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
