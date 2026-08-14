import {
  CopyOutlined,
  DownOutlined,
  EyeOutlined,
  FilterOutlined,
  PrinterOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
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
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getProcessDefinition } from "../data/processDefinitions";
import { isSystemFieldVisible, loadSystemListFields } from "../data/listFieldConfig";
import type { InstanceStatus, ProcessInstance } from "../data/types";
import { isSuperAdminPersona, usePrototypeStore } from "../state/usePrototypeStore";

const statusMeta: Record<InstanceStatus, { className: string }> = {
  审核中: { className: "is-reviewing" },
  驳回待处理: { className: "is-rejected" },
  已完成: { className: "is-completed" },
  进行中: { className: "is-reviewing" },
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
  const canCopyCompleted = personaId === "wangmin" || isSuperAdminPersona(personaId);
  const isFreeFlow = definition.id === "free-collaboration";
  const systemListFields = loadSystemListFields(definition.id);
  const showSystemField = (key: Parameters<typeof isSystemFieldVisible>[1]) =>
    isSystemFieldVisible(systemListFields, key, "processList");
  const showTitleCell = showSystemField("title") || showSystemField("template");
  const showNodeCell = showSystemField("currentNode") || showSystemField("round");

  useEffect(() => {
    setKeyword("");
    setStatus(undefined);
    setAdvancedOpen(false);
    form.resetFields();
  }, [definition.id, form]);

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
    ...(showSystemField("code") ? [{
      title: "实例编号", dataIndex: "code", width: 178,
      render: (value: string, record: ProcessInstance) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>{value}</button>
      ),
    }] : []),
    ...(showTitleCell ? [{
      title: showSystemField("title") ? "标题" : "流程名称", dataIndex: "title", width: 310,
      render: (value: string, record: ProcessInstance) => (
        <div className="title-cell">
          {showSystemField("title") ? <strong>{value}</strong> : null}
          {showSystemField("template") ? <span>{record.template}</span> : null}
        </div>
      ),
    }] : []),
    ...(isFreeFlow
      ? [
          { title: "事项分类", dataIndex: "category", width: 135 },
          { title: "当前受理人", dataIndex: "currentAssignee", width: 120, render: (value?: string) => value || "—" },
          { title: "参与人数", dataIndex: "participants", width: 100, render: (value?: string[]) => `${value?.length ?? 0} 人` },
        ]
      : [
          { title: "文件编号", dataIndex: "documentCode", width: 145 },
          { title: "文件类型", dataIndex: "documentType", width: 120 },
        ]),
    ...(showSystemField("templateVersion") ? [{
      title: "版本",
      dataIndex: "templateVersion",
      width: 82,
      render: (value: string) => <Tag>{value}</Tag>,
    }] : []),
    ...(showSystemField("status") ? [{
      title: "状态",
      dataIndex: "status",
      width: 120,
      render: (value: InstanceStatus) => (
        <span className={`status-pill ${statusMeta[value].className}`} aria-label={`流程状态：${value}`}>
          <span className="status-pill-dot" />
          {value}
        </span>
      ),
    }] : []),
    ...(showNodeCell ? [{
      title: "当前节点",
      dataIndex: "currentNode",
      width: 205,
      ellipsis: true,
      render: (value: string, record: ProcessInstance) =>
        record.workflowType === "free"
          ? (showSystemField("currentNode") && record.status === "进行中" ? record.currentAssignee ?? "" : "")
          : <span>
              {showSystemField("currentNode") ? value : null}
              {showSystemField("round") ? <small className="inline-subtle">第 {record.round} 轮</small> : null}
            </span>,
    }] : []),
    ...(showSystemField("initiator") ? [{
      title: "发起人",
      dataIndex: "initiator",
      width: 108,
      render: (value: string, record: ProcessInstance) => <span>{value}<small className="inline-subtle">{record.department}</small></span>,
    }] : []),
    ...(showSystemField("createdAt") ? [{
      title: "发起时间",
      dataIndex: "createdAt",
      width: 150,
    }] : []),
    ...(showSystemField("updatedAt") ? [{
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 150,
    }] : []),
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
          {record.workflowType !== "free" && (
            <Tooltip title="打印为 PDF">
              <Button
                className="task-action-button is-print"
                type="text"
                icon={<PrinterOutlined />}
                aria-label={`打印流程为 PDF：${record.title}`}
                onClick={() => window.open(`/processes/${record.id}/print`, "_blank", "noopener,noreferrer")}
              />
            </Tooltip>
          )}
          {record.workflowType !== "free" && record.status === "已完成" && (
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
                  options={(isFreeFlow ? ["进行中", "已关闭"] : ["审核中", "驳回待处理", "已完成", "已关闭"]).map((value) => ({ value, label: value }))}
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
              {isFreeFlow ? (
                <>
                  <Col span={8}><Select placeholder="事项分类" style={{ width: "100%" }} options={["生产异常", "质量问题", "设计问题", "测试记录", "一般协作"].map((value) => ({ value }))} /></Col>
                  <Col span={8}><Select showSearch placeholder="当前受理人" style={{ width: "100%" }} options={["王敏", "张伟", "林晓", "赵磊"].map((value) => ({ value }))} /></Col>
                  <Col span={8}><Select placeholder="优先级" style={{ width: "100%" }} options={["普通", "紧急"].map((value) => ({ value }))} /></Col>
                </>
              ) : (
                <>
                  <Col span={6}><Input placeholder="文件编号" /></Col>
                  <Col span={6}><Select placeholder="文件类型" style={{ width: "100%" }} options={["作业指导书", "检验规范", "包装规范"].map((value) => ({ value }))} /></Col>
                  <Col span={6}><Select placeholder="文件密级" style={{ width: "100%" }} options={["受控文件", "内部文件"].map((value) => ({ value }))} /></Col>
                  <Col span={6}><Select placeholder="产品线" style={{ width: "100%" }} options={[{ value: "工业控制/驱动器", label: "工业控制 / 驱动器" }]} /></Col>
                </>
              )}
            </Row>
          </div>
        )}
      </Card>

      <Card className="content-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head">
          <div><strong>流程实例</strong><Tag bordered={false}>{filtered.length} 条</Tag></div>
          <Space>
            <Typography.Text type="secondary">{definition.label} · 包含当前用户可见的全部历史版本实例</Typography.Text>
            {isFreeFlow && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate("/free-flow/new")}>新建事项</Button>}
          </Space>
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
          const createdId = copyCompletedInstance(copySource.id, copyTitle);
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
            description="新实例会按目标流程当前版本的编号前缀，从该前缀的共享月序列取得新编号并从第1轮开始；原附件、审批记录、审核结果、通知和流转历史均不会复制。"
          />
          <label className="field-block">
            <span>新流程标题</span>
            <Input value={copyTitle} onChange={(event) => setCopyTitle(event.target.value)} maxLength={120} showCount />
          </label>
          <Typography.Text type="secondary">创建后请重新上传所需附件；新流程在尚无人审核时仍可修改，首位审核人提交后内容锁定。</Typography.Text>
        </div>
      </Modal>
    </div>
  );
}
