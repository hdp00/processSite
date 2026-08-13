import {
  CopyOutlined,
  DownOutlined,
  EyeOutlined,
  FilterOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Row,
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { getProcessDefinition } from "../data/processDefinitions";
import type { InstanceStatus, ProcessInstance } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";

const statusMeta: Record<InstanceStatus, { className: string }> = {
  审核中: { className: "is-reviewing" },
  驳回待处理: { className: "is-rejected" },
  已完成: { className: "is-completed" },
  已关闭: { className: "is-closed" },
};

export function ProcessListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const definition = getProcessDefinition(searchParams.get("definitionId"));
  const { instances, personaId, copyCompletedInstance } = usePrototypeStore();
  const [form] = Form.useForm();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<InstanceStatus>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copySource, setCopySource] = useState<ProcessInstance | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [copyAttachment, setCopyAttachment] = useState(true);
  const canCopyCompleted = personaId === "wangmin";

  const filtered = useMemo(
    () =>
      instances.filter((item) => {
        const matchesKeyword = `${item.code}${item.title}${item.documentCode}${item.initiator}`
          .toLowerCase()
          .includes(keyword.trim().toLowerCase());
        return matchesKeyword && (!status || item.status === status) && item.template === definition.template;
      }),
    [instances, keyword, status, definition.template],
  );

  const columns: TableProps<ProcessInstance>["columns"] = [
    {
      title: "实例编号",
      dataIndex: "code",
      width: 178,
      render: (value: string, record) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>{value}</button>
      ),
    },
    {
      title: "标题",
      dataIndex: "title",
      width: 310,
      render: (value: string, record) => (
        <div className="title-cell"><strong>{value}</strong><span>{record.template}</span></div>
      ),
    },
    { title: "文件编号", dataIndex: "documentCode", width: 145 },
    { title: "文件类型", dataIndex: "documentType", width: 120 },
    {
      title: "版本",
      dataIndex: "templateVersion",
      width: 82,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (value: InstanceStatus) => (
        <span className={`status-pill ${statusMeta[value].className}`} aria-label={`流程状态：${value}`}>
          <span className="status-pill-dot" />
          {value}
        </span>
      ),
    },
    {
      title: "当前节点",
      dataIndex: "currentNode",
      width: 205,
      ellipsis: true,
      render: (value: string, record) => <span>{value}<small className="inline-subtle">第 {record.round} 轮</small></span>,
    },
    {
      title: "发起人",
      dataIndex: "initiator",
      width: 108,
      render: (value: string, record) => <span>{value}<small className="inline-subtle">{record.department}</small></span>,
    },
    {
      title: "发起时间",
      dataIndex: "createdAt",
      width: 150,
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 150,
    },
    {
      title: "操作",
      fixed: "right",
      width: 154,
      align: "center",
      render: (_, record) => (
        <Space size={6}>
          <Tooltip title="查看流程">
            <Button
              className="task-action-button"
              type="text"
              icon={<EyeOutlined />}
              aria-label={`查看流程：${record.title}`}
              onClick={() => navigate(`/processes/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title="打印为 PDF">
            <Button
              className="task-action-button is-print"
              type="text"
              icon={<PrinterOutlined />}
              aria-label={`打印流程为 PDF：${record.title}`}
              onClick={() => window.open(`/processes/${record.id}/print`, "_blank", "noopener,noreferrer")}
            />
          </Tooltip>
          {record.status === "已完成" && (
            <Tooltip title={canCopyCompleted ? "复制新建" : "需要该流程的发布权限"}>
              <span>
                <Button
                  className="task-action-button is-copy"
                  type="text"
                  disabled={!canCopyCompleted}
                  icon={<CopyOutlined />}
                  aria-label={`复制新建：${record.title}`}
                  onClick={() => {
                    setCopySource(record);
                    setCopyTitle(`${record.title}（复制）`);
                    setCopyAttachment(true);
                  }}
                />
              </span>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  const reset = () => {
    setKeyword("");
    setStatus(undefined);
    form.resetFields();
  };

  return (
    <div className="page-stack">
      <Card className="query-card">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Row gutter={16} align="bottom">
            <Col flex="280px">
              <Form.Item label="关键词">
                <Input prefix={<SearchOutlined />} allowClear value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="实例编号、标题、文件编号" />
              </Form.Item>
            </Col>
            <Col flex="180px">
              <Form.Item label="状态">
                <Select
                  allowClear
                  value={status}
                  onChange={setStatus}
                  placeholder="全部状态"
                  options={["审核中", "驳回待处理", "已完成", "已关闭"].map((value) => ({ value, label: value }))}
                />
              </Form.Item>
            </Col>
            <Col flex="280px">
              <Form.Item label="发起时间">
                <DatePicker.RangePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col flex="210px">
              <Form.Item>
                <Space>
                  <Button type="primary" icon={<SearchOutlined />}>查询</Button>
                  <Button icon={<ReloadOutlined />} onClick={reset}>重置</Button>
                  <Button
                    type="link"
                    icon={<FilterOutlined />}
                    onClick={() => setAdvancedOpen((value) => !value)}
                  >
                    高级查询 <DownOutlined rotate={advancedOpen ? 180 : 0} />
                  </Button>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>
        {advancedOpen && (
          <div className="advanced-query">
            <div className="advanced-query-title"><FilterOutlined /> 当前流程的可查询表单字段</div>
            <Row gutter={16}>
              <Col span={6}><Input placeholder="文件编号" /></Col>
              <Col span={6}><Select placeholder="文件类型" style={{ width: "100%" }} options={["作业指导书", "检验规范", "包装规范"].map((value) => ({ value }))} /></Col>
              <Col span={6}><Select placeholder="文件密级" style={{ width: "100%" }} options={["受控文件", "内部文件"].map((value) => ({ value }))} /></Col>
              <Col span={6}><Select placeholder="产品线" style={{ width: "100%" }} options={[{ value: "工业控制/驱动器", label: "工业控制 / 驱动器" }]} /></Col>
            </Row>
          </div>
        )}
      </Card>

      <Card className="content-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head">
          <div><strong>流程实例</strong><Tag bordered={false}>{filtered.length} 条</Tag></div>
          <Typography.Text type="secondary">{definition.label} · 包含当前用户可见的全部历史版本实例</Typography.Text>
        </div>
        <Table<ProcessInstance>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: 1530 }}
          pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录` }}
          onRow={(record) => ({ onDoubleClick: () => navigate(`/processes/${record.id}`) })}
        />
      </Card>

      <Modal
        open={Boolean(copySource)}
        title="复制新建流程"
        okText="复制并创建"
        cancelText="取消"
        onCancel={() => setCopySource(null)}
        onOk={() => {
          if (!copySource || !copyTitle.trim()) {
            message.warning("请输入新流程标题");
            return;
          }
          const createdId = copyCompletedInstance(copySource.id, copyTitle, copyAttachment);
          if (!createdId) {
            message.error("复制失败，请确认流程状态和发布权限");
            return;
          }
          setCopySource(null);
          message.success("新流程已创建，当前尚无人审核，可以继续修改");
          navigate(`/processes/${createdId}`);
        }}
      >
        <div className="copy-process-modal">
          <Alert
            type="info"
            showIcon
            message="复制最终表单内容，创建新的流程实例"
            description="新实例会生成独立编号并从第1轮开始；原审批记录、审核结果、通知和流转历史不会复制。"
          />
          <label className="field-block">
            <span>新流程标题</span>
            <Input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)} maxLength={120} showCount />
          </label>
          <Checkbox checked={copyAttachment} onChange={(event) => setCopyAttachment(event.target.checked)}>
            同时复制原附件
          </Checkbox>
          <Typography.Text type="secondary">创建后进入尚无人审核状态，发布方仍可修改；首位审核人提交后内容锁定。</Typography.Text>
        </div>
      </Modal>
    </div>
  );
}
