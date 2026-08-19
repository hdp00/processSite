import {
  AppstoreOutlined,
  AuditOutlined,
  EyeOutlined,
  FileTextOutlined,
  MessageOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Dropdown,
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
import { ListFieldValue } from "../components/ListFieldValue";
import {
  cloneDefaultSystemListFields,
  isSystemFieldVisible,
} from "../data/listFieldConfig";
import type { ProcessInstance, WorkflowTask } from "../data/types";
import { isSuperAdminPersona, usePrototypeStore } from "../state/usePrototypeStore";
import { useIdentityStore } from "../state/useIdentityStore";
import { getPublishedVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { formatRoundLabel } from "../utils/roundDisplay";
import { canUserProcessTask } from "../state/workflowAccess";
import { PROCESS_TITLE_FIELD_ID } from "../utils/designerStorage";

const ALL_FLOWS = "__all__";
const TASK_FLOW_STORAGE_PREFIX = "flowpilot-task-center-flow-v1";
type TaskCenterTab = "mine" | "substitute" | "initiated";

export function TaskCenterPage() {
  const navigate = useNavigate();
  const { instances, tasks, personaId } = usePrototypeStore();
  const definitions = useProcessDefinitionStore((state) => state.definitions);
  const identityUser = useIdentityStore((state) => state.users.find((user) => user.id === personaId));
  const [tab, setTab] = useState<TaskCenterTab>("mine");
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

  const actionableTasks = useMemo(() => tasks
    .filter((task) => task.status === "待处理" && canUserProcessTask(personaId, task)), [personaId, tasks]);
  const actionableTasksByInstance = useMemo(() => actionableTasks.reduce((result, task) => {
    const current = result.get(task.instanceId) ?? [];
    result.set(task.instanceId, [...current, task]);
    return result;
  }, new Map<string, WorkflowTask[]>()), [actionableTasks]);
  const myTaskItems = useMemo(() => actionableTasks.filter((task) =>
    isSuperAdmin || !task.defaultAssigneeId || task.defaultAssigneeId === personaId,
  ), [actionableTasks, isSuperAdmin, personaId]);
  const substituteTaskItems = useMemo(() => isSuperAdmin ? [] : actionableTasks.filter((task) =>
    Boolean(task.defaultAssigneeId && task.defaultAssigneeId !== personaId),
  ), [actionableTasks, isSuperAdmin, personaId]);
  const actionable = useMemo(() => instances.filter((instance) =>
    instance.workflowType === "free"
      ? instance.status === "进行中" && Boolean(isSuperAdmin || identityUser?.id === instance.currentAssigneeId)
      : instance.status === "审核中" && actionableTasksByInstance.has(instance.id),
  ), [actionableTasksByInstance, identityUser?.id, instances, isSuperAdmin]);

  const myTasks = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return true;
    return myTaskItems.some((task) => task.instanceId === instance.id);
  });
  const substituteTasks = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return false;
    return substituteTaskItems.some((task) => task.instanceId === instance.id);
  });
  const initiatedInstances = useMemo(() => instances.filter((instance) => {
    const initiatedByCurrentUser = instance.initiatorId === personaId
      || Boolean(identityUser?.name && instance.initiator === identityUser.name);
    return initiatedByCurrentUser && instance.status !== "已完成" && instance.status !== "已关闭";
  }), [identityUser?.name, instances, personaId]);

  const source = tab === "mine" ? myTasks : tab === "substitute" ? substituteTasks : initiatedInstances;
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
  const selectedVersion = getPublishedVersion(selectedDefinition);
  const activeCategoryLabel = activeTemplate
    ? flowCategories.find((category) => category.template === activeTemplate)?.label ?? activeTemplate
    : tab === "initiated" ? "全部发起" : "全部待办";
  const selectFlow = (template: string) => {
    setSelectedTemplate(template);
    window.localStorage.setItem(`${TASK_FLOW_STORAGE_PREFIX}:${personaId}`, template);
  };
  const systemListFields = selectedVersion
    ? selectedVersion.snapshot.systemFields
    : cloneDefaultSystemListFields();
  const showSystemField = (key: Parameters<typeof isSystemFieldVisible>[1]) =>
    isSystemFieldVisible(systemListFields, key, "task");
  const titleVisibleForVersion = (version: ReturnType<typeof getPublishedVersion>) =>
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
          <ListFieldValue field={field} value={record.formValues?.[field.id]} />
        ),
      }))
    : [];

  const tasksForRecord = (record: ProcessInstance) => {
    const recordTasks = actionableTasksByInstance.get(record.id) ?? [];
    if (tab === "mine") return recordTasks.filter((task) => isSuperAdmin || !task.defaultAssigneeId || task.defaultAssigneeId === personaId);
    if (tab === "substitute") return recordTasks.filter((task) => !isSuperAdmin && Boolean(task.defaultAssigneeId && task.defaultAssigneeId !== personaId));
    return [];
  };

  const approvalTaskActionLabel = (record: ProcessInstance, task?: WorkflowTask) => {
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
          {showSystemField("currentNode") ? <span>{record.workflowType === "free" ? record.status === "进行中" ? record.currentAssignee ?? "" : "" : value}</span> : null}
          {showSystemField("round") && record.workflowType !== "free" && record.round > 1 ? <small>{formatRoundLabel(record.round)}</small> : null}
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
    ...(tab !== "initiated" ? [{
      title: "任务归属",
      dataIndex: "designatedReviewer",
      width: 135,
      render: (_value?: string, record?: ProcessInstance) => {
        const recordTasks = record ? tasksForRecord(record) : [];
        const task = recordTasks[0];
        const defaultAssignees = recordTasks
          .map((item) => useIdentityStore.getState().users.find((user) => user.id === item.defaultAssigneeId)?.name)
          .filter(Boolean);
        const defaultAssignee = [...new Set(defaultAssignees)].join("、") || "未指定";
        return (
        isSuperAdmin ? (
          <Tag icon={<AuditOutlined />} color="gold">{record?.workflowType === "free" ? "可处理" : `可处理 ${recordTasks.length} 个节点`}</Tag>
        ) : tab === "mine" ? (
          <Tag icon={<UserOutlined />} color="blue">{record?.workflowType === "free" ? "当前由我受理" : recordTasks.length > 1 ? `${recordTasks.length} 个节点` : task?.defaultAssigneeId ? "指定给我" : "组内共享"}</Tag>
        ) : (
          <Tooltip title={`默认责任人：${defaultAssignee}。同组成员可直接代为审核。`}>
            <Tag icon={<TeamOutlined />} color="purple">可代办 · {defaultAssignee}</Tag>
          </Tooltip>
        ));
      },
    }] : []),
    {
      title: "操作",
      fixed: "right",
      width: 76,
      align: "center",
      render: (_, record) => {
        const recordTasks = tasksForRecord(record);
        const actionLabel = tab === "initiated"
          ? "查看流程"
          : record.workflowType === "free" ? "进入处理" : recordTasks.length > 1 ? "选择处理节点" : approvalTaskActionLabel(record, recordTasks[0]);
        const actionButton = (
        <Tooltip title={actionLabel}>
          <Button
            className="task-action-button"
            type="text"
            icon={tab === "initiated" ? <EyeOutlined /> : record.workflowType === "free" ? <MessageOutlined /> : <AuditOutlined />}
            aria-label={`${actionLabel}：${record.title}`}
            onClick={() => {
              if (recordTasks.length > 1) return;
              const taskQuery = recordTasks[0] ? `?taskId=${encodeURIComponent(recordTasks[0].id)}` : "";
              navigate(`/processes/${record.id}${taskQuery}`);
            }}
          />
        </Tooltip>
        );
        if (record.workflowType === "free" || tab === "initiated" || recordTasks.length <= 1) return actionButton;
        return (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: recordTasks.map((task) => ({ key: task.id, label: task.nodeName })),
              onClick: ({ key }) => navigate(`/processes/${record.id}?taskId=${encodeURIComponent(key)}`),
            }}
          >
            {actionButton}
          </Dropdown>
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
            onChange={(value) => setTab(value as TaskCenterTab)}
            options={[
              {
                label: <span className="task-tab-label">我的待办 <span className="task-tab-count">{myTaskItems.length}</span></span>,
                value: "mine",
              },
              {
                label: <span className="task-tab-label">可代办 <span className="task-tab-count">{substituteTaskItems.length}</span></span>,
                value: "substitute",
              },
              {
                label: <span className="task-tab-label">我的发起 <span className="task-tab-count">{initiatedInstances.length}</span></span>,
                value: "initiated",
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
              <span className="task-flow-item__copy"><strong>{tab === "initiated" ? "全部发起" : "全部待办"}</strong><small>{tab === "initiated" ? "本人发起且未完成" : "所有流程"}</small></span>
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
            className="task-table process-record-table"
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            bordered
            size="middle"
            scroll={{ x: activeTemplate ? 1300 : 1020 }}
            pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => `共 ${total} 项${tab === "initiated" ? "流程" : "任务"}` }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={keyword || activeTemplate ? `没有符合筛选条件的${tab === "initiated" ? "流程" : "任务"}` : tab === "mine" ? "当前没有指定给你的待办" : tab === "substitute" ? "当前组内没有可代办任务" : "当前没有由你发起且尚未完成的流程"}
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
