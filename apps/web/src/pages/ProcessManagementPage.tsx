import {
  BranchesOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
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
import { StatusPill } from "../components/StatusPill";
import {
  definitionStatus,
  getEffectiveVersion,
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
  const withdrawEffectiveVersion = useProcessDefinitionStore((state) => state.withdrawEffectiveVersion);
  const deleteProcessVersion = useProcessDefinitionStore((state) => state.deleteVersion);
  const toggleDefinition = useProcessDefinitionStore((state) => state.toggleDefinition);
  const deleteDefinition = useProcessDefinitionStore((state) => state.deleteDefinition);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<DefinitionStatus>();
  const [type, setType] = useState<DefinitionType>();
  const [createOpen, setCreateOpen] = useState(false);

  const filteredDefinitions = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return definitions.filter((item) => {
      const effectiveBasic = getEffectiveVersion(item)?.basic;
      const keywordMatched = !normalizedKeyword
        || `${item.name}${item.code}${effectiveBasic?.instancePrefix ?? ""}${item.draft?.basic.instancePrefix ?? ""}${item.description}`.toLowerCase().includes(normalizedKeyword);
      return keywordMatched && (!status || definitionStatus(item) === status) && (!type || item.type === type);
    });
  }, [definitions, keyword, status, type]);

  const updateStatus = (record: ProcessDefinition) => {
    const nextStatus: DefinitionStatus = record.disabled ? "已发布" : "已停用";
    Modal.confirm({
      title: nextStatus === "已停用" ? "停用这个流程？" : "重新启用这个流程？",
      content: nextStatus === "已停用"
        ? "停用后不能再发起新实例，运行中和历史实例不受影响。"
        : "启用后将使用当前生效版本，符合权限的用户可再次发起。",
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

  const removeDefinition = (record: ProcessDefinition) => {
    Modal.confirm({
      title: `删除流程“${record.name}”？`,
      content: "该流程没有创建过实例。删除后会同时移除全部版本快照、草稿和员工侧菜单，且不可恢复。",
      okText: "确认删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        if (!deleteDefinition(record.id)) {
          message.error("流程已有实例，不能删除，请改为停用");
          return;
        }
        message.success("流程及其全部无实例版本已删除");
      },
    });
  };

  const removeDraft = (record: ProcessDefinition) => {
    const draft = record.draft;
    if (!draft) return;
    const isInitialDraft = record.versions.length === 0;
    const isWithdrawnDraft = Boolean(draft.withdrawnVersionId);
    Modal.confirm({
      title: isInitialDraft ? `删除草稿流程“${draft.basic.name}”？` : `删除草稿 ${draft.version}？`,
      content: isInitialDraft
        ? "该流程从未发布。删除后会同时移除流程定义、初始表单、流程图和列表字段设计，且不可恢复。"
        : isWithdrawnDraft
          ? `这会放弃 ${draft.version} 撤回后的全部修改，并恢复撤回前的发布快照及原启停状态。`
          : `只删除未发布的 ${draft.version} 草稿；当前生效版本和已有实例不受影响。该版本号以后不会重新使用。`,
      okText: isInitialDraft ? "删除草稿流程" : "删除草稿",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        const result = deleteProcessVersion(record.id, draft.id);
        if (result === "definition-deleted") message.success("草稿流程及其设计数据已删除");
        else if (result === "deleted" && isWithdrawnDraft) message.success(`${draft.version} 的修改已放弃，撤回前版本已恢复生效`);
        else if (result === "deleted") message.success(`${draft.version} 草稿已删除，当前生效版本保持不变`);
        else message.error("草稿状态已经变化，请刷新后重试");
      },
    });
  };

  const editDefinition = (record: ProcessDefinition) => {
    if (record.draft) {
      navigate(`/admin/processes/${record.id}/basic`);
      return;
    }
    const effective = getEffectiveVersion(record);
    if (effective && effective.instanceCount === 0) {
      Modal.confirm({
        title: `撤回 ${effective.version} 并继续编辑？`,
        content: `该生效版本尚未创建流程实例。撤回后 ${effective.version} 将恢复为草稿，版本号保持不变；编辑期间流程暂停发起，重新发布后再次生效。`,
        okText: "撤回并编辑",
        cancelText: "取消",
        onOk: () => {
          const result = withdrawEffectiveVersion(record.id, effective.id);
          if (result === "has-instances") message.error("该版本已经创建流程实例，不能撤回，请创建新版本");
          else if (result === "has-draft") message.info("该流程已有草稿，已进入现有草稿");
          else if (result !== "withdrawn") message.error("版本状态已经变化，请刷新后重试");
          if (result === "withdrawn" || result === "has-draft") navigate(`/admin/processes/${record.id}/basic`);
        },
      });
      return;
    }
    const created = ensureDraft(record.id);
    if (created) message.info("已基于当前生效版本创建新版本草稿，原版本继续生效");
    navigate(`/admin/processes/${record.id}/basic`);
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
    ...(record.draft ? [{
      key: "delete-draft",
      icon: <DeleteOutlined />,
      label: record.versions.length === 0 ? "删除草稿流程" : `删除草稿 ${record.draft.version}`,
      danger: true,
      onClick: () => removeDraft(record),
    }] : []),
    ...(record.versions.length > 0 ? [
      { type: "divider" as const },
      {
        key: "toggle",
        icon: record.disabled ? <CheckCircleOutlined /> : <StopOutlined />,
        label: record.disabled ? "启用流程" : "停用流程",
        danger: !record.disabled,
        disabled: !record.effectiveVersionId,
        onClick: () => updateStatus(record),
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: record.instanceCount > 0 ? `删除流程（已有 ${record.instanceCount} 个实例）` : "删除流程",
        danger: true,
        disabled: record.instanceCount > 0 || record.versions.some((item) => item.instanceCount > 0),
        onClick: () => removeDefinition(record),
      },
    ] : []),
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
      title: "生效编号前缀",
      key: "instancePrefix",
      width: 132,
      render: (_, record) => {
        const config = getEffectiveVersion(record)?.basic ?? record.draft?.basic;
        return config?.instancePrefix
          ? <Tag bordered={false} color="blue">{config.instancePrefix}</Tag>
          : <span className="pa-muted">待发布</span>;
      },
    },
    {
      title: "状态",
      key: "status",
      width: 112,
      render: (_, record) => {
        const value = definitionStatus(record);
        return <Space size={5} wrap><StatusPill status={value} />{record.effectiveVersionId && record.draft ? <Tag color="gold" bordered={false}>有草稿</Tag> : null}</Space>;
      },
    },
    {
      title: "生效版本",
      key: "effectiveVersion",
      width: 104,
      render: (_, record) => {
        const value = getEffectiveVersion(record)?.version;
        return <span className={!value ? "pa-muted" : "pa-version"}>{value ?? "—"}</span>;
      },
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
          <Tooltip title={record.draft
            ? "编辑草稿"
            : getEffectiveVersion(record)?.instanceCount === 0
              ? `撤回 ${getEffectiveVersion(record)?.version} 并编辑，版本号不变`
              : "基于生效版本创建新版本草稿"}>
            <Button
              type="text"
              className="pa-icon-button is-primary"
              icon={<EditOutlined />}
              aria-label={`编辑${record.name}`}
              onClick={() => editDefinition(record)}
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
          <Typography.Text type="secondary">流程定义管理菜单与启停；每个版本保存完整快照，并且只有一个版本生效。</Typography.Text>
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
          <Typography.Text type="secondary">只有生效版本用于新实例；停用不影响已有实例</Typography.Text>
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
