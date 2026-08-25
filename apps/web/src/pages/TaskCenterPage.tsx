import {
  AppstoreOutlined,
  AuditOutlined,
  EyeOutlined,
  FileTextOutlined,
  MessageOutlined,
  RollbackOutlined,
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
import { getBusinessListColumnWidth, getSystemListColumnWidth } from "../utils/listColumnWidth";
import { getPublishedVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { formatRoundLabel } from "../utils/roundDisplay";
import { canUserProcessTask } from "../state/workflowAccess";
import { PROCESS_TITLE_FIELD_ID } from "../utils/designerStorage";
import { isProcessInstanceResubmissionTodo } from "../utils/processInstanceAccess";
import { formatDisplayDateTime } from "../utils/domainTime";
import { flowPilotApi } from "../api/flowPilotApi";
import { cacheProcessDefinition } from "../api/entityCache";
import { isBrowserMockMode } from "../utils/runtimeMode";

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [remoteInstances, setRemoteInstances] = useState<ProcessInstance[]>([]);
  const [remoteTasks, setRemoteTasks] = useState<WorkflowTask[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteTabTotals, setRemoteTabTotals] = useState<Record<TaskCenterTab, number>>({ mine: 0, substitute: 0, initiated: 0 });
  const [remoteLoading, setRemoteLoading] = useState(false);

  useEffect(() => {
    setSelectedTemplate(
      window.localStorage.getItem(`${TASK_FLOW_STORAGE_PREFIX}:${personaId}`) ?? ALL_FLOWS,
    );
    setFlowKeyword("");
    setPage(1);
  }, [personaId]);

  useEffect(() => {
    if (isBrowserMockMode) return;
    let cancelled = false;
    void Promise.all([
      flowPilotApi.tasks.listMine({ page: 1, pageSize: 1, view: "pending" }),
      flowPilotApi.tasks.listMine({ page: 1, pageSize: 1, view: "substitutable" }),
      flowPilotApi.instances.list({ page: 1, pageSize: 1, initiatorId: personaId, activeOnly: true }),
    ]).then(([mine, substitute, initiated]) => {
      if (!cancelled) setRemoteTabTotals({
        mine: mine.page.totalElements,
        substitute: substitute.page.totalElements,
        initiated: initiated.page.totalElements,
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [personaId]);

  useEffect(() => {
    if (isBrowserMockMode) return;
    let cancelled = false;
    setRemoteLoading(true);
    const definitionId = selectedTemplate === ALL_FLOWS ? undefined : selectedTemplate;
    const request = tab === "initiated"
      ? flowPilotApi.instances.list({ page, pageSize, q: keyword.trim() || undefined, definitionId, initiatorId: personaId, activeOnly: true })
        .then((result) => ({ instances: result.items, tasks: [] as WorkflowTask[], total: result.page.totalElements }))
      : flowPilotApi.tasks.listMine({ page, pageSize, q: keyword.trim() || undefined, definitionId, view: tab === "mine" ? "pending" : "substitutable" })
        .then((result) => ({ instances: result.items.map((item) => item.instance), tasks: result.items.map((item) => item.task), total: result.page.totalElements }));
    void request.then((result) => {
      if (cancelled) return;
      setRemoteInstances(result.instances);
      setRemoteTasks(result.tasks);
      setRemoteTotal(result.total);
    }).catch(() => {
      if (!cancelled) {
        setRemoteInstances([]);
        setRemoteTasks([]);
      }
    }).finally(() => {
      if (!cancelled) setRemoteLoading(false);
    });
    return () => { cancelled = true; };
  }, [keyword, page, pageSize, personaId, selectedTemplate, tab]);

  const runtimeInstances = isBrowserMockMode ? instances : remoteInstances;
  const runtimeTasks = isBrowserMockMode ? tasks : remoteTasks;
  const actionableTasks = useMemo(() => runtimeTasks
    .filter((task) => task.status === "待处理" && (!isBrowserMockMode || canUserProcessTask(personaId, task))), [personaId, runtimeTasks]);
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
  const actionable = useMemo(() => runtimeInstances.filter((instance) =>
    instance.workflowType === "free"
      ? instance.status === "进行中" && Boolean(isSuperAdmin || identityUser?.id === instance.currentAssigneeId)
      : instance.status === "审核中" && actionableTasksByInstance.has(instance.id),
  ), [actionableTasksByInstance, identityUser?.id, isSuperAdmin, runtimeInstances]);

  const reviewTaskInstances = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return true;
    return myTaskItems.some((task) => task.instanceId === instance.id);
  });
  const substituteTasks = actionable.filter((instance) => {
    if (isSuperAdmin || instance.workflowType === "free") return false;
    return substituteTaskItems.some((task) => task.instanceId === instance.id);
  });
  const initiatedInstances = useMemo(() => runtimeInstances.filter((instance) => {
    const initiatedByCurrentUser = instance.initiatorId === personaId
      || Boolean(identityUser?.name && instance.initiator === identityUser.name);
    return initiatedByCurrentUser && instance.status !== "已完成" && instance.status !== "已关闭";
  }), [identityUser?.name, personaId, runtimeInstances]);
  const rejectedInitiatedInstances = useMemo(() => identityUser
    ? initiatedInstances.filter((instance) => isProcessInstanceResubmissionTodo(instance, identityUser))
    : [], [identityUser, initiatedInstances]);
  const myTasks = [
    ...reviewTaskInstances,
    ...rejectedInitiatedInstances.filter((instance) => !reviewTaskInstances.some((item) => item.id === instance.id)),
  ];

  const source = isBrowserMockMode
    ? tab === "mine" ? myTasks : tab === "substitute" ? substituteTasks : initiatedInstances
    : remoteInstances;
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
    && (!isBrowserMockMode || flowCategories.some((category) => category.template === selectedTemplate))
      ? selectedTemplate
      : undefined;
  const visibleFlowCategories = flowCategories.filter((category) =>
    category.label.toLowerCase().includes(flowKeyword.trim().toLowerCase()),
  );
  const selectedDefinition = definitions.find((item) => item.id === activeTemplate);
  const selectedVersion = getPublishedVersion(selectedDefinition);
  useEffect(() => {
    if (isBrowserMockMode || !selectedDefinition || selectedVersion) return;
    let cancelled = false;
    void flowPilotApi.definitions.get(selectedDefinition.id)
      .then((loaded) => { if (!cancelled) cacheProcessDefinition(loaded); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selectedDefinition, selectedVersion]);
  const activeCategoryLabel = activeTemplate
    ? flowCategories.find((category) => category.template === activeTemplate)?.label ?? activeTemplate
    : tab === "initiated" ? "全部发起" : "全部待办";
  const selectFlow = (template: string) => {
    setSelectedTemplate(template);
    setPage(1);
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
  const showFlowNameUnderTitle = !activeTemplate && tab !== "initiated";
  const showVersionUnderTitle = Boolean(activeTemplate && showSystemField("templateVersion"));
  const showTitleCell = showTitle || showFlowNameUnderTitle || showVersionUnderTitle;
  const showNodeCell = showSystemField("currentNode") || showSystemField("round");
  const filtered = source.filter((item) => {
    const matchesKeyword = `${item.code}${item.title}${item.initiator}`
      .toLowerCase()
      .includes(keyword.trim().toLowerCase());
    const matchesTemplate = !activeTemplate || item.definitionId === activeTemplate;
    return matchesKeyword && matchesTemplate;
  });

  const selectedTaskFields = selectedVersion?.snapshot.form.fields
    .filter((field) => field.id !== PROCESS_TITLE_FIELD_ID && field.taskVisible) ?? [];
  const dynamicColumns: TableProps<ProcessInstance>["columns"] = selectedVersion
    ? selectedTaskFields.map((field) => ({
        title: field.label,
        key: field.id,
        width: getBusinessListColumnWidth(field),
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
  const isResubmissionTask = (record: ProcessInstance) =>
    tab === "mine" && record.status === "驳回待处理" && rejectedInitiatedInstances.some((item) => item.id === record.id);

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
      width: getSystemListColumnWidth("code", "实例编号"),
      render: (value: string, record: ProcessInstance) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>
          {value}
        </button>
      ),
    }] : []),
    ...(showTitleCell ? [{
      title: showTitle ? "流程与标题" : "所属流程",
      dataIndex: "title",
      width: getSystemListColumnWidth("title", showTitle ? "流程与标题" : "所属流程"),
      render: (value: string, record: ProcessInstance) => (
        <div className="title-cell">
          {recordShowsTitle() ? <strong>{value}</strong> : null}
          {(showFlowNameUnderTitle || showVersionUnderTitle) ? (
            <span>
              {[
                showFlowNameUnderTitle ? record.template : "",
                showVersionUnderTitle ? record.templateVersion : "",
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
      width: getSystemListColumnWidth("status", "状态"),
      render: (value: string) => <StatusPill status={value} />,
    }] : []),
    ...(showNodeCell ? [{
      title: "当前节点",
      dataIndex: "currentNode",
      width: getSystemListColumnWidth("currentNode", "当前节点"),
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
      width: getSystemListColumnWidth("initiator", "发起人"),
      render: (value: string, record: ProcessInstance) => (
        <div className="person-cell"><AvatarText name={value} /><span>{value}<small>{record.department}</small></span></div>
      ),
    }] : []),
    ...(showSystemField("createdAt") ? [{ title: "发起时间", dataIndex: "createdAt", width: getSystemListColumnWidth("createdAt", "发起时间"), render: (value: string) => formatDisplayDateTime(value) }] : []),
    ...(showSystemField("updatedAt") ? [{ title: "更新时间", dataIndex: "updatedAt", width: getSystemListColumnWidth("updatedAt", "更新时间"), render: (value: string) => formatDisplayDateTime(value) }] : []),
    ...(tab !== "initiated" ? [{
      title: "任务归属",
      dataIndex: "designatedReviewer",
      width: getSystemListColumnWidth("taskOwner", "任务归属"),
      render: (_value?: string, record?: ProcessInstance) => {
        const recordTasks = record ? tasksForRecord(record) : [];
        const task = recordTasks[0];
        const defaultAssignees = recordTasks
          .map((item) => useIdentityStore.getState().users.find((user) => user.id === item.defaultAssigneeId)?.name)
          .filter(Boolean);
        const defaultAssignee = [...new Set(defaultAssignees)].join("、") || "未指定";
        return isResubmissionTask(record!) ? (
          <Tag icon={<RollbackOutlined />} color="orange">待我重新提交</Tag>
        ) : isSuperAdmin ? (
          <Tag icon={<AuditOutlined />} color="gold">{record?.workflowType === "free" ? "可处理" : `可处理 ${recordTasks.length} 个节点`}</Tag>
        ) : tab === "mine" ? (
          <Tag icon={<UserOutlined />} color="blue">{record?.workflowType === "free" ? "当前由我受理" : recordTasks.length > 1 ? `${recordTasks.length} 个节点` : task?.defaultAssigneeId ? "指定给我" : "组内共享"}</Tag>
        ) : (
          <Tooltip title={`默认责任人：${defaultAssignee}。同组成员可直接代为审核。`}>
            <Tag icon={<TeamOutlined />} color="purple">可代办 · {defaultAssignee}</Tag>
          </Tooltip>
        );
      },
    }] : []),
    {
      title: "操作",
      fixed: "right",
      width: 76,
      align: "center",
      render: (_, record) => {
        const recordTasks = tasksForRecord(record);
        const resubmissionTask = isResubmissionTask(record);
        const actionLabel = tab === "initiated"
          ? "查看流程"
          : resubmissionTask ? "处理驳回并重新提交" : record.workflowType === "free" ? "进入处理" : recordTasks.length > 1 ? "选择处理节点" : approvalTaskActionLabel(record, recordTasks[0]);
        const actionButton = (
        <Tooltip title={actionLabel}>
          <Button
            className="task-action-button"
            type="text"
            icon={tab === "initiated" ? <EyeOutlined /> : resubmissionTask ? <RollbackOutlined /> : record.workflowType === "free" ? <MessageOutlined /> : <AuditOutlined />}
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
                label: <span className="task-tab-label">我的待办 <span className="task-tab-count">{isBrowserMockMode ? myTaskItems.length + rejectedInitiatedInstances.length : remoteTabTotals.mine}</span></span>,
                value: "mine",
              },
              {
                label: <span className="task-tab-label">可代办 <span className="task-tab-count">{isBrowserMockMode ? substituteTaskItems.length : remoteTabTotals.substitute}</span></span>,
                value: "substitute",
              },
              {
                label: <span className="task-tab-label">我的发起 <span className="task-tab-count">{isBrowserMockMode ? initiatedInstances.length : remoteTabTotals.initiated}</span></span>,
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
            <span><AppstoreOutlined /> {isBrowserMockMode ? "流程分类" : "本页流程"}</span>
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
              <span className="task-flow-item__count">{isBrowserMockMode ? source.length : remoteTotal}</span>
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
                <span className="task-flow-item__count">{isBrowserMockMode ? category.count : `本页 ${category.count}`}</span>
              </button>
            ))}
          </nav>
        </Card>

        <Card className="content-card task-list-card" styles={{ body: { padding: 0 } }}>
          <div className="task-list-context">
            <div><strong>{activeCategoryLabel}</strong><Tag bordered={false}>{isBrowserMockMode ? filtered.length : remoteTotal} 项</Tag></div>
            <span>{activeTemplate ? "公共列 + 当前流程自定义列" : "全部流程仅显示公共列"}</span>
          </div>
          <Table<ProcessInstance>
            key={`${tab}-${activeTemplate ?? ALL_FLOWS}`}
            className="task-table process-record-table"
            rowKey="id"
            columns={columns}
            dataSource={filtered}
            loading={remoteLoading}
            bordered
            size="middle"
            scroll={{ x: "max-content" }}
            pagination={{ current: page, pageSize, total: isBrowserMockMode ? filtered.length : remoteTotal, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (total) => `共 ${total} 项${tab === "initiated" ? "流程" : "任务"}`, onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize); } }}
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
