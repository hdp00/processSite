import {
  ArrowLeftOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  CopyOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  SafetyCertificateOutlined,
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
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import "./process-admin-pages.css";

type VersionStatus = "草稿" | "已发布" | "已停用";
type DefinitionType = "approval" | "free";

interface ProcessVersionsPageProps {
  definitionId?: string;
}

interface ProcessVersionRow {
  id: string;
  version: string;
  status: VersionStatus;
  publishedAt: string;
  createdBy: string;
  changeNote: string;
  instanceCount: number;
  formFieldCount: number;
  nodeCount: number;
  starterGroup: string;
  checksum: string;
  instancePrefix?: string;
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
    currentVersion: "v3",
    instancePrefix: "DOC",
    versions: [
      {
        id: "pdf-v3", version: "v3", status: "已发布", publishedAt: "2026-08-02 14:30", createdBy: "王敏",
        changeNote: "增加质量节点可修改的文件等级字段；优化并行分支待办提醒。", instanceCount: 42,
        formFieldCount: 9, nodeCount: 5, starterGroup: "PDF审核_文控_流程权限组", checksum: "9D7A-4F21-C8B0",
      },
      {
        id: "pdf-v2", version: "v2", status: "已停用", publishedAt: "2026-05-16 10:05", createdBy: "刘燕",
        changeNote: "研发、质量和生产改为同起点并行审核。", instanceCount: 71,
        formFieldCount: 8, nodeCount: 5, starterGroup: "PDF审核_文控_流程权限组", checksum: "3B16-A94D-78C2",
      },
      {
        id: "pdf-v1", version: "v1", status: "已停用", publishedAt: "2026-02-12 09:20", createdBy: "系统管理员",
        changeNote: "首次发布，包含文控发起及研发、质量、生产顺序审核。", instanceCount: 15,
        formFieldCount: 7, nodeCount: 5, starterGroup: "PDF审核_文控_流程权限组", checksum: "1A44-ED90-6F31",
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
        formFieldCount: 5, nodeCount: 4, starterGroup: "测试报告_发起_流程权限组", checksum: "草稿未生成",
      },
    ],
  },
  "free-collaboration": {
    name: "异常协作事项",
    code: "PROC-FREE-003",
    type: "free",
    currentVersion: "v2",
    instancePrefix: "ISSUE",
    versions: [
      {
        id: "free-v2", version: "v2", status: "已发布", publishedAt: "2026-07-30 16:18", createdBy: "王敏",
        changeNote: "增加异常改派；重新打开时恢复发起表单编辑。", instanceCount: 39,
        formFieldCount: 5, nodeCount: 0, starterGroup: "自由协作_发起_流程权限组", checksum: "7C89-21EF-55A0",
      },
      {
        id: "free-v1", version: "v1", status: "已停用", publishedAt: "2026-04-08 11:42", createdBy: "系统管理员",
        changeNote: "首次发布自由协作流程。", instanceCount: 28,
        formFieldCount: 4, nodeCount: 0, starterGroup: "自由协作_发起_流程权限组", checksum: "2A07-BD33-CE18",
      },
    ],
  },
};

const defaultVersionMeta = versionDataById["pdf-review"];

const statusClassName: Record<VersionStatus, string> = {
  草稿: "is-draft",
  已发布: "is-published",
  已停用: "is-disabled",
};

export function ProcessVersionsPage({ definitionId }: ProcessVersionsPageProps) {
  const navigate = useNavigate();
  const params = useParams<{ definitionId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const resolvedId = definitionId
    ?? params.definitionId
    ?? params.id
    ?? searchParams.get("definitionId")
    ?? "pdf-review";
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === resolvedId),
  );
  const ensureDraft = useProcessDefinitionStore((state) => state.ensureDraft);
  const fallbackMeta = versionDataById[resolvedId] ?? defaultVersionMeta;
  const definitionMeta = {
    name: definition?.name ?? fallbackMeta.name,
    code: definition?.code ?? fallbackMeta.code,
    type: definition?.type ?? fallbackMeta.type,
    currentVersion: definition?.currentVersion ?? "尚未发布",
  };
  const versions = useMemo<ProcessVersionRow[]>(() => {
    if (!definition) return fallbackMeta.versions;
    const draftRow: ProcessVersionRow[] = definition.draft ? [{
      id: definition.draft.id,
      version: definition.draft.version,
      status: "草稿",
      publishedAt: "—",
      createdBy: "当前用户",
      changeNote: definition.draft.basedOn
        ? `基于 ${definition.draft.basedOn} 创建，等待完成配置与发布。`
        : "初始草稿，等待完成配置与发布。",
      instanceCount: 0,
      formFieldCount: definition.draft.formFieldCount,
      nodeCount: definition.draft.nodeCount,
      starterGroup: definition.draft.basic.starterGroup || "尚未选择",
      checksum: "草稿未生成",
      instancePrefix: definition.draft.basic.instancePrefix,
    }] : [];
    const releasedRows = definition.versions.map((item) => ({
      ...item,
      instancePrefix: item.basic.instancePrefix,
    }));
    return [...draftRow, ...releasedRows];
  }, [definition, fallbackMeta.versions]);
  const [selectedVersion, setSelectedVersion] = useState<ProcessVersionRow>();
  const [copySource, setCopySource] = useState<ProcessVersionRow>();

  const publishedInstances = useMemo(
    () => versions.reduce((total, version) => total + version.instanceCount, 0),
    [versions],
  );
  const hasDraft = versions.some((version) => version.status === "草稿");

  const createDraft = () => {
    if (!copySource) return;
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

  const columns: TableProps<ProcessVersionRow>["columns"] = [
    {
      title: "版本",
      dataIndex: "version",
      width: 116,
      render: (value: string, record) => (
        <button type="button" className="pa-version-button" onClick={() => setSelectedVersion(record)}>
          <strong>{value}</strong>{record.status === "已发布" && <Tag color="blue" bordered={false}>当前</Tag>}
        </button>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 112,
      render: (value: VersionStatus) => (
        <span className={`pa-status ${statusClassName[value]}`}><span className="pa-status__dot" />{value}</span>
      ),
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
      width: 136,
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
            <Tooltip title={hasDraft ? "已有未发布草稿" : "基于此版本新建草稿"}>
              <span>
                <Button
                  type="text"
                  className="pa-icon-button is-copy"
                  disabled={hasDraft}
                  icon={<CopyOutlined />}
                  aria-label={`基于${record.version}新建草稿`}
                  onClick={() => setCopySource(record)}
                />
              </span>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack pa-page pa-versions-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/admin/processes")}>返回流程管理</Button>
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
            onClick={() => setCopySource(versions.find((item) => item.status === "已发布") ?? versions[0])}
          >
            基于当前版本新建草稿
          </Button>
        )}
      </Card>

      <div className="pa-version-stats">
        <Card bordered={false}><span className="pa-stat-icon is-blue"><HistoryOutlined /></span><span><small>累计版本</small><strong>{versions.length}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-green"><CheckCircleFilled /></span><span><small>当前发布版本</small><strong>{definitionMeta.currentVersion}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-purple"><FileTextOutlined /></span><span><small>累计流程实例</small><strong>{publishedInstances}</strong></span></Card>
        <Card bordered={false}><span className="pa-stat-icon is-orange"><SafetyCertificateOutlined /></span><span><small>配置状态</small><strong>{hasDraft ? "有待发布草稿" : "全部已发布"}</strong></span></Card>
      </div>

      <Alert
        className="pa-page-alert"
        type="info"
        showIcon
        message="发布版本不可直接修改"
        description="修改时会基于所选版本新建草稿。运行实例永久关联其发起时版本；停用旧版本不会影响这些实例的查看和继续处理。"
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
          rowClassName={(record) => record.status === "草稿" ? "pa-draft-row" : ""}
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
              <span className={`pa-version-emblem ${selectedVersion.status === "已发布" ? "is-current" : ""}`}>{selectedVersion.version}</span>
              <span>
                <Space size={8}>
                  <Typography.Title level={4}>{definitionMeta.name}</Typography.Title>
                  <span className={`pa-status ${statusClassName[selectedVersion.status]}`}><span className="pa-status__dot" />{selectedVersion.status}</span>
                </Space>
                <Typography.Text type="secondary">配置快照校验码：{selectedVersion.checksum}</Typography.Text>
              </span>
            </div>

            {selectedVersion.status !== "草稿" && (
              <Alert type="info" showIcon message="该版本为只读快照" description="表单、节点、权限和规则均按发布时间固化，不能在此直接修改。" />
            )}

            <Descriptions
              className="pa-drawer-descriptions"
              bordered
              size="small"
              column={1}
              items={[
                { key: "publishedAt", label: "发布时间", children: selectedVersion.publishedAt },
                { key: "createdBy", label: "创建人", children: selectedVersion.createdBy },
                { key: "instances", label: "关联实例", children: `${selectedVersion.instanceCount} 个` },
                { key: "instancePrefix", label: "实例编号前缀", children: selectedVersion.instancePrefix ?? fallbackMeta.instancePrefix },
                { key: "fields", label: "表单字段", children: `${selectedVersion.formFieldCount} 个` },
                { key: "nodes", label: definitionMeta.type === "approval" ? "流程节点" : "节点设计", children: definitionMeta.type === "approval" ? `${selectedVersion.nodeCount} 个` : "自由协作不使用节点设计器" },
                { key: "group", label: "发起权限组", children: selectedVersion.starterGroup },
              ]}
            />

            <Card size="small" className="pa-change-note-card" title="变更说明">
              {selectedVersion.changeNote}
            </Card>

            <Divider>版本生命周期</Divider>
            <Timeline
              items={selectedVersion.status === "草稿" ? [
                { color: "blue", children: <><strong>草稿创建</strong><small>当前用户基于历史版本创建</small></> },
                { color: "gray", dot: <InfoCircleOutlined />, children: <><strong>等待发布</strong><small>完成配置和校验后形成正式版本</small></> },
              ] : [
                { color: "green", children: <><strong>版本发布</strong><small>{selectedVersion.publishedAt} · {selectedVersion.createdBy}</small></> },
                ...(selectedVersion.status === "已停用" ? [{ color: "gray", dot: <StopOutlined />, children: <><strong>版本停用</strong><small>被后续版本替代，历史实例仍可访问</small></> }] : []),
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
        okText="新建草稿"
        cancelText="取消"
        onCancel={() => setCopySource(undefined)}
        onOk={createDraft}
      >
        {copySource && (
          <div className="pa-copy-version-modal">
            <Alert
              type="info"
              showIcon
              message={`将复制 ${copySource.version} 的完整配置`}
              description="复制范围包括基本信息、表单、节点、流程规则和权限引用；发布人、发布时间、历史实例及通知记录不会复制。"
            />
            <div className="pa-copy-source">
              <span><small>源版本</small><strong>{copySource.version}</strong></span>
              <span><small>表单字段</small><strong>{copySource.formFieldCount}</strong></span>
              <span><small>{definitionMeta.type === "approval" ? "流程节点" : "流程类型"}</small><strong>{definitionMeta.type === "approval" ? copySource.nodeCount : "自由协作"}</strong></span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default ProcessVersionsPage;
