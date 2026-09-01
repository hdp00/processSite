import {
  CopyOutlined,
  DownOutlined,
  EyeOutlined,
  ExportOutlined,
  FilterOutlined,
  PrinterOutlined,
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
  Row,
  Result,
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
import { ApiError } from "../api/client";
import { flowPilotApi } from "../api/flowPilotApi";
import { cacheProcessDefinition } from "../api/entityCache";
import { StatusPill } from "../components/StatusPill";
import { ListFieldValue } from "../components/ListFieldValue";
import { cloneDefaultSystemListFields, isSystemFieldVisible } from "../data/listFieldConfig";
import type { InstanceStatus, ProcessInstance } from "../data/types";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { getPublishedVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { canPersonaLaunchDefinition, hasPersonaPermission } from "../state/rolePermissions";
import { createDefaultDateRange, normalizeDayRange } from "../utils/dateRange";
import { normalizeDesignerFieldValue, PROCESS_TITLE_FIELD_ID } from "../utils/designerStorage";
import { designerChoiceOptionsToAntd } from "../utils/designerOptions";
import { downloadProcessListXlsx } from "../utils/processExcelExport";
import { formatDisplayDateTime } from "../utils/domainTime";
import { formatRoundLabel } from "../utils/roundDisplay";
import { getBusinessListColumnWidth, getSystemListColumnWidth } from "../utils/listColumnWidth";

export function ProcessListPage() {
  const { message: messageApi } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const managedDefinitions = useProcessDefinitionStore((state) => state.definitions);
  const definitionId = searchParams.get("definitionId")
    ?? managedDefinitions.find((item) => Boolean(item.publishedVersionId))?.id
    ?? "";
  const managedDefinition = managedDefinitions.find((item) => item.id === definitionId);
  const currentVersion = getPublishedVersion(managedDefinition);
  const definition = { id: definitionId, label: currentVersion?.basic.name ?? managedDefinition?.name ?? "未命名流程" };
  const personaId = usePrototypeStore((state) => state.personaId);
  const [form] = Form.useForm();
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<InstanceStatus>();
  const [dateRange, setDateRange] = useState(createDefaultDateRange);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedValues, setAdvancedValues] = useState<Record<string, string>>({});
  const [appliedFilters, setAppliedFilters] = useState(() => ({
    keyword: "",
    status: undefined as InstanceStatus | undefined,
    dateRange: createDefaultDateRange(),
    advancedValues: {} as Record<string, string>,
  }));
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(8);
  const [remoteRows, setRemoteRows] = useState<ProcessInstance[]>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteLoading, setRemoteLoading] = useState(false);
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
  const queryFields = currentVersion?.snapshot.form.fields.filter((field) =>
    field.id !== PROCESS_TITLE_FIELD_ID
    && field.queryable
    && field.type !== "attachment"
    && field.type !== "table"
    && field.type !== "richtext",
  ) ?? [];
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
    setAppliedFilters({ keyword: "", status: undefined, dateRange: createDefaultDateRange(), advancedValues: {} });
    form.resetFields();
    setPage(1);
  }, [definition.id, form]);

  useEffect(() => {
    if (!managedDefinition || currentVersion) return;
    let cancelled = false;
    void flowPilotApi.definitions.get(managedDefinition.id)
      .then((loaded) => { if (!cancelled) cacheProcessDefinition(loaded); })
      .catch(() => { if (!cancelled) messageApi.error("流程版本加载失败，请刷新后重试"); });
    return () => { cancelled = true; };
  }, [currentVersion, managedDefinition, messageApi]);

  useEffect(() => {
    if (!definition.id || !currentVersion) return;
    let cancelled = false;
    setRemoteLoading(true);
    const normalizedRange = normalizeDayRange(appliedFilters.dateRange);
    void flowPilotApi.instances.list({
      page,
      pageSize,
      q: appliedFilters.keyword.trim() || undefined,
      definitionId: definition.id,
      status: appliedFilters.status,
      createdFrom: normalizedRange[0].format("YYYY-MM-DD"),
      createdTo: normalizedRange[1].format("YYYY-MM-DD"),
      dynamicFilters: appliedFilters.advancedValues,
    }).then((result) => {
      if (cancelled) return;
      setRemoteRows(result.items);
      setRemoteTotal(result.page.totalElements);
    }).catch(() => {
      if (!cancelled) messageApi.error("流程清单加载失败，请稍后重试");
    }).finally(() => {
      if (!cancelled) setRemoteLoading(false);
    });
    return () => { cancelled = true; };
  }, [appliedFilters, currentVersion, definition.id, messageApi, page, pageSize]);

  const filtered = remoteRows;

  const dynamicColumns: TableProps<ProcessInstance>["columns"] = listFields.map((field) => ({
    title: field.label,
    key: field.id,
    width: getBusinessListColumnWidth(field),
    ellipsis: true,
    render: (_, record) => <ListFieldValue field={field} value={record.formValues?.[field.id]} />,
  }));

  const columns: TableProps<ProcessInstance>["columns"] = [
    ...(showSystemField("code") ? [{
      title: "实例编号", dataIndex: "code", width: getSystemListColumnWidth("code", "实例编号"),
      render: (value: string, record: ProcessInstance) => (
        <button className="table-link strong" type="button" onClick={() => navigate(`/processes/${record.id}`)}>{value}</button>
      ),
    }] : []),
    ...(showTitleCell ? [{
      title: showTitle ? "标题" : "流程名称", dataIndex: "title", width: getSystemListColumnWidth("title", showTitle ? "标题" : "流程名称"),
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
      width: getSystemListColumnWidth("templateVersion", "版本"),
      render: (value: string) => <Tag>{value}</Tag>,
    }] : []),
    ...(showSystemField("status") ? [{
      title: "状态",
      dataIndex: "status",
      width: getSystemListColumnWidth("status", "状态"),
      render: (value: InstanceStatus) => <StatusPill status={value} ariaLabel={`流程状态：${value}`} />,
    }] : []),
    ...(showNodeCell ? [{
      title: "当前节点",
      dataIndex: "currentNode",
      width: getSystemListColumnWidth("currentNode", "当前节点"),
      ellipsis: true,
      render: (value: string, record: ProcessInstance) =>
        record.workflowType === "free"
          ? (showSystemField("currentNode") && record.status === "进行中" ? record.currentAssignee ?? "" : "")
          : <span>
              {showSystemField("currentNode") ? value : null}
              {showSystemField("round") && record.round > 1 ? <small className="inline-subtle">{formatRoundLabel(record.round)}</small> : null}
            </span>,
    }] : []),
    ...(showSystemField("initiator") ? [{
      title: "发起人",
      dataIndex: "initiator",
      width: getSystemListColumnWidth("initiator", "发起人"),
      render: (value: string, record: ProcessInstance) => <span>{value}<small className="inline-subtle">{record.department}</small></span>,
    }] : []),
    ...(showSystemField("createdAt") ? [{
      title: "发起时间",
      dataIndex: "createdAt",
      width: getSystemListColumnWidth("createdAt", "发起时间"),
      render: (value: string) => formatDisplayDateTime(value),
    }] : []),
    ...(showSystemField("updatedAt") ? [{
      title: "更新时间",
      dataIndex: "updatedAt",
      width: getSystemListColumnWidth("updatedAt", "更新时间"),
      render: (value: string) => formatDisplayDateTime(value),
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
                onClick={() => window.open(`${import.meta.env.BASE_URL}processes/${record.id}/print`, "_blank", "noopener,noreferrer")}
              />
            </Tooltip>
          )}
          {record.workflowType !== "free" && record.status === "已完成" && (
            <Tooltip title={canCopyCompleted ? "复制内容并进入编辑" : "需要复制新建及流程发起权限"}>
              <span>
                <Button
                  className="task-action-button is-copy"
                  type="text"
                  disabled={!canCopyCompleted}
                  icon={<CopyOutlined />}
                  aria-label={`复制新建：${record.title}`}
                  onClick={() => navigate(`/launch/${record.definitionId}?copyFrom=${record.id}`)}
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
    setAppliedFilters({ keyword: "", status: undefined, dateRange: createDefaultDateRange(), advancedValues: {} });
    setPage(1);
  };

  const exportCurrentQuery = async () => {
    setExporting(true);
    const hideLoading = messageApi.loading("正在查询导出数据并生成 Excel，请稍候…", 0);
    try {
      const normalizedRange = normalizeDayRange(appliedFilters.dateRange);
      const dataset = await flowPilotApi.exports.processInstanceData({
        definitionId: definition.id,
        dateFrom: normalizedRange[0].format("YYYY-MM-DD"),
        dateTo: normalizedRange[1].format("YYYY-MM-DD"),
        q: appliedFilters.keyword.trim() || undefined,
        status: appliedFilters.status,
        dynamicFilters: appliedFilters.advancedValues,
      });
      const downloaded = await downloadProcessListXlsx(dataset);
      if (!downloaded) {
        messageApi.warning("当前流程尚未配置导出字段");
        return;
      }
      messageApi.success(`已导出当前查询范围内的 ${dataset.rowCount} 条记录`);
    } catch (error) {
      messageApi.error(error instanceof ApiError ? error.message : "Excel 导出失败，请稍后重试");
    } finally {
      hideLoading();
      setExporting(false);
    }
  };

  if (!managedDefinition || !currentVersion) {
    return (
      <Card className="content-card">
        <Result
          status="info"
          title="流程清单入口当前不可用"
          subTitle="该流程没有发布版本。历史实例仍可在实例监控中查询，但流程清单不会展示该流程入口。"
          extra={<Button type="primary" onClick={() => navigate("/tasks")}>返回任务中心</Button>}
        />
      </Card>
    );
  }

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
                  <Button type="primary" icon={<SearchOutlined />} onClick={() => { setPage(1); setAppliedFilters({ keyword, status, dateRange: normalizeDayRange(dateRange), advancedValues: { ...advancedValues } }); }}>查询</Button>
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
                      options={designerChoiceOptionsToAntd(field.options)}
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
          <div><strong>流程实例</strong><Tag variant="filled">{remoteTotal} 条</Tag></div>
          <Space>
            <Typography.Text type="secondary">{definition.label} · 包含当前用户可见的全部历史版本实例</Typography.Text>
            <Button icon={<ExportOutlined />} loading={exporting} onClick={() => void exportCurrentQuery()}>导出 Excel</Button>
          </Space>
        </div>
        <Table<ProcessInstance>
          className="process-record-table"
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={remoteLoading}
          bordered
          size="middle"
          scroll={{ x: "max-content" }}
          pagination={{ current: page, pageSize, total: remoteTotal, showSizeChanger: false, showTotal: (total) => `共 ${total} 条记录`, onChange: setPage }}
          onRow={(record) => ({ onDoubleClick: () => navigate(`/processes/${record.id}`) })}
        />
      </Card>

    </div>
  );
}
