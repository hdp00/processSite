import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FilePdfOutlined,
  HistoryOutlined,
  LockOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SendOutlined,
  StopOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Cascader,
  Descriptions,
  Divider,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { StatusPill } from "../components/StatusPill";
import type { ReviewerProgress } from "../data/types";
import { isSuperAdminPersona, usePrototypeStore } from "../state/usePrototypeStore";
import { findIdentityUser } from "../state/useIdentityStore";
import { canUserCloseInstance, canUserProcessTask } from "../state/workflowAccess";
import { hasPersonaPermission } from "../state/rolePermissions";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import type { StoredDesignerField } from "../utils/designerStorage";

const reviewMeta: Record<ReviewerProgress["status"], { icon: React.ReactNode }> = {
  待审核: { icon: <HistoryOutlined /> },
  已通过: { icon: <CheckCircleFilled /> },
  已驳回: { icon: <CloseCircleFilled /> },
  已取消: { icon: <StopOutlined /> },
};

type PendingAction = "pass" | "reject" | null;

export function ProcessDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    instances,
    tasks,
    personaId,
    reviewInstance,
    closeInstance,
    updateUnreviewedInstance,
    republishInstance,
  } = usePrototypeStore();
  const instance = instances.find((item) => item.id === id);
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === instance?.definitionId));
  const lockedVersion = definition?.versions.find((version) => version.id === instance?.versionId);
  const persona = findIdentityUser(personaId);
  const isSuperAdmin = isSuperAdminPersona(personaId);
  const [comment, setComment] = useState("");
  const [documentLevel, setDocumentLevel] = useState(instance?.documentLevel ?? "受控文件");
  const [draftTitle, setDraftTitle] = useState(instance?.title ?? "");
  const [draftDocumentCode, setDraftDocumentCode] = useState(instance?.documentCode ?? "");
  const [draftDocumentType, setDraftDocumentType] = useState(instance?.documentType ?? "");
  const [draftDescription, setDraftDescription] = useState(instance?.description ?? "");
  const [draftPdfName, setDraftPdfName] = useState(instance?.pdfName ?? "");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [dynamicValues, setDynamicValues] = useState<Record<string, unknown>>(instance?.formValues ?? {});

  useEffect(() => {
    if (instance) {
      setDocumentLevel(instance.documentLevel);
      setDraftTitle(instance.title);
      setDraftDocumentCode(instance.documentCode);
      setDraftDocumentType(instance.documentType);
      setDraftDescription(instance.description);
      setDraftPdfName(instance.pdfName);
      setDynamicValues(structuredClone(instance.formValues ?? {}));
    }
  }, [instance?.id, instance?.documentLevel]);


  const currentTask = useMemo(() => tasks.find((task) =>
    task.instanceId === instance?.id && task.status === "待处理" && canUserProcessTask(personaId, task),
  ), [instance?.id, personaId, tasks]);
  const currentReviewer = useMemo(
    () => instance?.reviewers.find((reviewer) => reviewer.key === currentTask?.nodeId),
    [currentTask?.nodeId, instance],
  );
  const canReview = Boolean(
    instance?.status === "审核中" && currentReviewer?.status === "待审核" && currentTask,
  );
  const isSubstitute = Boolean(
    canReview && currentTask?.defaultAssigneeId && currentTask.defaultAssigneeId !== persona?.id,
  );
  const isDcc = Boolean(instance && canUserCloseInstance(personaId, instance));
  const canPrint = hasPersonaPermission(personaId, "work-list:打印");
  const hasReviewAction = Boolean(instance?.reviewers.some(
    (reviewer) => reviewer.status === "已通过" || reviewer.status === "已驳回",
  ));
  const canEditBeforeReview = Boolean(isDcc && instance?.status === "审核中" && !hasReviewAction);
  const canRepublish = isDcc && instance?.status === "驳回待处理";
  const canEditPublishedContent = canEditBeforeReview || canRepublish;
  const dynamicText = (keywords: string[], fallback: string) => {
    const field = lockedVersion?.snapshot.form.fields.find((item) => keywords.some((keyword) =>
      item.id.toLowerCase().includes(keyword.toLowerCase()) || item.label.includes(keyword),
    ));
    const value = field ? dynamicValues[field.id] : undefined;
    if (Array.isArray(value)) return value.join("、") || fallback;
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };

  if (!instance) {
    return (
      <Card className="empty-page-card">
        <Empty description="未找到流程实例" />
        <AppBackButton onClick={() => navigate("/processes")} />
      </Card>
    );
  }

  const openReviewConfirm = (action: Exclude<PendingAction, null>) => {
    if (action === "reject" && !comment.trim()) {
      message.warning("驳回时必须填写审核意见");
      return;
    }
    setPendingAction(action);
  };

  const confirmReview = () => {
    if (!pendingAction) return;
    reviewInstance(instance.id, pendingAction, comment.trim(), documentLevel, dynamicValues);
    message.success(pendingAction === "pass" ? "审核已通过" : "已驳回并通知文控处理");
    setPendingAction(null);
    setComment("");
  };

  const confirmClose = () => {
    if (!closeReason.trim()) {
      message.warning("请填写关闭说明");
      return;
    }
    closeInstance(instance.id, closeReason.trim());
    setCloseOpen(false);
    setCloseReason("");
    message.success("流程已关闭，未完成待办已取消");
  };

  const republish = () => {
    if (!draftTitle.trim()) {
      message.warning("请完善必填表单内容后再重新发布");
      return;
    }
    Modal.confirm({
      title: `确认重新发布并开启第 ${instance.round + 1} 轮审核？`,
      content: "当前表单修改和可选附件变更将一起发布，全部审批分支都会重新生成待办。",
      okText: "确认重新发布",
      cancelText: "取消",
      icon: <ReloadOutlined />,
      onOk: () => {
        republishInstance(instance.id, {
          title: dynamicText(["title", "标题"], draftTitle.trim()),
          documentCode: dynamicText(["documentCode", "文件编号", "报告编号"], draftDocumentCode.trim()),
          documentType: dynamicText(["documentType", "文件类型", "分类"], draftDocumentType),
          documentLevel,
          description: draftDescription.trim(),
          pdfName: draftPdfName,
          formValues: dynamicValues,
          attachmentNames: instance.attachmentNames,
        });
        message.success("流程已重新发布，全部分支待办已重新生成");
      },
    });
  };

  const saveBeforeReview = () => {
    if (!draftTitle.trim()) {
      message.warning("请完善必填表单内容后再保存");
      return;
    }
    updateUnreviewedInstance(instance.id, {
      title: dynamicText(["title", "标题"], draftTitle.trim()),
      documentCode: dynamicText(["documentCode", "文件编号", "报告编号"], draftDocumentCode.trim()),
      documentType: dynamicText(["documentType", "文件类型", "分类"], draftDocumentType),
      documentLevel,
      description: draftDescription.trim(),
      pdfName: draftPdfName,
      formValues: dynamicValues,
      attachmentNames: instance.attachmentNames,
    });
    message.success("修改已保存，本轮待办保持不变");
  };

  const changedLevel = documentLevel !== instance.documentLevel;
  const configuredFields = lockedVersion?.snapshot.form.fields ?? [];
  const editableFieldIds = new Set(
    lockedVersion?.snapshot.flow.nodes.find((node) => node.id === currentTask?.nodeId)?.data?.editableFields ?? [],
  );
  const displayDynamicValue = (value: unknown) => {
    if (Array.isArray(value)) return value.join("、") || "—";
    if (typeof value === "string") return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "—";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return value && typeof value === "object" ? "已填写" : "—";
  };
  const updateDynamicValue = (fieldId: string, value: unknown) =>
    setDynamicValues((current) => ({ ...current, [fieldId]: value }));
  const renderDynamicField = (field: StoredDesignerField) => {
    const value = dynamicValues[field.id];
    const editable = canEditPublishedContent || (canReview && editableFieldIds.has(field.id));
    if (field.type === "attachment") {
      const names = Array.isArray(value) ? value.map(String) : instance.attachmentNames ?? [];
      return <div className="field-block field-wide" key={field.id}><span>{field.label}</span><Space wrap>{names.length ? names.map((name) => <Tag key={name}>{name}</Tag>) : <Typography.Text type="secondary">无附件</Typography.Text>}</Space></div>;
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
      return <div className="field-block field-wide" key={field.id}><span>{field.label}</span><Table size="small" rowKey={(row) => String(row.key ?? rows.indexOf(row))} dataSource={rows} pagination={false} scroll={{ x: 680 }} columns={(field.columns ?? []).map((column) => ({ title: column.label, dataIndex: column.id, width: column.width ?? 150, render: (cell: unknown, row: Record<string, unknown>, rowIndex: number) => {
        const cellEditable = canEditPublishedContent || (canReview && editableFieldIds.has(`${field.id}.${column.id}`));
        return cellEditable ? <Input size="small" value={displayDynamicValue(cell) === "—" ? "" : displayDynamicValue(cell)} onChange={(event) => updateDynamicValue(field.id, rows.map((item, index) => index === rowIndex ? { ...row, [column.id]: event.target.value } : item))} /> : displayDynamicValue(cell);
      } }))} /><Typography.Text className="table-rule-note" type="secondary">审核节点只能修改授权单元格，不能新增或删除整行。</Typography.Text></div>;
    }
    if (!editable) return <div className="field-block" key={field.id}><span>{field.label}</span><strong>{displayDynamicValue(value)}</strong></div>;
    if (["select", "radio", "checkbox"].includes(field.type)) return <label className="field-block editable-field" key={field.id}><span>{field.label} {canReview && <em>本节点可修改</em>}</span><Select mode={field.type === "checkbox" ? "multiple" : undefined} value={value as string | string[]} onChange={(next) => updateDynamicValue(field.id, next)} options={(field.options ?? []).map((option) => ({ value: option, label: option }))} /></label>;
    return <label className={`field-block editable-field${field.type === "richtext" ? " field-wide" : ""}`} key={field.id}><span>{field.label} {canReview && <em>本节点可修改</em>}</span>{field.type === "richtext" ? <Input.TextArea value={String(value ?? "")} onChange={(event) => updateDynamicValue(field.id, event.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} /> : <Input value={String(value ?? "")} onChange={(event) => updateDynamicValue(field.id, event.target.value)} />}</label>;
  };

  return (
    <div className="page-stack detail-page">
      <div className="detail-topbar">
        <AppBackButton onClick={() => navigate(-1)} />
        <div className="detail-topbar-actions">
          {canPrint && <Button icon={<PrinterOutlined />} onClick={() => window.open(`/processes/${instance.id}/print`, "_blank", "noopener,noreferrer")}>打印为 PDF</Button>}
          {canEditBeforeReview && (
            <Button type="primary" icon={<EditOutlined />} onClick={saveBeforeReview}>保存修改</Button>
          )}
          {isDcc && instance.status === "驳回待处理" && (
            <Button type="primary" icon={<ReloadOutlined />} onClick={republish}>重新发布</Button>
          )}
          {isDcc && instance.status !== "已关闭" && (
            <Button danger icon={<CloseOutlined />} onClick={() => setCloseOpen(true)}>关闭流程</Button>
          )}
        </div>
      </div>

      <Card className="detail-hero">
        <div className="detail-hero-main">
          <div className="document-icon"><FilePdfOutlined /></div>
          <div>
            <div className="detail-title-row">
              <Typography.Title level={2}>{instance.title}</Typography.Title>
              <StatusPill status={instance.status} />
              {instance.priority === "紧急" && <Tag color="error">紧急</Tag>}
            </div>
            <Space split={<Divider type="vertical" />} wrap>
              <Typography.Text copyable>{instance.code}</Typography.Text>
              <span>{instance.template} · {instance.templateVersion}</span>
              <span>第 {instance.round} 轮</span>
              <span>发起人 {instance.initiator}</span>
              <span>{instance.createdAt}</span>
            </Space>
          </div>
        </div>
        <div className="detail-node-indicator">
          <small>当前节点</small>
          <strong>{instance.currentNode}</strong>
          <span>最近更新 {instance.updatedAt}</span>
        </div>
      </Card>

      {isSubstitute && (
        <Alert
          type="info"
          showIcon
          icon={<TeamOutlined />}
          message={isSuperAdmin ? `超级管理员正在处理“${currentReviewer?.shortGroup ?? "审批"}”待办` : `这是 ${findIdentityUser(currentTask?.defaultAssigneeId ?? "")?.name ?? "其他成员"} 的默认任务，你可以作为同组成员直接代办`}
          description={isSuperAdmin ? "这是系统级处理权限，不会把超级管理员加入该节点的流程权限组或人员名单；提交后仍记录实际处理人。" : "无需转交或填写代办原因；提交后系统会记录实际处理人为你，并通知默认责任人。"}
        />
      )}

      {canRepublish && (
        <Alert
          type="warning"
          showIcon
          message="流程已驳回，发布内容现已解锁"
          description="你可以修改表单，并按需更换附件；确认重新发布后将开启新一轮，全部审批分支重新审核。"
        />
      )}

      {canEditBeforeReview && (
        <Alert
          type="success"
          showIcon
          icon={<EditOutlined />}
          message="本轮尚无人提交审核，发布内容可以修改"
          description="保存修改不会创建新轮次，也不会重新生成待办；任一审批人提交结果后，内容将立即锁定。"
        />
      )}

      {isDcc && instance.status === "审核中" && hasReviewAction && (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="本轮已有审核结果，发布内容已锁定"
          description="发布方不能再修改表单或附件；如果本轮被驳回，内容会重新开放编辑。"
        />
      )}

      <Card className="progress-card" title="流程进度" extra={<Tag bordered={false}>按实例锁定版本的拓扑推进</Tag>}>
        <div className="parallel-flow">
          <div className="flow-endpoint done"><CheckOutlined /><span>开始<small>{instance.createdAt.slice(5, 16)}</small></span></div>
          <div className="flow-connector"><span /></div>
          <div className="parallel-branch-wrap">
            <div className="parallel-label"><ApartmentBadge />审批节点</div>
            <div className="parallel-branches">
              {instance.reviewers.map((reviewer) => (
                <div className={`branch-card status-${reviewer.status}`} key={reviewer.key}>
                  <div className="branch-card-top">
                    <span className="branch-icon">{reviewMeta[reviewer.status].icon}</span>
                    <StatusPill status={reviewer.status} />
                  </div>
                  <strong>{reviewer.shortGroup}</strong>
                  <Tooltip title={reviewer.group}><small>{reviewer.group}</small></Tooltip>
                  <div className="branch-person"><UserOutlined /> 默认：{findIdentityUser(tasks.find((task) => task.instanceId === instance.id && task.nodeId === reviewer.key && task.round === instance.round)?.defaultAssigneeId ?? "")?.name ?? "组内共享"}</div>
                  {reviewer.actionAt && <div className="branch-action">实际：{reviewer.name}{reviewer.substitute && <Tag color="purple">代办</Tag>}</div>}
                </div>
              ))}
            </div>
          </div>
          <div className="flow-connector"><span /></div>
          <div className={instance.status === "已完成" ? "flow-endpoint done" : "flow-endpoint"}><CheckOutlined /><span>结束<small>{instance.status === "已完成" ? instance.updatedAt.slice(5, 16) : "等待全部通过"}</small></span></div>
        </div>
      </Card>

      <div className="detail-workspace">
        <Card
          className="pdf-card"
          title={<Space><FilePdfOutlined className="pdf-red" />流程附件<Tag>{instance.attachmentNames?.length ?? (instance.pdfName === "无附件" ? 0 : 1)} 个</Tag></Space>}
          extra={canEditPublishedContent ? <Upload showUploadList={false} beforeUpload={(file) => { setDraftPdfName(file.name); message.success(canRepublish ? "附件已暂存，将在重新发布时一并提交" : "附件已暂存，请保存修改"); return false; }}><Button type="text" icon={<UploadOutlined />}>更换附件（可选）</Button></Upload> : null}
        >
          <Alert type="info" showIcon message="附件内容不属于动态表单数据" description="原型仅展示受控附件名称；下载和 PDF 页面预览在正式后端接入文件服务后按同一实例权限校验。" />
          <div className="detail-attachment-list">
            {(instance.attachmentNames?.length ? instance.attachmentNames : instance.pdfName === "无附件" ? [] : [draftPdfName]).map((name) => <div key={name}><FilePdfOutlined /><strong>{name}</strong><Button type="link" icon={<DownloadOutlined />} onClick={() => message.info("原型：已触发受控下载")}>下载</Button></div>)}
          </div>
        </Card>

        <div className="form-review-column">
          <Card
            className="form-card"
            title={<span>流程表单 <Tag bordered={false}>动态表单</Tag></span>}
            extra={canRepublish
              ? <Tag color="orange" icon={<EditOutlined />}>驳回后可修改</Tag>
              : canEditBeforeReview
                ? <Tag color="green" icon={<EditOutlined />}>首人审核前可修改</Tag>
              : canReview
                ? <Tag color="gold" icon={<EditOutlined />}>2 项本节点可修改</Tag>
                : <Tag icon={<LockOutlined />}>只读</Tag>}
          >
            {configuredFields.length ? <div className="form-field-grid">{configuredFields.map(renderDynamicField)}</div> : <Descriptions bordered size="small" column={1} items={[{ key: "title", label: "标题", children: instance.title }, { key: "description", label: "说明", children: instance.description }]} />}
          </Card>

          {canReview && (
            <Card className="approval-card" title={isSuperAdmin ? `超级管理员审核 · ${currentReviewer?.shortGroup ?? "节点"}` : isSubstitute ? "代办审核" : `${currentReviewer?.shortGroup ?? "节点"}处理`}>
              <label className="field-block">
                <span>审核意见 <em className="required-hint">驳回时必填</em></span>
                <Input.TextArea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="填写审核意见；通过时可选，驳回时必填"
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  maxLength={500}
                  showCount
                />
              </label>
              <div className="approval-actions">
                <Button danger size="large" icon={<CloseOutlined />} onClick={() => openReviewConfirm("reject")}>驳回</Button>
                <Button type="primary" size="large" icon={<CheckOutlined />} onClick={() => openReviewConfirm("pass")}>通过并提交</Button>
              </div>
            </Card>
          )}

          {!canReview && instance.status === "审核中" && (
            !isDcc && <Alert message="当前以只读方式查看" description="你没有此待办的处理权限，或该节点已由其他成员完成。" type="info" showIcon />
          )}
        </div>
      </div>

      <Card title="流转记录" extra={<Tag bordered={false}>按轮次留痕</Tag>}>
        <Timeline
          items={[
            {
              color: "blue",
              children: <HistoryItem title={`第 ${instance.round} 轮发起`} person={`${instance.initiator} · ${instance.department}`} time={instance.createdAt} detail={`上传 ${instance.pdfName}`} />,
            },
            ...instance.reviewers
              .filter((reviewer) => reviewer.actionAt)
              .map((reviewer) => ({
                color: reviewer.status === "已通过" ? "green" : "red",
                children: <HistoryItem title={`${reviewer.shortGroup} · ${reviewer.status}`} person={`实际处理人 ${reviewer.name}${reviewer.substitute ? "（代办）" : ""}`} time={reviewer.actionAt ?? ""} detail={reviewer.comment ?? "未填写意见"} />,
              })),
          ]}
        />
      </Card>

      <Modal
        open={Boolean(pendingAction)}
        title={pendingAction === "pass" ? "确认通过本节点？" : "确认驳回本轮审核？"}
        okText={pendingAction === "pass" ? "确认通过" : "确认驳回"}
        okButtonProps={{ danger: pendingAction === "reject" }}
        cancelText="返回检查"
        onOk={confirmReview}
        onCancel={() => setPendingAction(null)}
      >
        <div className="confirm-summary">
          <p>{pendingAction === "pass" ? "审核结果和表单修改将一次性提交。" : "其他未完成的并行任务会立即取消，并通知文控重新处理。"}</p>
          {changedLevel && <div><span>文件密级</span><del>{instance.documentLevel}</del><b>→</b><ins>{documentLevel}</ins></div>}
          <div><span>审核意见</span><strong>{comment.trim() || "未填写（通过时允许）"}</strong></div>
          {isSubstitute && <Tag color="purple">将记录为代办：默认 {findIdentityUser(currentTask?.defaultAssigneeId ?? "")?.name} / 实际 {persona?.name}</Tag>}
        </div>
      </Modal>

      <Modal open={closeOpen} title="关闭流程" okText="确认关闭" okButtonProps={{ danger: true }} cancelText="取消" onOk={confirmClose} onCancel={() => setCloseOpen(false)}>
        <Alert type="warning" showIcon message="关闭后不可恢复，所有未完成待办将被取消。" />
        <label className="field-block modal-field"><span>关闭说明 <em className="required-hint">必填</em></span><Input.TextArea value={closeReason} onChange={(event) => setCloseReason(event.target.value)} placeholder="请说明关闭原因" rows={3} /></label>
      </Modal>
    </div>
  );
}

function ApartmentBadge() {
  return <span className="parallel-badge"><TeamOutlined /></span>;
}

function HistoryItem({ title, person, time, detail }: { title: string; person: string; time: string; detail: string }) {
  return (
    <div className="history-item">
      <div><strong>{title}</strong><span>{time}</span></div>
      <small>{person}</small>
      <p>{detail}</p>
    </div>
  );
}
