import {
  AuditOutlined,
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
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  type TableProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { processDefinitions, type TaskListFieldDefinition } from "../data/processDefinitions";
import {
  cloneDefaultSystemListFields,
  isSystemFieldVisible,
  loadSystemListFields,
} from "../data/listFieldConfig";
import type { ProcessInstance } from "../data/types";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";

export function TaskCenterPage() {
  const navigate = useNavigate();
  const { instances, personaId } = usePrototypeStore();
  const [tab, setTab] = useState<"mine" | "substitute">("mine");
  const [keyword, setKeyword] = useState("");
  const [template, setTemplate] = useState<string>();
  const [expandedInfoIds, setExpandedInfoIds] = useState<string[]>([]);
  const persona = personas.find((item) => item.id === personaId) ?? personas[2];

  const actionable = useMemo(
    () =>
      instances.filter((item) => {
        if (item.workflowType === "free") {
          return item.status === "进行中" && item.currentAssignee === persona.name;
        }
        return Boolean(
          persona.reviewerKey &&
          item.status === "审核中" &&
          item.reviewers.some(
            (reviewer) => reviewer.key === persona.reviewerKey && reviewer.status === "待审核",
          ),
        );
      }),
    [instances, persona.reviewerKey],
  );

  const myTasks = actionable.filter(
    (item) => item.workflowType === "free" || !item.designatedReviewer || item.designatedReviewer === persona.name,
  );
  const substituteTasks = actionable.filter(
    (item) => item.workflowType !== "free" && Boolean(item.designatedReviewer && item.designatedReviewer !== persona.name),
  );

  const source = tab === "mine" ? myTasks : substituteTasks;
  const selectedDefinition = processDefinitions.find((item) => item.template === template);
  const systemListFields = selectedDefinition
    ? loadSystemListFields(selectedDefinition.id)
    : cloneDefaultSystemListFields();
  const showSystemField = (key: Parameters<typeof isSystemFieldVisible>[1]) =>
    isSystemFieldVisible(systemListFields, key, "task");
  const showTitleCell = showSystemField("title") || showSystemField("template") || showSystemField("templateVersion");
  const showNodeCell = showSystemField("currentNode") || showSystemField("round");
  const filtered = source.filter((item) => {
    const matchesKeyword = `${item.code}${item.title}${item.initiator}`
      .toLowerCase()
      .includes(keyword.trim().toLowerCase());
    const matchesTemplate = !template || item.template === template;
    return matchesKeyword && matchesTemplate;
  });

  const formatTaskFieldValue = (record: ProcessInstance, field: TaskListFieldDefinition) => {
    const value = record[field.key];
    if (Array.isArray(value)) return value.join("、") || "—";
    if (value === undefined || value === null || value === "") return "—";
    return String(value);
  };

  const dynamicColumns: TableProps<ProcessInstance>["columns"] = selectedDefinition
    ? selectedDefinition.taskFields.slice(0, 6).map((field) => ({
        title: field.label,
        key: String(field.key),
        width: field.width,
        ellipsis: true,
        render: (_, record) => (
          <span className="task-dynamic-value">{formatTaskFieldValue(record, field)}</span>
        ),
      }))
    : [];

  const renderTaskInformation = (record: ProcessInstance) => {
    const definition = processDefinitions.find((item) => item.template === record.template);
    const fields = definition?.taskFields ?? [];
    const isFullyExpanded = expandedInfoIds.includes(record.id);
    const visibleFields = isFullyExpanded ? fields : fields.slice(0, 6);
    const remainingCount = fields.length - visibleFields.length;

    return (
      <div className="task-detail-band">
        <div className="task-detail-band__label">流程信息</div>
        <div className="task-detail-band__fields">
          {visibleFields.map((field) => {
            const value = formatTaskFieldValue(record, field);
            return (
              <Tooltip title={value} key={String(field.key)}>
                <div className="task-detail-field">
                  <small>{field.label}</small>
                  <strong>{value}</strong>
                </div>
              </Tooltip>
            );
          })}
        </div>
        {remainingCount > 0 && (
          <Button
            type="link"
            size="small"
            onClick={() => setExpandedInfoIds((ids) => [...ids, record.id])}
          >
            其余 {remainingCount} 项
          </Button>
        )}
      </div>
    );
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
      title: showSystemField("title") ? "流程与标题" : "流程信息",
      dataIndex: "title",
      width: 350,
      render: (value: string, record: ProcessInstance) => (
        <div className="title-cell">
          {showSystemField("title") ? <strong>{value}</strong> : null}
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
      render: (value: string) => <Tag color="blue">{value}</Tag>,
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
      render: (value?: string) =>
        tab === "mine" ? (
          <Tag icon={<UserOutlined />} color={value ? "blue" : "default"}>{value ? "当前由我受理" : "指定给我"}</Tag>
        ) : (
          <Tooltip title={`默认责任人：${value ?? "未指定"}。同组成员可直接代为审核。`}>
            <Tag icon={<TeamOutlined />} color="purple">可代办 · {value}</Tag>
          </Tooltip>
        ),
    },
    {
      title: "操作",
      fixed: "right",
      width: 76,
      align: "center",
      render: (_, record) => (
        <Tooltip title={record.workflowType === "free" ? "进入处理" : "进入审核"}>
          <Button
            className="task-action-button"
            type="text"
            icon={record.workflowType === "free" ? <MessageOutlined /> : <AuditOutlined />}
            aria-label={`${record.workflowType === "free" ? "处理" : "审核"}：${record.title}`}
            onClick={() => navigate(`/processes/${record.id}`)}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <div className="page-stack tasks-page">
      <Card className="content-card" styles={{ body: { padding: 0 } }}>
        <div className="table-toolbar">
          <Segmented
            className={`task-tabs is-${tab}`}
            value={tab}
            onChange={(value) => setTab(value as "mine" | "substitute")}
            options={[
              {
                label: <span className="task-tab-label">我的待办 <span className="task-tab-count">{myTasks.length}</span></span>,
                value: "mine",
              },
              {
                label: <span className="task-tab-label is-purple">可代办 <span className="task-tab-count">{substituteTasks.length}</span></span>,
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
            <Select
              allowClear
              placeholder="全部流程"
              value={template}
              onChange={setTemplate}
              style={{ width: 180 }}
              options={processDefinitions.map((definition) => ({
                value: definition.template,
                label: definition.label,
              }))}
            />
          </Space>
        </div>
        <Table<ProcessInstance>
          className={`task-table ${selectedDefinition ? "is-single-process" : "is-mixed-process"}`}
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: selectedDefinition ? 1300 : 1020 }}
          expandable={
            selectedDefinition
              ? undefined
              : {
                  expandedRowRender: renderTaskInformation,
                  expandedRowKeys: filtered.map((record) => record.id),
                  showExpandColumn: false,
                  expandRowByClick: false,
                }
          }
          pagination={{ pageSize: 6, showSizeChanger: false, showTotal: (total) => `共 ${total} 项任务` }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={keyword || template ? "没有符合筛选条件的任务" : tab === "mine" ? "当前没有指定给你的待办" : "当前组内没有可代办任务"}
              />
            ),
          }}
          onRow={(record) => ({ onDoubleClick: () => navigate(`/processes/${record.id}`) })}
        />
      </Card>
    </div>
  );
}

function AvatarText({ name }: { name: string }) {
  return <span className="mini-avatar">{name.slice(-1)}</span>;
}
