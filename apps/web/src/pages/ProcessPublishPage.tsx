import { ApartmentOutlined, ArrowRightOutlined, AuditOutlined, CheckCircleFilled, CheckCircleOutlined, FileTextOutlined, PlayCircleOutlined, RocketOutlined, SafetyCertificateOutlined, TeamOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Divider, Form, Input, Modal, Space, Tag, Typography, message } from "antd";
import { Fragment, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { ProcessWizardPreviousButton } from "../components/ProcessWizardNavigation";
import { ProcessWizardSteps } from "../components/ProcessWizardSteps";
import { StatusPill } from "../components/StatusPill";
import { resolveWorkflowGroupLabel, resolveWorkflowGroupLabels, useIdentityStore } from "../state/useIdentityStore";
import { getPublishedVersion, getVersionStatus, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { buildFlowLevels, conditionOperatorLabel, rejectionHandlingLabel, type StoredNodeEmailNotification } from "../utils/designerStorage";
import "./process-admin-pages.css";

export function ProcessPublishPage() {
  const navigate = useNavigate();
  const { definitionId = "" } = useParams<{ definitionId: string }>();
  const [searchParams] = useSearchParams();
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === definitionId));
  const versionId = searchParams.get("versionId") ?? definition?.versions[0]?.id ?? "";
  const version = definition?.versions.find((item) => item.id === versionId);
  const users = useIdentityStore((state) => state.users);
  const workflowGroups = useIdentityStore((state) => state.workflowGroups);
  const publishVersion = useProcessDefinitionStore((state) => state.publishVersion);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [changeNote, setChangeNote] = useState("");

  const approvalNodes = useMemo(() => version?.snapshot.flow.nodes.filter((node) => node.data?.kind === "approval") ?? [], [version]);
  const topologyLevels = useMemo(() => {
    const nodes = version?.snapshot.flow.nodes ?? [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return buildFlowLevels(nodes, version?.snapshot.flow.edges ?? []).map((level) =>
      level.flatMap((nodeId) => {
        const node = nodeById.get(nodeId);
        return node ? [node] : [];
      }),
    );
  }, [version]);
  const editableFieldLabels = useMemo(() => {
    const entries = (version?.snapshot.form.fields ?? []).flatMap((field) => {
      if (field.type === "table") {
        return (field.columns ?? []).map((column) => [`${field.id}.${column.id}`, `${field.label} / ${column.label}`] as const);
      }
      return [[field.id, field.label] as const];
    });
    return new Map(entries);
  }, [version]);
  const emailNotificationText = (notification?: StoredNodeEmailNotification) => {
    if (!notification?.enabled) return "不发送";
    const recipients = [
      notification.notifyReviewers ? "审核人" : "",
      notification.notifyInitiator ? "发起人" : "",
      ...(notification.extraUserIds ?? []).map((userId) => {
        const user = users.find((item) => item.id === userId);
        const email = user && "email" in user ? String(user.email ?? "").trim() : "";
        return user ? `${user.name}${email ? ` <${email}>` : "（未维护邮箱）"}` : userId;
      }),
    ].filter(Boolean);
    return recipients.length ? recipients.join("、") : "已启用，未配置收件人";
  };
  if (!definition || !version) return <Alert type="error" showIcon message="流程版本不存在" description="发布必须绑定到一个明确的正式版本。" action={<AppBackButton onClick={() => navigate("/admin/processes")} />} />;

  const status = getVersionStatus(definition, version.id);
  const current = getPublishedVersion(definition);
  const previousUrl = definition.type === "free" ? `/admin/processes/${definition.id}/form?versionId=${version.id}` : `/admin/processes/${definition.id}/flow?versionId=${version.id}`;
  const canPublish = version.validation.status === "通过" && status !== "已发布";
  const publish = async () => {
    if (!canPublish) return;
    setPublishing(true);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    const result = publishVersion(definition.id, version.id, changeNote.trim() || (current ? `从 ${current.version} 切换到 ${version.version}` : "首次发布"));
    setPublishing(false);
    if (!result) return message.error("发布失败：版本校验结果已经变化，请重新检查");
    const publishedDefinition = useProcessDefinitionStore.getState().definitions.find((item) => item.id === definition.id);
    if (publishedDefinition?.publishedVersionId !== version.id) {
      return message.error("发布状态未能确认，请返回版本记录后重试");
    }
    setConfirmOpen(false);
    message.success(`${version.version} 已发布并生效`);
    navigate(`/admin/processes/${definition.id}/versions`, { replace: true });
  };

  return <div className="page-stack pa-page">
    <Card className="pa-config-head" bordered={false}>
      <div className="pa-config-head__main"><AppBackButton onClick={() => navigate(`/admin/processes/${definition.id}/versions`)} /><div><Space size={10} wrap><Typography.Title level={3}>{version.basic.name}</Typography.Title><Tag color="blue">正式版本 {version.version}</Tag><StatusPill status={status} /></Space><Typography.Text type="secondary">{definition.code} · 发布确认</Typography.Text></div></div>
      <Space><ProcessWizardPreviousButton step={definition.type === "free" ? "初始表单" : "流程设计"} onClick={() => navigate(previousUrl)} /><Button type="primary" icon={<RocketOutlined />} disabled={!canPublish} onClick={() => setConfirmOpen(true)}>{status === "已发布" ? "当前已发布" : current ? "切换并发布" : "发布并生效"}</Button></Space>
    </Card>
    <Card className="pa-steps-card" bordered={false}><ProcessWizardSteps workflowType={definition.type} current={definition.type === "free" ? 2 : 3} /></Card>

    {status === "已发布" ? <Alert type="success" showIcon message={`${version.version} 当前已发布`} description="新发起实例使用该版本的完整快照；如需修改，没有实例时先取消发布，有实例时复制新建版本。" /> : <Alert type={version.validation.status === "通过" ? "success" : "error"} showIcon message={version.validation.status === "通过" ? `${version.version} 校验通过，可以发布` : `${version.version} 校验未通过，不能发布`} description={version.validation.issues.length ? version.validation.issues.join("；") : `最近校验：${version.validation.checkedAt}`} />}

    <div className="pa-publish-grid">
      <div className="pa-config-main">
        <Card className="pa-section-card" title={<span className="pa-card-title"><FileTextOutlined /> 版本完整快照</span>}>
          <Descriptions bordered size="small" column={2} items={[
            { key: "definition", label: "流程定义", children: `${definition.name}（${definition.code}）`, span: 2 },
            { key: "version", label: "目标版本", children: version.version },
            { key: "source", label: "来源版本", children: version.basedOn ?? "首次创建" },
            { key: "type", label: "流程类型", children: definition.type === "approval" ? "固定审批" : "自由协作" },
            { key: "prefix", label: "编号前缀", children: version.basic.instancePrefix || "—" },
            { key: "starter", label: "发起权限组", children: resolveWorkflowGroupLabels(workflowGroups, version.basic.starterGroups).join("、") || "—", span: 2 },
            { key: "closer", label: "关闭权限组", children: resolveWorkflowGroupLabels(workflowGroups, version.basic.closeGroups).join("、") || "—", span: 2 },
            ...(definition.type === "free" ? [{ key: "assignee", label: "审批/受理权限组", children: resolveWorkflowGroupLabels(workflowGroups, version.basic.assigneeGroups ?? []).join("、") || "—", span: 2 as const }] : []),
            { key: "form", label: "初始表单", children: "标题字段由系统固定，其余字段按版本配置", span: 2 },
            { key: "fields", label: "表单字段", children: `${version.snapshot.form.fields.length} 个` },
            { key: "system", label: "系统列表字段", children: `${version.snapshot.systemFields.length} 个配置` },
          ]} />
          <Divider>初始表单字段</Divider>
          <Space wrap>{version.snapshot.form.fields.length ? version.snapshot.form.fields.map((field) => <Tag key={field.id} color={field.displayCondition ? "cyan" : undefined} bordered={false}>{field.label}{field.displayCondition ? " · 条件显示" : ""}</Tag>) : <Typography.Text type="danger">尚未配置字段</Typography.Text>}</Space>
        </Card>

        {definition.type === "approval" ? <Card className="pa-section-card" title={<span className="pa-card-title"><ApartmentOutlined /> 审批拓扑与规则</span>}>
          {topologyLevels.length && topologyLevels.some((level) => level.length) ? <>
            <div className="pa-publish-topology" aria-label="审批拓扑">
              {topologyLevels.map((level, levelIndex) => {
                const approvalCount = level.filter((node) => node.data?.kind === "approval").length;
                const isParallel = approvalCount > 1;
                return <Fragment key={`level-${levelIndex}`}>
                  <section className={`pa-publish-stage${isParallel ? " is-parallel" : ""}`}>
                    <header className="pa-publish-stage__head">
                      <span>步骤 {levelIndex + 1}</span>
                      <Tag variant="filled" color={isParallel ? "blue" : "default"}>{isParallel ? `并行 · ${approvalCount} 个节点` : level[0]?.data?.kind === "start" ? "开始" : level[0]?.data?.kind === "end" ? "结束" : "顺序处理"}</Tag>
                    </header>
                    <div className="pa-publish-stage__nodes">
                      {level.map((node) => {
                        const kind = node.data?.kind ?? "approval";
                        const selectedFields = (node.data?.editableFields ?? []).map((fieldId) => editableFieldLabels.get(fieldId) ?? fieldId);
                        return <article key={node.id} className={`pa-publish-node is-${kind}`}>
                          <div className="pa-publish-node__title">
                            <span>{kind === "start" ? <PlayCircleOutlined /> : kind === "end" ? <CheckCircleOutlined /> : <AuditOutlined />}</span>
                            <strong>{node.data?.label || (kind === "approval" ? "未命名审批节点" : kind === "start" ? "开始" : "结束")}</strong>
                          </div>
                          {kind === "start" ? <div className="pa-publish-node__detail"><small>发起权限组</small><span>{resolveWorkflowGroupLabels(workflowGroups, node.data?.permissionGroups ?? []).join("、") || "未配置"}</span></div> : null}
                          {kind === "approval" ? <>
                            <div className="pa-publish-node__detail"><small>执行权限组</small><span>{node.data?.permissionGroup ? resolveWorkflowGroupLabel(workflowGroups, node.data.permissionGroup) : "未配置"}</span></div>
                            <div className="pa-publish-node__detail"><small>处理方式</small><span>{node.data?.handlingMode === "confirmation" ? "确认（只能确认，不能驳回）" : "审批（可通过或驳回）"}</span></div>
                            <div className="pa-publish-node__detail"><small>人员分配</small><span>{node.data?.specifyAssignee ? "发起时可指定；组内仍可代办" : "组内任一成员可处理"}</span></div>
                            <div className="pa-publish-node__detail"><small>可修改字段</small><span>{selectedFields.length ? selectedFields.join("、") : "不可修改表单内容"}</span></div>
                            <div className="pa-publish-node__detail"><small>重复修改</small><span>{node.data?.allowRepeatedEditing ? "允许处理结果提交后继续修改授权字段" : "不允许"}</span></div>
                            <div className="pa-publish-node__detail"><small>执行条件</small><span>{node.data?.activationCondition?.rules.length
                              ? node.data.activationCondition.rules.map((rule) => `${editableFieldLabels.get(rule.fieldId) ?? rule.fieldId} ${conditionOperatorLabel(rule.operator)} ${["empty", "not-empty"].includes(rule.operator) ? "" : String(rule.value ?? "")}`).join(node.data.activationCondition.mode === "all" ? " 且 " : " 或 ")
                              : "始终执行"}</span></div>
                            <div className="pa-publish-node__detail"><small>邮件通知</small><span>{emailNotificationText(node.data?.emailNotification)}</span></div>
                          </> : null}
                          {kind === "end" ? <><div className="pa-publish-node__detail"><small>完成条件</small><span>前序节点通过、确认或条件跳过</span></div><div className="pa-publish-node__detail"><small>邮件通知</small><span>{emailNotificationText(node.data?.emailNotification)}</span></div></> : null}
                        </article>;
                      })}
                    </div>
                  </section>
                  {levelIndex < topologyLevels.length - 1 ? <div className="pa-publish-stage__arrow" aria-hidden="true"><ArrowRightOutlined /><small>{level.length > 1 ? "全部完成" : "继续"}</small></div> : null}
                </Fragment>;
              })}
            </div>
            <div className="pa-publish-rules">
              <div><strong>流转规则</strong><span>{topologyLevels.some((level) => level.filter((node) => node.data?.kind === "approval").length > 1) ? "同层节点同时开始，全部通过或确认后进入下一步；审批节点任一驳回时取消本轮其他待办。" : "按连线顺序逐节点处理，当前节点通过或确认后进入下一步。"}</span></div>
              <div><strong>驳回处理</strong><span>{rejectionHandlingLabel(version.snapshot.flow.meta?.rejectionHandling)}：{version.snapshot.flow.meta?.rejectionHandling === "auto-close" ? "流程立即关闭。" : version.snapshot.flow.meta?.rejectionHandling === "resubmit-only" ? "发起方修改后可重新提交，所有审批重新开始。" : "发起方可修改后重新提交；关闭权限组也可直接关闭流程。"}</span></div>
              <div><strong>内容锁定</strong><span>首个审核结果提交前，发起方可修改；提交后锁定，驳回后重新开放修改。</span></div>
            </div>
          </> : <Alert type="error" showIcon message="尚未形成可预览的审批拓扑" description="请返回流程设计，配置开始、审批、结束节点并完成连线。" />}
        </Card> : <Card className="pa-section-card" title={<span className="pa-card-title"><TeamOutlined /> 自由协作规则</span>}><Alert type="info" showIcon message="不使用流程图" description={`受理人从 ${version.basic.assigneeGroups?.length ?? 0} 个流程权限组的有效成员中选择；每次回复后可继续指定下一位受理人，直到手动关闭。`} /></Card>}
      </div>

      <aside className="pa-config-aside">
        <Card className="pa-validation-card" title={<span className="pa-card-title"><SafetyCertificateOutlined /> 自动校验</span>}>
          <div className="pa-validation-score"><CheckCircleFilled /><strong>{version.validation.status}</strong><span>{version.validation.checkedAt}</span></div>
          <Divider />
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <div className="pa-scope-line"><span>基本信息</span><StatusPill compact status={version.basic.instancePrefix && version.basic.starterGroups.length && version.basic.closeGroups.length ? "已通过" : "失败"} /></div>
            <div className="pa-scope-line"><span>初始表单</span><StatusPill compact status={version.snapshot.form.fields.length ? "已通过" : "失败"} /></div>
            <div className="pa-scope-line"><span>{definition.type === "approval" ? "审批拓扑" : "受理范围"}</span><StatusPill compact status={definition.type === "approval" ? (approvalNodes.length ? "已通过" : "失败") : (version.basic.assigneeGroups?.length ? "已通过" : "失败")} /></div>
          </Space>
        </Card>
        <Card className="pa-help-card" bordered={false}><Typography.Title level={5}>发布影响</Typography.Title><ul><li>流程定义最多只有一个发布版本。</li><li>切换后新实例立即使用目标版本。</li><li>运行中实例继续锁定发起时版本。</li><li>历史版本及其完整快照不会被覆盖。</li></ul></Card>
      </aside>
    </div>

    <Modal title={current ? `切换发布版本：${current.version} → ${version.version}` : `发布 ${version.version}`} open={confirmOpen} confirmLoading={publishing} okText="确认发布" cancelText="取消" onCancel={() => setConfirmOpen(false)} onOk={() => void publish()}>
      <Alert type="warning" showIcon message="发布会立即影响新发起实例" description={current ? `原发布版本 ${current.version} 自动退出发布，已有实例不受影响。` : "符合发起权限的员工将看到此流程入口。"} />
      <Form layout="vertical" style={{ marginTop: 18 }}><Form.Item label="发布说明"><Input.TextArea value={changeNote} onChange={(event) => setChangeNote(event.target.value)} rows={3} maxLength={200} showCount placeholder="可选，说明本次发布或切换原因" /></Form.Item></Form>
    </Modal>
  </div>;
}

export default ProcessPublishPage;
