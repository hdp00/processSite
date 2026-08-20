import { ApartmentOutlined, ArrowDownOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, FormOutlined, HistoryOutlined, PauseCircleOutlined, PlayCircleOutlined, RocketOutlined, SafetyCertificateOutlined, TableOutlined, TeamOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Drawer, Input, Modal, Space, Table, Tabs, Tag, Timeline, Tooltip, Typography, message, type TableProps } from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { StatusPill } from "../components/StatusPill";
import { resolveWorkflowGroupLabel, resolveWorkflowGroupLabels, useIdentityStore } from "../state/useIdentityStore";
import { canEditVersion, definitionStatus, getPublishedVersion, getVersionStatus, useProcessDefinitionStore, type ProcessVersion } from "../state/useProcessDefinitionStore";
import { buildFlowLevels, conditionOperatorLabel, normalizeDesignerInputPermission, rejectionHandlingLabel, type StoredDesignerField, type StoredNodeEmailNotification } from "../utils/designerStorage";
import "./process-admin-pages.css";

const fieldTypeLabels: Record<string, string> = {
  text: "文本框",
  richtext: "富文本编辑框",
  select: "下拉框",
  cascader: "多级下拉框",
  radio: "单选框",
  checkbox: "复选框",
  attachment: "附件上传",
  table: "表格",
};

const valueText = (value?: string | string[]) => Array.isArray(value) ? value.join("、") : value || "—";

function VersionFormSnapshot({ version }: { version: ProcessVersion }) {
  const fields = version.snapshot.form.fields;
  const fieldLabels = new Map(fields.map((field) => [field.id, field.label]));
  return <div className="pa-snapshot-stack">
    <div className="pa-snapshot-heading"><div><FormOutlined /><span><strong>初始表单</strong><small>以下内容来自该版本保存的表单完整快照</small></span></div><Tag>{fields.length} 个字段</Tag></div>
    {fields.length ? fields.map((field, index) => <article className="pa-snapshot-field" key={field.id}>
      <header><span className="pa-snapshot-index">{index + 1}</span><div><strong>{field.label || "未命名字段"}</strong><small>{field.id}</small></div><Space size={5} wrap><Tag color="blue">{fieldTypeLabels[field.type] ?? field.type}</Tag>{field.required && <Tag color="red">必填</Tag>}</Space></header>
      {field.description && <p>{field.description}</p>}
      <div className="pa-snapshot-properties">
        <span><small>提示文字</small><strong>{field.placeholder || "—"}</strong></span>
        <span><small>默认值</small><strong>{valueText(field.defaultValue)}</strong></span>
        <span><small>列表、查询与导出</small><strong>{[field.taskVisible && "任务中心", field.listVisible && "流程清单", field.queryable && "可查询", field.exportVisible && "Excel 导出"].filter(Boolean).join("、") || "不展示"}</strong></span>
        <span><small>输入权限</small><strong>{{ initiator: "发起人", both: "发起人/审核人", reviewer: "审核人" }[normalizeDesignerInputPermission(field)]}</strong></span>
      </div>
      {field.options?.length ? <div className="pa-snapshot-options"><small>选项</small><Space size={[5, 5]} wrap>{field.options.map((option) => <Tag key={option}>{option}</Tag>)}</Space></div> : null}
      {field.displayCondition?.rules.length ? <div className="pa-snapshot-options"><small>显示条件</small><span>{field.displayCondition.rules.map((rule) => `${fieldLabels.get(rule.fieldId) ?? rule.fieldId} ${conditionOperatorLabel(rule.operator)} ${["empty", "not-empty"].includes(rule.operator) ? "" : String(rule.value ?? "")}`.trim()).join(field.displayCondition.mode === "all" ? " 且 " : " 或 ")}</span></div> : null}
      {field.type === "attachment" ? <div className="pa-snapshot-options"><small>附件规则</small><span>最多 {field.attachment?.maxCount ?? 20} 个，单文件不超过 {field.attachment?.maxSizeMb ?? 100} MB；PDF {field.attachment?.inlinePdf ? "在页面内展示" : "仅提供下载"}</span></div> : null}
      {field.type === "table" ? <VersionTableColumns field={field} /> : null}
    </article>) : <Alert type="warning" showIcon message="该版本尚未配置初始表单字段" />}
    <section className="pa-snapshot-list-fields">
      <div className="pa-snapshot-subtitle"><TableOutlined /><strong>系统列表字段</strong></div>
      <div>{version.snapshot.systemFields.map((field) => <span key={field.key}><strong>{field.label}</strong><small>{[field.taskVisible && "任务中心", field.processListVisible && "流程清单", field.exportVisible && "Excel 导出"].filter(Boolean).join("、") || "不展示"}</small></span>)}</div>
    </section>
  </div>;
}

function VersionTableColumns({ field }: { field: StoredDesignerField }) {
  return <div className="pa-snapshot-table-columns">
    <div><strong>表格列</strong><span>类型</span><span>必填</span><span>审核可输入</span></div>
    {(field.columns ?? []).map((column) => <div key={column.id}><strong>{column.label}<small>{column.id}</small></strong><span>{fieldTypeLabels[column.type ?? "text"] ?? column.type}</span><span>{column.required ? "是" : "否"}</span><span>{column.reviewEditable ? "是" : "否"}</span></div>)}
  </div>;
}

function VersionFlowSnapshot({ version, type }: { version: ProcessVersion; type: "approval" | "free" }) {
  const users = useIdentityStore((state) => state.users);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const emailNotificationText = (notification?: StoredNodeEmailNotification) => {
    if (!notification?.enabled) return "不发送";
    const recipients = [
      notification.notifyReviewers ? "审核人" : "",
      notification.notifyInitiator ? "发起人" : "",
      ...(notification.extraUserIds ?? []).map((userId) => {
        const user = users.find((item) => item.id === userId);
        const email = user && "email" in user ? String(user.email ?? "").trim() : "";
        return user ? `${user.name}${email ? ` <${email}>` : "（未维护邮箱）"}` : userId;
      }),
    ].filter(Boolean);
    return recipients.length ? recipients.join("、") : "已启用，未配置收件人";
  };
  if (type === "free") {
    const rules = [
      ["连续流转", "当前受理人处理后选择下一位受理人"],
      ["手动关闭", "处理人可关闭流程，关闭动作进入时间线"],
      ["重新打开", "填写理由后恢复流转与初始表单编辑"],
      ["异常改派", "有权限的管理员可更换当前受理人"],
      ["本人可编辑", "参与者可编辑自己发布的历史内容并保留版本"],
      ["不支持打印", "自由协作流程不生成流程 PDF"],
    ];
    return <div className="pa-snapshot-stack">
      <div className="pa-snapshot-heading"><div><TeamOutlined /><span><strong>自由协作规则</strong><small>该流程类型无需设计审批拓扑</small></span></div></div>
      <div className="pa-snapshot-group"><small>受理流程权限组</small><Space wrap>{version.basic.assigneeGroups?.length ? version.basic.assigneeGroups.map((group) => <Tag color="purple" key={group}>{resolveWorkflowGroupLabel(workflowGroups, group)}</Tag>) : <Typography.Text type="danger">未配置</Typography.Text>}</Space></div>
      <div className="pa-snapshot-rule-grid">{rules.map(([title, detail]) => <div key={title}><CheckCircleOutlined /><span><strong>{title}</strong><small>{detail}</small></span></div>)}</div>
    </div>;
  }

  const nodes = version.snapshot.flow.nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const levels = buildFlowLevels(nodes, version.snapshot.flow.edges).map((level) => level.flatMap((id) => {
    const node = nodeById.get(id);
    return node ? [node] : [];
  }));
  const fieldLabels = new Map(version.snapshot.form.fields.flatMap((field) => field.type === "table"
    ? (field.columns ?? []).map((column) => [`${field.id}.${column.id}`, `${field.label} / ${column.label}`] as const)
    : [[field.id, field.label] as const]));

  return <div className="pa-snapshot-stack">
    <div className="pa-snapshot-heading"><div><ApartmentOutlined /><span><strong>审批流程</strong><small>按该版本保存的节点和连线生成，只读展示</small></span></div><Tag>{nodes.length} 个节点</Tag></div>
    {levels.length && levels.some((level) => level.length) ? <div className="pa-version-flow">
      {levels.map((level, index) => {
        const approvalCount = level.filter((node) => node.data?.kind === "approval").length;
        return <div key={`flow-level-${index}`}>
          <section className="pa-version-flow-stage">
            <header><span>步骤 {index + 1}</span><Tag color={approvalCount > 1 ? "blue" : "default"}>{approvalCount > 1 ? `并行 · ${approvalCount} 个节点` : level[0]?.data?.kind === "start" ? "开始" : level[0]?.data?.kind === "end" ? "结束" : "顺序处理"}</Tag></header>
            <div className={approvalCount > 1 ? "is-parallel" : ""}>{level.map((node) => {
              const kind = node.data?.kind ?? "approval";
              const editableFields = (node.data?.editableFields ?? []).map((id) => fieldLabels.get(id) ?? id);
              return <article className={`pa-version-flow-node is-${kind}`} key={node.id}>
                <div className="pa-version-flow-node__title"><span>{kind === "start" ? <PlayCircleOutlined /> : kind === "end" ? <CheckCircleOutlined /> : <ApartmentOutlined />}</span><strong>{node.data?.label || "未命名节点"}</strong></div>
                {kind === "start" && <p><small>发起权限组</small><span>{resolveWorkflowGroupLabels(workflowGroups, node.data?.permissionGroups ?? []).join("、") || "未配置"}</span></p>}
                {kind === "approval" && <><p><small>执行权限组</small><span>{node.data?.permissionGroup ? resolveWorkflowGroupLabel(workflowGroups, node.data.permissionGroup) : "未配置"}</span></p><p><small>处理方式</small><span>{node.data?.handlingMode === "confirmation" ? "确认（只能确认，不能驳回）" : "审批（可通过或驳回）"}</span></p><p><small>人员分配</small><span>{node.data?.specifyAssignee ? "发起时可指定；组内仍可代办" : "组内任一成员可处理"}</span></p><p><small>可修改字段</small><span>{editableFields.join("、") || "不可修改表单内容"}</span></p><p><small>重复修改</small><span>{node.data?.allowRepeatedEditing ? "允许处理结果提交后继续修改授权字段" : "不允许"}</span></p><p><small>执行条件</small><span>{node.data?.activationCondition?.rules.length ? node.data.activationCondition.rules.map((rule) => `${fieldLabels.get(rule.fieldId) ?? rule.fieldId} ${conditionOperatorLabel(rule.operator)} ${["empty", "not-empty"].includes(rule.operator) ? "" : String(rule.value ?? "")}`).join(node.data.activationCondition.mode === "all" ? " 且 " : " 或 ") : "始终执行"}</span></p><p><small>邮件通知</small><span>{emailNotificationText(node.data?.emailNotification)}</span></p></>}
                {kind === "end" && <><p><small>完成条件</small><span>全部前序节点通过、确认或因条件不满足而跳过</span></p><p><small>邮件通知</small><span>{emailNotificationText(node.data?.emailNotification)}</span></p></>}
              </article>;
            })}</div>
          </section>
          {index < levels.length - 1 && <div className="pa-version-flow-arrow"><ArrowDownOutlined /><small>{level.length > 1 ? "全部通过或确认后继续" : "继续"}</small></div>}
        </div>;
      })}
    </div> : <Alert type="warning" showIcon message="该版本尚未形成可展示的审批拓扑" />}
    <Alert type="info" showIcon message={`驳回处理：${rejectionHandlingLabel(version.snapshot.flow.meta?.rejectionHandling)}`} description={version.snapshot.flow.meta?.rejectionHandling === "auto-close" ? "任一节点驳回后流程自动关闭。" : version.snapshot.flow.meta?.rejectionHandling === "resubmit-only" ? "发起方修改后重新提交，所有审批节点重新开始。" : "发起方可修改后重新提交并重新开始全部审批；关闭权限组也可以直接关闭流程。"} />
  </div>;
}

export function ProcessVersionsPage() {
  const navigate = useNavigate();
  const { definitionId = "" } = useParams<{ definitionId: string }>();
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === definitionId));
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const createVersion = useProcessDefinitionStore((state) => state.createVersion);
  const publishVersion = useProcessDefinitionStore((state) => state.publishVersion);
  const unpublishVersion = useProcessDefinitionStore((state) => state.unpublishVersion);
  const deleteVersion = useProcessDefinitionStore((state) => state.deleteVersion);
  const [selected, setSelected] = useState<ProcessVersion>();
  const [unpublishTarget, setUnpublishTarget] = useState<ProcessVersion>();
  const [unpublishReason, setUnpublishReason] = useState("");

  const versions = useMemo(() => definition ? [...definition.versions].sort((a, b) => Number(b.version.slice(1)) - Number(a.version.slice(1))) : [], [definition]);
  if (!definition) return <Alert type="error" showIcon message="流程定义不存在" action={<AppBackButton onClick={() => navigate("/admin/processes")} />} />;

  const edit = (version: ProcessVersion) => navigate(`/admin/processes/${definition.id}/basic?versionId=${version.id}`);
  const copy = (version: ProcessVersion) => {
    const id = createVersion(definition.id, version.id);
    const created = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definition.id)?.versions.find((item) => item.id === id);
    if (!created) return message.error("新版本创建失败");
    message.success(`已从 ${version.version} 的完整快照创建 ${created.version}`);
    edit(created);
  };
  const publish = (version: ProcessVersion) => {
    if (version.validation.status !== "通过") return message.error("该版本校验未通过，不能发布");
    const current = getPublishedVersion(definition);
    Modal.confirm({
      title: current ? `将发布版本从 ${current.version} 切换为 ${version.version}？` : `发布 ${version.version}？`,
      content: current ? "切换会原子完成：原版本退出发布，新发起实例立即使用目标版本；运行中实例仍锁定原版本。" : "发布后符合权限的员工可发起该流程。",
      okText: current ? "确认切换" : "确认发布",
      cancelText: "取消",
      onOk: () => {
        if (!publishVersion(definition.id, version.id, current ? `从 ${current.version} 切换发布` : "首次发布")) return message.error("发布失败，请重新检查版本校验结果");
        message.success(`${version.version} 已发布`);
      },
    });
  };
  const unpublish = (version: ProcessVersion) => {
    setUnpublishTarget(version);
    setUnpublishReason("");
  };
  const remove = (version: ProcessVersion) => {
    Modal.confirm({
      title: `删除版本 ${version.version}？`,
      content: `将删除该版本保存的基本信息、表单、流程图和列表字段完整快照。版本号不会复用，下一个版本仍为 V${definition.nextVersionNumber}。`,
      okText: "确认删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        const result = deleteVersion(definition.id, version.id);
        if (result === "published") return message.error("发布版本必须先取消发布");
        if (result === "has-instances") return message.error("该版本已有实例，不能删除");
        if (result === "definition-deleted") { message.success("最后一个版本和流程定义已删除"); navigate("/admin/processes"); return; }
        if (result !== "deleted") return message.error("版本状态已经变化");
        message.success(`${version.version} 已删除，版本号不会复用`);
      },
    });
  };

  const columns: TableProps<ProcessVersion>["columns"] = [
    { title: "版本", dataIndex: "version", width: 92, render: (value: string, record) => <button type="button" className="pa-version-button" onClick={() => setSelected(record)}><span className="pa-version">{value}</span></button> },
    { title: "版本状态", key: "status", width: 130, render: (_, record) => <StatusPill status={getVersionStatus(definition, record.id)} /> },
    { title: "来源版本", dataIndex: "basedOn", width: 110, render: (value?: string) => value ?? "首次创建" },
    { title: "完整快照", key: "snapshot", width: 190, render: (_, record) => <Space size={6} wrap><Tag bordered={false}>{record.formFieldCount} 个字段</Tag>{definition.type === "approval" && <Tag bordered={false}>{record.nodeCount} 个节点</Tag>}</Space> },
    { title: "编号前缀", key: "prefix", width: 120, render: (_, record) => record.basic.instancePrefix ? <Tag color="blue" bordered={false}>{record.basic.instancePrefix}</Tag> : "—" },
    { title: "实例数", dataIndex: "instanceCount", width: 88, align: "right" },
    { title: "最近更新", dataIndex: "updatedAt", width: 190, render: (value: string, record) => <span className="pa-two-line-cell"><span>{value}</span><small>{record.updatedBy}</small></span> },
    {
      title: "操作", key: "actions", fixed: "right", width: 220, align: "center",
      render: (_, record) => {
        const status = getVersionStatus(definition, record.id);
        return <Space size={3}>
          <Tooltip title="查看完整快照"><Button type="text" className="pa-icon-button" icon={<EyeOutlined />} onClick={() => setSelected(record)} /></Tooltip>
          {canEditVersion(definition, record) && <Tooltip title="编辑这个正式版本"><Button type="text" className="pa-icon-button is-primary" icon={<EditOutlined />} onClick={() => edit(record)} /></Tooltip>}
          <Tooltip title="从此版本复制新建下一版本"><Button type="text" className="pa-icon-button is-copy" icon={<CopyOutlined />} onClick={() => copy(record)} /></Tooltip>
          {status === "已发布" ? <Tooltip title="取消发布"><Button type="text" className="pa-icon-button" icon={<PauseCircleOutlined />} onClick={() => unpublish(record)} /></Tooltip> : <Tooltip title={status === "可发布" ? "发布此版本" : "校验通过后才可发布"}><Button type="text" className="pa-icon-button" icon={<RocketOutlined />} disabled={status !== "可发布"} onClick={() => publish(record)} /></Tooltip>}
          <Tooltip title={record.instanceCount ? "已有实例，不可删除" : status === "已发布" ? "先取消发布才能删除" : "删除版本"}><Button type="text" danger icon={<DeleteOutlined />} disabled={Boolean(record.instanceCount || status === "已发布")} onClick={() => remove(record)} /></Tooltip>
        </Space>;
      },
    },
  ];

  const published = getPublishedVersion(definition);
  return <div className="page-stack pa-page">
    <Card className="pa-config-head" bordered={false}>
      <div className="pa-config-head__main"><AppBackButton onClick={() => navigate("/admin/processes")} /><div><Space size={10} wrap><Typography.Title level={3}>{definition.name}</Typography.Title><StatusPill status={definitionStatus(definition)} /></Space><Typography.Text type="secondary">{definition.code} · 流程定义与版本记录</Typography.Text></div></div>
      <Button icon={<CheckCircleOutlined />} onClick={() => published ? setSelected(published) : message.info("当前没有发布版本")}>查看发布版本</Button>
    </Card>
    <div className="pa-version-stats"><Card bordered={false}><span className="pa-stat-icon"><HistoryOutlined /></span><span><small>正式版本</small><strong>{versions.length}</strong></span></Card><Card bordered={false}><span className="pa-stat-icon is-green"><RocketOutlined /></span><span><small>当前发布</small><strong>{published?.version ?? "无"}</strong></span></Card><Card bordered={false}><span className="pa-stat-icon is-orange"><SafetyCertificateOutlined /></span><span><small>校验通过</small><strong>{versions.filter((item) => item.validation.status === "通过").length}</strong></span></Card></div>
    <Alert type="info" showIcon message="流程定义负责入口，版本保存完整配置" description="名称相同的各版本共用一个员工侧菜单。每个版本独立保存基本信息、表单、列表字段、流程图和规则；发布只是把流程定义的发布指针切换到一个校验通过版本。" />
    <Card className="content-card pa-table-card" styles={{ body: { padding: 0 } }}><div className="table-result-head pa-table-head"><div><strong>版本记录</strong><Tag bordered={false}>{versions.length} 个</Tag></div><Typography.Text type="secondary">任何版本都可复制新建；已有实例的版本永久只读</Typography.Text></div><Table<ProcessVersion> rowKey="id" columns={columns} dataSource={versions} scroll={{ x: 1210 }} pagination={false} rowClassName={(record) => definition.publishedVersionId === record.id ? "pa-effective-row" : ""} /></Card>
    <Drawer title={selected ? `${definition.name} · ${selected.version} 完整快照` : "版本详情"} size="large" open={Boolean(selected)} onClose={() => setSelected(undefined)} extra={selected && canEditVersion(definition, selected) ? <Button type="primary" icon={<EditOutlined />} onClick={() => edit(selected)}>编辑版本</Button> : null}>
      {selected && <Tabs className="pa-version-snapshot-tabs" defaultActiveKey="overview" items={[
        { key: "overview", label: "版本概览", children: <Space orientation="vertical" size={18} style={{ width: "100%" }}><Descriptions column={2} bordered size="small" items={[{ key: "status", label: "版本状态", children: <StatusPill status={getVersionStatus(definition, selected.id)} /> }, { key: "source", label: "来源版本", children: selected.basedOn ?? "首次创建" }, { key: "prefix", label: "编号前缀", children: selected.basic.instancePrefix || "—" }, { key: "instances", label: "实例数", children: selected.instanceCount }, { key: "starter", label: "发起权限组", children: resolveWorkflowGroupLabels(workflowGroups, selected.basic.starterGroups).join("、") || "—", span: 2 }, { key: "closer", label: "关闭权限组", children: resolveWorkflowGroupLabels(workflowGroups, selected.basic.closeGroups).join("、") || "—", span: 2 }, ...(definition.type === "free" ? [{ key: "assignee", label: "审批/受理权限组", children: resolveWorkflowGroupLabels(workflowGroups, selected.basic.assigneeGroups ?? []).join("、") || "—", span: 2 as const }] : []), { key: "visible", label: "额外可见范围", children: [...selected.basic.visibleRoles, ...selected.basic.visibleUsers].join("、") || "—", span: 2 }, { key: "updated", label: "最近更新", children: `${selected.updatedAt} · ${selected.updatedBy}`, span: 2 }]} />
          <Alert type={selected.validation.status === "通过" ? "success" : "error"} showIcon message={selected.validation.status === "通过" ? "版本校验通过，可以发布" : "版本校验未通过"} description={selected.validation.issues.length ? selected.validation.issues.join("；") : `自动校验于 ${selected.validation.checkedAt} 完成`} />
          <Timeline items={[{ color: "blue", children: <><strong>创建 {selected.version}</strong><br /><Typography.Text type="secondary">{selected.createdAt} · {selected.createdBy}</Typography.Text></> }, ...(selected.firstPublishedAt ? [{ color: "green", children: <><strong>首次发布</strong><br /><Typography.Text type="secondary">{selected.firstPublishedAt} · {selected.firstPublishedBy}</Typography.Text></> }] : []), ...(selected.lastUnpublishedAt ? [{ color: "gray", children: <><strong>最近取消发布</strong><br /><Typography.Text type="secondary">{selected.lastUnpublishedAt} · {selected.lastUnpublishedBy}<br />原因：{selected.lastUnpublishReason ?? "—"}</Typography.Text></> }] : [])]} />
        </Space> },
        { key: "form", label: <span><FormOutlined /> 初始表单</span>, children: <VersionFormSnapshot version={selected} /> },
        { key: "flow", label: <span><ApartmentOutlined /> {definition.type === "approval" ? "审批流程" : "协作规则"}</span>, children: <VersionFlowSnapshot version={selected} type={definition.type} /> },
      ]} />}
    </Drawer>
    <Modal
      title={`取消发布 ${unpublishTarget?.version ?? ""}`}
      open={Boolean(unpublishTarget)}
      okText="确认取消发布"
      cancelText="返回"
      okButtonProps={{ disabled: !unpublishReason.trim() }}
      onCancel={() => setUnpublishTarget(undefined)}
      onOk={() => {
        if (!unpublishTarget || !unpublishReason.trim()) return;
        if (unpublishVersion(definition.id, unpublishTarget.id, unpublishReason) !== "unpublished") return message.error("发布状态已经变化");
        message.success(`${unpublishTarget.version} 已取消发布`);
        setUnpublishTarget(undefined);
      }}
    >
      <Alert type="warning" showIcon message="取消后流程将没有发布版本" description={unpublishTarget?.instanceCount ? "员工不能发起新实例，已有实例继续按原版本运行；由于已有实例，该版本仍不可编辑。" : "员工不能发起新实例；版本号和完整配置保留，取消后可直接编辑。"} />
      <Typography.Text strong style={{ display: "block", marginTop: 18, marginBottom: 8 }}>取消发布原因</Typography.Text>
      <Input.TextArea value={unpublishReason} onChange={(event) => setUnpublishReason(event.target.value)} rows={3} maxLength={200} showCount placeholder="请说明取消发布原因" />
    </Modal>
  </div>;
}

export default ProcessVersionsPage;
