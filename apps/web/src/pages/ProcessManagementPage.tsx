import {
  BranchesOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  HistoryOutlined,
  MessageOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  type MenuProps,
  type TableProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  definitionStatus,
  useProcessDefinitionStore,
  type DefinitionStatus,
  type DefinitionType,
  type ProcessDefinition,
} from "../state/useProcessDefinitionStore";
import "./process-admin-pages.css";

interface CreateProcessValues {
  name: string;
  type: DefinitionType;
  description?: string;
}

const statusClassName: Record<DefinitionStatus, string> = {
  草稿: "is-draft",
  已发布: "is-published",
  已停用: "is-disabled",
};

const typeMeta: Record<DefinitionType, { label: string; icon: React.ReactNode; className: string }> = {
  approval: { label: "固定审批", icon: <BranchesOutlined />, className: "is-approval" },
  free: { label: "自由协作", icon: <MessageOutlined />, className: "is-free" },
};

export function ProcessManagementPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<CreateProcessValues>();
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const createProcessDefinition = useProcessDefinitionStore((state) => state.createDefinition);
  const copyProcessDefinition = useProcessDefinitionStore((state) => state.copyDefinition);
  const ensureDraft = useProcessDefinitionStore((state) => state.ensureDraft);
  const toggleDefinition = useProcessDefinitionStore((state) => state.toggleDefinition);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<DefinitionStatus>();
  const [type, setType] = useState<DefinitionType>();
  const [createOpen, setCreateOpen] = useState(false);

  const filteredDefinitions = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return definitions.filter((item) => {
      const latestBasic = item.draft?.basic
        ?? item.versions.find((version) => version.version === item.currentVersion)?.basic;
      const keywordMatched = !normalizedKeyword
        || `${item.name}${item.code}${latestBasic?.instancePrefix ?? ""}${item.description}`.toLowerCase().includes(normalizedKeyword);
      return keywordMatched && (!status || definitionStatus(item) === status) && (!type || item.type === type);
    });
  }, [definitions, keyword, status, type]);

  const updateStatus = (record: ProcessDefinition) => {
    const nextStatus: DefinitionStatus = record.disabled ? "已发布" : "已停用";
    Modal.confirm({
      title: nextStatus === "已停用" ? "停用这个流程？" : "重新启用这个流程？",
      content: nextStatus === "已停用"
        ? "停用后不能再发起新实例，运行中和历史实例不受影响。"
        : "启用后将恢复当前已发布版本，符合权限的用户可再次发起。",
      okText: nextStatus === "已停用" ? "确认停用" : "确认启用",
      okButtonProps: nextStatus === "已停用" ? { danger: true } : undefined,
      cancelText: "取消",
      onOk: () => {
        toggleDefinition(record.id);
        message.success(nextStatus === "已停用" ? "流程已停用" : "流程已重新启用");
      },
    });
  };

  const copyDefinition = (record: ProcessDefinition) => {
    const copiedId = copyProcessDefinition(record.id);
    if (!copiedId) return;
    [
      "flowpilot-form-designer-draft-v2-",
      "flowpilot-flow-designer-v2-",
      "flowpilot-system-list-fields-v1:",
    ].forEach((prefix) => {
      const saved = window.localStorage.getItem(`${prefix}${record.id}`);
      if (saved) window.localStorage.setItem(`${prefix}${copiedId}`, saved);
    });
    message.success("已复制为新流程草稿，版本和历史实例未复制");
    navigate(`/admin/processes/${copiedId}/basic`);
  };

  const getActionMenu = (record: ProcessDefinition): MenuProps["items"] => [
    {
      key: "versions",
      icon: <HistoryOutlined />,
      label: "版本记录",
      onClick: () => navigate(`/admin/processes/${record.id}/versions`),
    },
    {
      key: "copy",
      icon: <CopyOutlined />,
      label: "复制新建",
      onClick: () => copyDefinition(record),
    },
    { type: "divider" },
    {
      key: "toggle",
      icon: record.disabled ? <CheckCircleOutlined /> : <StopOutlined />,
      label: record.disabled ? "启用流程" : "停用流程",
      danger: !record.disabled,
      disabled: !record.currentVersion,
      onClick: () => updateStatus(record),
    },
  ];

  const columns: TableProps<ProcessDefinition>["columns"] = [
    {
      title: "流程名称",
      dataIndex: "name",
      width: 310,
      render: (value: string, record) => (
        <button
          type="button"
          className="pa-name-button"
          onClick={() => navigate(`/admin/processes/${record.id}/versions`)}
        >
          <span className={`pa-definition-icon ${typeMeta[record.type].className}`}>
            {typeMeta[record.type].icon}
          </span>
          <span>
            <strong>{value}</strong>
            <small>{record.code}</small>
          </span>
        </button>
      ),
    },
    {
      title: "流程类型",
      dataIndex: "type",
      width: 124,
      render: (value: DefinitionType) => <Tag className="pa-type-tag">{typeMeta[value].label}</Tag>,
    },
    {
      title: "实例编号前缀",
      key: "instancePrefix",
      width: 132,
      render: (_, record) => {
        const config = record.draft?.basic
          ?? record.versions.find((version) => version.version === record.currentVersion)?.basic;
        return config?.instancePrefix
          ? <Tag bordered={false} color="blue">{config.instancePrefix}</Tag>
          : <span className="pa-muted">待配置</span>;
      },
    },
    {
      title: "状态",
      key: "status",
      width: 112,
      render: (_, record) => {
        const value = definitionStatus(record);
        return <Space size={5} wrap><span className={`pa-status ${statusClassName[value]}`}><span className="pa-status__dot" />{value}</span>{record.currentVersion && record.draft ? <Tag color="gold" bordered={false}>有草稿</Tag> : null}</Space>;
      },
    },
    {
      title: "当前版本",
      dataIndex: "currentVersion",
      width: 104,
      render: (value?: string) => <span className={!value ? "pa-muted" : "pa-version"}>{value ?? "—"}</span>,
    },
    {
      title: "实例数",
      dataIndex: "instanceCount",
      width: 90,
      align: "right",
      render: (value: number) => value.toLocaleString("zh-CN"),
    },
    {
      title: "最近更新",
      dataIndex: "updatedAt",
      width: 182,
      render: (value: string, record) => (
        <span className="pa-two-line-cell"><span>{value}</span><small>{record.updatedBy}</small></span>
      ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 152,
      align: "center",
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="查看配置">
            <Button
              type="text"
              className="pa-icon-button"
              icon={<EyeOutlined />}
              aria-label={`查看${record.name}`}
              onClick={() => navigate(`/admin/processes/${record.id}/versions`)}
            />
          </Tooltip>
          <Tooltip title={record.currentVersion && !record.draft ? "基于当前版本修改" : "编辑草稿"}>
            <Button
              type="text"
              className="pa-icon-button is-primary"
              icon={<EditOutlined />}
              aria-label={`编辑${record.name}`}
              onClick={() => {
                const created = ensureDraft(record.id);
                if (created) message.info("已基于当前发布版本创建新版本草稿，原版本继续生效");
                navigate(`/admin/processes/${record.id}/basic`);
              }}
            />
          </Tooltip>
          <Dropdown menu={{ items: getActionMenu(record) }} trigger={["click"]} placement="bottomRight">
            <Button type="text" className="pa-icon-button" icon={<MoreOutlined />} aria-label={`更多操作：${record.name}`} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const createDefinition = async () => {
    const values = await form.validateFields();
    const id = createProcessDefinition(values);
    setCreateOpen(false);
    form.resetFields();
    message.success("流程草稿已创建，可继续配置基本信息");
    navigate(`/admin/processes/${id}/basic`);
  };

  const resetFilters = () => {
    setKeyword("");
    setStatus(undefined);
    setType(undefined);
  };

  return (
    <div className="page-stack pa-page">
      <Card className="pa-overview-card" bordered={false}>
        <div className="pa-overview-copy">
          <span className="pa-eyebrow"><FileTextOutlined /> 流程配置</span>
          <Typography.Title level={3}>流程定义概览</Typography.Title>
          <Typography.Text type="secondary">统一管理固定审批与自由协作流程，发布版本与运行实例相互隔离。</Typography.Text>
        </div>
        <div className="pa-overview-stats" aria-label="流程统计">
          <span><strong>{definitions.length}</strong><small>全部流程</small></span>
          <span><strong>{definitions.filter((item) => definitionStatus(item) === "已发布").length}</strong><small>正在使用</small></span>
          <span><strong>{definitions.filter((item) => Boolean(item.draft)).length}</strong><small>待配置草稿</small></span>
        </div>
      </Card>

      <Card className="query-card pa-filter-card">
        <div className="pa-filter-row">
          <Input
            className="pa-keyword-input"
            prefix={<SearchOutlined />}
            allowClear
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索流程名称、编号或说明"
          />
          <Select<DefinitionType>
            className="pa-filter-select"
            allowClear
            value={type}
            onChange={setType}
            placeholder="全部类型"
            options={Object.entries(typeMeta).map(([value, meta]) => ({ value: value as DefinitionType, label: meta.label }))}
          />
          <Select<DefinitionStatus>
            className="pa-filter-select"
            allowClear
            value={status}
            onChange={setStatus}
            placeholder="全部状态"
            options={["草稿", "已发布", "已停用"].map((value) => ({ value, label: value }))}
          />
          <Button icon={<ReloadOutlined />} onClick={resetFilters}>重置</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建流程</Button>
        </div>
      </Card>

      <Card className="content-card pa-table-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head pa-table-head">
          <div><strong>流程定义</strong><Tag bordered={false}>{filteredDefinitions.length} 条</Tag></div>
          <Typography.Text type="secondary">停用不影响运行中及历史流程</Typography.Text>
        </div>
        <Table<ProcessDefinition>
          rowKey="id"
          columns={columns}
          dataSource={filteredDefinitions}
          scroll={{ x: 1210 }}
          pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录` }}
        />
      </Card>

      <Modal
        title="新建流程"
        open={createOpen}
        width={560}
        okText="创建并配置"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => { setCreateOpen(false); form.resetFields(); }}
        onOk={() => void createDefinition()}
      >
        <Form<CreateProcessValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ type: "approval" }}
          className="pa-modal-form"
        >
          <Form.Item name="name" label="流程名称" rules={[{ required: true, message: "请输入流程名称" }, { max: 60 }]}> 
            <Input placeholder="例如：设备变更审核" maxLength={60} showCount />
          </Form.Item>
          <Form.Item name="type" label="流程类型" rules={[{ required: true }]}>
            <Select options={[
              { value: "approval", label: "固定审批 — 按预设节点和连线流转" },
              { value: "free", label: "自由协作 — 每次处理后选择下一位受理人" },
            ]} />
          </Form.Item>
          <Form.Item name="description" label="流程说明">
            <Input.TextArea placeholder="简要说明适用范围和使用目的" rows={3} maxLength={200} showCount />
          </Form.Item>
          <div className="pa-inline-note">流程定义编号由系统自动生成；实例编号前缀在下一步基本信息中填写。新流程默认保存为草稿，不会立即对员工开放。</div>
        </Form>
      </Modal>
    </div>
  );
}

export default ProcessManagementPage;
