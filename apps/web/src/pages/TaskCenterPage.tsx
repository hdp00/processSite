import {
  ArrowRightOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Badge,
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
  Typography,
  message,
  type TableProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ProcessInstance } from "../data/types";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";

const priorityColor = { 紧急: "error", 普通: "default" } as const;

export function TaskCenterPage() {
  const navigate = useNavigate();
  const { instances, personaId } = usePrototypeStore();
  const [tab, setTab] = useState<"mine" | "substitute">("mine");
  const [keyword, setKeyword] = useState("");
  const [template, setTemplate] = useState<string>();
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
  const filtered = source.filter((item) => {
    const matchesKeyword = `${item.code}${item.title}${item.initiator}`
      .toLowerCase()
      .includes(keyword.trim().toLowerCase());
    const matchesTemplate = !template || item.template === template;
    return matchesKeyword && matchesTemplate;
  });

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
      title: "时限",
      dataIndex: "dueText",
      width: 125,
      render: (value: string, record) => (
        <span className={record.priority === "紧急" ? "due-text is-urgent" : "due-text"}>
          <ClockCircleOutlined /> {value}
        </span>
      ),
    },
    {
      title: "操作",
      fixed: "right",
      width: 105,
      render: (_, record) => (
        <Button type="link" icon={<ArrowRightOutlined />} iconPosition="end" onClick={() => navigate(`/processes/${record.id}`)}>
          去审核
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack tasks-page">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>任务中心</Typography.Title>
          <Typography.Paragraph type="secondary">
            处理指定给你的审核，也可以在组内同事不在时直接代办。
          </Typography.Paragraph>
        </div>
        <Space>
          <Tag color={persona.reviewerKey ? "processing" : "default"}>{persona.role}</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => message.success("待办已刷新")}>刷新</Button>
        </Space>
      </div>

      <div className="task-summary-grid">
        <button className={tab === "mine" ? "summary-card active" : "summary-card"} type="button" onClick={() => setTab("mine")}>
          <span className="summary-icon blue"><UserOutlined /></span>
          <span><small>我的待办</small><strong>{myTasks.length}</strong><em>指定给我的任务</em></span>
          <ArrowRightOutlined />
        </button>
        <button className={tab === "substitute" ? "summary-card active purple" : "summary-card purple"} type="button" onClick={() => setTab("substitute")}>
          <span className="summary-icon purple"><TeamOutlined /></span>
          <span><small>可代办</small><strong>{substituteTasks.length}</strong><em>流程权限组内共享</em></span>
          <ArrowRightOutlined />
        </button>
        <div className="summary-note">
          <span className="summary-note-mark">i</span>
          <span><strong>临时代办无需转交</strong><small>组内任意一人提交即完成本节点，系统会记录实际处理人。</small></span>
        </div>
      </div>

      <Card className="content-card" styles={{ body: { padding: 0 } }}>
        <div className="table-toolbar">
          <Segmented
            value={tab}
            onChange={(value) => setTab(value as "mine" | "substitute")}
            options={[
              { label: <span>我的待办 <Badge count={myTasks.length} showZero color="#3157d5" /></span>, value: "mine" },
              { label: <span>可代办 <Badge count={substituteTasks.length} showZero color="#7658c9" /></span>, value: "substitute" },
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
              options={[{ value: "PDF 文件审核流程", label: "PDF 文件审核流程" }]}
            />
          </Space>
        </div>
        <Table<ProcessInstance>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1180 }}
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
