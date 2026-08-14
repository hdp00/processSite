import {
  ApartmentOutlined,
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
  Tag,
  Typography,
  message,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ProcessWizardPreviousButton } from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { getEffectiveVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import {
  buildFlowLevels,
  getReviewEditableFieldOptions,
  readFlowDesignerSnapshot,
  rejectionHandlingLabel,
  type StoredFlowNodeSnapshot,
} from "../utils/designerStorage";
import { formatInstanceNumber } from "../utils/instanceNumber";
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
  instancePrefix: string;
  type: "approval" | "free";
  currentVersion: string;
  nextVersion: string;
  description: string;
  starterGroups: string[];
  assigneeGroups?: string[];
  extraScope: string[];
  fields: Array<{ name: string; type: string; required?: boolean; list?: boolean }>;
  rejectionHandling?: string;
}

const publishDataById: Record<string, PublishSnapshot> = {
  "pdf-review": {
    name: "PDF 文件审核",
    code: "PROC-PDF-001",
    instancePrefix: "DOC",
    type: "approval",
    currentVersion: "V3",
    nextVersion: "V4",
    description: "受控 PDF 文件由研发、质量、生产并行审核。",
    starterGroups: ["PDF审核_文控_流程权限组"],
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
    instancePrefix: "DOC",
    type: "approval",
    currentVersion: "尚未发布",
    nextVersion: "V1",
    description: "用于研发测试报告的会签、确认和正式发布。",
    starterGroups: ["测试报告_发起_流程权限组"],
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
    instancePrefix: "ISSUE",
    type: "free",
    currentVersion: "V2",
    nextVersion: "V3",
    description: "当前受理人处理后指定下一位受理人，直至手动关闭。",
    starterGroups: ["自由协作_发起_流程权限组"],
    assigneeGroups: ["自由协作_受理_流程权限组"],
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

const emptyPublishSnapshot: PublishSnapshot = {
  name: "流程不存在",
  code: "—",
  instancePrefix: "",
  type: "approval",
  currentVersion: "尚未发布",
  nextVersion: "V1",
  description: "",
  starterGroups: [],
  extraScope: [],
  fields: [],
};

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
    ?? "";
  const definition = useProcessDefinitionStore((state) =>
    state.definitions.find((item) => item.id === resolvedId),
  );
  const isWithdrawnDraft = Boolean(definition?.draft?.withdrawnVersionId);
  const remainsDisabledAfterPublish = definition?.draft?.withdrawnVersionId
    ? Boolean(definition.draft.withdrawnWasDisabled)
    : Boolean(definition?.disabled);
  const publishDraft = useProcessDefinitionStore((state) => state.publishDraft);
  const fallbackSnapshot = publishDataById[resolvedId] ?? emptyPublishSnapshot;
  const snapshot = useMemo<PublishSnapshot>(() => {
    const effectiveVersion = getEffectiveVersion(definition);
    const config = definition?.draft?.basic ?? effectiveVersion?.basic;
    if (!definition || !config) return fallbackSnapshot;
    return {
      name: config.name,
      code: config.code,
      instancePrefix: config.instancePrefix ?? "",
      type: config.type,
      currentVersion: effectiveVersion?.version
        ?? (definition.draft?.withdrawnVersionId ? definition.draft.version : "尚未发布"),
      nextVersion: definition.draft?.version ?? effectiveVersion?.version ?? "V1",
      description: config.description,
      starterGroups: config.starterGroups,
      assigneeGroups: config.assigneeGroups,
      extraScope: [...config.visibleRoles, ...config.visibleUsers],
      fields: readFormFields(resolvedId, fallbackSnapshot.fields),
      rejectionHandling: rejectionHandlingLabel(readFlowDesignerSnapshot(resolvedId)?.meta?.rejectionHandling)
        || fallbackSnapshot.rejectionHandling
        || "重新发布或关闭",
    };
  }, [definition, fallbackSnapshot, resolvedId]);
  const flowSnapshot = useMemo(() => readFlowDesignerSnapshot(resolvedId), [resolvedId]);
  const editableFieldLabelByValue = useMemo(
    () => new Map(getReviewEditableFieldOptions(resolvedId).map((option) => [option.value, option.label])),
    [resolvedId],
  );
  const flowNodes = useMemo(
    () => flowSnapshot?.nodes.filter((node) => node.data?.kind && node.data.label) ?? [],
    [flowSnapshot],
  );
  const flowLevels = useMemo(() => {
    if (!flowSnapshot || !flowNodes.length) return [];
    const nodeById = new Map(flowNodes.map((node) => [node.id, node]));
    return buildFlowLevels(flowNodes, flowSnapshot.edges)
      .map((ids) => ids.map((id) => nodeById.get(id)).filter((node): node is StoredFlowNodeSnapshot => Boolean(node)))
      .filter((level) => level.length);
  }, [flowNodes, flowSnapshot]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [validating, setValidating] = useState(false);
  const [published, setPublished] = useState(false);
  const [publishedMode, setPublishedMode] = useState<"new" | "same">();
  const sameVersionMode = isWithdrawnDraft || publishedMode === "same";

  const validationItems = useMemo<ValidationItem[]>(() => {
    const draft = definition?.draft;
    const hasForm = published || Boolean(draft?.formConfigured && snapshot.fields.length);
    const hasStarter = published || Boolean(draft?.basic.starterGroups.length);
    const hasInstancePrefix = published || Boolean(draft?.basic.instancePrefix?.trim());
    const common: ValidationItem[] = [
      { key: "basic", title: "基本信息完整", detail: "流程名称、定义编号、说明和流程类型均已设置。", level: "pass" },
      {
        key: "instance-number",
        title: hasInstancePrefix ? "实例编号规则有效" : "缺少实例编号前缀",
        detail: hasInstancePrefix
          ? `新实例按“${snapshot.instancePrefix} + 两位年份 + 两位月份 + 四位月序号”生成；相同前缀跨流程共享序列。`
          : "请返回基本信息填写实例编号前缀，否则不能发布。",
        level: hasInstancePrefix ? "pass" : "block",
      },
      { key: "form", title: "初始表单有效", detail: hasForm ? `${snapshot.fields.length} 个字段已完成配置，必填项和列表字段规则有效。` : "请返回初始表单步骤，至少配置并保存一个字段。", level: hasForm ? "pass" : "block" },
      { key: "starter", title: "发起权限有效", detail: hasStarter ? `已关联 ${snapshot.starterGroups.length} 个发起流程权限组，任一组的当前有效成员均可发起。` : "请返回基本信息选择至少一个发起流程权限组。", level: hasStarter ? "pass" : "block" },
    ];

    if (snapshot.type === "free") {
      const hasAssignee = published || Boolean(draft?.basic.assigneeGroups?.length);
      return [
        ...common,
        { key: "assignee", title: "受理范围有效", detail: hasAssignee ? `已关联 ${snapshot.assigneeGroups?.length ?? 0} 个受理流程权限组，候选受理人按有效成员并集搜索。` : "请返回基本信息至少选择一个受理流程权限组。", level: hasAssignee ? "pass" : "block" },
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
          ? `已保存 ${flowNodes.length || draft?.nodeCount || getEffectiveVersion(definition)?.nodeCount || 0} 个流程节点，拓扑结构已通过设计器检查。`
          : "请返回流程设计器完成节点、权限组和连线配置。",
        level: published || draft?.flowConfigured ? "pass" : "block",
      },
      { key: "editable", title: "并行字段权限无冲突", detail: "审批节点的可修改字段来自当前初始表单，且并行路径之间没有重复授权。", level: "pass" },
      { key: "notice", title: "通知模板沿用系统默认值", detail: "尚未配置专属通知文案，将使用统一的待办与站内通知模板。", level: "warning" },
    ];
  }, [definition, flowNodes.length, published, snapshot]);

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
    const publishingSameVersion = isWithdrawnDraft;
    setConfirmOpen(false);
    const released = publishDraft(resolvedId, changeNote.trim());
    if (!released) {
      message.error("当前流程没有可发布的草稿，请返回流程管理重新进入编辑");
      return;
    }
    setPublished(true);
    setPublishedMode(publishingSameVersion ? "same" : "new");
    message.success(`${snapshot.name} ${snapshot.nextVersion} 已${publishingSameVersion ? "重新" : ""}发布并生效${publishingSameVersion ? "，版本号保持不变" : "，其他发布版本已自动失效"}${remainsDisabledAfterPublish ? "；流程仍保持停用" : ""}`);
  };

  return (
    <div className="page-stack pa-page pa-publish-page">
      <Card className="pa-config-head" bordered={false}>
        <div className="pa-config-head__main">
          <div>
            <Space size={10} wrap>
              <Typography.Title level={3}>发布并生效</Typography.Title>
              <Tag color={snapshot.type === "approval" ? "blue" : "purple"}>{snapshot.type === "approval" ? "固定审批" : "自由协作"}</Tag>
            </Space>
            <Typography.Text type="secondary">{sameVersionMode
              ? "发布前检查撤回后的完整快照和权限配置；重新发布后恢复生效，版本号保持不变。"
              : "发布前检查完整快照和权限配置；发布后本版本生效，原生效版本自动失效。"}</Typography.Text>
          </div>
        </div>
        <div className="pa-config-head__actions">
          <ProcessWizardPreviousButton
            step={snapshot.type === "approval" ? "流程设计" : "初始表单"}
            onClick={() => navigate(`/admin/processes/${resolvedId}/${snapshot.type === "approval" ? "flow" : "form"}`)}
          />
          <Button loading={validating} icon={<ReloadOutlined />} onClick={rerunValidation}>重新校验</Button>
        </div>
      </Card>

      <Card className="pa-steps-card" bordered={false}>
        <ProcessWizardSteps workflowType={snapshot.type} current={snapshot.type === "approval" ? 3 : 2} />
      </Card>

      {published && (
        <Alert
          className="pa-page-alert"
          type="success"
          showIcon
          message={`${snapshot.nextVersion} 已成功发布`}
          description={remainsDisabledAfterPublish
            ? "完整版本快照已生成并恢复生效；流程仍保持停用，不会开放新发起。"
            : sameVersionMode
              ? "流程已恢复发起，版本号保持不变；首次发布时间和本次发布时间均已保留。"
              : "新发起流程将使用本版本；运行中的流程继续按其发起时版本执行。"}
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
                { key: "code", label: "流程定义编号", children: snapshot.code },
                {
                  key: "instanceNumber",
                  label: "实例编号规则",
                  children: <Space wrap><Tag color="blue">前缀 {snapshot.instancePrefix || "未配置"}</Tag><span>{snapshot.instancePrefix ? formatInstanceNumber(snapshot.instancePrefix, 1) : "—"}</span><Typography.Text type="secondary">同前缀跨流程共享月序列</Typography.Text></Space>,
                  span: 2,
                },
                { key: "version", label: "发布版本", children: sameVersionMode
                  ? <Space><Tag color="blue">{snapshot.nextVersion}</Tag><Typography.Text type="secondary">重新发布，版本号不变</Typography.Text></Space>
                  : <Space><span className="pa-muted">{snapshot.currentVersion}</span><span>→</span><Tag color="blue">{snapshot.nextVersion}</Tag></Space> },
                { key: "type", label: "流程类型", children: snapshot.type === "approval" ? "固定审批" : "自由协作" },
                { key: "starter", label: "发起流程权限组", children: <Space size={[4, 6]} wrap>{snapshot.starterGroups.length ? snapshot.starterGroups.map((group) => <Tag key={group}>{group}</Tag>) : <span className="pa-muted">尚未选择</span>}</Space>, span: 2 },
                ...(snapshot.assigneeGroups?.length ? [{ key: "assignee", label: "受理流程权限组", children: <Space size={[4, 6]} wrap>{snapshot.assigneeGroups.map((group) => <Tag key={group}>{group}</Tag>)}</Space>, span: 2 as const }] : []),
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
              {flowLevels.length ? (
                <div className="pa-topology-dynamic" aria-label="审批流程拓扑预览">
                  {flowLevels.map((level, levelIndex) => (
                    <div className="pa-topology-stage" key={level.map((node) => node.id).join("-")}>
                      <div className="pa-topology-stage__nodes">
                        {level.map((node) => {
                          const groups = node.data?.kind === "start"
                            ? node.data.permissionGroups ?? []
                            : node.data?.permissionGroup ? [node.data.permissionGroup] : [];
                          return (
                            <div className={`pa-topology-node is-${node.data?.kind}`} key={node.id}>
                              <small>{node.data?.kind === "start" ? "开始" : node.data?.kind === "end" ? "结束" : "审批"}</small>
                              <strong>{node.data?.label}</strong>
                              <span>{groups.length ? groups.join("、") : node.data?.kind === "end" ? "全部前置通过" : "尚未配置权限组"}</span>
                              {node.data?.kind === "approval" && (
                                <span>
                                  可修改：{node.data.editableFields?.length
                                    ? node.data.editableFields.map((field) => editableFieldLabelByValue.get(field) ?? field).join("、")
                                    : "无"}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {levelIndex < flowLevels.length - 1 && <span className="pa-topology-stage__arrow">→</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <Alert type="warning" showIcon message="尚未读取到流程设计快照" description="请返回流程设计器保存当前节点与连线后再发布。" />
              )}
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
          <Card className="pa-validation-card" title={<span className="pa-card-title"><SafetyCertificateOutlined /> 发布前检查</span>}>
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
              <strong>唯一生效版本</strong>
              <Typography.Text type="secondary">{sameVersionMode
                ? "重新发布后当前版本恢复为唯一生效版本，版本号保持不变；撤回前若已停用，发布后仍保持停用。"
                : "发布后本版本成为唯一生效版本；已有实例仍锁定原版本，停用流程不会自动启用。"}</Typography.Text>
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
            {published ? `${snapshot.nextVersion} 已生效` : `发布并生效 ${snapshot.nextVersion}`}
          </Button>
          {blockCount > 0 && (
            <Typography.Text className="pa-block-hint" type="danger">请先处理所有阻断项，再重新执行校验。</Typography.Text>
          )}
        </aside>
      </div>

      <Modal
        title={<Space><RocketOutlined /> 确认发布并生效 {snapshot.nextVersion}</Space>}
        open={confirmOpen}
        width={580}
        okText="确认发布并生效"
        cancelText="返回检查"
        okButtonProps={{ disabled: !confirmed || !changeNote.trim() }}
        onCancel={() => setConfirmOpen(false)}
        onOk={publish}
      >
        <div className="pa-confirm-publish">
          <Alert
            type="warning"
            showIcon
            message={sameVersionMode ? `将重新发布 ${snapshot.nextVersion}` : "发布后该版本内容不可修改"}
            description={sameVersionMode
              ? "本次发布替换撤回前的同版本快照，版本号不变，并同时保留首次发布时间和最近发布时间；撤回前若已停用，发布不会自动启用。"
              : "后续修改将基于此完整快照新建草稿。原生效版本自动失效，当前运行实例继续使用原版本；若流程已停用，发布不会自动启用。"}
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
