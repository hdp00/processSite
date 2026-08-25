import { BranchesOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EyeOutlined, FileTextOutlined, MessageOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, StopOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Dropdown, Form, Input, Modal, Select, Space, Table, Tag, Typography, Upload, message, type MenuProps, type TableProps } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { flowPilotApi } from "../api/flowPilotApi";
import { cacheProcessDefinition, removeCachedProcessDefinition } from "../api/entityCache";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import { useIdentityStore } from "../state/useIdentityStore";
import { hasPersonaPermission } from "../state/rolePermissions";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { definitionStatus, getPublishedVersion, useProcessDefinitionStore, type DefinitionStatus, type DefinitionType, type ProcessDefinition, type ProcessVersion } from "../state/useProcessDefinitionStore";
import { createProcessDefinitionExport, parseProcessDefinitionImport, type ProcessDefinitionImportPreview } from "../utils/processDefinitionTransfer";
import { formatDisplayDateTime } from "../utils/domainTime";
import "./process-admin-pages.css";
import { isBrowserMockMode } from "../utils/runtimeMode";

interface CreateProcessValues { name: string; type: DefinitionType; description?: string }
interface ImportPreviewState extends ProcessDefinitionImportPreview { fileName: string; document: unknown }

const typeMeta: Record<DefinitionType, { label: string; icon: React.ReactNode; className: string }> = {
  approval: { label: "固定审批", icon: <BranchesOutlined />, className: "is-approval" },
  free: { label: "自由协作", icon: <MessageOutlined />, className: "is-free" },
};
const editUrl = (record: ProcessDefinition, version: ProcessVersion) => `/admin/processes/${record.id}/basic?versionId=${version.id}`;

export function ProcessManagementPage() {
  const navigate = useNavigate();
  const [form] = Form.useForm<CreateProcessValues>();
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const users = useIdentityStore((state) => state.users);
  const roles = useIdentityStore((state) => state.roles);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const personaId = usePrototypeStore((state) => state.personaId);
  const canEditDefinition = hasPersonaPermission(personaId, "config-definition:编辑");
  const canDeleteDefinition = hasPersonaPermission(personaId, "config-definition:删除");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<DefinitionStatus>();
  const [type, setType] = useState<DefinitionType>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewState>();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(8);
  const [remoteDefinitions, setRemoteDefinitions] = useState<ProcessDefinition[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const { guard: createDefinitionGuard, allowNextNavigation: allowCreateNavigation } = useUnsavedChangesGuard({
    dirty: createDirty,
    title: "新流程信息尚未提交",
    description: "离开后，当前填写的流程名称、类型和说明将丢失。",
  });

  useEffect(() => {
    if (isBrowserMockMode) return;
    let cancelled = false;
    setRemoteLoading(true);
    void flowPilotApi.definitions.list({ page, pageSize, q: keyword.trim() || undefined, status, type })
      .then((result) => {
        if (!cancelled) {
          setRemoteDefinitions(result.items);
          setRemoteTotal(result.page.totalElements);
        }
      })
      .catch(() => { if (!cancelled) message.error("流程定义加载失败，请稍后重试"); })
      .finally(() => { if (!cancelled) setRemoteLoading(false); });
    return () => { cancelled = true; };
  }, [keyword, page, pageSize, status, type]);

  const filteredDefinitions = useMemo(() => {
    if (!isBrowserMockMode) return remoteDefinitions;
    const normalized = keyword.trim().toLowerCase();
    return definitions.filter((item) => {
      const published = getPublishedVersion(item);
      const matched = !normalized || `${item.name}${item.code}${published?.basic.instancePrefix ?? ""}${item.description}`.toLowerCase().includes(normalized);
      return matched && (!status || definitionStatus(item) === status) && (!type || item.type === type);
    });
  }, [definitions, keyword, remoteDefinitions, status, type]);

  const updateStatus = (record: ProcessDefinition) => {
    const stopping = !record.disabled;
    Modal.confirm({
      title: stopping ? "停用这个流程？" : "重新启用这个流程？",
      content: stopping ? "停用后不能发起新实例，运行中和历史实例不受影响。" : "启用后继续使用当前发布版本。",
      okText: stopping ? "确认停用" : "确认启用",
      okButtonProps: stopping ? { danger: true } : undefined,
      cancelText: "取消",
      onOk: async () => {
        const resource = await flowPilotApi.definitions.getResource(record.id);
        const updated = await flowPilotApi.definitions.updateAvailability(record.id, stopping, resource.etag);
        cacheProcessDefinition(updated);
        setRemoteDefinitions((rows) => rows.map((item) => item.id === updated.id ? updated : item));
        message.success(stopping ? "流程已停用" : "流程已重新启用");
      },
    });
  };

  const copyDefinition = async (record: ProcessDefinition) => {
    try {
      const copied = await flowPilotApi.definitions.copy(record.id, record.publishedVersionId ?? record.versions[0]?.id);
      cacheProcessDefinition(copied.definition);
      message.success("已复制为新的流程定义和正式 V1，未复制历史实例");
      navigate(editUrl(copied.definition, copied.version));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "复制新建失败");
    }
  };

  const removeDefinition = (record: ProcessDefinition) => {
    Modal.confirm({
      title: `删除流程“${record.name}”？`,
      content: "仅未发布且从未创建实例的流程定义可以删除。删除后全部版本快照和员工侧入口都会移除，且不可恢复。",
      okText: "确认删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          const resource = await flowPilotApi.definitions.getResource(record.id);
          await flowPilotApi.definitions.remove(record.id, resource.etag);
          removeCachedProcessDefinition(record.id);
          setRemoteDefinitions((rows) => rows.filter((item) => item.id !== record.id));
          setRemoteTotal((total) => Math.max(0, total - 1));
          message.success("流程定义及其全部无实例版本已删除");
        } catch (error) {
          message.error(error instanceof Error ? error.message : "流程已发布或已有实例，不能删除");
          throw error;
        }
      },
    });
  };

  const exportDefinition = async (record: ProcessDefinition) => {
    const completeDefinition = record.versions.length ? record : await flowPilotApi.definitions.get(record.id);
    const payload = createProcessDefinitionExport(completeDefinition, { users, roles, workflowGroups });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${record.name.replace(/[\\/:*?"<>|]/g, "_")}_流程定义.json`;
    link.click();
    URL.revokeObjectURL(url);
    message.success(`已导出“${completeDefinition.name}”的全部版本`);
  };

  const readImportFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".json")) {
      message.error("文件格式不正确，请选择流程定义导出文件");
      return;
    }
    try {
      const sourceText = await file.text();
      const preview = parseProcessDefinitionImport(sourceText, { users, roles, workflowGroups });
      setImportPreview({ ...preview, fileName: file.name, document: JSON.parse(sourceText) as unknown });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "流程定义导入文件无法解析");
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    try {
      const imported = await flowPilotApi.definitions.import(importPreview.document);
      cacheProcessDefinition(imported);
      setImportPreview(undefined);
      message.success(`已导入为“${imported.name}”，全部版本保持未发布`);
      navigate(`/admin/processes/${imported.id}/versions`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "流程定义导入失败");
    }
  };

  const getActionMenu = (record: ProcessDefinition): MenuProps["items"] => [
    ...(canEditDefinition ? [{ key: "copy", icon: <CopyOutlined />, label: "复制新建流程", onClick: () => copyDefinition(record) }] : []),
    { key: "export", icon: <DownloadOutlined />, label: "导出", onClick: () => void exportDefinition(record) },
    ...(canEditDefinition ? [{ type: "divider" as const }, { key: "toggle", icon: record.disabled ? <CheckCircleOutlined /> : <StopOutlined />, label: record.disabled ? "启用流程" : "停用流程", danger: !record.disabled, disabled: !record.publishedVersionId, onClick: () => updateStatus(record) }] : []),
    ...(canDeleteDefinition ? [{ key: "delete", icon: <DeleteOutlined />, label: "删除流程", danger: true, disabled: Boolean(record.publishedVersionId || record.instanceCount || record.versions.some((version) => version.instanceCount > 0)), onClick: () => removeDefinition(record) }] : []),
  ];

  const columns: TableProps<ProcessDefinition>["columns"] = [
    {
      title: "流程定义", dataIndex: "name", width: 310,
      render: (value: string, record) => <button type="button" className="pa-name-button" onClick={() => navigate(`/admin/processes/${record.id}/versions`)}><span className={`pa-definition-icon ${typeMeta[record.type].className}`}>{typeMeta[record.type].icon}</span><span><strong>{value}</strong><small>{record.code}</small></span></button>,
    },
    { title: "类型", dataIndex: "type", width: 120, render: (value: DefinitionType) => <Tag className="pa-type-tag">{typeMeta[value].label}</Tag> },
    { title: "发布编号前缀", key: "prefix", width: 145, render: (_, record) => getPublishedVersion(record)?.basic.instancePrefix || record.publishedInstancePrefix ? <Tag bordered={false} color="blue">{getPublishedVersion(record)?.basic.instancePrefix ?? record.publishedInstancePrefix}</Tag> : <span className="pa-muted">—</span> },
    { title: "定义状态", key: "status", width: 115, render: (_, record) => <StatusPill status={definitionStatus(record)} /> },
    { title: "发布版本", key: "published", width: 105, render: (_, record) => <span className={record.publishedVersionId ? "pa-version" : "pa-muted"}>{getPublishedVersion(record)?.version ?? record.publishedVersionLabel ?? "—"}</span> },
    { title: "版本数", key: "versions", width: 86, align: "right", render: (_, record) => record.versionCount ?? record.versions.length },
    { title: "最近更新", dataIndex: "updatedAt", width: 180, render: (value: string, record) => <span className="pa-two-line-cell"><span>{formatDisplayDateTime(value)}</span><small>{record.updatedBy}</small></span> },
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
        <div className="pa-overview-stats" aria-label="流程统计"><span><strong>{isBrowserMockMode ? definitions.length : remoteTotal}</strong><small>流程定义</small></span><span><strong>{filteredDefinitions.filter((item) => definitionStatus(item) === "已发布").length}</strong><small>{isBrowserMockMode ? "已发布" : "当前页已发布"}</small></span><span><strong>{filteredDefinitions.reduce((total, item) => total + (item.versionCount ?? item.versions.length), 0)}</strong><small>{isBrowserMockMode ? "正式版本" : "当前页版本"}</small></span></div>
      </Card>
      <Card className="query-card pa-filter-card"><div className="pa-filter-row"><Input className="pa-keyword-input" prefix={<SearchOutlined />} allowClear value={keyword} onChange={(event) => { setPage(1); setKeyword(event.target.value); }} placeholder="搜索流程名称、编号或说明" /><Select<DefinitionType> className="pa-filter-select" allowClear value={type} onChange={(value) => { setPage(1); setType(value); }} placeholder="全部类型" options={Object.entries(typeMeta).map(([value, meta]) => ({ value: value as DefinitionType, label: meta.label }))} /><Select<DefinitionStatus> className="pa-filter-select" allowClear value={status} onChange={(value) => { setPage(1); setStatus(value); }} placeholder="全部状态" options={["未发布", "已发布", "已停用"].map((value) => ({ value: value as DefinitionStatus, label: value }))} /><Button icon={<ReloadOutlined />} onClick={() => { setPage(1); setKeyword(""); setStatus(undefined); setType(undefined); }}>重置</Button>{canEditDefinition && <Upload accept=".json" showUploadList={false} beforeUpload={(file) => { void readImportFile(file); return false; }}><Button icon={<UploadOutlined />}>导入</Button></Upload>}{canEditDefinition && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建流程</Button>}</div></Card>
      <Card className="content-card pa-table-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head pa-table-head"><div><strong>流程定义</strong><Tag bordered={false}>{isBrowserMockMode ? filteredDefinitions.length : remoteTotal} 条</Tag></div><Typography.Text type="secondary">进入版本记录可发布、取消发布、切换发布版本或从任意版本复制新建</Typography.Text></div>
        <Table<ProcessDefinition> loading={remoteLoading} rowKey="id" columns={columns} dataSource={filteredDefinitions} scroll={{ x: 1120 }} pagination={{ current: page, pageSize, total: isBrowserMockMode ? filteredDefinitions.length : remoteTotal, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录`, onChange: setPage }} />
      </Card>
      <Modal title="新建流程定义" open={createOpen} width={560} okText="继续填写基本信息" cancelText="取消" destroyOnHidden onCancel={() => { setCreateDirty(false); setCreateOpen(false); form.resetFields(); }} onOk={() => void createDefinition()}>
        <Form<CreateProcessValues> form={form} layout="vertical" requiredMark={false} initialValues={{ type: "approval" }} onValuesChange={() => setCreateDirty(true)} className="pa-modal-form"><Form.Item name="name" label="流程名称" rules={[{ required: true, message: "请输入流程名称" }, { max: 60 }]}><Input placeholder="例如：设备变更审核" maxLength={60} showCount /></Form.Item><Form.Item name="type" label="流程类型" rules={[{ required: true }]}><Select options={[{ value: "approval", label: "固定审批 — 按预设节点和连线流转" }, { value: "free", label: "自由协作 — 每次处理后选择下一位受理人" }]} /></Form.Item><Form.Item name="description" label="流程说明"><Input.TextArea placeholder="简要说明适用范围和使用目的" rows={3} maxLength={200} showCount /></Form.Item><div className="pa-inline-note">下一步填写完整基本信息。首次保存时才创建流程定义并生成正式 V1；在此之前不会形成流程或中间业务状态。</div></Form>
      </Modal>
      <Modal title="确认导入流程定义" open={Boolean(importPreview)} width={680} okText="导入为新流程" cancelText="取消" onCancel={() => setImportPreview(undefined)} onOk={confirmImport}>
        {importPreview && <Space orientation="vertical" size={16} style={{ width: "100%" }}>
          <Alert type="info" showIcon message="导入不会覆盖或自动发布流程" description="系统会生成新的流程编号和内部标识；文件中的权限组、角色、用户只按显示名称匹配，未找到的引用自动省略。" />
          <Descriptions bordered size="small" column={2} items={[
            { key: "file", label: "文件", children: importPreview.fileName, span: 2 },
            { key: "name", label: "流程名称", children: definitions.some((definition) => definition.name === importPreview.definition.name) ? `${importPreview.definition.name}（导入）` : importPreview.definition.name },
            { key: "type", label: "流程类型", children: typeMeta[importPreview.definition.type].label },
            { key: "versions", label: "版本数量", children: `${importPreview.definition.versions.length} 个完整版本` },
            { key: "publish", label: "导入后状态", children: <Tag>未发布</Tag> },
          ]} />
          {importPreview.warnings.length ? <Alert type="warning" showIcon message={`有 ${importPreview.warnings.length} 项同名信息未找到，将自动省略`} description={<div className="pa-import-warning-list">{importPreview.warnings.slice(0, 10).map((warning) => <div key={warning}>• {warning}</div>)}{importPreview.warnings.length > 10 && <div>• 另有 {importPreview.warnings.length - 10} 项</div>}</div>} /> : <Alert type="success" showIcon message="全部名称引用均已匹配" />}
        </Space>}
      </Modal>
    </div>
  );
}

export default ProcessManagementPage;
