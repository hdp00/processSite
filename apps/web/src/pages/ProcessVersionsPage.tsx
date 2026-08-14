import {
  BranchesOutlined,
  CheckCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  SelectOutlined,
  StopOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
  type TableProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { StatusPill } from "../components/StatusPill";
import {
  getEffectiveVersion,
  getVersionStatus,
  useProcessDefinitionStore,
  type DeleteVersionResult,
  type VersionStatus,
} from "../state/useProcessDefinitionStore";
import "./process-admin-pages.css";

type DefinitionType = "approval" | "free";

interface ProcessVersionsPageProps {
  definitionId?: string;
}

interface ProcessVersionRow {
  id: string;
  version: string;
  status: VersionStatus;
  firstPublishedAt?: string;
  firstPublishedBy?: string;
  publishedAt: string;
  lastWithdrawnAt?: string;
  lastWithdrawnBy?: string;
  createdBy: string;
  changeNote: string;
  instanceCount: number;
  formFieldCount: number;
  nodeCount: number;
  starterGroups: string[];
  checksum: string;
  instancePrefix?: string;
  processName?: string;
}

interface DefinitionVersionMeta {
  name: string;
  code: string;
  type: DefinitionType;
  currentVersion: string;
  instancePrefix: string;
  versions: ProcessVersionRow[];
}

const versionDataById: Record<string, DefinitionVersionMeta> = {
  "pdf-review": {
    name: "PDF 文件审核",
    code: "PROC-PDF-001",
    type: "approval",
    currentVersion: "V3",
    instancePrefix: "DOC",
    versions: [
      {
        id: "pdf-v3", version: "V3", status: "生效", publishedAt: "2026-08-02 14:30", createdBy: "王敏",
        changeNote: "增加质量节点可修改的文件等级字段；优化并行分支待办提醒。", instanceCount: 42,
        formFieldCount: 9, nodeCount: 5, starterGroups: ["PDF审核_文控_流程权限组"], checksum: "9D7A-4F21-C8B0",
      },
      {
        id: "pdf-v2", version: "V2", status: "失效", publishedAt: "2026-05-16 10:05", createdBy: "刘燕",
        changeNote: "研发、质量和生产改为同起点并行审核。", instanceCount: 71,
        formFieldCount: 8, nodeCount: 5, starterGroups: ["PDF审核_文控_流程权限组"], checksum: "3B16-A94D-78C2",
      },
      {
        id: "pdf-v1", version: "V1", status: "失效", publishedAt: "2026-02-12 09:20", createdBy: "系统管理员",
        changeNote: "首次发布，包含文控发起及研发、质量、生产顺序审核。", instanceCount: 15,
        formFieldCount: 7, nodeCount: 5, starterGroups: ["PDF审核_文控_流程权限组"], checksum: "1A44-ED90-6F31",
      },
    ],
  },
  "test-report-review": {
    name: "测试报告审核",
    code: "PROC-TR-002",
    type: "approval",
    currentVersion: "尚未发布",
    instancePrefix: "DOC",
    versions: [
      {
        id: "tr-draft", version: "草稿", status: "草稿", publishedAt: "—", createdBy: "林晓",
        changeNote: "初始草稿，正在配置生产确认节点。", instanceCount: 0,
        formFieldCount: 5, nodeCount: 4, starterGroups: ["测试报告_发起_流程权限组"], checksum: "草稿未生成",
      },
    ],
  },
  "free-collaboration": {
    name: "异常协作事项",
    code: "PROC-FREE-003",
    type: "free",
    currentVersion: "V2",
    instancePrefix: "ISSUE",
    versions: [
      {
        id: "free-v2", version: "V2", status: "生效", publishedAt: "2026-07-30 16:18", createdBy: "王敏",
        changeNote: "增加异常改派；重新打开时恢复发起表单编辑。", instanceCount: 39,
        formFieldCount: 5, nodeCount: 0, starterGroups: ["自由协作_发起_流程权限组"], checksum: "7C89-21EF-55A0",
      },
      {
        id: "free-v1", version: "V1", status: "失效", publishedAt: "2026-04-08 11:42", createdBy: "系统管理员",
        changeNote: "首次发布自由协作流程。", instanceCount: 28,
        formFieldCount: 4, nodeCount: 0, starterGroups: ["自由协作_发起_流程权限组"], checksum: "2A07-BD33-CE18",
      },
    ],
  },
};

const emptyVersionMeta: DefinitionVersionMeta = {
  name: "流程不存在",
  code: "—",
  type: "approval",
  currentVersion: "尚未发布",
  instancePrefix: "",
  versions: [],
};

export function ProcessVersionsPage({ definitionId }: ProcessVersionsPageProps) {
  const navigate = useNavigate();
  const params = useParams<{ definitionId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const resolvedId = definitionId
    ?? params.definitionId
    ?? params.id
    ?? searchParams.get("definitionId")
    ?? "";
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === resolvedId),
  );
  const ensureDraft = useProcessDefinitionStore((state) => state.ensureDraft);
  const resetDraftFromVersion = useProcessDefinitionStore((state) => state.resetDraftFromVersion);
  const withdrawEffectiveVersion = useProcessDefinitionStore((state) => state.withdrawEffectiveVersion);
  const activateVersion = useProcessDefinitionStore((state) => state.activateVersion);
  const deleteVersion = useProcessDefinitionStore((state) => state.deleteVersion);
  const fallbackMeta = versionDataById[resolvedId] ?? emptyVersionMeta;
  const effectiveVersion = getEffectiveVersion(definition);
  const definitionMeta = {
    name: definition?.name ?? fallbackMeta.name,
    code: definition?.code ?? fallbackMeta.code,
    type: definition?.type ?? fallbackMeta.type,
    currentVersion: effectiveVersion?.version
      ?? (definition?.draft?.withdrawnVersionId ? `${definition.draft.version}（已撤回）` : "尚未发布"),
  };
  const versions = useMemo<ProcessVersionRow[]>(() => {
    if (!definition) return fallbackMeta.versions;
    const withdrawnSource = definition.draft?.withdrawnVersionId
      ? definition.versions.find((item) => item.id === definition.draft?.withdrawnVersionId)
      : undefined;
    const draftRow: ProcessVersionRow[] = definition.draft ? [{
      id: definition.draft.id,
      version: definition.draft.version,
      status: "草稿",
      firstPublishedAt: withdrawnSource?.firstPublishedAt ?? withdrawnSource?.publishedAt,
      firstPublishedBy: withdrawnSource?.firstPublishedBy ?? withdrawnSource?.createdBy,
      publishedAt: withdrawnSource?.publishedAt ?? "—",
      lastWithdrawnAt: definition.draft.withdrawnAt,
      lastWithdrawnBy: definition.draft.withdrawnBy,
      createdBy: "当前用户",
      changeNote: definition.draft.withdrawnVersionId
        ? `${definition.draft.version} 已撤回发布，正在同一版本号下修改。`
        : definition.draft.basedOn
        ? `基于 ${definition.draft.basedOn} 创建，等待完成配置与发布。`
        : "初始草稿，等待完成配置与发布。",
      instanceCount: 0,
      formFieldCount: definition.draft.formFieldCount,
      nodeCount: definition.draft.nodeCount,
      starterGroups: definition.draft.basic.starterGroups,
      checksum: "草稿未生成",
      instancePrefix: definition.draft.basic.instancePrefix,
    }] : [];
    const releasedRows = definition.versions
      .filter((item) => item.id !== definition.draft?.withdrawnVersionId)
      .map((item) => ({
        ...item,
        status: getVersionStatus(definition, item.id),
        instancePrefix: item.basic.instancePrefix,
        processName: item.basic.name,
      }));
    return [...draftRow, ...releasedRows];
  }, [definition, fallbackMeta.versions]);
  const [selectedVersion, setSelectedVersion] = useState<ProcessVersionRow>();
  const [copySource, setCopySource] = useState<ProcessVersionRow>();
  const [activationTarget, setActivationTarget] = useState<ProcessVersionRow>();
  const [withdrawTarget, setWithdrawTarget] = useState<ProcessVersionRow>();
  const [deleteTarget, setDeleteTarget] = useState<ProcessVersionRow>();
  const [replacementVersionId, setReplacementVersionId] = useState<string>();

  const publishedInstances = useMemo(
    () => versions.reduce((total, version) => total + version.instanceCount, 0),
    [versions],
  );
  const hasDraft = versions.some((version) => version.status === "草稿");

  const createDraft = () => {
    if (!copySource) return;
    if (definition?.draft) {
      const reset = resetDraftFromVersion(resolvedId, copySource.version);
      setCopySource(undefined);
      if (!reset) {
        message.error("无法基于所选版本重建草稿");
        return;
      }
      message.success(`已在 ${definition.draft.version} 中载入 ${copySource.version} 的完整快照`);
      navigate(`/admin/processes/${resolvedId}/basic`);
      return;
    }
    const created = ensureDraft(resolvedId, copySource.version);
    setCopySource(undefined);
    if (!created && definition?.draft) {
      message.info("该流程已有待发布草稿，已进入现有草稿");
    } else if (!created) {
      message.error("无法从所选版本创建草稿");
      return;
    } else {
      message.success(`已基于 ${copySource.version} 创建新版本草稿`);
    }
    navigate(`/admin/processes/${resolvedId}/basic`);
  };

  const continueExistingDraft = () => {
    setCopySource(undefined);
    navigate(`/admin/processes/${resolvedId}/basic`);
  };

  const confirmActivation = () => {
    if (!activationTarget) return;
    if (!activateVersion(resolvedId, activationTarget.id)) {
      message.error("版本生效失败，请刷新后重试");
      return;
    }
    message.success(`${activationTarget.version} 已设为唯一生效版本，菜单名称已同步为“${activationTarget.processName ?? definitionMeta.name}”`);
    setActivationTarget(undefined);
  };

  const confirmWithdrawal = () => {
    if (!withdrawTarget) return;
    const result = withdrawEffectiveVersion(resolvedId, withdrawTarget.id);
    setWithdrawTarget(undefined);
    if (result === "withdrawn") {
      message.success(`${withdrawTarget.version} 已撤回为同版本草稿，流程已暂停发起`);
      navigate(`/admin/processes/${resolvedId}/basic`);
    } else if (result === "has-instances") message.error("该版本已经创建流程实例，不能撤回，请创建新版本");
    else if (result === "has-draft") message.warning("当前已有其他草稿，请先处理现有草稿");
    else message.error("版本状态已经变化，请刷新后重试");
  };

  const handleDeleteResult = (result: DeleteVersionResult, target: ProcessVersionRow) => {
    if (result === "has-instances") message.error(`${target.version} 已关联实例，不能删除`);
    else if (result === "needs-replacement") message.warning("请先选择替代生效版本");
    else if (result === "definition-deleted") {
      message.success(target.status === "草稿" ? "草稿流程及其设计数据已删除" : "最后一个无实例版本及空流程定义已删除");
      navigate("/admin/processes");
    } else if (result === "deleted") {
      if (target.status === "草稿" && definition?.draft?.withdrawnVersionId) {
        message.success(`已放弃撤回后的修改，${target.version} 已恢复为生效版本`);
        return;
      }
      if (target.status === "草稿") {
        message.success(`${target.version} 草稿已删除，当前生效版本保持不变；下次草稿将使用 V${definition?.nextVersionNumber ?? "—"}`);
        return;
      }
      const returnedToDraft = target.status === "生效" && definition?.versions.length === 1 && Boolean(definition.draft);
      message.success(returnedToDraft ? "生效版本已删除，流程已退回草稿状态" : `${target.version} 已删除，剩余版本号保持不变`);
    } else message.error("版本不存在或已被其他人删除");
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const result = deleteVersion(resolvedId, deleteTarget.id, replacementVersionId);
    if (result === "needs-replacement") return;
    handleDeleteResult(result, deleteTarget);
    setDeleteTarget(undefined);
    setReplacementVersionId(undefined);
  };

  const columns: TableProps<ProcessVersionRow>["columns"] = [
    {
      title: "版本",
      dataIndex: "version",
      width: 116,
      render: (value: string, record) => (
        <button type="button" className="pa-version-button" onClick={() => setSelectedVersion(record)}>
          <strong>{value}</strong>{record.status === "生效" && <Tag color="blue" bordered={false}>当前</Tag>}
        </button>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 112,
      render: (value: VersionStatus) => <StatusPill status={value} />,
    },
    {
      title: "发布时间",
      dataIndex: "publishedAt",
      width: 168,
      render: (value: string) => <span className={value === "—" ? "pa-muted" : undefined}>{value}</span>,
    },
    {
      title: "创建人",
      dataIndex: "createdBy",
      width: 116,
      render: (value: string) => <Space size={7}><span className="pa-user-dot"><UserOutlined /></span>{value}</Space>,
    },
    {
      title: "变更说明",
      dataIndex: "changeNote",
      width: 390,
      ellipsis: true,
      render: (value: string) => <Typography.Text ellipsis={{ tooltip: value }}>{value}</Typography.Text>,
    },
    {
      title: "实例数",
      dataIndex: "instanceCount",
      width: 94,
      align: "right",
      render: (value: number) => value.toLocaleString("zh-CN"),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      align: "center",
      width: 202,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="查看版本详情">
            <Button
              type="text"
              className="pa-icon-button"
              icon={<EyeOutlined />}
              aria-label={`查看${record.version}`}
              onClick={() => setSelectedVersion(record)}
            />
          </Tooltip>
          {record.status === "草稿" ? (
            <Tooltip title="编辑草稿">
              <Button
                type="text"
                className="pa-icon-button is-primary"
                icon={<EditOutlined />}
                aria-label={`编辑${record.version}`}
                onClick={() => navigate(`/admin/processes/${resolvedId}/basic`)}
              />
            </Tooltip>
          ) : (
            <Tooltip title={hasDraft ? "选择如何处理现有草稿" : "基于此完整快照新建草稿"}>
              <Button
                type="text"
                className="pa-icon-button is-copy"
                icon={<CopyOutlined />}
                aria-label={`基于${record.version}新建草稿`}
                onClick={() => setCopySource(record)}
              />
            </Tooltip>
          )}
          {record.status === "失效" && (
            <Tooltip title={definition?.draft?.withdrawnVersionId ? "当前版本处于撤回编辑中，重新发布或放弃修改后才能切换生效版本" : "设为唯一生效版本"}>
              <Button
                type="text"
                className="pa-icon-button is-primary"
                icon={<SelectOutlined />}
                disabled={Boolean(definition?.draft?.withdrawnVersionId)}
                aria-label={`将${record.version}设为生效版本`}
                onClick={() => setActivationTarget(record)}
              />
            </Tooltip>
          )}
          {record.status === "生效" && record.instanceCount === 0 && !hasDraft && (
            <Tooltip title={`撤回 ${record.version} 并继续编辑，版本号保持不变`}>
              <Button
                type="text"
                className="pa-icon-button is-primary"
                icon={<RollbackOutlined />}
                aria-label={`撤回${record.version}并编辑`}
                onClick={() => setWithdrawTarget(record)}
              />
            </Tooltip>
          )}
          <Tooltip title={record.instanceCount > 0 ? `已有 ${record.instanceCount} 个实例，不能删除` : record.status === "草稿" ? "删除这个未发布草稿" : "删除这个完整版本快照"}>
            <span>
              <Button
                type="text"
                danger
                disabled={record.instanceCount > 0}
                className="pa-icon-button"
                icon={<DeleteOutlined />}
                aria-label={`删除${record.version}`}
                onClick={() => { setDeleteTarget(record); setReplacementVersionId(undefined); }}
              />
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack pa-page pa-versions-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <AppBackButton onClick={() => navigate("/admin/processes")} />
          <div>
            <Space size={10} wrap>
              <Typography.Title level={3}>{definitionMeta.name}</Typography.Title>
              <Tag color={definitionMeta.type === "approval" ? "blue" : "purple"}>
                {definitionMeta.type === "approval" ? <BranchesOutlined /> : <MessageOutlined />} {definitionMeta.type === "approval" ? "固定审批" : "自由协作"}
              </Tag>
            </Space>
            <Typography.Text type="secondary">{definitionMeta.code} · 各版本定义、发布状态与生效范围</Typography.Text>
          </div>
        </div>
        {!hasDraft && (
          <Button
            type="primary"
            icon={<CopyOutlined />}
            onClick={() => setCopySource(versions.find((item) => item.status === "生效") ?? versions[0])}
          >
            基于生效版本新建草稿
          </Button>
        )}
      </Card>

      <div className="pa-version-stats">
        <Card bordered={false}><span className="pa-stat-icon is-blue"><HistoryOutlined /></span><span><small>累计版本</small><strong>{versions.length}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-green"><CheckCircleFilled /></span><span><small>唯一生效版本</small><strong>{definitionMeta.currentVersion}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-purple"><FileTextOutlined /></span><span><small>累计流程实例</small><strong>{publishedInstances}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-orange"><SafetyCertificateOutlined /></span><span><small>配置状态</small><strong>{hasDraft ? "有待发布草稿" : definition?.effectiveVersionId ? "快照完整" : "等待首次发布"}</strong></span></Card>
      </div>

      <Alert
        className="pa-page-alert"
        type="info"
        showIcon
        message={definition?.draft?.withdrawnVersionId ? `${definition.draft.version} 已撤回为草稿` : "每个版本都是完整、独立的配置快照"}
        description={definition?.draft?.withdrawnVersionId
          ? "版本号保持不变，编辑期间流程暂停发起；重新发布后恢复生效。放弃该草稿会恢复撤回前的发布快照。"
          : "已发布版本通常不可直接修改；当前生效版本实例数为 0 时可以先撤回为同版本草稿。历史版本可以创建下一草稿，无实例版本可删除，已有实例永久锁定其发起时版本。"}
      />

      <Card className="content-card pa-table-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head pa-table-head">
          <div><strong>全部版本</strong><Tag bordered={false}>{versions.length} 条</Tag></div>
          <Typography.Text type="secondary">按创建时间倒序排列</Typography.Text>
        </div>
        <Table<ProcessVersionRow>
          rowKey="id"
          columns={columns}
          dataSource={versions}
          scroll={{ x: 1120 }}
          pagination={false}
          rowClassName={(record) => record.status === "草稿" ? "pa-draft-row" : record.status === "生效" ? "pa-effective-row" : ""}
        />
      </Card>

      <Drawer
        title={<Space><HistoryOutlined /> 版本详情</Space>}
        open={Boolean(selectedVersion)}
        width={560}
        onClose={() => setSelectedVersion(undefined)}
        extra={selectedVersion?.status === "草稿"
          ? <Button type="primary" icon={<EditOutlined />} onClick={() => navigate(`/admin/processes/${resolvedId}/basic`)}>编辑草稿</Button>
          : null}
      >
        {selectedVersion && (
          <div className="pa-version-drawer">
            <div className="pa-version-drawer__hero">
              <span className={`pa-version-emblem ${selectedVersion.status === "生效" ? "is-current" : ""}`}>{selectedVersion.version}</span>
              <span>
                <Space size={8}>
                  <Typography.Title level={4}>{selectedVersion.processName ?? definitionMeta.name}</Typography.Title>
                  <StatusPill status={selectedVersion.status} />
                </Space>
                <Typography.Text type="secondary">配置快照校验码：{selectedVersion.checksum}</Typography.Text>
              </span>
            </div>

            {selectedVersion.status !== "草稿" && (
              <Alert type="info" showIcon message="该版本为只读快照" description="表单、节点、权限和规则均按发布时间固化，不能在此直接修改。" />
            )}
            {selectedVersion.status === "草稿" && definition?.draft?.withdrawnVersionId && (
              <Alert type="warning" showIcon message="该版本正在撤回编辑" description="重新发布后版本号保持不变；删除这个草稿将放弃修改并恢复撤回前的发布快照。" />
            )}

            <Descriptions
              className="pa-drawer-descriptions"
              bordered
              size="small"
              column={1}
              items={[
                { key: "firstPublishedAt", label: "首次发布时间", children: selectedVersion.firstPublishedAt ?? selectedVersion.publishedAt },
                { key: "firstPublishedBy", label: "首次发布人", children: selectedVersion.firstPublishedBy ?? selectedVersion.createdBy },
                { key: "publishedAt", label: "最近发布时间", children: selectedVersion.publishedAt },
                { key: "createdBy", label: "创建人", children: selectedVersion.createdBy },
                { key: "instances", label: "关联实例", children: `${selectedVersion.instanceCount} 个` },
                { key: "instancePrefix", label: "实例编号前缀", children: selectedVersion.instancePrefix ?? fallbackMeta.instancePrefix },
                { key: "fields", label: "表单字段", children: `${selectedVersion.formFieldCount} 个` },
                { key: "nodes", label: definitionMeta.type === "approval" ? "流程节点" : "节点设计", children: definitionMeta.type === "approval" ? `${selectedVersion.nodeCount} 个` : "自由协作不使用节点设计器" },
                { key: "group", label: "发起权限组", children: selectedVersion.starterGroups.length ? selectedVersion.starterGroups.join("、") : "尚未选择" },
              ]}
            />

            <Card size="small" className="pa-change-note-card" title="变更说明">
              {selectedVersion.changeNote}
            </Card>

            <Divider>版本生命周期</Divider>
            <Timeline
              items={selectedVersion.status === "草稿" ? [
                { color: "blue", children: <><strong>{definition?.draft?.withdrawnVersionId ? "版本撤回" : "草稿创建"}</strong><small>{definition?.draft?.withdrawnVersionId ? "实例数为 0，版本号保持不变并暂停发起" : "当前用户基于历史版本创建"}</small></> },
                { color: "gray", dot: <InfoCircleOutlined />, children: <><strong>等待发布</strong><small>完成配置和校验后形成正式版本</small></> },
              ] : [
                { color: "green", children: <><strong>首次发布</strong><small>{selectedVersion.firstPublishedAt ?? selectedVersion.publishedAt} · {selectedVersion.firstPublishedBy ?? selectedVersion.createdBy}</small></> },
                ...(selectedVersion.lastWithdrawnAt ? [{ color: "orange", dot: <RollbackOutlined />, children: <><strong>撤回发布</strong><small>{selectedVersion.lastWithdrawnAt} · {selectedVersion.lastWithdrawnBy ?? "当前用户"}</small></> }] : []),
                ...(selectedVersion.firstPublishedAt && selectedVersion.firstPublishedAt !== selectedVersion.publishedAt ? [{ color: "green", children: <><strong>重新发布</strong><small>{selectedVersion.publishedAt} · {selectedVersion.createdBy}</small></> }] : []),
                ...(selectedVersion.status === "失效" ? [{ color: "gray", dot: <StopOutlined />, children: <><strong>版本失效</strong><small>被其他版本替代，历史实例仍锁定此完整快照</small></> }] : []),
                { color: "blue", children: <><strong>已关联 {selectedVersion.instanceCount} 个实例</strong><small>实例继续按此版本规则运行</small></> },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal
        title="基于历史版本新建草稿"
        open={Boolean(copySource)}
        width={540}
        okText={definition?.draft ? `放弃并重建 ${definition.draft.version}` : "新建草稿"}
        cancelText="取消"
        onCancel={() => setCopySource(undefined)}
        onOk={createDraft}
        okButtonProps={definition?.draft ? { danger: true } : undefined}
        footer={definition?.draft ? [
          <Button key="cancel" onClick={() => setCopySource(undefined)}>取消</Button>,
          <Button key="continue" onClick={continueExistingDraft}>继续编辑现有草稿</Button>,
          <Button key="replace" danger type="primary" onClick={createDraft}>放弃并基于 {copySource?.version} 重建</Button>,
        ] : undefined}
      >
        {copySource && (
          <div className="pa-copy-version-modal">
            {definition?.draft && (
              <Alert
                type="warning"
                showIcon
                message={`当前已有 ${definition.draft.version} 草稿`}
                description="可以继续编辑现有草稿，或放弃草稿中的未发布修改并在同一版本号下重新载入所选完整快照。"
              />
            )}
            <Alert
              type="info"
              showIcon
              message={`将复制 ${copySource.version} 的完整配置`}
              description="复制范围包括流程名称与编号前缀、完整表单、列表配置、节点、流程规则和权限引用；新草稿运行时不再依赖来源版本。"
            />
            <div className="pa-copy-source">
              <span><small>源版本</small><strong>{copySource.version}</strong></span>
              <span><small>表单字段</small><strong>{copySource.formFieldCount}</strong></span>
              <span><small>{definitionMeta.type === "approval" ? "流程节点" : "流程类型"}</small><strong>{definitionMeta.type === "approval" ? copySource.nodeCount : "自由协作"}</strong></span>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title={`撤回 ${withdrawTarget?.version ?? ""} 并继续编辑？`}
        open={Boolean(withdrawTarget)}
        width={560}
        okText="撤回并编辑"
        cancelText="取消"
        onCancel={() => setWithdrawTarget(undefined)}
        onOk={confirmWithdrawal}
      >
        {withdrawTarget && (
          <div className="pa-copy-version-modal">
            <Alert
              type="warning"
              showIcon
              message="编辑期间流程将暂停发起"
              description={`${withdrawTarget.version} 尚未创建流程实例，可以安全撤回为草稿。版本号保持 ${withdrawTarget.version} 不变，重新发布时不会生成下一版本。`}
            />
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: "version", label: "草稿版本", children: withdrawTarget.version },
                { key: "firstPublishedAt", label: "首次发布时间", children: withdrawTarget.firstPublishedAt ?? withdrawTarget.publishedAt },
                { key: "firstPublishedBy", label: "首次发布人", children: withdrawTarget.firstPublishedBy ?? withdrawTarget.createdBy },
                { key: "publishedAt", label: "最近发布时间", children: withdrawTarget.publishedAt },
                { key: "instances", label: "关联实例", children: "0 个" },
              ]}
            />
          </div>
        )}
      </Modal>

      <Modal
        title={`将 ${activationTarget?.version ?? ""} 设为生效版本？`}
        open={Boolean(activationTarget)}
        width={560}
        okText="确认切换生效版本"
        cancelText="取消"
        onCancel={() => setActivationTarget(undefined)}
        onOk={confirmActivation}
      >
        {activationTarget && (
          <div className="pa-copy-version-modal">
            <Alert
              type="warning"
              showIcon
              message="流程只允许一个生效版本"
              description={`切换后 ${activationTarget.version} 成为唯一生效版本，当前版本自动失效；新实例和流程清单使用该快照，已有实例保持原版本。`}
            />
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: "name", label: "菜单名称同步为", children: activationTarget.processName ?? definitionMeta.name },
                { key: "prefix", label: "实例编号前缀", children: activationTarget.instancePrefix ?? "—" },
                { key: "snapshot", label: "完整快照", children: `${activationTarget.formFieldCount} 个表单字段 · ${definitionMeta.type === "approval" ? `${activationTarget.nodeCount} 个节点` : "自由协作规则"}` },
              ]}
            />
          </div>
        )}
      </Modal>

      <Modal
        title={deleteTarget?.status === "草稿" && definition?.versions.length === 0
          ? `删除草稿流程“${definitionMeta.name}”？`
          : `${deleteTarget?.status === "草稿" ? "删除草稿" : "删除版本"} ${deleteTarget?.version ?? ""}？`}
        open={Boolean(deleteTarget)}
        width={570}
        okText={deleteTarget?.status === "草稿" && definition?.versions.length === 0 ? "删除草稿流程" : deleteTarget?.status === "草稿" ? "删除草稿" : "确认删除"}
        okButtonProps={{ danger: true, disabled: deleteTarget?.status === "生效" && (definition?.versions.length ?? 0) > 1 && !replacementVersionId }}
        cancelText="取消"
        onCancel={() => { setDeleteTarget(undefined); setReplacementVersionId(undefined); }}
        onOk={confirmDelete}
      >
        {deleteTarget && (
          <div className="pa-copy-version-modal">
            <Alert
              type={deleteTarget.status === "生效" ? "warning" : "error"}
              showIcon
              message={deleteTarget.status === "草稿" && definition?.versions.length === 0
                ? "未发布的流程定义和设计数据将一并删除"
                : deleteTarget.status === "草稿" && definition?.draft?.withdrawnVersionId
                  ? "将放弃撤回后的全部修改"
                  : deleteTarget.status === "草稿"
                    ? "草稿中的未发布配置将丢失"
                    : "完整版本快照删除后不可恢复"}
              description={deleteTarget.status === "草稿" && definition?.versions.length === 0
                ? "该流程从未发布。确认后会删除流程定义、初始表单、流程图和列表字段设计，并从流程管理中移除。"
                : deleteTarget.status === "草稿" && definition?.draft?.withdrawnVersionId
                  ? `删除后恢复 ${deleteTarget.version} 撤回前的完整发布快照及原启停状态，版本号保持不变。`
                  : deleteTarget.status === "草稿"
                    ? `只删除未发布的 ${deleteTarget.version} 草稿；当前生效版本和已有实例不受影响。该版本号不会复用，下次草稿使用 V${definition?.nextVersionNumber ?? "—"}。`
                    : deleteTarget.status === "生效" && definition?.versions.length === 1 && definition.draft
                ? "这是唯一生效版本。删除后流程保留现有草稿并自动退回草稿状态，员工侧菜单和发起入口会移除。"
                : deleteTarget.status === "生效" && (definition?.versions.length ?? 0) > 1
                  ? "请明确选择替代生效版本；替代生效和删除将在同一操作中完成。"
                  : deleteTarget.status === "生效" && definition?.versions.length === 1
                    ? "这是流程唯一的版本且没有关联实例。确认后会同时删除该版本和空流程定义，员工侧菜单随即移除。"
                  : "该版本没有关联实例，可以独立删除；剩余版本号不会重排或复用。"}
            />
            {deleteTarget.status === "生效" && (definition?.versions.length ?? 0) > 1 && (
              <div>
                <Typography.Text strong>替代生效版本</Typography.Text>
                <Select
                  className="pa-replacement-select"
                  value={replacementVersionId}
                  placeholder="请选择一个失效版本"
                  onChange={setReplacementVersionId}
                  options={versions.filter((item) => item.status === "失效").map((item) => ({ value: item.id, label: `${item.version} · ${item.processName ?? definitionMeta.name} · ${item.instanceCount} 个实例` }))}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default ProcessVersionsPage;
