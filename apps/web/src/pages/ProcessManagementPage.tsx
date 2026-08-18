import { BranchesOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, EyeOutlined, FileTextOutlined, MessageOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Card, Dropdown, Form, Input, Modal, Select, Space, Table, Tag, Typography, message, type MenuProps, type TableProps } from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { definitionStatus, getPublishedVersion, useProcessDefinitionStore, type DefinitionStatus, type DefinitionType, type ProcessDefinition, type ProcessVersion } from "../state/useProcessDefinitionStore";
import "./process-admin-pages.css";

interface CreateProcessValues { name: string; type: DefinitionType; description?: string }

const typeMeta: Record<DefinitionType, { label: string; icon: React.ReactNode; className: string }> = {
  approval: { label: "固定审批", icon: <BranchesOutlined />, className: "is-approval" },
  free: { label: "自由协作", icon: <MessageOutlined />, className: "is-free" },
};
const editUrl = (record: ProcessDefinition, version: ProcessVersion) => `/admin/processes/${record.id}/basic?versionId=${version.id}`;

export function ProcessManagementPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<CreateProcessValues>();
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const copyProcessDefinition = useProcessDefinitionStore((state) => state.copyDefinition);
  const toggleDefinition = useProcessDefinitionStore((state) => state.toggleDefinition);
  const deleteDefinition = useProcessDefinitionStore((state) => state.deleteDefinition);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<DefinitionStatus>();
  const [type, setType] = useState<DefinitionType>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const { guard: createDefinitionGuard, allowNextNavigation: allowCreateNavigation } = useUnsavedChangesGuard({
    dirty: createDirty,
    title: "新流程信息尚未提交",
    description: "离开后，当前填写的流程名称、类型和说明将丢失。",
  });

  const filteredDefinitions = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return definitions.filter((item) => {
      const published = getPublishedVersion(item);
      const matched = !normalized || `${item.name}${item.code}${published?.basic.instancePrefix ?? ""}${item.description}`.toLowerCase().includes(normalized);
      return matched && (!status || definitionStatus(item) === status) && (!type || item.type === type);
    });
  }, [definitions, keyword, status, type]);

  const updateStatus = (record: ProcessDefinition) => {
    const stopping = !record.disabled;
    Modal.confirm({
      title: stopping ? "停用这个流程？" : "重新启用这个流程？",
      content: stopping ? "停用后不能发起新实例，运行中和历史实例不受影响。" : "启用后继续使用当前发布版本。",
      okText: stopping ? "确认停用" : "确认启用",
      okButtonProps: stopping ? { danger: true } : undefined,
      cancelText: "取消",
      onOk: () => { toggleDefinition(record.id); message.success(stopping ? "流程已停用" : "流程已重新启用"); },
    });
  };

  const copyDefinition = (record: ProcessDefinition) => {
    const copiedId = copyProcessDefinition(record.id);
    const copied = useProcessDefinitionStore.getState().definitions.find((item) => item.id === copiedId);
    const version = copied?.versions[0];
    if (!copied || !version) return message.error("复制新建失败");
    message.success("已复制为新的流程定义和正式 V1，未复制历史实例");
    navigate(editUrl(copied, version));
  };

  const removeDefinition = (record: ProcessDefinition) => {
    Modal.confirm({
      title: `删除流程“${record.name}”？`,
      content: "仅未发布且从未创建实例的流程定义可以删除。删除后全部版本快照和员工侧入口都会移除，且不可恢复。",
      okText: "确认删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => { if (!deleteDefinition(record.id)) return message.error("流程已发布或已有实例，不能删除"); message.success("流程定义及其全部无实例版本已删除"); },
    });
  };

  const getActionMenu = (record: ProcessDefinition): MenuProps["items"] => [
    { key: "copy", icon: <CopyOutlined />, label: "复制新建流程", onClick: () => copyDefinition(record) },
    { type: "divider" },
    { key: "toggle", icon: record.disabled ? <CheckCircleOutlined /> : <StopOutlined />, label: record.disabled ? "启用流程" : "停用流程", danger: !record.disabled, disabled: !record.publishedVersionId, onClick: () => updateStatus(record) },
    { key: "delete", icon: <DeleteOutlined />, label: "删除流程", danger: true, disabled: Boolean(record.publishedVersionId || record.instanceCount || record.versions.some((version) => version.instanceCount > 0)), onClick: () => removeDefinition(record) },
  ];

  const columns: TableProps<ProcessDefinition>["columns"] = [
    {
      title: "流程定义", dataIndex: "name", width: 310,
      render: (value: string, record) => <button type="button" className="pa-name-button" onClick={() => navigate(`/admin/processes/${record.id}/versions`)}><span className={`pa-definition-icon ${typeMeta[record.type].className}`}>{typeMeta[record.type].icon}</span><span><strong>{value}</strong><small>{record.code}</small></span></button>,
    },
    { title: "类型", dataIndex: "type", width: 120, render: (value: DefinitionType) => <Tag className="pa-type-tag">{typeMeta[value].label}</Tag> },
    { title: "发布编号前缀", key: "prefix", width: 145, render: (_, record) => getPublishedVersion(record)?.basic.instancePrefix ? <Tag bordered={false} color="blue">{getPublishedVersion(record)?.basic.instancePrefix}</Tag> : <span className="pa-muted">—</span> },
    { title: "定义状态", key: "status", width: 115, render: (_, record) => <StatusPill status={definitionStatus(record)} /> },
    { title: "发布版本", key: "published", width: 105, render: (_, record) => <span className={record.publishedVersionId ? "pa-version" : "pa-muted"}>{getPublishedVersion(record)?.version ?? "—"}</span> },
    { title: "版本数", key: "versions", width: 86, align: "right", render: (_, record) => record.versions.length },
    { title: "最近更新", dataIndex: "updatedAt", width: 180, render: (value: string, record) => <span className="pa-two-line-cell"><span>{value}</span><small>{record.updatedBy}</small></span> },
    {
      title: "操作", key: "actions", fixed: "right", width: 126, align: "center",
      render: (_, record) => <Space size={2}><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/admin/processes/${record.id}/versions`)}>查看</Button><Dropdown menu={{ items: getActionMenu(record) }} trigger={["click"]} placement="bottomRight"><Button type="text" className="pa-icon-button" icon={<MoreOutlined />} aria-label={`更多流程操作：${record.name}`} /></Dropdown></Space>,
    },
  ];

  const createDefinition = async () => {
    const values = await form.validateFields();
    setCreateOpen(false);
    setCreateDirty(false);
    form.resetFields();
    const query = new URLSearchParams({ name: values.name, type: values.type, description: values.description ?? "" });
    allowCreateNavigation();
    navigate(`/admin/processes/new/basic?${query.toString()}`);
  };

  return (
    <div className="page-stack pa-page">
      {createDefinitionGuard}
      <Card className="pa-overview-card" bordered={false}>
        <div className="pa-overview-copy"><span className="pa-eyebrow"><FileTextOutlined /> 流程配置</span><Typography.Title level={3}>流程定义概览</Typography.Title><Typography.Text type="secondary">流程定义负责名称与员工侧入口；每个版本都是完整快照，最多一个版本处于发布状态。</Typography.Text></div>
        <div className="pa-overview-stats" aria-label="流程统计"><span><strong>{definitions.length}</strong><small>流程定义</small></span><span><strong>{definitions.filter((item) => definitionStatus(item) === "已发布").length}</strong><small>已发布</small></span><span><strong>{definitions.reduce((total, item) => total + item.versions.length, 0)}</strong><small>正式版本</small></span></div>
      </Card>
      <Card className="query-card pa-filter-card"><div className="pa-filter-row"><Input className="pa-keyword-input" prefix={<SearchOutlined />} allowClear value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索流程名称、编号或说明" /><Select<DefinitionType> className="pa-filter-select" allowClear value={type} onChange={setType} placeholder="全部类型" options={Object.entries(typeMeta).map(([value, meta]) => ({ value: value as DefinitionType, label: meta.label }))} /><Select<DefinitionStatus> className="pa-filter-select" allowClear value={status} onChange={setStatus} placeholder="全部状态" options={["未发布", "已发布", "已停用"].map((value) => ({ value: value as DefinitionStatus, label: value }))} /><Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setStatus(undefined); setType(undefined); }}>重置</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建流程</Button></div></Card>
      <Card className="content-card pa-table-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head pa-table-head"><div><strong>流程定义</strong><Tag bordered={false}>{filteredDefinitions.length} 条</Tag></div><Typography.Text type="secondary">进入版本记录可发布、取消发布、切换发布版本或从任意版本复制新建</Typography.Text></div>
        <Table<ProcessDefinition> rowKey="id" columns={columns} dataSource={filteredDefinitions} scroll={{ x: 1120 }} pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录` }} />
      </Card>
      <Modal title="新建流程定义" open={createOpen} width={560} okText="继续填写基本信息" cancelText="取消" destroyOnHidden onCancel={() => { setCreateDirty(false); setCreateOpen(false); form.resetFields(); }} onOk={() => void createDefinition()}>
        <Form<CreateProcessValues> form={form} layout="vertical" requiredMark={false} initialValues={{ type: "approval" }} onValuesChange={() => setCreateDirty(true)} className="pa-modal-form"><Form.Item name="name" label="流程名称" rules={[{ required: true, message: "请输入流程名称" }, { max: 60 }]}><Input placeholder="例如：设备变更审核" maxLength={60} showCount /></Form.Item><Form.Item name="type" label="流程类型" rules={[{ required: true }]}><Select options={[{ value: "approval", label: "固定审批 — 按预设节点和连线流转" }, { value: "free", label: "自由协作 — 每次处理后选择下一位受理人" }]} /></Form.Item><Form.Item name="description" label="流程说明"><Input.TextArea placeholder="简要说明适用范围和使用目的" rows={3} maxLength={200} showCount /></Form.Item><div className="pa-inline-note">下一步填写完整基本信息。首次保存时才创建流程定义并生成正式 V1；在此之前不会形成流程或中间业务状态。</div></Form>
      </Modal>
    </div>
  );
}

export default ProcessManagementPage;
