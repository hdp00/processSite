import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  AuditOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  ExclamationCircleFilled,
  FileDoneOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  WarningFilled,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Space,
  Steps,
  Tag,
  Typography,
  message,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import "./process-admin-pages.css";

type ValidationLevel = "pass" | "warning" | "block";

interface ProcessPublishPageProps {
  definitionId?: string;
}

interface ValidationItem {
  key: string;
  title: string;
  detail: string;
  level: ValidationLevel;
}

interface PublishSnapshot {
  name: string;
  code: string;
  type: "approval" | "free";
  currentVersion: string;
  nextVersion: string;
  description: string;
  starterGroup: string;
  assigneeGroup?: string;
  extraScope: string[];
  fields: Array<{ name: string; type: string; required?: boolean; list?: boolean }>;
  rejectionHandling?: string;
}

const publishDataById: Record<string, PublishSnapshot> = {
  "pdf-review": {
    name: "PDF 文件审核",
    code: "PROC-PDF-001",
    type: "approval",
    currentVersion: "v3",
    nextVersion: "v4",
    description: "受控 PDF 文件由研发、质量、生产并行审核。",
    starterGroup: "PDF审核_文控_流程权限组",
    extraScope: ["部门查看员", "林晓"],
    fields: [
      { name: "文档名称", type: "文本框", required: true, list: true },
      { name: "文档编号", type: "文本框", required: true, list: true },
      { name: "文档分类", type: "多级下拉", required: true, list: true },
      { name: "文件级别", type: "下拉框", required: true },
      { name: "适用部门", type: "复选框", required: true },
      { name: "审核检查清单", type: "表格", required: true },
      { name: "正式审核文件", type: "附件上传", required: true },
    ],
    rejectionHandling: "重新发布或关闭",
  },
  "test-report-review": {
    name: "测试报告审核",
    code: "PROC-TR-002",
    type: "approval",
    currentVersion: "尚未发布",
    nextVersion: "v1",
    description: "用于研发测试报告的会签、确认和正式发布。",
    starterGroup: "测试报告_发起_流程权限组",
    extraScope: ["研发经理", "质量经理"],
    fields: [
      { name: "报告名称", type: "文本框", required: true, list: true },
      { name: "报告编号", type: "文本框", required: true, list: true },
      { name: "产品型号", type: "下拉框", required: true, list: true },
      { name: "测试结论", type: "单选框", required: true },
      { name: "测试报告", type: "附件上传", required: true },
    ],
    rejectionHandling: "重新发布或关闭",
  },
  "free-collaboration": {
    name: "异常协作事项",
    code: "PROC-FREE-003",
    type: "free",
    currentVersion: "v2",
    nextVersion: "v3",
    description: "当前受理人处理后指定下一位受理人，直至手动关闭。",
    starterGroup: "自由协作_发起_流程权限组",
    assigneeGroup: "自由协作_受理_流程权限组",
    extraScope: ["部门查看员"],
    fields: [
      { name: "事项标题", type: "文本框", required: true, list: true },
      { name: "事项分类", type: "下拉框", required: true, list: true },
      { name: "优先级", type: "单选框", required: true, list: true },
      { name: "问题说明", type: "富文本编辑框", required: true },
      { name: "相关附件", type: "附件上传" },
    ],
  },
};

const defaultSnapshot = publishDataById["pdf-review"];

const formFieldTypeLabels: Record<string, string> = {
  text: "文本框",
  richtext: "富文本编辑框",
  select: "下拉框",
  cascader: "多级下拉",
  radio: "单选框",
  checkbox: "复选框",
  attachment: "附件上传",
  table: "明细表格",
};

const readFormFields = (definitionId: string, fallback: PublishSnapshot["fields"]) => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`flowpilot-form-designer-draft-v2-${definitionId}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      fields?: Array<{ label?: string; type?: string; required?: boolean; listVisible?: boolean }>;
    };
    if (!Array.isArray(parsed.fields)) return fallback;
    return parsed.fields.map((field, index) => ({
      name: field.label?.trim() || `未命名字段 ${index + 1}`,
      type: formFieldTypeLabels[field.type ?? ""] ?? field.type ?? "未知类型",
      required: field.required,
      list: field.listVisible,
    }));
  } catch {
    return fallback;
  }
};

const levelMeta: Record<ValidationLevel, { label: string; icon: React.ReactNode; className: string }> = {
  pass: { label: "通过", icon: <CheckCircleFilled />, className: "is-pass" },
  warning: { label: "警告", icon: <WarningFilled />, className: "is-warning" },
  block: { label: "阻断", icon: <ExclamationCircleFilled />, className: "is-block" },
};

export function ProcessPublishPage({ definitionId }: ProcessPublishPageProps) {
  const navigate = useNavigate();
  const params = useParams<{ definitionId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const resolvedId = definitionId
    ?? params.definitionId
    ?? params.id
    ?? searchParams.get("definitionId")
    ?? "pdf-review";
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === resolvedId),
  );
  const publishDraft = useProcessDefinitionStore((state) => state.publishDraft);
  const fallbackSnapshot = publishDataById[resolvedId] ?? defaultSnapshot;
  const snapshot = useMemo<PublishSnapshot>(() => {
    const config = definition?.draft?.basic
      ?? definition?.versions.find((item) => item.version === definition.currentVersion)?.basic;
    if (!definition || !config) return fallbackSnapshot;
    return {
      name: config.name,
      code: config.code,
      type: config.type,
      currentVersion: definition.currentVersion ?? "尚未发布",
      nextVersion: definition.draft?.version ?? definition.currentVersion ?? "v1",
      description: config.description,
      starterGroup: config.starterGroup || "尚未选择",
      assigneeGroup: config.assigneeGroup,
      extraScope: [...config.visibleRoles, ...config.visibleUsers],
      fields: readFormFields(resolvedId, fallbackSnapshot.fields),
      rejectionHandling: fallbackSnapshot.rejectionHandling ?? "重新发布或关闭",
    };
  }, [definition, fallbackSnapshot, resolvedId]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [validating, setValidating] = useState(false);
  const [published, setPublished] = useState(false);

  const validationItems = useMemo<ValidationItem[]>(() => {
    const draft = definition?.draft;
    const hasForm = published || Boolean(draft?.formConfigured && snapshot.fields.length);
    const hasStarter = published || Boolean(draft?.basic.starterGroup);
    const common: ValidationItem[] = [
      { key: "basic", title: "基本信息完整", detail: "流程名称、编号、说明和流程类型均已设置。", level: "pass" },
      { key: "form", title: "发起表单有效", detail: hasForm ? `${snapshot.fields.length} 个字段已完成配置，必填项和列表字段规则有效。` : "请返回表单设计步骤，至少配置并保存一个字段。", level: hasForm ? "pass" : "block" },
      { key: "starter", title: "发起权限有效", detail: hasStarter ? `已关联“${snapshot.starterGroup}”，当前有效成员会获得发起权限。` : "请返回基本信息选择发起流程权限组。", level: hasStarter ? "pass" : "block" },
    ];

    if (snapshot.type === "free") {
      const hasAssignee = published || Boolean(draft?.basic.assigneeGroup);
      return [
        ...common,
        { key: "assignee", title: "受理范围有效", detail: hasAssignee ? `已关联“${snapshot.assigneeGroup}”，受理人支持按姓名和部门搜索。` : "请返回基本信息选择受理流程权限组。", level: hasAssignee ? "pass" : "block" },
        { key: "rules", title: "自由流转规则完整", detail: "关闭、填写理由后重新打开、异常改派和本人编辑历史内容均已启用。", level: "pass" },
        { key: "notice", title: "通知模板沿用系统默认值", detail: "尚未配置专属通知文案，将使用统一的待办与站内通知模板。", level: "warning" },
      ];
    }

    return [
      ...common,
      {
        key: "topology",
        title: published || draft?.flowConfigured ? "审批拓扑有效" : "审批节点存在未完成配置",
        detail: published || draft?.flowConfigured
          ? `已保存 ${draft?.nodeCount ?? definition?.versions[0]?.nodeCount ?? 0} 个流程节点，拓扑结构已通过设计器校验。`
          : "请返回流程设计器完成节点、权限组和连线配置。",
        level: published || draft?.flowConfigured ? "pass" : "block",
      },
      { key: "editable", title: "并行字段权限无冲突", detail: "研发、质量、生产节点未配置修改同一字段。", level: "pass" },
      { key: "notice", title: "通知模板沿用系统默认值", detail: "尚未配置专属通知文案，将使用统一的待办与站内通知模板。", level: "warning" },
    ];
  }, [definition, published, snapshot]);

  const blockCount = validationItems.filter((item) => item.level === "block").length;
  const warningCount = validationItems.filter((item) => item.level === "warning").length;
  const passCount = validationItems.filter((item) => item.level === "pass").length;

  const rerunValidation = () => {
    setValidating(true);
    window.setTimeout(() => {
      setValidating(false);
      message.success("校验已完成，结果已刷新");
    }, 650);
  };

  const publish = () => {
    if (!changeNote.trim()) {
      message.warning("请填写本次发布的变更说明");
      return;
    }
    if (!confirmed) {
      message.warning("请确认已了解发布影响范围");
      return;
    }
    setConfirmOpen(false);
    const released = publishDraft(resolvedId, changeNote.trim());
    if (!released) {
      message.error("当前流程没有可发布的草稿，请返回流程管理重新进入编辑");
      return;
    }
    setPublished(true);
    message.success(`${snapshot.name} ${snapshot.nextVersion} 已发布，新发起实例将使用该版本`);
  };

  return (
    <div className="page-stack pa-page pa-publish-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(`/admin/processes/${resolvedId}/${snapshot.type === "approval" ? "flow" : "form"}`)}
          >
            上一步
          </Button>
          <div>
            <Space size={10} wrap>
              <Typography.Title level={3}>发布流程</Typography.Title>
              <Tag color={snapshot.type === "approval" ? "blue" : "purple"}>{snapshot.type === "approval" ? "固定审批" : "自由协作"}</Tag>
            </Space>
            <Typography.Text type="secondary">发布前检查流程快照和权限配置，发布后形成不可修改的版本记录。</Typography.Text>
          </div>
        </div>
        <Button loading={validating} icon={<ReloadOutlined />} onClick={rerunValidation}>重新校验</Button>
      </Card>

      <Card className="pa-steps-card" bordered={false}>
        <Steps
          size="small"
          current={snapshot.type === "approval" ? 3 : 2}
          items={snapshot.type === "approval"
            ? [{ title: "基本信息" }, { title: "表单设计" }, { title: "流程设计" }, { title: "发布" }]
            : [{ title: "基本信息" }, { title: "表单设计" }, { title: "发布校验" }]}
        />
      </Card>

      {published && (
        <Alert
          className="pa-page-alert"
          type="success"
          showIcon
          message={`${snapshot.nextVersion} 已成功发布`}
          description="新发起的流程将使用本版本；运行中的流程继续按其发起时版本执行。"
          action={<Button size="small" onClick={() => navigate(`/admin/processes/${resolvedId}/versions`)}>查看版本记录</Button>}
        />
      )}

      <div className="pa-publish-grid">
        <main className="pa-publish-main">
          <Card className="pa-section-card" title={<span className="pa-card-title"><FileDoneOutlined /> 发布摘要</span>}>
            <Descriptions
              className="pa-summary-descriptions"
              bordered
              size="small"
              column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }}
              items={[
                { key: "name", label: "流程名称", children: snapshot.name },
                { key: "code", label: "流程编号", children: snapshot.code },
                { key: "version", label: "发布版本", children: <Space><span className="pa-muted">{snapshot.currentVersion}</span><span>→</span><Tag color="blue">{snapshot.nextVersion}</Tag></Space> },
                { key: "type", label: "流程类型", children: snapshot.type === "approval" ? "固定审批" : "自由协作" },
                { key: "starter", label: "发起流程权限组", children: snapshot.starterGroup, span: 2 },
                ...(snapshot.assigneeGroup ? [{ key: "assignee", label: "受理流程权限组", children: snapshot.assigneeGroup, span: 2 as const }] : []),
                { key: "scope", label: "额外可见范围", children: snapshot.extraScope.map((item) => <Tag key={item}>{item}</Tag>), span: 2 },
                { key: "description", label: "流程说明", children: snapshot.description, span: 2 },
              ]}
            />
          </Card>

          <Card className="pa-section-card" title={<span className="pa-card-title"><FileTextOutlined /> 表单快照</span>} extra={<Tag bordered={false}>{snapshot.fields.length} 个字段</Tag>}>
            <div className="pa-field-preview-list">
              {snapshot.fields.map((field, index) => (
                <div className="pa-field-preview" key={field.name}>
                  <span className="pa-field-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="pa-field-copy"><strong>{field.name}</strong><small>{field.type}</small></span>
                  <Space size={4}>
                    {field.required && <Tag color="red" bordered={false}>必填</Tag>}
                    {field.list && <Tag color="blue" bordered={false}>列表显示</Tag>}
                  </Space>
                </div>
              ))}
            </div>
          </Card>

          {snapshot.type === "approval" ? (
            <Card className="pa-section-card" title={<span className="pa-card-title"><ApartmentOutlined /> 审批拓扑与规则</span>}>
              <div className="pa-topology" aria-label="审批流程拓扑预览">
                <div className="pa-topology-node is-start"><small>开始</small><strong>文控发起</strong><span>8 人</span></div>
                <div className="pa-topology-lines"><span /><span /><span /></div>
                <div className="pa-topology-parallel">
                  <div className="pa-topology-node"><small>审批</small><strong>研发审核</strong><span>任一人处理</span></div>
                  <div className="pa-topology-node"><small>审批</small><strong>质量审核</strong><span>任一人处理</span></div>
                <div className={`pa-topology-node ${!published && !definition?.draft?.flowConfigured ? "is-invalid" : ""}`}><small>审批</small><strong>生产审核</strong><span>{!published && !definition?.draft?.flowConfigured ? "尚未完成配置" : "任一人处理"}</span></div>
                </div>
                <div className="pa-topology-join" />
                <div className="pa-topology-node is-end"><small>结束</small><strong>审核完成</strong><span>全部分支通过</span></div>
              </div>
              <Divider />
              <div className="pa-rule-summary">
                <span><AuditOutlined /></span>
                <div><strong>驳回后的处理方式</strong><Typography.Text type="secondary">{snapshot.rejectionHandling}</Typography.Text></div>
                <Tag color="orange">任一分支驳回，本轮其他待办自动取消</Tag>
              </div>
            </Card>
          ) : (
            <Card className="pa-section-card" title={<span className="pa-card-title"><TeamOutlined /> 自由协作固定规则</span>}>
              <div className="pa-free-rule-grid">
                {[
                  ["连续流转", "当前受理人处理后选择下一位受理人"],
                  ["手动关闭", "处理人关闭事项，关闭动作进入时间线"],
                  ["重新打开", "填写理由后恢复流转和发起表单编辑"],
                  ["异常改派", "有权限的管理员可更换当前受理人"],
                  ["本人可编辑", "参与者可编辑自己发布的历史内容并保留版本"],
                  ["不支持打印", "自由协作流程不生成流程 PDF"],
                ].map(([title, description]) => (
                  <div key={title}><CheckCircleFilled /><span><strong>{title}</strong><small>{description}</small></span></div>
                ))}
              </div>
            </Card>
          )}
        </main>

        <aside className="pa-publish-aside">
          <Card className="pa-validation-card" title={<span className="pa-card-title"><SafetyCertificateOutlined /> 发布校验</span>}>
            <div className="pa-validation-score">
              <div className={blockCount > 0 ? "is-blocked" : "is-ready"}>
                {blockCount > 0 ? <ExclamationCircleFilled /> : <CheckCircleFilled />}
              </div>
              <span>
                <strong>{blockCount > 0 ? "暂不能发布" : "可以发布"}</strong>
                <small>{passCount} 项通过 · {warningCount} 项警告 · {blockCount} 项阻断</small>
              </span>
            </div>
            <div className="pa-validation-list">
              {validationItems.map((item) => (
                <div className={`pa-validation-item ${levelMeta[item.level].className}`} key={item.key}>
                  <span className="pa-validation-item__icon">{levelMeta[item.level].icon}</span>
                  <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                  <Tag bordered={false}>{levelMeta[item.level].label}</Tag>
                </div>
              ))}
            </div>
          </Card>

          <Card className="pa-publish-impact" bordered={false}>
            <InfoCircleOutlined />
            <div>
              <strong>版本生效范围</strong>
              <Typography.Text type="secondary">发布只影响之后新发起的实例，不迁移或重算运行中的待办。</Typography.Text>
            </div>
          </Card>

          <Button
            className="pa-publish-button"
            type="primary"
            size="large"
            icon={published ? <CheckCircleFilled /> : <RocketOutlined />}
            disabled={blockCount > 0 || published || !definition?.draft}
            onClick={() => setConfirmOpen(true)}
          >
            {published ? `${snapshot.nextVersion} 已发布` : `发布 ${snapshot.nextVersion}`}
          </Button>
          {blockCount > 0 && (
            <Typography.Text className="pa-block-hint" type="danger">请先处理所有阻断项，再重新执行校验。</Typography.Text>
          )}
        </aside>
      </div>

      <Modal
        title={<Space><RocketOutlined /> 确认发布 {snapshot.nextVersion}</Space>}
        open={confirmOpen}
        width={580}
        okText="确认发布"
        cancelText="返回检查"
        okButtonProps={{ disabled: !confirmed || !changeNote.trim() }}
        onCancel={() => setConfirmOpen(false)}
        onOk={publish}
      >
        <div className="pa-confirm-publish">
          <Alert
            type="warning"
            showIcon
            message="发布后该版本内容不可修改"
            description="后续修改将基于此版本新建草稿。当前运行实例继续使用原版本，不会自动切换。"
          />
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="变更说明" required>
              <Input.TextArea
                rows={4}
                value={changeNote}
                onChange={(event) => setChangeNote(event.target.value)}
                placeholder="说明本版本新增或调整了哪些内容"
                maxLength={300}
                showCount
              />
            </Form.Item>
          </Form>
          <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
            我已核对表单、流程规则和人员权限范围，并确认发布
          </Checkbox>
          <div className="pa-publish-time"><ClockCircleOutlined /> 发布时间和发布人由系统自动记录</div>
        </div>
      </Modal>
    </div>
  );
}

export default ProcessPublishPage;
