import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  FilePdfOutlined,
  InboxOutlined,
  PlusOutlined,
  SaveOutlined,
  SendOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Cascader,
  Checkbox,
  DatePicker,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
  type TableProps,
  type UploadFile,
  type UploadProps,
} from "antd";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { usePrototypeStore } from "../state/usePrototypeStore";
import { issueNextInstanceNumber, previewNextInstanceNumber } from "../utils/instanceNumber";
import "./launch-pages.css";

type ApprovalGroupKey = "rd" | "qa" | "production";

interface StartDefinition {
  id: "pdf-review" | "test-report-review";
  name: string;
  version: string;
  description: string;
  permissionGroup: string;
  documentLabel: string;
  titlePlaceholder: string;
  instancePrefix: string;
}

interface RequirementRow {
  key: string;
  item: string;
  standard: string;
  method: string;
  mandatory: boolean;
  expected: "通过" | "不适用";
}

const definitions: Record<StartDefinition["id"], StartDefinition> = {
  "pdf-review": {
    id: "pdf-review",
    name: "PDF审核",
    version: "V2.3",
    description: "研发、质量、生产并行审核，任一分支驳回后本轮结束。",
    permissionGroup: "PDF审核_发起权限组",
    documentLabel: "待审核 PDF",
    titlePlaceholder: "例如：伺服驱动器装配作业指导书发布审核",
    instancePrefix: "DOC",
  },
  "test-report-review": {
    id: "test-report-review",
    name: "测试报告审核",
    version: "V1.6",
    description: "提交测试报告及验证明细，由三个专业流程权限组并行审核。",
    permissionGroup: "测试报告_发起权限组",
    documentLabel: "测试报告 PDF",
    titlePlaceholder: "例如：SD700 系列高温老化测试报告审核",
    instancePrefix: "DOC",
  },
};

const reviewerGroups: Record<ApprovalGroupKey, {
  label: string;
  permissionGroup: string;
  options: Array<{ value: string; label: string }>;
}> = {
  rd: {
    label: "研发审核",
    permissionGroup: "PDF审核_研发_审核组",
    options: [
      { value: "张伟", label: "张伟 · 研发 / 软件 · 员工" },
      { value: "陈昊", label: "陈昊 · 研发 / 硬件 · 员工" },
      { value: "孙宁", label: "孙宁 · 研发 · 经理" },
    ],
  },
  qa: {
    label: "质量审核",
    permissionGroup: "PDF审核_质量_审核组",
    options: [
      { value: "林晓", label: "林晓 · 质量 / 体系 · 员工" },
      { value: "周玥", label: "周玥 · 质量 / 检验 · 员工" },
      { value: "方诚", label: "方诚 · 质量 · 经理" },
    ],
  },
  production: {
    label: "生产审核",
    permissionGroup: "PDF审核_生产_审核组",
    options: [
      { value: "赵磊", label: "赵磊 · 生产 / 装配 · 员工" },
      { value: "刘洋", label: "刘洋 · 生产 / 测试 · 员工" },
      { value: "顾明", label: "顾明 · 生产 · 经理" },
    ],
  },
};

const productLineOptions = [
  {
    value: "工业控制",
    label: "工业控制",
    children: [
      { value: "驱动器", label: "驱动器" },
      { value: "控制器", label: "控制器" },
    ],
  },
  {
    value: "新能源",
    label: "新能源",
    children: [
      { value: "储能", label: "储能" },
      { value: "充电设备", label: "充电设备" },
    ],
  },
];

const initialRows: RequirementRow[] = [
  {
    key: "row-1",
    item: "文件内容与当前产品版本一致",
    standard: "图号、物料编码和软件版本与发布清单一致",
    method: "文件核对",
    mandatory: true,
    expected: "通过",
  },
  {
    key: "row-2",
    item: "关键参数和判定标准完整",
    standard: "参数单位明确，允许范围无歧义",
    method: "人工评审",
    mandatory: true,
    expected: "通过",
  },
];

function resolveDefinitionId(paramId: string | undefined, pathname: string): StartDefinition["id"] {
  const candidate = paramId ?? pathname.split("/").filter(Boolean).at(-1);
  return candidate === "test-report-review" ? "test-report-review" : "pdf-review";
}

export function ProcessStartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { definitionId } = useParams<{ definitionId?: string }>();
  const resolvedDefinitionId = resolveDefinitionId(definitionId, location.pathname);
  const definition = definitions[resolvedDefinitionId];
  const configuredInstancePrefix = useProcessDefinitionStore((state) => {
    const item = state.definitions.find((candidate) => candidate.id === resolvedDefinitionId);
    return item?.versions.find((version) => version.version === item.currentVersion)?.basic.instancePrefix
      ?? item?.draft?.basic.instancePrefix;
  });
  const instancePrefix = configuredInstancePrefix || definition.instancePrefix;
  const existingInstances = usePrototypeStore((state) => state.instances);
  const existingInstanceCodes = existingInstances.map((item) => item.code);
  const [form] = Form.useForm();
  const [rows, setRows] = useState<RequirementRow[]>(initialRows);
  const [pdfFiles, setPdfFiles] = useState<UploadFile[]>([]);
  const [attachmentFiles, setAttachmentFiles] = useState<UploadFile[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const previewCode = previewNextInstanceNumber(instancePrefix, existingInstanceCodes);

  const updateRow = <K extends keyof RequirementRow>(key: string, field: K, value: RequirementRow[K]) => {
    setRows((current) => current.map((row) => row.key === key ? { ...row, [field]: value } : row));
  };

  const addRow = () => {
    setRows((current) => [
      ...current,
      {
        key: `row-${Date.now()}`,
        item: "",
        standard: "",
        method: "人工评审",
        mandatory: false,
        expected: "通过",
      },
    ]);
  };

  const copyRow = (row: RequirementRow) => {
    setRows((current) => {
      const sourceIndex = current.findIndex((item) => item.key === row.key);
      const next = [...current];
      next.splice(sourceIndex + 1, 0, { ...row, key: `row-${Date.now()}` });
      return next;
    });
  };

  const removeRow = (key: string) => {
    if (rows.length === 1) {
      message.warning("明细表格至少保留一行");
      return;
    }
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const requirementColumns: TableProps<RequirementRow>["columns"] = [
    {
      title: "序号",
      width: 58,
      align: "center",
      render: (_, __, index) => index + 1,
    },
    {
      title: "审核项目",
      width: 220,
      render: (_, row) => (
        <Input
          value={row.item}
          placeholder="填写审核项目"
          onChange={(event) => updateRow(row.key, "item", event.target.value)}
          aria-label={`第${rows.indexOf(row) + 1}行审核项目`}
        />
      ),
    },
    {
      title: "判定标准",
      width: 260,
      render: (_, row) => (
        <Input
          value={row.standard}
          placeholder="填写可执行的判定标准"
          onChange={(event) => updateRow(row.key, "standard", event.target.value)}
          aria-label={`第${rows.indexOf(row) + 1}行判定标准`}
        />
      ),
    },
    {
      title: "验证方式",
      width: 132,
      render: (_, row) => (
        <Select
          value={row.method}
          onChange={(value) => updateRow(row.key, "method", value)}
          options={["文件核对", "人工评审", "样机验证", "数据复核"].map((value) => ({ value }))}
          aria-label={`第${rows.indexOf(row) + 1}行验证方式`}
        />
      ),
    },
    {
      title: "必检",
      width: 72,
      align: "center",
      render: (_, row) => (
        <Checkbox
          checked={row.mandatory}
          onChange={(event) => updateRow(row.key, "mandatory", event.target.checked)}
          aria-label={`第${rows.indexOf(row) + 1}行是否必检`}
        />
      ),
    },
    {
      title: "期望结果",
      width: 170,
      render: (_, row) => (
        <Radio.Group
          value={row.expected}
          onChange={(event) => updateRow(row.key, "expected", event.target.value as RequirementRow["expected"])}
          options={["通过", "不适用"]}
          aria-label={`第${rows.indexOf(row) + 1}行期望结果`}
        />
      ),
    },
    {
      title: "操作",
      width: 90,
      fixed: "right",
      align: "center",
      render: (_, row) => (
        <Space size={2}>
          <Tooltip title="复制此行">
            <Button type="text" icon={<CopyOutlined />} aria-label="复制此行" onClick={() => copyRow(row)} />
          </Tooltip>
          <Tooltip title="删除此行">
            <Button danger type="text" icon={<DeleteOutlined />} aria-label="删除此行" onClick={() => removeRow(row.key)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const validateUpload = (file: UploadFile, pdfOnly: boolean) => {
    const rawFile = file as UploadFile & { size?: number; type?: string };
    const isPdf = rawFile.type === "application/pdf" || rawFile.name.toLowerCase().endsWith(".pdf");
    if (pdfOnly && !isPdf) {
      message.error("主文件仅支持 PDF 格式");
      return Upload.LIST_IGNORE;
    }
    const maxSize = pdfOnly ? 50 : 100;
    if ((rawFile.size ?? 0) / 1024 / 1024 > maxSize) {
      message.error(`单个文件不能超过 ${maxSize} MB`);
      return Upload.LIST_IGNORE;
    }
    return false;
  };

  const pdfUploadProps: UploadProps = {
    accept: ".pdf,application/pdf",
    maxCount: 1,
    fileList: pdfFiles,
    beforeUpload: (file) => validateUpload(file, true),
    onChange: ({ fileList }) => setPdfFiles(fileList.slice(-1)),
    onRemove: () => {
      setPdfFiles([]);
      return true;
    },
  };

  const attachmentUploadProps: UploadProps = {
    multiple: true,
    maxCount: 10,
    fileList: attachmentFiles,
    beforeUpload: (file) => validateUpload(file, false),
    onChange: ({ fileList }) => setAttachmentFiles(fileList.slice(-10)),
  };

  const saveDraft = () => {
    message.success("草稿已保存，实例编号将在正式提交时生成");
  };

  const prepareSubmit = async () => {
    try {
      await form.validateFields();
      if (pdfFiles.length === 0) {
        message.warning(`请上传${definition.documentLabel}`);
        return;
      }
      if (rows.some((row) => !row.item.trim() || !row.standard.trim())) {
        message.warning("请完整填写审核明细中的审核项目和判定标准");
        return;
      }
      setConfirmOpen(true);
    } catch {
      message.warning("请检查并补全必填信息");
    }
  };

  const confirmSubmit = () => {
    setSubmitting(true);
    window.setTimeout(() => {
      const issuedCode = issueNextInstanceNumber(instancePrefix, existingInstanceCodes);
      setSubmitting(false);
      setConfirmOpen(false);
      message.success(`流程 ${issuedCode} 已发布，三个审核节点的待办已同时生成`);
      navigate("/tasks");
    }, 450);
  };

  const selectedReviewers = form.getFieldsValue(["rdReviewer", "qaReviewer", "productionReviewer"]);

  return (
    <div className="page-stack process-start-page">
      <div className="process-start-toolbar">
        <div className="process-start-title">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/launch")}>返回发起中心</Button>
          <Divider type="vertical" />
          <div>
            <strong>{definition.name}</strong>
            <span>{definition.version} · {definition.permissionGroup}</span>
          </div>
        </div>
        <Space>
          <Button icon={<SaveOutlined />} onClick={saveDraft}>保存草稿</Button>
          <Button type="primary" icon={<SendOutlined />} onClick={prepareSubmit}>提交审核</Button>
        </Space>
      </div>

      <Card className="start-progress-card">
        <div className="start-progress-copy">
          <Tag color="processing">已发布版本</Tag>
          <Typography.Text>{definition.description}</Typography.Text>
        </div>
        <Steps
          current={0}
          responsive={false}
          items={[
            { title: "填写并发布", description: "文控" },
            { title: "并行审核", description: "研发 / 质量 / 生产" },
            { title: "流程结束", description: "全部通过" },
          ]}
        />
      </Card>

      <Form
        form={form}
        layout="vertical"
        requiredMark="optional"
        initialValues={{
          priority: "普通",
          confidentiality: "内部文件",
          revision: "A.0",
          documentType: resolvedDefinitionId === "pdf-review" ? "作业指导书" : "测试报告",
          testType: "型式测试",
          conclusion: "通过",
          rdReviewer: "张伟",
          qaReviewer: "林晓",
          productionReviewer: "赵磊",
        }}
      >
        <div className="process-start-layout">
          <main className="process-start-main">
            <Card className="form-card" title="初始表单" extra={<Typography.Text type="secondary">实例编号提交后由后台生成</Typography.Text>}>
              <div className="start-form-grid">
                <Form.Item className="field-wide" label="流程标题" name="title" rules={[{ required: true, message: "请输入流程标题" }]}>
                  <Input maxLength={120} showCount placeholder={definition.titlePlaceholder} />
                </Form.Item>

                <Form.Item label={resolvedDefinitionId === "pdf-review" ? "文件编号" : "报告编号"} name="documentCode" extra="留空时由后台自动生成">
                  <Input placeholder="自动生成，也可填写外部编号" />
                </Form.Item>
                <Form.Item label="优先级" name="priority" rules={[{ required: true }]}>
                  <Radio.Group optionType="button" buttonStyle="solid" options={["普通", "紧急"]} />
                </Form.Item>

                <Form.Item label="文件类型" name="documentType" rules={[{ required: true, message: "请选择文件类型" }]}>
                  <Select options={(resolvedDefinitionId === "pdf-review"
                    ? ["作业指导书", "检验规范", "包装规范", "技术标准"]
                    : ["测试报告", "验证报告", "失效分析报告"]
                  ).map((value) => ({ value }))} />
                </Form.Item>
                <Form.Item label="产品线" name="productLine" rules={[{ required: true, message: "请选择产品线" }]}>
                  <Cascader options={productLineOptions} placeholder="选择一级 / 二级产品线" />
                </Form.Item>

                {resolvedDefinitionId === "pdf-review" ? (
                  <>
                    <Form.Item label="修订版本" name="revision" rules={[{ required: true }]}>
                      <Input placeholder="例如 A.0" />
                    </Form.Item>
                    <Form.Item label="文件密级" name="confidentiality" rules={[{ required: true }]}>
                      <Radio.Group options={["内部文件", "受控文件"]} />
                    </Form.Item>
                    <Form.Item label="计划生效日期" name="effectiveDate">
                      <DatePicker style={{ width: "100%" }} placeholder="选择计划生效日期" />
                    </Form.Item>
                    <Form.Item label="适用部门" name="applicableDepartments" rules={[{ required: true, message: "请选择适用部门" }]}>
                      <Select mode="multiple" placeholder="可选择多个部门" options={["研发", "质量", "生产", "供应链"].map((value) => ({ value }))} />
                    </Form.Item>
                  </>
                ) : (
                  <>
                    <Form.Item label="产品型号" name="productModel" rules={[{ required: true, message: "请输入产品型号" }]}>
                      <Input placeholder="例如 SD700-2R2G" />
                    </Form.Item>
                    <Form.Item label="测试类型" name="testType" rules={[{ required: true }]}>
                      <Select options={["型式测试", "回归测试", "可靠性测试", "例行测试"].map((value) => ({ value }))} />
                    </Form.Item>
                    <Form.Item label="测试日期" name="testDate" rules={[{ required: true, message: "请选择测试日期" }]}>
                      <DatePicker style={{ width: "100%" }} />
                    </Form.Item>
                    <Form.Item label="测试结论" name="conclusion" rules={[{ required: true }]}>
                      <Radio.Group options={["通过", "有条件通过", "不通过"]} />
                    </Form.Item>
                  </>
                )}

                <Form.Item className="field-wide" label="发布说明" name="description" rules={[{ required: true, message: "请输入发布说明" }]}>
                  <Input.TextArea rows={4} maxLength={500} showCount placeholder="说明本次发布背景、重点变更或审核关注事项" />
                </Form.Item>
              </div>
            </Card>

            <Card
              className="form-card start-table-card"
              title="审核明细"
              extra={<Button type="primary" ghost icon={<PlusOutlined />} onClick={addRow}>新增一行</Button>}
            >
              <Typography.Paragraph type="secondary" className="start-card-help">
                发起人可新增、复制或删除整行；进入审核后，审核人只能修改节点配置允许的单元格。
              </Typography.Paragraph>
              <Table<RequirementRow>
                rowKey="key"
                columns={requirementColumns}
                dataSource={rows}
                pagination={false}
                scroll={{ x: 1000 }}
                size="small"
              />
            </Card>

            <Card className="form-card" title="附件">
              <div className="start-upload-grid">
                <div>
                  <div className="start-upload-label"><FilePdfOutlined /><strong>{definition.documentLabel} *</strong><Tag bordered={false}>PDF · 最大 50 MB</Tag></div>
                  <Upload.Dragger {...pdfUploadProps}>
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽上传主文件</p>
                    <p className="ant-upload-hint">主文件可配置为在审核页面中直接预览</p>
                  </Upload.Dragger>
                </div>
                <div>
                  <div className="start-upload-label"><InboxOutlined /><strong>补充附件</strong><Tag bordered={false}>最多 10 个</Tag></div>
                  <Upload.Dragger {...attachmentUploadProps}>
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">上传图纸、数据或说明材料</p>
                    <p className="ant-upload-hint">单个文件最大 100 MB；打印流程时仅显示附件名称</p>
                  </Upload.Dragger>
                </div>
              </div>
            </Card>
          </main>

          <aside className="process-start-aside">
            <Card className="approval-card start-reviewer-card" title="指定并行审批人" extra={<TeamOutlined />}>
              <Alert
                type="info"
                showIcon
                message="指定人员优先处理，同组成员仍可代办"
                description="其他人员默认在“我的待办”中看不到此流程，但可从“可代办”进入处理。"
              />
              <div className="start-reviewer-list">
                {(Object.entries(reviewerGroups) as Array<[ApprovalGroupKey, (typeof reviewerGroups)[ApprovalGroupKey]]>).map(([key, group]) => (
                  <div className="start-reviewer-item" key={key}>
                    <div className="start-reviewer-head">
                      <span><CheckCircleOutlined /><strong>{group.label}</strong></span>
                      <Tag bordered={false} color="blue">任一人完成</Tag>
                    </div>
                    <Form.Item
                      name={`${key}Reviewer`}
                      rules={[{ required: true, message: `请选择${group.label}人` }]}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder={`搜索${group.label}组成员`}
                        options={group.options}
                      />
                    </Form.Item>
                    <span className="start-permission-name"><TeamOutlined /> {group.permissionGroup} · {group.options.length} 人</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="approval-card start-rule-card" title="固定流程规则">
              <ul>
                <li><strong>并行开始</strong><span>三个审核节点提交后同时生成待办。</span></li>
                <li><strong>任一驳回</strong><span>本轮其他待办自动取消，返回发布方处理。</span></li>
                <li><strong>内容锁定</strong><span>首位审核人提交前可修改；之后仅驳回重开时可修改。</span></li>
                <li><strong>重新发布</strong><span>重新发布后全部审核分支从新一轮开始。</span></li>
              </ul>
            </Card>
          </aside>
        </div>
      </Form>

      <Modal
        open={confirmOpen}
        title="确认发布流程"
        okText="确认发布"
        cancelText="返回检查"
        confirmLoading={submitting}
        onOk={confirmSubmit}
        onCancel={() => setConfirmOpen(false)}
      >
        <Alert
          type="warning"
          showIcon
          message="发布后将立即生成三个并行审核待办"
          description="在首位审核人提交前，你仍可以修改表单；出现审核动作后表单自动锁定。"
        />
        <Descriptions className="start-confirm-descriptions" column={1} size="small" bordered>
          <Descriptions.Item label="流程">{definition.name} {definition.version}</Descriptions.Item>
          <Descriptions.Item label="预计实例编号">{previewCode}</Descriptions.Item>
          <Descriptions.Item label="主文件">{pdfFiles[0]?.name ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="研发审核">{selectedReviewers.rdReviewer ?? "张伟"}</Descriptions.Item>
          <Descriptions.Item label="质量审核">{selectedReviewers.qaReviewer ?? "林晓"}</Descriptions.Item>
          <Descriptions.Item label="生产审核">{selectedReviewers.productionReviewer ?? "赵磊"}</Descriptions.Item>
        </Descriptions>
      </Modal>
    </div>
  );
}
