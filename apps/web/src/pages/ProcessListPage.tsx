import {
  DownOutlined,
  EyeOutlined,
  FilterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Form,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableProps,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { InstanceStatus, ProcessInstance } from "../data/types";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";

const statusMeta: Record<InstanceStatus, { color: string; dot: string }> = {
  审核中: { color: "processing", dot: "blue" },
  驳回待处理: { color: "error", dot: "red" },
  已完成: { color: "success", dot: "green" },
  已关闭: { color: "default", dot: "gray" },
};

export function ProcessListPage() {
  const navigate = useNavigate();
  const { instances, personaId } = usePrototypeStore();
  const persona = personas.find((item) => item.id === personaId) ?? personas[2];
  const [form] = Form.useForm();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<InstanceStatus>();
  const [template, setTemplate] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const filtered = useMemo(
    () =>
      instances.filter((item) => {
        const matchesKeyword = `${item.code}${item.title}${item.documentCode}${item.initiator}`
          .toLowerCase()
          .includes(keyword.trim().toLowerCase());
        return matchesKeyword && (!status || item.status === status) && (!template || item.template === template);
      }),
    [instances, keyword, status, template],
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
    ...(template
      ? [
          { title: "文件编号", dataIndex: "documentCode", width: 145 },
          { title: "文件类型", dataIndex: "documentType", width: 120 },
        ]
      : []),
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
      render: (value: InstanceStatus) => <Tag color={statusMeta[value].color}>{value}</Tag>,
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
      width: 86,
      render: (_, record) => <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/processes/${record.id}`)}>查看</Button>,
    },
  ];

  const reset = () => {
    setKeyword("");
    setStatus(undefined);
    setTemplate(undefined);
    form.resetFields();
  };

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>所有流程</Typography.Title>
          <Typography.Paragraph type="secondary">
            查询你有权查看的流程实例及完整表单信息。
          </Typography.Paragraph>
        </div>
        <div className="scope-badge">
          <span className="scope-icon"><EyeOutlined /></span>
          <span><small>当前数据范围</small><strong>{persona.id === "admin" ? "全部流程实例" : persona.id === "hejing" ? "额外授权 · 只读" : `${persona.role}相关流程`}</strong></span>
        </div>
      </div>

      <Card className="query-card">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Row gutter={16} align="bottom">
            <Col flex="280px">
              <Form.Item label="关键词">
                <Input prefix={<SearchOutlined />} allowClear value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="实例编号、标题、文件编号" />
              </Form.Item>
            </Col>
            <Col flex="220px">
              <Form.Item label="流程名称">
                <Select allowClear value={template} onChange={setTemplate} placeholder="全部流程" options={[{ value: "PDF 文件审核流程", label: "PDF 文件审核流程" }]} />
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
                    disabled={!template}
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
        {advancedOpen && template && (
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
          <Typography.Text type="secondary">选择具体流程后，表格会追加该表单配置的列表字段</Typography.Text>
        </div>
        <Table<ProcessInstance>
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          scroll={{ x: template ? 1530 : 1270 }}
          pagination={{ pageSize: 8, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录` }}
          onRow={(record) => ({ onDoubleClick: () => navigate(`/processes/${record.id}`) })}
        />
      </Card>
    </div>
  );
}
