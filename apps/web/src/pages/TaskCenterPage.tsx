import {
  AuditOutlined,
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
      persona.reviewerKey
        ? instances.filter(
            (item) =>
              item.status === "审核中" &&
              item.reviewers.some(
                (reviewer) => reviewer.key === persona.reviewerKey && reviewer.status === "待审核",
              ),
          )
        : [],
    [instances, persona.reviewerKey],
  );

  const myTasks = actionable.filter(
    (item) => !item.designatedReviewer || item.designatedReviewer === persona.name,
  );
  const substituteTasks = actionable.filter(
    (item) => Boolean(item.designatedReviewer && item.designatedReviewer !== persona.name),
  );

  const source = tab === "mine" ? myTasks : substituteTasks;
  const selectedDefinition = processDefinitions.find((item) => item.template === template);
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
    {
      title: "实例编号",
      dataIndex: "code",
      width: 174,
      render: (value: string, record) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>
          {value}
        </button>
      ),
    },
    {
      title: "流程与标题",
      dataIndex: "title",
      width: 350,
      render: (value: string, record) => (
        <div className="title-cell">
          <strong>{value}</strong>
          <span>{record.template} · {record.templateVersion}</span>
        </div>
      ),
    },
    ...dynamicColumns,
    {
      title: "当前节点",
      dataIndex: "currentNode",
      width: 185,
      render: (value: string, record) => (
        <div className="node-cell">
          <span className="node-pulse" />
          <span>{value}</span>
          <small>第 {record.round} 轮</small>
        </div>
      ),
    },
    {
      title: "发起人",
      dataIndex: "initiator",
      width: 108,
      render: (value: string, record) => (
        <div className="person-cell"><AvatarText name={value} /><span>{value}<small>{record.department}</small></span></div>
      ),
    },
    {
      title: "任务归属",
      dataIndex: "designatedReviewer",
      width: 135,
      render: (value?: string) =>
        tab === "mine" ? (
          <Tag icon={<UserOutlined />} color="blue">指定给我</Tag>
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
        <Tooltip title="进入审核">
          <Button
            className="task-action-button"
            type="text"
            icon={<AuditOutlined />}
            aria-label={`审核：${record.title}`}
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
