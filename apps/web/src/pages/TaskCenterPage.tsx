import {
  AppstoreOutlined,
  AuditOutlined,
  FileTextOutlined,
  MessageOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Empty,
  Input,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  type TableProps,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import {
  cloneDefaultSystemListFields,
  isSystemFieldVisible,
} from "../data/listFieldConfig";
import type { ProcessInstance } from "../data/types";
import { isSuperAdminPersona, usePrototypeStore } from "../state/usePrototypeStore";
import { useIdentityStore } from "../state/useIdentityStore";
import { getEffectiveVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { canUserProcessTask } from "../state/workflowAccess";
import { PROCESS_TITLE_FIELD_ID, type StoredDesignerField } from "../utils/designerStorage";

const ALL_FLOWS = "__all__";
const TASK_FLOW_STORAGE_PREFIX = "flowpilot-task-center-flow-v1";

export function TaskCenterPage() {
  const navigate = useNavigate();
  const { instances, tasks, personaId } = usePrototypeStore();
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const identityUser = useIdentityStore((state) => state.users.find((user) => user.id === personaId));
  const [tab, setTab] = useState<"mine" | "substitute">("mine");
  const [keyword, setKeyword] = useState("");
  const [flowKeyword, setFlowKeyword] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState(() =>
    window.localStorage.getItem(`${TASK_FLOW_STORAGE_PREFIX}:${personaId}`) ?? ALL_FLOWS,
  );
  const isSuperAdmin = isSuperAdminPersona(personaId);

  useEffect(() => {
    setSelectedTemplate(
      window.localStorage.getItem(`${TASK_FLOW_STORAGE_PREFIX}:${personaId}`) ?? ALL_FLOWS,
    );
    setFlowKeyword("");
  }, [personaId]);

  const actionableTaskByInstance = useMemo(() => new Map(
    tasks
      .filter((task) => task.status === "待处理" && canUserProcessTask(personaId, task))
      .map((task) => [task.instanceId, task]),
  ), [personaId, tasks]);
  const actionable = useMemo(() => instances.filter((instance) =>
    instance.workflowType === "free"
      ? instance.status === "进行中" && Boolean(isSuperAdmin || identityUser?.name === instance.currentAssignee)
      : instance.status === "审核中" && actionableTaskByInstance.has(instance.id),
  ), [actionableTaskByInstance, identityUser?.name, instances, isSuperAdmin]);

  const myTasks = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return true;
    const task = actionableTaskByInstance.get(instance.id);
    return !task?.defaultAssigneeId || task.defaultAssigneeId === personaId;
  });
  const substituteTasks = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return false;
    const task = actionableTaskByInstance.get(instance.id);
    return Boolean(task?.defaultAssigneeId && task.defaultAssigneeId !== personaId);
  });

  const source = tab === "mine" ? myTasks : substituteTasks;
  const flowCategories = useMemo(() => {
    const counts = new Map<string, number>();
    source.forEach((item) => item.definitionId && counts.set(item.definitionId, (counts.get(item.definitionId) ?? 0) + 1));
    return Array.from(counts, ([definitionId, count]) => ({
      template: definitionId,
      count,
      label: definitions.find((definition) => definition.id === definitionId)?.name ?? definitionId,
      workflowType: source.find((item) => item.definitionId === definitionId)?.workflowType,
    })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
  }, [definitions, source]);
  const activeTemplate = selectedTemplate !== ALL_FLOWS
    && flowCategories.some((category) => category.template === selectedTemplate)
      ? selectedTemplate
      : undefined;
  const visibleFlowCategories = flowCategories.filter((category) =>
    category.label.toLowerCase().includes(flowKeyword.trim().toLowerCase()),
  );
  const selectedDefinition = definitions.find((item) => item.id === activeTemplate);
  const selectedVersion = getEffectiveVersion(selectedDefinition);
  const activeCategoryLabel = activeTemplate
    ? flowCategories.find((category) => category.template === activeTemplate)?.label ?? activeTemplate
    : "全部待办";
  const selectFlow = (template: string) => {
    setSelectedTemplate(template);
    window.localStorage.setItem(`${TASK_FLOW_STORAGE_PREFIX}:${personaId}`, template);
  };
  const systemListFields = selectedVersion
    ? selectedVersion.snapshot.systemFields
    : cloneDefaultSystemListFields();
  const showSystemField = (key: Parameters<typeof isSystemFieldVisible>[1]) =>
    isSystemFieldVisible(systemListFields, key, "task");
  const titleVisibleForVersion = (version: ReturnType<typeof getEffectiveVersion>) =>
    version?.snapshot.form.fields.find((field) => field.id === PROCESS_TITLE_FIELD_ID)?.taskVisible ?? true;
  const recordShowsTitle = () => activeTemplate ? titleVisibleForVersion(selectedVersion) : true;
  const showTitle = activeTemplate ? titleVisibleForVersion(selectedVersion) : true;
  const showTitleCell = showTitle || showSystemField("template") || showSystemField("templateVersion");
  const showNodeCell = showSystemField("currentNode") || showSystemField("round");
  const filtered = source.filter((item) => {
    const matchesKeyword = `${item.code}${item.title}${item.initiator}`
      .toLowerCase()
      .includes(keyword.trim().toLowerCase());
    const matchesTemplate = !activeTemplate || item.definitionId === activeTemplate;
    return matchesKeyword && matchesTemplate;
  });

  const formatTaskFieldValue = (record: ProcessInstance, field: StoredDesignerField) => {
    const raw = record.formValues?.[field.id];
    const value = raw === undefined || raw === null || raw === "" ? field.defaultValue ?? raw : raw;
    const emptyText = field.inputStage === "reviewer" ? "" : "—";
    if (Array.isArray(value)) return value.join("、") || emptyText;
    if (typeof value === "object" && value !== null) return "已填写";
    if (value === undefined || value === null || value === "") return emptyText;
    return String(value);
  };

  const selectedTaskFields = selectedVersion?.snapshot.form.fields
    .filter((field) => field.id !== PROCESS_TITLE_FIELD_ID && field.taskVisible)
    .sort((left, right) => (left.taskOrder ?? 999) - (right.taskOrder ?? 999)) ?? [];
  const dynamicColumns: TableProps<ProcessInstance>["columns"] = selectedVersion
    ? selectedTaskFields.map((field) => ({
        title: field.taskDisplayName || field.label,
        key: field.id,
        width: field.taskWidth ?? 160,
        ellipsis: true,
        render: (_, record) => (
          <span className="task-dynamic-value">{formatTaskFieldValue(record, field)}</span>
        ),
      }))
    : [];

  const approvalTaskActionLabel = (record: ProcessInstance) => {
    const task = actionableTaskByInstance.get(record.id);
    const definition = definitions.find((item) => item.id === record.definitionId);
    const version = definition?.versions.find((item) => item.id === record.versionId);
    const node = version?.snapshot.flow.nodes.find((item) => item.id === task?.nodeId);
    return node?.data?.handlingMode === "confirmation" ? "进入确认" : "进入审核";
  };

  const columns: TableProps<ProcessInstance>["columns"] = [
    ...(showSystemField("code") ? [{
      title: "实例编号",
      dataIndex: "code",
      width: 174,
      render: (value: string, record: ProcessInstance) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>
          {value}
        </button>
      ),
    }] : []),
    ...(showTitleCell ? [{
      title: showTitle ? "流程与标题" : "所属流程",
      dataIndex: "title",
      width: 350,
      render: (value: string, record: ProcessInstance) => (
        <div className="title-cell">
          {recordShowsTitle() ? <strong>{value}</strong> : null}
          {(showSystemField("template") || showSystemField("templateVersion")) ? (
            <span>
              {[
                showSystemField("template") ? record.template : "",
                showSystemField("templateVersion") ? record.templateVersion : "",
              ].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
      ),
    }] : []),
    ...dynamicColumns,
    ...(showSystemField("status") ? [{
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (value: string) => <StatusPill status={value} />,
    }] : []),
    ...(showNodeCell ? [{
      title: "当前节点",
      dataIndex: "currentNode",
      width: 185,
      render: (value: string, record: ProcessInstance) => (
        <div className="node-cell">
          <span className="node-pulse" />
          {showSystemField("currentNode") ? <span>{value}</span> : null}
          {showSystemField("round") && record.workflowType !== "free" ? <small>第 {record.round} 轮</small> : null}
        </div>
      ),
    }] : []),
    ...(showSystemField("initiator") ? [{
      title: "发起人",
      dataIndex: "initiator",
      width: 108,
      render: (value: string, record: ProcessInstance) => (
        <div className="person-cell"><AvatarText name={value} /><span>{value}<small>{record.department}</small></span></div>
      ),
    }] : []),
    ...(showSystemField("createdAt") ? [{ title: "发起时间", dataIndex: "createdAt", width: 150 }] : []),
    ...(showSystemField("updatedAt") ? [{ title: "更新时间", dataIndex: "updatedAt", width: 150 }] : []),
    {
      title: "任务归属",
      dataIndex: "designatedReviewer",
      width: 135,
      render: (_value?: string, record?: ProcessInstance) => {
        const task = record ? actionableTaskByInstance.get(record.id) : undefined;
        const defaultAssignee = useIdentityStore.getState().users.find((user) => user.id === task?.defaultAssigneeId)?.name;
        return (
        isSuperAdmin ? (
          <Tag icon={<AuditOutlined />} color="gold">超级管理员可处理</Tag>
        ) : tab === "mine" ? (
          <Tag icon={<UserOutlined />} color="blue">{record?.workflowType === "free" ? "当前由我受理" : task?.defaultAssigneeId ? "指定给我" : "组内共享"}</Tag>
        ) : (
          <Tooltip title={`默认责任人：${defaultAssignee ?? "未指定"}。同组成员可直接代为审核。`}>
            <Tag icon={<TeamOutlined />} color="purple">可代办 · {defaultAssignee}</Tag>
          </Tooltip>
        ));
      },
    },
    {
      title: "操作",
      fixed: "right",
      width: 76,
      align: "center",
      render: (_, record) => {
        const actionLabel = record.workflowType === "free" ? "进入处理" : approvalTaskActionLabel(record);
        return (
        <Tooltip title={actionLabel}>
          <Button
            className="task-action-button"
            type="text"
            icon={record.workflowType === "free" ? <MessageOutlined /> : <AuditOutlined />}
            aria-label={`${actionLabel}：${record.title}`}
            onClick={() => navigate(`/processes/${record.id}`)}
          />
        </Tooltip>
        );
      },
    },
  ];

  return (
    <div className="page-stack tasks-page">
      <Card className="task-mode-card">
        <div className="task-mode-toolbar">
          <Segmented
            className="app-mode-segmented task-tabs"
            value={tab}
            onChange={(value) => setTab(value as "mine" | "substitute")}
            options={[
              {
                label: <span className="task-tab-label">我的待办 <span className="task-tab-count">{myTasks.length}</span></span>,
                value: "mine",
              },
              {
                label: <span className="task-tab-label">可代办 <span className="task-tab-count">{substituteTasks.length}</span></span>,
                value: "substitute",
              },
            ]}
          />
          <Space wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索编号、标题或发起人"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 250 }}
            />
          </Space>
        </div>
      </Card>

      <div className="task-center-layout">
        <Card className="task-flow-sidebar" styles={{ body: { padding: 0 } }}>
          <div className="task-flow-sidebar__head">
            <span><AppstoreOutlined /> 流程分类</span>
          </div>
          {flowCategories.length > 8 && (
            <div className="task-flow-search">
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined />}
                placeholder="搜索流程"
                value={flowKeyword}
                onChange={(event) => setFlowKeyword(event.target.value)}
              />
            </div>
          )}
          <nav className="task-flow-list" aria-label="按流程筛选任务">
            <button
              type="button"
              className={!activeTemplate ? "task-flow-item is-active" : "task-flow-item"}
              onClick={() => selectFlow(ALL_FLOWS)}
            >
              <span className="task-flow-item__icon"><AppstoreOutlined /></span>
              <span className="task-flow-item__copy"><strong>全部待办</strong><small>所有流程</small></span>
              <span className="task-flow-item__count">{source.length}</span>
            </button>
            {visibleFlowCategories.map((category) => (
              <button
                type="button"
                key={category.template}
                className={activeTemplate === category.template ? "task-flow-item is-active" : "task-flow-item"}
                onClick={() => selectFlow(category.template)}
              >
                <span className="task-flow-item__icon">
                  {category.workflowType === "free" ? <MessageOutlined /> : <FileTextOutlined />}
                </span>
                <span className="task-flow-item__copy"><strong>{category.label}</strong><small>{category.workflowType === "free" ? "自由协作" : "固定审批"}</small></span>
                <span className="task-flow-item__count">{category.count}</span>
              </button>
            ))}
          </nav>
        </Card>

        <Card className="content-card task-list-card" styles={{ body: { padding: 0 } }}>
          <div className="task-list-context">
            <div><strong>{activeCategoryLabel}</strong><Tag bordered={false}>{filtered.length} 项</Tag></div>
            <span>{activeTemplate ? "公共列 + 当前流程自定义列" : "全部流程仅显示公共列"}</span>
          </div>
          <Table<ProcessInstance>
            key={`${tab}-${activeTemplate ?? ALL_FLOWS}`}
            className={`task-table ${activeTemplate ? "is-single-process" : "is-mixed-process"}`}
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            scroll={{ x: activeTemplate ? 1300 : 1020 }}
            pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => `共 ${total} 项任务` }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={keyword || activeTemplate ? "没有符合筛选条件的任务" : tab === "mine" ? "当前没有指定给你的待办" : "当前组内没有可代办任务"}
                />
              ),
            }}
            onRow={(record) => ({ onDoubleClick: () => navigate(`/processes/${record.id}`) })}
          />
        </Card>
      </div>
    </div>
  );
}

function AvatarText({ name }: { name: string }) {
  return <span className="mini-avatar">{name.slice(-1)}</span>;
}
