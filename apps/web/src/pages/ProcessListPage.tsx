import {
  CopyOutlined,
  DownOutlined,
  EyeOutlined,
  ExportOutlined,
  FilterOutlined,
  PrinterOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
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
  type TableProps,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { StatusPill } from "../components/StatusPill";
import { cloneDefaultSystemListFields, isSystemFieldVisible } from "../data/listFieldConfig";
import type { InstanceStatus, ProcessInstance } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { getEffectiveVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { canPersonaLaunchDefinition, hasPersonaPermission } from "../state/rolePermissions";
import { canUserViewInstance } from "../state/workflowAccess";
import { createDefaultDateRange, isDateTimeInRange, normalizeDayRange } from "../utils/dateRange";
import { PROCESS_TITLE_FIELD_ID, type StoredDesignerField } from "../utils/designerStorage";
import { downloadProcessListExcel, processExportColumnCount } from "../utils/processExcelExport";

export function ProcessListPage() {
  const { message: messageApi } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const managedDefinitions = useProcessDefinitionStore((state) => state.definitions);
  const definitionId = searchParams.get("definitionId")
    ?? managedDefinitions.find((item) => Boolean(item.publishedVersionId))?.id
    ?? "";
  const managedDefinition = managedDefinitions.find((item) => item.id === definitionId);
  const currentVersion = getEffectiveVersion(managedDefinition);
  const definition = { id: definitionId, label: currentVersion?.basic.name ?? managedDefinition?.name ?? "未命名流程" };
  const { instances, personaId, copyCompletedInstance } = usePrototypeStore();
  const [form] = Form.useForm();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<InstanceStatus>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedValues, setAdvancedValues] = useState<Record<string, string>>({});
  const [copySource, setCopySource] = useState<ProcessInstance | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [exporting, setExporting] = useState(false);
  const canCopyCompleted = hasPersonaPermission(personaId, "work-list:复制新建")
    && canPersonaLaunchDefinition(personaId, definition.id);
  const canPrint = hasPersonaPermission(personaId, "work-list:打印");
  const isFreeFlow = managedDefinition?.type === "free";
  const systemListFields = currentVersion?.snapshot.systemFields ?? cloneDefaultSystemListFields();
  const titleField = currentVersion?.snapshot.form.fields.find((field) => field.id === PROCESS_TITLE_FIELD_ID);
  const showTitle = titleField?.listVisible ?? true;
  const listFields = currentVersion?.snapshot.form.fields.filter((field) =>
    field.id !== PROCESS_TITLE_FIELD_ID && field.listVisible && field.type !== "richtext",
  ) ?? [];
  const queryFields = currentVersion?.snapshot.form.fields.filter((field) => field.queryable && field.type !== "attachment" && field.type !== "table" && field.type !== "richtext") ?? [];
  const showSystemField = (key: Parameters<typeof isSystemFieldVisible>[1]) =>
    isSystemFieldVisible(systemListFields, key, "processList");
  const showTitleCell = showTitle || showSystemField("template");
  const showNodeCell = showSystemField("currentNode") || showSystemField("round");

  useEffect(() => {
    setKeyword("");
    setStatus(undefined);
    setDateRange(createDefaultDateRange());
    setAdvancedOpen(false);
    setAdvancedValues({});
    form.resetFields();
  }, [definition.id, form]);

  const filtered = useMemo(
    () =>
      instances.filter((item) => {
        const matchesKeyword = `${item.code}${item.title}${item.documentCode}${item.initiator}`
          .toLowerCase()
          .includes(keyword.trim().toLowerCase());
        const matchesAdvanced = queryFields.every((field) => {
          const query = advancedValues[field.id]?.trim().toLowerCase();
          if (!query) return true;
          const raw = item.formValues?.[field.id];
          const value = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
          return value.toLowerCase().includes(query);
        });
        return matchesKeyword
          && (!status || item.status === status)
          && isDateTimeInRange(item.createdAt, dateRange)
          && item.definitionId === definition.id
          && canUserViewInstance(personaId, item)
          && matchesAdvanced;
      }),
    [advancedValues, dateRange, definition.id, instances, keyword, personaId, queryFields, status],
  );

  const fieldValue = (record: ProcessInstance, field: StoredDesignerField) => {
    const raw = record.formValues?.[field.id];
    const value = raw === undefined || raw === null || raw === "" ? field.defaultValue ?? raw : raw;
    const emptyText = field.inputStage === "reviewer" ? "" : "—";
    if (Array.isArray(value)) return value.join("、") || emptyText;
    if (value && typeof value === "object") return "已填写";
    return value === undefined || value === null || value === "" ? emptyText : String(value);
  };

  const dynamicColumns: TableProps<ProcessInstance>["columns"] = listFields.map((field) => ({
    title: field.label,
    key: field.id,
    width: 160,
    ellipsis: true,
    render: (_, record) => fieldValue(record, field),
  }));

  const columns: TableProps<ProcessInstance>["columns"] = [
    ...(showSystemField("code") ? [{
      title: "实例编号", dataIndex: "code", width: 178,
      render: (value: string, record: ProcessInstance) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>{value}</button>
      ),
    }] : []),
    ...(showTitleCell ? [{
      title: showTitle ? "标题" : "流程名称", dataIndex: "title", width: 310,
      render: (value: string, record: ProcessInstance) => (
        <div className="title-cell">
          {showTitle ? <strong>{value}</strong> : null}
          {showSystemField("template") ? <span>{record.template}</span> : null}
        </div>
      ),
    }] : []),
    ...dynamicColumns,
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
      render: (value: InstanceStatus) => <StatusPill status={value} ariaLabel={`流程状态：${value}`} />,
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
          {record.workflowType !== "free" && canPrint && (
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
    setDateRange(createDefaultDateRange());
    form.resetFields();
    setAdvancedValues({});
  };

  const exportCurrentQuery = async () => {
    if (!filtered.length) {
      messageApi.warning("当前查询没有可导出的数据");
      return;
    }
    const formFields = currentVersion?.snapshot.form.fields ?? [];
    if (!processExportColumnCount(systemListFields, formFields)) {
      messageApi.warning("当前流程尚未配置导出字段");
      return;
    }

    setExporting(true);
    const hideLoading = messageApi.loading("正在生成 Excel，请稍候…", 0);
    let exportFailed = false;
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      downloadProcessListExcel({
        definitionName: definition.label,
        systemFields: systemListFields,
        formFields,
        instances: filtered,
      });
    } catch {
      exportFailed = true;
    } finally {
      hideLoading();
      setExporting(false);
    }
    if (exportFailed) messageApi.error("Excel 导出失败，请稍后重试");
    else messageApi.success(`已导出当前查询范围内的 ${filtered.length} 条记录`);
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
                <DatePicker.RangePicker
                  allowClear={false}
                  value={dateRange}
                  style={{ width: "100%" }}
                  onChange={(value) => {
                    if (value?.[0] && value[1]) setDateRange(normalizeDayRange([value[0], value[1]]));
                  }}
                />
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
              {queryFields.length ? queryFields.map((field) => (
                <Col span={6} key={field.id}>
                  {["select", "radio", "checkbox"].includes(field.type) ? (
                    <Select
                      allowClear
                      placeholder={field.label}
                      style={{ width: "100%" }}
                      value={advancedValues[field.id] || undefined}
                      onChange={(value) => setAdvancedValues((current) => ({ ...current, [field.id]: value ?? "" }))}
                      options={(field.options ?? []).map((value) => ({ value, label: value }))}
                    />
                  ) : (
                    <Input
                      allowClear
                      placeholder={field.label}
                      value={advancedValues[field.id] ?? ""}
                      onChange={(event) => setAdvancedValues((current) => ({ ...current, [field.id]: event.target.value }))}
                    />
                  )}
                </Col>
              )) : <Col span={24}><Typography.Text type="secondary">当前发布版本没有配置可查询字段</Typography.Text></Col>}
            </Row>
          </div>
        )}
      </Card>

      <Card className="content-card" styles={{ body: { padding: 0 } }}>
        <div className="table-result-head">
          <div><strong>流程实例</strong><Tag bordered={false}>{filtered.length} 条</Tag></div>
          <Space>
            <Typography.Text type="secondary">{definition.label} · 包含当前用户可见的全部历史版本实例</Typography.Text>
            <Button icon={<ExportOutlined />} loading={exporting} onClick={() => void exportCurrentQuery()}>导出 Excel</Button>
            {isFreeFlow && canPersonaLaunchDefinition(personaId, definition.id) && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(`/launch/${definition.id}`)}>新建事项</Button>}
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
            messageApi.warning("请输入新流程标题");
            return;
          }
          const createdId = copyCompletedInstance(copySource.id, copyTitle);
          if (!createdId) {
            messageApi.error("复制失败，请确认流程状态和发布权限");
            return;
          }
          setCopySource(null);
          messageApi.success("新流程已创建，当前尚无人审核，可以继续修改");
          navigate(`/processes/${createdId}`);
        }}
      >
        <div className="copy-process-modal">
          <Alert
            type="info"
            showIcon
            message="复制最终表单内容，创建新的流程实例"
            description="新实例会按目标流程当前版本的编号前缀，从该前缀的共享月序列取得新编号并从第1轮开始；原附件、审批记录、审核结果和流转历史均不会复制。"
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
