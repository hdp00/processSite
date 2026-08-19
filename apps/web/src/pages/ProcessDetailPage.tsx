import {
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CloseOutlined,
  DeleteOutlined,
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
  Checkbox,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { flowPilotApi } from "../api/flowPilotApi";
import { AppBackButton } from "../components/AppBackButton";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import type { ReviewerProgress } from "../data/types";
import { isSuperAdminPersona, usePrototypeStore } from "../state/usePrototypeStore";
import { effectiveGroupMemberIds, findIdentityUser, useIdentityStore } from "../state/useIdentityStore";
import { canUserCloseInstance, canUserProcessTask } from "../state/workflowAccess";
import { hasPersonaPermission } from "../state/rolePermissions";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import type { StoredDesignerField } from "../utils/designerStorage";
import { canEditProcessInstanceSubmission } from "../utils/processInstanceAccess";
import { formatRoundLabel, formatRoundStartLabel, prefixWithRound } from "../utils/roundDisplay";

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
    return Array.isArray(value) ? value.map(attachmentItemName) : [];
  })
  .filter((name) => name.trim() && !["无附件", "—"].includes(name));

const attachmentItemName = (item: unknown) => typeof item === "string"
  ? item
  : item && typeof item === "object" && "name" in item
    ? String((item as { name?: unknown }).name ?? "")
    : "";

const attachmentItemId = (item: unknown) => item && typeof item === "object" && "id" in item
  ? String((item as { id?: unknown }).id ?? "")
  : "";

interface RuntimeAttachmentItem {
  id?: string;
  name: string;
  sourceIndex: number;
}

const inlinePdfEnabled = (field: StoredDesignerField) => field.attachment?.inlinePdf ?? true;

type PendingAction = "pass" | "confirm" | "reject" | null;

export function ProcessDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  const identityUsers = useIdentityStore((state) => state.users);
  useIdentityStore((state) => state.workflowGroups);
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
  const [draftAssignees, setDraftAssignees] = useState<Record<string, string>>({});
  const [repeatTaskId, setRepeatTaskId] = useState<string>();
  const [repeatComment, setRepeatComment] = useState("");
  const [uploadingAttachmentFieldId, setUploadingAttachmentFieldId] = useState<string>();
  const [deletingAttachmentKey, setDeletingAttachmentKey] = useState<string>();

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


  const currentTasks = useMemo(() => tasks.filter((task) =>
    task.instanceId === instance?.id && task.status === "待处理" && canUserProcessTask(personaId, task),
  ), [instance?.id, personaId, tasks]);
  const requestedTaskId = searchParams.get("taskId");
  const currentTask = useMemo(() => requestedTaskId
    ? currentTasks.find((task) => task.id === requestedTaskId)
    : currentTasks.length === 1 ? currentTasks[0] : undefined,
  [currentTasks, requestedTaskId]);
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
  const canEditAsCreator = Boolean(
    instance && persona && hasPersonaPermission(persona.id, "work-launch:发起")
    && canEditProcessInstanceSubmission(instance, persona, isSuperAdmin),
  );
  const canPrint = hasPersonaPermission(personaId, "work-list:打印");
  const hasReviewAction = Boolean(instance?.reviewers.some(
    (reviewer) => reviewer.status === "已通过" || reviewer.status === "已确认" || reviewer.status === "已驳回",
  ));
  const assignableApprovalNodes = useMemo(
    () => (lockedVersion?.snapshot.flow.nodes ?? []).filter((node) =>
      node.data?.kind === "approval" && node.data.specifyAssignee && node.data.permissionGroup,
    ),
    [lockedVersion],
  );
  const savedAssignees = useMemo(() => Object.fromEntries(assignableApprovalNodes.map((node) => {
    const assigneeId = tasks.find((task) =>
      task.instanceId === instance?.id && task.round === instance?.round && task.nodeId === node.id,
    )?.defaultAssigneeId ?? "";
    return [node.id, assigneeId];
  })), [assignableApprovalNodes, instance?.id, instance?.round, tasks]);
  const savedAssigneeSignature = JSON.stringify(savedAssignees);

  useEffect(() => {
    setDraftAssignees(savedAssignees);
  }, [instance?.id, instance?.round, savedAssigneeSignature]);
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
  const canEditBeforeReview = Boolean(canEditAsCreator && instance?.status === "审核中" && !hasReviewAction);
  const canRepublish = Boolean(canEditAsCreator && instance?.status === "驳回待处理");
  const canEditPublishedContent = canEditBeforeReview || canRepublish;
  const editableContentDirty = Boolean(instance && (
    documentLevel !== instance.documentLevel
    || draftTitle !== instance.title
    || draftDocumentCode !== instance.documentCode
    || draftDocumentType !== instance.documentType
    || draftDescription !== instance.description
    || draftPdfName !== instance.pdfName
    || JSON.stringify(dynamicValues) !== JSON.stringify(instance.formValues ?? {})
    || (canEditBeforeReview && JSON.stringify(draftAssignees) !== savedAssigneeSignature)
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

  if (!definition || !lockedVersion) {
    return (
      <Card className="empty-page-card">
        <Alert
          type="error"
          showIcon
          title="实例锁定的流程版本不可用"
          description="系统没有找到该实例创建时使用的完整版本快照。为避免错误套用其他版本，当前实例已禁止查看表单和继续办理，请联系流程管理员检查版本数据。"
        />
        <AppBackButton onClick={() => navigate("/tasks")} />
      </Card>
    );
  }

  const attachmentFields = lockedVersion.snapshot.form.fields.filter((field) => field.type === "attachment");
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
    const result = closeInstance(instance.id, closeReason.trim());
    if (!result.ok) {
      message.error(result.message);
      return;
    }
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
        const result = republishInstance(instance.id, {
          title: dynamicText(["title", "标题"], draftTitle.trim()),
          documentCode: dynamicText(["documentCode", "文件编号", "报告编号"], draftDocumentCode.trim()),
          documentType: dynamicText(["documentType", "文件类型", "分类"], draftDocumentType),
          documentLevel,
          description: draftDescription.trim(),
          pdfName: draftPdfName,
          formValues: dynamicValues,
          attachmentNames,
        });
        if (!result.ok) {
          message.error(result.message);
          return;
        }
        message.success("流程已重新提交，全部分支待办已重新生成");
      },
    });
  };

  const saveBeforeReview = () => {
    if (!draftTitle.trim()) {
      message.warning("请完善必填表单内容后再保存");
      return;
    }
    const invalidAssigneeNode = assignableApprovalNodes.find((node) => {
      const groupId = node.data?.permissionGroup ?? "";
      return !draftAssignees[node.id] || !effectiveGroupMemberIds(groupId).includes(draftAssignees[node.id]);
    });
    if (invalidAssigneeNode) {
      message.warning(`请为“${invalidAssigneeNode.data?.label ?? "审批节点"}”选择当前流程权限组内的有效人员`);
      return;
    }
    const result = updateUnreviewedInstance(instance.id, {
      title: dynamicText(["title", "标题"], draftTitle.trim()),
      documentCode: dynamicText(["documentCode", "文件编号", "报告编号"], draftDocumentCode.trim()),
      documentType: dynamicText(["documentType", "文件类型", "分类"], draftDocumentType),
      documentLevel,
      description: draftDescription.trim(),
      pdfName: draftPdfName,
      formValues: dynamicValues,
      attachmentNames,
      assigneeByNode: draftAssignees,
    });
    if (!result.ok) {
      message.error(result.message);
      return;
    }
    message.success("修改已保存，默认审核人员与本轮待办已同步更新");
  };

  const changedLevel = documentLevel !== instance.documentLevel;
  const configuredFields = lockedVersion?.snapshot.form.fields ?? [];
  const editableFieldIds = new Set(
    (repeatTask ? repeatNodeConfig : currentNodeConfig)?.editableFields ?? [],
  );
  const displayDynamicValue = (value: unknown, field?: StoredDesignerField) => {
    const resolved = value === undefined || value === null || value === "" ? field?.defaultValue ?? value : value;
    const emptyText = "—";
    if (Array.isArray(resolved)) return resolved.join("、") || emptyText;
    if (typeof resolved === "string") return resolved.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || emptyText;
    if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
    return resolved && typeof resolved === "object" ? "已填写" : emptyText;
  };
  const updateDynamicValue = (fieldId: string, value: unknown) =>
    setDynamicValues((current) => ({ ...current, [fieldId]: value }));
  const assigneeOptions = (groupId: string) => {
    const memberIds = new Set(effectiveGroupMemberIds(groupId));
    return identityUsers
      .filter((user) => memberIds.has(user.id))
      .map((user) => ({
        value: user.id,
        label: `${user.name} · ${user.departmentPath} · ${user.jobTitle}`,
      }));
  };
  const stageAttachment = async (field: StoredDesignerField, file: File) => {
    const isInlinePdf = inlinePdfEnabled(field);
    if (isInlinePdf && (!file.name.toLowerCase().endsWith(".pdf") || (file.type && file.type !== "application/pdf"))) {
      message.error("该附件字段只能上传 PDF 文件");
      return;
    }
    const maxSizeMb = field.attachment?.maxSizeMb ?? 100;
    if (file.size / 1024 / 1024 > maxSizeMb) {
      message.error(`${file.name} 超过 ${maxSizeMb} MB 限制`);
      return;
    }
    setUploadingAttachmentFieldId(field.id);
    try {
      const record = isInlinePdf
        ? await flowPilotApi.attachments.replaceFieldAttachment(instance.id, field.id, file)
        : await flowPilotApi.attachments.upload(file, { instanceId: instance.id, fieldId: field.id });
      const reference = { id: record.id, name: record.name, size: record.size, contentType: record.contentType };
      setDraftPdfName(record.name);
      setDynamicValues((current) => {
        const existing = Array.isArray(current[field.id]) ? current[field.id] as unknown[] : [];
        const nextValues = isInlinePdf
          ? [reference]
          : [...existing.filter((item) => attachmentItemId(item) !== record.id), reference];
        return {
          ...current,
          [field.id]: nextValues,
        };
      });
      message.success(isInlinePdf ? "PDF 已上传并完成替换" : "附件已上传");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "附件上传失败，请稍后重试");
    } finally {
      setUploadingAttachmentFieldId(undefined);
    }
  };

  const downloadAttachment = async (attachment: RuntimeAttachmentItem) => {
    if (!attachment.id) {
      message.info("当前演示附件没有保存文件内容，仅保留了文件名");
      return;
    }
    try {
      const { blob, fileName } = await flowPilotApi.attachments.content(attachment.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName || attachment.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "附件下载失败");
    }
  };
  const removeAttachment = (field: StoredDesignerField, attachment: RuntimeAttachmentItem) => {
    const attachmentKey = `${field.id}:${attachment.id ?? attachment.sourceIndex}`;
    Modal.confirm({
      title: "确认删除附件？",
      content: `删除后将无法继续预览或下载“${attachment.name}”。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setDeletingAttachmentKey(attachmentKey);
        try {
          if (attachment.id) await flowPilotApi.attachments.remove(attachment.id);
          setDynamicValues((current) => {
            const rawValue = current[field.id];
            const currentValue: unknown[] = Array.isArray(rawValue) ? rawValue : [];
            const nextValue = currentValue.filter((entry, index) => attachment.id
              ? attachmentItemId(entry) !== attachment.id
              : index !== attachment.sourceIndex);
            if (field.id === attachmentFields[0]?.id) {
              setDraftPdfName(nextValue.map(attachmentItemName).find(Boolean) ?? "无附件");
            }
            return { ...current, [field.id]: nextValue };
          });
          message.success("附件已删除");
        } catch (error) {
          message.error(error instanceof Error ? error.message : "附件删除失败");
          throw error;
        } finally {
          setDeletingAttachmentKey(undefined);
        }
      },
    });
  };
  const renderDynamicField = (field: StoredDesignerField) => {
    const value = dynamicValues[field.id];
    const resolvedValue = value === undefined || value === null || value === ""
      ? field.defaultValue ?? ""
      : value;
    const initiatorEditable = canEditPublishedContent && (field.inputStage ?? "initiator") !== "reviewer";
    const reviewerEditing = canReview || Boolean(repeatTask);
    const editable = initiatorEditable || (reviewerEditing && editableFieldIds.has(field.id));
    const wide = ["richtext", "attachment", "table"].includes(field.type);
    const itemClassName = `runtime-form-item${wide ? " field-wide" : ""}${editable ? " is-editable" : " is-readonly"}`;
    const item = (control: React.ReactNode) => (
      <Form.Item
        key={field.id}
        className={itemClassName}
        label={field.label}
        extra={field.description || undefined}
      >
        {control}
      </Form.Item>
    );
    if (field.type === "attachment") {
      const attachments: RuntimeAttachmentItem[] = Array.isArray(value)
        ? value.map((entry, sourceIndex) => ({ id: attachmentItemId(entry) || undefined, name: attachmentItemName(entry), sourceIndex })).filter((entry) => Boolean(entry.name))
        : field.id === attachmentFields[0]?.id
          ? attachmentNames.map((name, sourceIndex) => ({ id: instance.attachmentIdsByField?.[field.id]?.[sourceIndex], name, sourceIndex }))
          : [];
      const previewPdf = inlinePdfEnabled(field)
        ? attachments.find((attachment) => attachment.name.toLowerCase().endsWith(".pdf"))
        : undefined;
      return item(<div className="runtime-attachment-field">
        <div className="attachment-field-control">
          {attachments.length ? <div className="attachment-field-list">
            {attachments.map((attachment) => {
              const attachmentKey = `${field.id}:${attachment.id ?? attachment.sourceIndex}`;
              return <div key={attachmentKey}>
                <PaperClipOutlined />
                <strong title={attachment.name}>{attachment.name}</strong>
                <Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => void downloadAttachment(attachment)}>下载</Button>
                {editable ? <Button
                  className="attachment-delete-button"
                  danger
                  type="text"
                  size="small"
                  loading={deletingAttachmentKey === attachmentKey}
                  icon={<DeleteOutlined />}
                  aria-label={`删除附件 ${attachment.name}`}
                  onClick={() => removeAttachment(field, attachment)}
                >删除</Button> : null}
              </div>;
            })}
          </div> : <div className="runtime-empty-control">未上传附件</div>}
          {editable ? <Upload showUploadList={false} beforeUpload={(file) => { void stageAttachment(field, file); return Upload.LIST_IGNORE; }}>
            <Button loading={uploadingAttachmentFieldId === field.id} icon={<UploadOutlined />}>{inlinePdfEnabled(field) && attachments.length ? "替换 PDF" : attachments.length ? "继续上传" : "上传附件"}</Button>
          </Upload> : null}
        </div>
        {previewPdf ? <InlinePdfPreview
          attachmentId={previewPdf.id}
          fileName={previewPdf.name}
          title={instance.title}
          code={instance.code}
          version={instance.revision || instance.templateVersion}
          description={instance.description}
          initiator={instance.initiator}
          createdAt={instance.createdAt}
        /> : null}
      </div>);
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
      return item(<div className="runtime-table-field"><Table className="embedded-form-table" bordered size="small" rowKey={(row) => String(row.key ?? rows.indexOf(row))} dataSource={rows} pagination={false} scroll={{ x: 680 }} columns={(field.columns ?? []).map((column) => ({ title: column.label, dataIndex: column.id, width: column.width ?? 150, render: (cell: unknown, row: Record<string, unknown>, rowIndex: number) => {
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
      </Space> : reviewerEditing ? <Typography.Text className="table-rule-note" type="secondary">审核节点只能修改授权单元格，不能新增或删除整行。</Typography.Text> : null}</div>);
    }
    const options = (field.options ?? []).map((option) => ({ value: option, label: option }));
    const readOnlyControl = () => {
      const text = displayDynamicValue(resolvedValue, field);
      return <Input className="runtime-readonly-value" readOnly value={text === "—" ? "" : text} placeholder="未填写" />;
    };
    if (field.type === "select") return item(editable
      ? <Select value={typeof resolvedValue === "string" && resolvedValue ? resolvedValue : undefined} placeholder="未填写" options={options} onChange={(next) => updateDynamicValue(field.id, next)} />
      : readOnlyControl());
    if (field.type === "cascader") return item(editable
      ? <Cascader value={Array.isArray(resolvedValue) ? resolvedValue as string[] : undefined} placeholder="未填写" options={options} onChange={(next) => updateDynamicValue(field.id, next)} />
      : readOnlyControl());
    if (field.type === "radio") return item(editable
      ? <Radio.Group value={resolvedValue || undefined} options={options} onChange={(event) => updateDynamicValue(field.id, event.target.value)} />
      : readOnlyControl());
    if (field.type === "checkbox") return item(editable
      ? <Checkbox.Group value={Array.isArray(resolvedValue) ? resolvedValue as string[] : []} options={options} onChange={(next) => updateDynamicValue(field.id, next)} />
      : readOnlyControl());
    if (field.type === "richtext") return item(<Input.TextArea readOnly={!editable} value={String(resolvedValue ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()} placeholder="未填写" onChange={(event) => updateDynamicValue(field.id, event.target.value)} autoSize={{ minRows: 4, maxRows: 10 }} />);
    return item(<Input readOnly={!editable} value={String(resolvedValue ?? "")} placeholder="未填写" onChange={(event) => updateDynamicValue(field.id, event.target.value)} />);
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
          {canRepublish && (
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
              {instance.round > 1 ? <span>{formatRoundLabel(instance.round)}</span> : null}
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

      {currentTasks.length > 1 && !currentTask && (
        <Alert
          type="info"
          showIcon
          title="请选择本次要处理的节点"
          description="你在此实例中同时拥有多个待处理节点。不同节点的可修改字段和处理方式可能不同。"
          action={(
            <Space wrap>
              {currentTasks.map((task) => (
                <Button
                  key={task.id}
                  size="small"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.set("taskId", task.id);
                    setSearchParams(next, { replace: true });
                  }}
                >
                  {task.nodeName}
                </Button>
              ))}
            </Space>
          )}
        />
      )}

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
          description="保存修改不会创建新轮次；表单、条件节点和默认审核人员会同步到本轮待办。任一审批人提交结果后，内容和人员选择将立即锁定。"
        />
      )}

      {canEditAsCreator && instance.status === "审核中" && hasReviewAction && (
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
            {configuredFields.length ? <Form className="runtime-process-form" layout="vertical"><div className="runtime-form-grid">{configuredFields.map(renderDynamicField)}</div></Form> : <Descriptions bordered size="small" column={1} items={[{ key: "title", label: "标题", children: instance.title }, { key: "description", label: "说明", children: instance.description }]} />}
            {canEditBeforeReview && assignableApprovalNodes.length > 0 ? (
              <section className="detail-assignee-section">
                <div className="detail-assignee-heading">
                  <div>
                    <Typography.Title level={5}>默认审核人员</Typography.Title>
                    <Typography.Text type="secondary">可在首个审核结果提交前调整；同一流程权限组的其他成员仍可代办。</Typography.Text>
                  </div>
                  <TeamOutlined />
                </div>
                <div className="detail-assignee-grid">
                  {assignableApprovalNodes.map((node) => {
                    const groupId = node.data?.permissionGroup ?? "";
                    return (
                      <label className="detail-assignee-item" key={node.id}>
                        <span>{node.data?.label ?? "审批节点"}</span>
                        <Select
                          showSearch
                          optionFilterProp="label"
                          value={draftAssignees[node.id] || undefined}
                          placeholder="搜索并选择默认责任人"
                          options={assigneeOptions(groupId)}
                          onChange={(assigneeId) => setDraftAssignees((current) => ({ ...current, [node.id]: assigneeId }))}
                        />
                        <small><TeamOutlined /> {instance.reviewers.find((reviewer) => reviewer.key === node.id)?.group ?? groupId}</small>
                      </label>
                    );
                  })}
                </div>
              </section>
            ) : null}
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
              children: <HistoryItem title={formatRoundStartLabel(instance.round)} person={`${instance.initiator} · ${instance.department}`} time={instance.createdAt} detail={hasAttachments ? `提交附件：${attachmentNames.join("、")}` : "提交初始表单"} />,
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
                  title={prefixWithRound(task.round, `${task.nodeName} · ${task.action ? `已${task.action}` : "已跳过"}`)}
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

function InlinePdfPreview({
  attachmentId,
  fileName,
  title,
  code,
  version,
  description,
  initiator,
  createdAt,
}: {
  attachmentId?: string;
  fileName: string;
  title: string;
  code: string;
  version: string;
  description: string;
  initiator: string;
  createdAt: string;
}) {
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [loading, setLoading] = useState(Boolean(attachmentId));
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    if (!attachmentId) {
      setSourceUrl(undefined);
      setLoading(false);
      setLoadError(undefined);
      return;
    }
    let active = true;
    let objectUrl: string | undefined;
    setLoading(true);
    setLoadError(undefined);
    void flowPilotApi.attachments.content(attachmentId)
      .then(({ blob }) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSourceUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "PDF 内容加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  return (
    <section className="inline-pdf-preview" aria-label={`PDF 预览：${fileName}`}>
      <div className="inline-pdf-toolbar">
        <div><EyeOutlined /><strong>PDF 页面预览</strong><span>{fileName}</span></div>
        <Tag variant="filled" color={sourceUrl ? "blue" : "default"}>{sourceUrl ? "浏览器预览" : "兼容预览"}</Tag>
      </div>
      {loading ? <div className="inline-pdf-loading"><Spin description="正在加载 PDF" /></div> : null}
      {loadError ? <Alert className="inline-pdf-error" type="warning" showIcon title="PDF 暂时无法显示" description={loadError} /> : null}
      {sourceUrl ? <iframe className="inline-pdf-frame" src={sourceUrl} title={`PDF 文件：${fileName}`} /> : !loading && !loadError ? <div className="inline-pdf-stage">
        <article className="inline-pdf-sheet">
          <header>
            <div><span className="pdf-company">FlowPilot</span><small>公司内部受控文件</small></div>
            <div><b>{code}</b><small>版本 {version || "—"}</small></div>
          </header>
          <h2>{title}</h2>
          <div className="inline-pdf-meta"><span>编制：{initiator}</span><span>提交时间：{createdAt}</span></div>
          <section>
            <h3>文件说明</h3>
            <p>{description || "本文件通过 FlowPilot 流程提交审核，具体正文内容在正式系统中由 PDF 文件服务加载。"}</p>
          </section>
          <section>
            <h3>审核范围</h3>
            <p>研发、质量及生产相关人员依据当前发布版本的流程定义完成审核，并在流程记录中保留处理结果。</p>
          </section>
          <div className="inline-pdf-placeholder-lines"><i /><i /><i /><i /><i /><i /></div>
          <div className="inline-pdf-stamp">受控文件</div>
        </article>
      </div> : null}
    </section>
  );
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
