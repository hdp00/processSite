import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LockOutlined,
  PaperClipOutlined,
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
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
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
  已确认: { icon: <CheckCircleFilled /> },
  已驳回: { icon: <CloseCircleFilled /> },
  已取消: { icon: <StopOutlined /> },
  已跳过: { icon: <StopOutlined /> },
};

const configuredAttachmentNames = (
  fields: StoredDesignerField[],
  values: Record<string, unknown>,
) => fields
  .filter((field) => field.type === "attachment")
  .flatMap((field) => {
    const value = values[field.id];
    return Array.isArray(value) ? value.map(String) : [];
  })
  .filter((name) => name.trim() && !["无附件", "—"].includes(name));

type PendingAction = "pass" | "confirm" | "reject" | null;

export function ProcessDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    instances,
    tasks,
    personaId,
    reviewInstance,
    reviseCompletedTask,
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
  const [repeatTaskId, setRepeatTaskId] = useState<string>();
  const [repeatComment, setRepeatComment] = useState("");

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
  }, [
    instance?.attachmentNames,
    instance?.description,
    instance?.documentCode,
    instance?.documentLevel,
    instance?.documentType,
    instance?.formValues,
    instance?.id,
    instance?.pdfName,
    instance?.title,
  ]);


  const currentTask = useMemo(() => tasks.find((task) =>
    task.instanceId === instance?.id && task.status === "待处理" && canUserProcessTask(personaId, task),
  ), [instance?.id, personaId, tasks]);
  const currentReviewer = useMemo(
    () => instance?.reviewers.find((reviewer) => reviewer.key === currentTask?.nodeId),
    [currentTask?.nodeId, instance],
  );
  const currentNodeConfig = lockedVersion?.snapshot.flow.nodes.find((node) => node.id === currentTask?.nodeId)?.data;
  const isConfirmationTask = (currentNodeConfig?.handlingMode ?? "approval") === "confirmation";
  const canReview = Boolean(
    instance?.status === "审核中" && currentReviewer?.status === "待审核" && currentTask,
  );
  const canReject = canReview && !isConfirmationTask && hasPersonaPermission(personaId, "work-task:驳回");
  const isSubstitute = Boolean(
    canReview && currentTask?.defaultAssigneeId && currentTask.defaultAssigneeId !== persona?.id,
  );
  const isDcc = Boolean(instance && canUserCloseInstance(personaId, instance));
  const canPrint = hasPersonaPermission(personaId, "work-list:打印");
  const hasReviewAction = Boolean(instance?.reviewers.some(
    (reviewer) => reviewer.status === "已通过" || reviewer.status === "已确认" || reviewer.status === "已驳回",
  ));
  const repeatCandidates = useMemo(() => {
    if (!instance || !lockedVersion || instance.status === "驳回待处理" || instance.status === "已关闭" || !hasPersonaPermission(personaId, "work-task:审核")) return [];
    return tasks.filter((task) => {
      const node = lockedVersion.snapshot.flow.nodes.find((item) => item.id === task.nodeId)?.data;
      return task.instanceId === instance.id && task.round === instance.round && task.status === "已完成"
        && (task.action === "通过" || task.action === "确认") && Boolean(node?.allowRepeatedEditing && node.editableFields?.length)
        && (isSuperAdmin || task.completedById === personaId);
    });
  }, [instance, isSuperAdmin, lockedVersion, personaId, tasks]);
  const repeatTask = repeatCandidates.find((task) => task.id === repeatTaskId);
  const repeatNodeConfig = lockedVersion?.snapshot.flow.nodes.find((node) => node.id === repeatTask?.nodeId)?.data;
  const canEditBeforeReview = Boolean(isDcc && instance?.status === "审核中" && !hasReviewAction);
  const canRepublish = isDcc && instance?.status === "驳回待处理";
  const canEditPublishedContent = canEditBeforeReview || canRepublish;
  const editableContentDirty = Boolean(instance && (
    documentLevel !== instance.documentLevel
    || draftTitle !== instance.title
    || draftDocumentCode !== instance.documentCode
    || draftDocumentType !== instance.documentType
    || draftDescription !== instance.description
    || draftPdfName !== instance.pdfName
    || JSON.stringify(dynamicValues) !== JSON.stringify(instance.formValues ?? {})
  ));
  const { guard, allowNextNavigation } = useUnsavedChangesGuard({
    dirty: Boolean(comment.trim() || closeReason.trim() || repeatComment.trim() || ((canEditPublishedContent || repeatTask) && editableContentDirty)),
    title: "当前流程有未提交修改",
    description: "离开后，尚未保存的表单修改、审核意见或关闭说明将丢失。",
  });
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

  const attachmentFields = (lockedVersion?.snapshot.form.fields ?? []).filter((field) => field.type === "attachment");
  const hasConfiguredAttachmentField = attachmentFields.length > 0;
  const hasDynamicAttachmentValues = attachmentFields.some((field) => Object.prototype.hasOwnProperty.call(dynamicValues, field.id));
  const dynamicAttachmentNames = configuredAttachmentNames(attachmentFields, dynamicValues);
  const attachmentNames = hasConfiguredAttachmentField ? Array.from(new Set((hasDynamicAttachmentValues
    ? dynamicAttachmentNames
    : [
        ...(instance.attachmentNames ?? []),
        ...(!instance.attachmentNames?.length && draftPdfName && !["无附件", "—"].includes(draftPdfName) ? [draftPdfName] : []),
      ]).filter(Boolean))) : [];
  const hasAttachments = attachmentNames.length > 0;

  const openReviewConfirm = (action: Exclude<PendingAction, null>) => {
    if (action === "reject" && !comment.trim()) {
      message.warning("驳回时必须填写审核意见");
      return;
    }
    if (action === "pass" || action === "confirm") {
      const missing = configuredFields.filter((field) => field.inputStage === "reviewer" && field.required && editableFieldIds.has(field.id)).filter((field) => {
        const value = dynamicValues[field.id] ?? field.defaultValue;
        if (field.type === "table") {
          const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
          return !rows.length || rows.some((row) => (field.columns ?? []).some((column) => column.required && (row[column.id] === undefined || row[column.id] === "" || (Array.isArray(row[column.id]) && !(row[column.id] as unknown[]).length))));
        }
        return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      });
      if (missing.length) {
        message.warning(`请先填写本节点负责的必填字段：${missing.map((field) => field.label).join("、")}`);
        return;
      }
    }
    setPendingAction(action);
  };

  const confirmReview = () => {
    if (!pendingAction) return;
    const saved = reviewInstance(instance.id, pendingAction, comment.trim(), documentLevel, dynamicValues);
    if (!saved) {
      message.error("提交失败：任务状态、节点处理方式或操作权限已发生变化");
      setPendingAction(null);
      return;
    }
    message.success(pendingAction === "pass" ? "审核已通过" : pendingAction === "confirm" ? "本节点已确认" : "已驳回，等待发起方处理");
    setPendingAction(null);
    setComment("");
    allowNextNavigation();
    navigate("/tasks");
  };

  const beginRepeatEditing = (taskId: string) => {
    setRepeatTaskId(taskId);
    setRepeatComment("");
    setDynamicValues(structuredClone(instance.formValues ?? {}));
    message.info("已进入继续修改模式，只能编辑该节点授权字段");
  };

  const cancelRepeatEditing = () => {
    setRepeatTaskId(undefined);
    setRepeatComment("");
    setDynamicValues(structuredClone(instance.formValues ?? {}));
  };

  const saveRepeatEditing = () => {
    if (!repeatTask) return;
    const result = reviseCompletedTask(instance.id, repeatTask.id, dynamicValues, repeatComment);
    if (result === "forbidden") {
      message.error("保存失败：流程状态或修改权限已发生变化");
      return;
    }
    if (result === "no-changes") {
      message.info("没有检测到授权字段变化");
      return;
    }
    setRepeatTaskId(undefined);
    setRepeatComment("");
    message.success("字段修改已保存，原审核结果保持不变");
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
      message.warning("请完善必填表单内容后再重新提交");
      return;
    }
    Modal.confirm({
      title: `确认重新提交并开启第 ${instance.round + 1} 轮审核？`,
      content: hasAttachments
        ? "当前表单修改和附件变更将一起提交，全部审批分支都会重新生成待办。"
        : "当前表单修改将一起提交，全部审批分支都会重新生成待办。",
      okText: "确认重新提交",
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
          attachmentNames,
        });
        message.success("流程已重新提交，全部分支待办已重新生成");
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
      attachmentNames,
    });
    message.success("修改已保存，尚未处理的条件节点已重新计算");
  };

  const changedLevel = documentLevel !== instance.documentLevel;
  const configuredFields = lockedVersion?.snapshot.form.fields ?? [];
  const editableFieldIds = new Set(
    (repeatTask ? repeatNodeConfig : currentNodeConfig)?.editableFields ?? [],
  );
  const displayDynamicValue = (value: unknown, field?: StoredDesignerField) => {
    const resolved = value === undefined || value === null || value === "" ? field?.defaultValue ?? value : value;
    const emptyText = field?.inputStage === "reviewer" ? "" : "—";
    if (Array.isArray(resolved)) return resolved.join("、") || emptyText;
    if (typeof resolved === "string") return resolved.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || emptyText;
    if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
    return resolved && typeof resolved === "object" ? "已填写" : emptyText;
  };
  const updateDynamicValue = (fieldId: string, value: unknown) =>
    setDynamicValues((current) => ({ ...current, [fieldId]: value }));
  const stageAttachment = (field: StoredDesignerField, fileName: string) => {
    setDraftPdfName(fileName);
    setDynamicValues((current) => {
      const currentValue = current[field.id];
      const existing = Array.isArray(currentValue) ? currentValue.map(String) : [];
      return {
        ...current,
        [field.id]: field.attachment?.inlinePdf ? [fileName] : Array.from(new Set([...existing, fileName])),
      };
    });
    message.success(field.attachment?.inlinePdf && fileName.toLowerCase().endsWith(".pdf")
      ? "新 PDF 已暂存，原文件将在保存时替换"
      : canRepublish ? "附件已暂存，将在重新提交时一并提交" : canReview ? "附件已暂存，将随审核结果一起提交" : "附件已暂存，请保存修改");
  };
  const renderDynamicField = (field: StoredDesignerField) => {
    const value = dynamicValues[field.id];
    const initiatorEditable = canEditPublishedContent && (field.inputStage ?? "initiator") !== "reviewer";
    const reviewerEditing = canReview || Boolean(repeatTask);
    const editable = initiatorEditable || (reviewerEditing && editableFieldIds.has(field.id));
    if (field.type === "attachment") {
      const names = Array.isArray(value)
        ? value.map(String)
        : field.id === attachmentFields[0]?.id
          ? attachmentNames
          : [];
      return <div className={`field-block field-wide${editable ? " editable-field" : ""}`} key={field.id}>
        <span>{field.label}</span>
        {field.description ? <Typography.Text type="secondary">{field.description}</Typography.Text> : null}
        <div className="attachment-field-control">
          {names.length ? <div className="attachment-field-list">
            {names.map((name) => <div key={name}><PaperClipOutlined /><strong>{name}</strong><Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => message.info("原型：已触发受控下载")}>下载</Button></div>)}
          </div> : <Typography.Text type="secondary">{field.inputStage === "reviewer" ? "" : "—"}</Typography.Text>}
          {editable ? <Upload showUploadList={false} beforeUpload={(file) => { stageAttachment(field, file.name); return false; }}>
            <Button icon={<UploadOutlined />}>{field.attachment?.inlinePdf && names.length ? "替换 PDF" : names.length ? "继续上传" : "上传附件"}</Button>
          </Upload> : null}
        </div>
      </div>;
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
      return <div className="field-block field-wide" key={field.id}><span>{field.label}</span><Table size="small" rowKey={(row) => String(row.key ?? rows.indexOf(row))} dataSource={rows} pagination={false} scroll={{ x: 680 }} columns={(field.columns ?? []).map((column) => ({ title: column.label, dataIndex: column.id, width: column.width ?? 150, render: (cell: unknown, row: Record<string, unknown>, rowIndex: number) => {
        const reviewerOwnsTable = reviewerEditing && field.inputStage === "reviewer" && editableFieldIds.has(field.id);
        const cellEditable = initiatorEditable || reviewerOwnsTable || (reviewerEditing && editableFieldIds.has(`${field.id}.${column.id}`));
        const text = displayDynamicValue(cell, field);
        const updateCell = (next: unknown) => updateDynamicValue(field.id, rows.map((item, index) => index === rowIndex ? { ...row, [column.id]: next } : item));
        if (!cellEditable) return text;
        if (column.type === "select" || column.type === "radio" || column.type === "checkbox") return <Select size="small" mode={column.type === "checkbox" ? "multiple" : undefined} value={column.type === "checkbox" ? (Array.isArray(cell) ? cell as string[] : []) : typeof cell === "string" && cell ? cell : undefined} options={(column.options ?? []).map((option) => ({ value: option, label: option }))} onChange={updateCell} />;
        return <Input size="small" value={text === "—" ? "" : text} onChange={(event) => updateCell(event.target.value)} />;
      } }))} />
      {reviewerEditing && field.inputStage === "reviewer" && editableFieldIds.has(field.id) ? <Space className="fd-row-actions">
        <Button size="small" onClick={() => updateDynamicValue(field.id, [...rows, { key: crypto.randomUUID(), ...Object.fromEntries((field.columns ?? []).map((column) => [column.id, column.defaultValue ?? (column.type === "checkbox" ? [] : "")])) }])}>新增行</Button>
        <Button size="small" disabled={!rows.length} onClick={() => updateDynamicValue(field.id, [...rows, { ...rows[rows.length - 1], key: crypto.randomUUID() }])}>复制末行</Button>
        <Button size="small" danger disabled={!rows.length} onClick={() => updateDynamicValue(field.id, rows.slice(0, -1))}>删除末行</Button>
      </Space> : <Typography.Text className="table-rule-note" type="secondary">审核节点只能修改授权单元格，不能新增或删除整行。</Typography.Text>}</div>;
    }
    if (!editable) return <div className="field-block" key={field.id}><span>{field.label}</span><strong>{displayDynamicValue(value, field)}</strong></div>;
    if (["select", "radio", "checkbox"].includes(field.type)) return <label className="field-block editable-field" key={field.id}><span>{field.label}</span><Select mode={field.type === "checkbox" ? "multiple" : undefined} value={value as string | string[]} onChange={(next) => updateDynamicValue(field.id, next)} options={(field.options ?? []).map((option) => ({ value: option, label: option }))} /></label>;
    return <label className={`field-block editable-field${field.type === "richtext" ? " field-wide" : ""}`} key={field.id}><span>{field.label}</span>{field.type === "richtext" ? <Input.TextArea value={String(value ?? "")} onChange={(event) => updateDynamicValue(field.id, event.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} /> : <Input value={String(value ?? "")} onChange={(event) => updateDynamicValue(field.id, event.target.value)} />}</label>;
  };

  return (
    <div className="page-stack detail-page">
      {guard}
      <div className="detail-topbar">
        <AppBackButton onClick={() => navigate(-1)} />
        <div className="detail-topbar-actions">
          {canPrint && <Button icon={<PrinterOutlined />} onClick={() => window.open(`/processes/${instance.id}/print`, "_blank", "noopener,noreferrer")}>打印为 PDF</Button>}
          {repeatTask ? (
            <>
              <Button onClick={cancelRepeatEditing}>取消继续修改</Button>
              <Button type="primary" icon={<EditOutlined />} onClick={saveRepeatEditing}>保存修改</Button>
            </>
          ) : repeatCandidates.map((task) => (
            <Button key={task.id} icon={<EditOutlined />} onClick={() => beginRepeatEditing(task.id)}>
              继续修改{repeatCandidates.length > 1 ? ` · ${task.nodeName}` : ""}
            </Button>
          ))}
          {canEditBeforeReview && (
            <Button type="primary" icon={<EditOutlined />} onClick={saveBeforeReview}>保存修改</Button>
          )}
          {isDcc && instance.status === "驳回待处理" && (
            <Button type="primary" icon={<ReloadOutlined />} onClick={republish}>重新提交</Button>
          )}
          {isDcc && instance.status !== "已关闭" && (
            <Button danger icon={<CloseOutlined />} onClick={() => setCloseOpen(true)}>关闭流程</Button>
          )}
        </div>
      </div>

      <Card className="detail-hero">
        <div className="detail-hero-main">
          <div className="document-icon"><FileTextOutlined /></div>
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
          description={isSuperAdmin ? "这是系统级处理权限，不会把超级管理员加入该节点的流程权限组或人员名单；提交后仍记录实际处理人。" : "无需转交或填写代办原因；提交后系统会记录实际处理人为你。"}
        />
      )}

      {canRepublish && (
        <Alert
          type="warning"
          showIcon
          message="流程已驳回，发起内容现已解锁"
          description={hasConfiguredAttachmentField ? "你可以修改表单，并按需上传或更换附件；确认重新提交后将开启新一轮，全部审批分支重新审核。" : "你可以修改表单；确认重新提交后将开启新一轮，全部审批分支重新审核。"}
        />
      )}

      {canEditBeforeReview && (
        <Alert
          type="success"
          showIcon
          icon={<EditOutlined />}
          message="本轮尚无人提交审核，发起内容可以修改"
          description="保存修改不会创建新轮次，也不会重新生成待办；任一审批人提交结果后，内容将立即锁定。"
        />
      )}

      {isDcc && instance.status === "审核中" && hasReviewAction && (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="本轮已有审核结果，发起内容已锁定"
          description={hasConfiguredAttachmentField ? "发起方不能再修改表单或附件；如果本轮被驳回，内容会重新开放编辑。" : "发起方不能再修改表单；如果本轮被驳回，内容会重新开放编辑。"}
        />
      )}

      {repeatTask && (
        <Alert
          type="success"
          showIcon
          icon={<EditOutlined />}
          message={`继续修改 · ${repeatTask.nodeName}`}
          description={`原结果“${repeatTask.action}”保持不变；仅可修改本节点授权字段，保存后自动记录修改人、时间和完整字段差异。`}
        />
      )}

      <Card className="progress-card" title="流程进度" extra={<Tag bordered={false}>按实例锁定版本的拓扑推进</Tag>}>
        <div className="parallel-flow">
          <div className="flow-endpoint done"><CheckOutlined /><span>开始<small>{instance.createdAt.slice(5, 16)}</small></span></div>
          <div className="flow-connector"><span /></div>
          <div className="parallel-branch-wrap">
            <div className="parallel-label"><ApartmentBadge />处理节点</div>
            <div className="parallel-branches">
              {instance.reviewers.map((reviewer) => {
                const handlingMode = lockedVersion?.snapshot.flow.nodes.find((node) => node.id === reviewer.key)?.data?.handlingMode ?? "approval";
                return (
                <div className={`branch-card status-${reviewer.status}`} key={reviewer.key}>
                  <div className="branch-card-top">
                    <span className="branch-icon">{reviewMeta[reviewer.status].icon}</span>
                    <Space size={4}><Tag bordered={false} color={handlingMode === "confirmation" ? "cyan" : "blue"}>{handlingMode === "confirmation" ? "确认" : "审批"}</Tag><StatusPill status={reviewer.status} /></Space>
                  </div>
                  <strong>{reviewer.shortGroup}</strong>
                  <Tooltip title={reviewer.group}><small>{reviewer.group}</small></Tooltip>
                  <div className="branch-person"><UserOutlined /> 默认：{findIdentityUser(tasks.find((task) => task.instanceId === instance.id && task.nodeId === reviewer.key && task.round === instance.round)?.defaultAssigneeId ?? "")?.name ?? "组内共享"}</div>
                  {reviewer.actionAt && reviewer.status !== "已跳过" && <div className="branch-action">实际：{reviewer.name}{reviewer.substitute && <Tag color="purple">代办</Tag>}</div>}
                </div>
                );
              })}
            </div>
          </div>
          <div className="flow-connector"><span /></div>
          <div className={instance.status === "已完成" ? "flow-endpoint done" : "flow-endpoint"}><CheckOutlined /><span>结束<small>{instance.status === "已完成" ? instance.updatedAt.slice(5, 16) : "等待全部通过或确认"}</small></span></div>
        </div>
      </Card>

      <div className="detail-workspace is-form-only">
        <div className="form-review-column">
          <Card className="form-card" title="流程表单">
            {configuredFields.length ? <div className="form-field-grid">{configuredFields.map(renderDynamicField)}</div> : <Descriptions bordered size="small" column={1} items={[{ key: "title", label: "标题", children: instance.title }, { key: "description", label: "说明", children: instance.description }]} />}
          </Card>

          {canReview && !repeatTask && (
            <Card className="approval-card" title={isConfirmationTask
              ? `${currentReviewer?.shortGroup ?? "节点"}确认`
              : isSuperAdmin ? `超级管理员审核 · ${currentReviewer?.shortGroup ?? "节点"}` : isSubstitute ? "代办审核" : `${currentReviewer?.shortGroup ?? "节点"}处理`}>
              <label className="field-block">
                <span>{isConfirmationTask ? "确认说明（选填）" : <>审核意见 <em className="required-hint">驳回时必填</em></>}</span>
                <Input.TextArea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder={isConfirmationTask ? "可填写本次确认的补充说明" : "填写审核意见；通过时可选，驳回时必填"}
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  maxLength={500}
                  showCount
                />
              </label>
              <div className="approval-actions">
                {isConfirmationTask ? (
                  <Button type="primary" size="large" icon={<CheckOutlined />} onClick={() => openReviewConfirm("confirm")}>确认并提交</Button>
                ) : (
                  <>
                    {canReject && <Button danger size="large" icon={<CloseOutlined />} onClick={() => openReviewConfirm("reject")}>驳回</Button>}
                    <Button type="primary" size="large" icon={<CheckOutlined />} onClick={() => openReviewConfirm("pass")}>通过并提交</Button>
                  </>
                )}
              </div>
            </Card>
          )}

          {repeatTask && (
            <Card className="approval-card" title={`继续修改 · ${repeatTask.nodeName}`}>
              <Alert type="info" showIcon message={`原处理结果：${repeatTask.action}`} description="本次只保存授权字段差异，不重新生成审核记录，也不能改变原处理结果。" />
              <label className="field-block">
                <span>修改说明（选填）</span>
                <Input.TextArea value={repeatComment} onChange={(event) => setRepeatComment(event.target.value)} placeholder="可说明本次继续修改的原因" autoSize={{ minRows: 3, maxRows: 6 }} maxLength={500} showCount />
              </label>
              <div className="approval-actions">
                <Button size="large" onClick={cancelRepeatEditing}>取消</Button>
                <Button type="primary" size="large" icon={<EditOutlined />} onClick={saveRepeatEditing}>保存修改</Button>
              </div>
            </Card>
          )}

          {!canReview && !repeatTask && instance.status === "审核中" && (
            !isDcc && <Alert message="当前以只读方式查看" description="你没有此待办的处理权限，或该节点已由其他成员完成。" type="info" showIcon />
          )}
        </div>
      </div>

      <Card title="流转记录" extra={<Tag bordered={false}>按轮次留痕</Tag>}>
        <Timeline
          items={[
            {
              color: "blue",
              children: <HistoryItem title={`第 ${instance.round} 轮发起`} person={`${instance.initiator} · ${instance.department}`} time={instance.createdAt} detail={hasAttachments ? `提交附件：${attachmentNames.join("、")}` : "提交初始表单"} />,
            },
            ...instance.reviewers
              .filter((reviewer) => reviewer.actionAt)
              .map((reviewer) => {
                const reviewerTask = tasks.find((task) => task.instanceId === instance.id && task.round === instance.round && task.nodeId === reviewer.key);
                const submittedChanges = reviewerTask?.submittedFieldChanges ?? [];
                return {
                  color: reviewer.status === "已通过" || reviewer.status === "已确认" ? "green" : reviewer.status === "已跳过" ? "gray" : "red",
                  children: <HistoryItem title={`${reviewer.shortGroup} · ${reviewer.status}`} person={reviewer.status === "已跳过" ? "系统按节点条件判定" : `实际处理人 ${reviewer.name}${reviewer.substitute ? "（代办）" : ""}`} time={reviewer.actionAt ?? ""} detail={reviewer.conditionSummary ?? [reviewer.comment ?? (reviewer.status === "已确认" ? "未填写确认说明" : "未填写意见"), ...submittedChanges.map((change) => `${change.label}：${change.before} → ${change.after}`)].join("；")} />,
                };
              }),
            ...tasks
              .filter((task) => task.instanceId === instance.id && task.round < instance.round && (task.status === "已完成" || task.status === "已跳过"))
              .map((task) => ({
                color: task.action === "通过" || task.action === "确认" ? "green" : task.status === "已跳过" ? "gray" : "red",
                children: <HistoryItem
                  title={`第 ${task.round} 轮 · ${task.nodeName} · ${task.action ? `已${task.action}` : "已跳过"}`}
                  person={task.status === "已跳过" ? "系统按节点条件判定" : `实际处理人 ${task.completedByName ?? "未知"}`}
                  time={task.completedAt ?? task.conditionEvaluatedAt ?? ""}
                  detail={task.conditionSummary ?? [
                    task.comment ?? (task.action === "确认" ? "未填写确认说明" : "未填写意见"),
                    ...(task.submittedFieldChanges ?? []).map((change) => `${change.label}：${change.before} → ${change.after}`),
                  ].join("；")}
                />,
              })),
            ...tasks
              .filter((task) => task.instanceId === instance.id && task.fieldRevisions?.length)
              .flatMap((task) => (task.fieldRevisions ?? []).map((revision) => ({
                color: "blue",
                children: <HistoryItem title={`${task.nodeName} · 继续修改`} person={`修改人 ${revision.editedByName} · 原结果 ${task.action}`} time={revision.editedAt} detail={[revision.comment ? `说明：${revision.comment}` : "未填写修改说明", ...revision.changes.map((change) => `${change.label}：${change.before} → ${change.after}`)].join("；")} />,
              }))),
          ]}
        />
      </Card>

      <Modal
        open={Boolean(pendingAction)}
        title={pendingAction === "pass" ? "确认通过本节点？" : pendingAction === "confirm" ? "确认完成本节点？" : "确认驳回本轮审核？"}
        okText={pendingAction === "pass" ? "确认通过" : pendingAction === "confirm" ? "确认完成" : "确认驳回"}
        okButtonProps={{ danger: pendingAction === "reject" }}
        cancelText="返回检查"
        onOk={confirmReview}
        onCancel={() => setPendingAction(null)}
      >
        <div className="confirm-summary">
          <p>{pendingAction === "pass" ? "审核结果和表单修改将一次性提交。" : pendingAction === "confirm" ? "确认结果和本节点授权字段修改将一次性提交，提交后不能改为驳回。" : "其他未完成的并行任务会立即取消，流程转为等待发起方处理。"}</p>
          {changedLevel && <div><span>文件密级</span><del>{instance.documentLevel}</del><b>→</b><ins>{documentLevel}</ins></div>}
          <div><span>{pendingAction === "confirm" ? "确认说明" : "审核意见"}</span><strong>{comment.trim() || (pendingAction === "confirm" ? "未填写（选填）" : "未填写（通过时允许）")}</strong></div>
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
