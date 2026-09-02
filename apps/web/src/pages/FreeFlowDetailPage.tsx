import {
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  LockOutlined,
  MessageOutlined,
  ReloadOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  type UploadFile,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { cacheProcessRuntime } from "../api/entityCache";
import { ApiError } from "../api/client";
import { flowPilotApi } from "../api/flowPilotApi";
import { RichTextContent, RichTextEditor } from "../components/RichTextEditor";
import { ExcelPdfPreviewModal } from "../components/ExcelPdfPreviewModal";
import { RuntimeReadonlyChoice } from "../components/RuntimeReadonlyChoice";
import { StatusPill } from "../components/StatusPill";
import { useUnsavedChangesGuard } from "../components/UnsavedChangesGuard";
import type { AttachmentRecord } from "../api/contracts";
import type { FreeFlowEntry, ProcessInstance } from "../data/types";
import {
  canUserReplyFreeFlow,
  canUserTransferFreeFlow,
  isSessionSuperAdmin,
  usePrototypeStore,
} from "../state/usePrototypeStore";
import { effectiveGroupMemberIds, findIdentityUser, isUserInWorkflowGroup, useIdentityStore } from "../state/useIdentityStore";
import { useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { canUserCloseInstance } from "../state/workflowAccess";
import { formatDisplayDateTime } from "../utils/domainTime";
import { convertXlsxToPdf, type ExcelPdfConversionResult } from "../utils/excelToPdf";
import { cleanupTemporaryAttachments } from "../utils/attachmentLifecycle";
import { canEditProcessInstanceSubmission } from "../utils/processInstanceAccess";
import { applyDesignerFieldVisibility, isDesignerFieldVisible, normalizeDesignerFormValues, type StoredDesignerField } from "../utils/designerStorage";
import { designerChoiceOptionsToAntd, displayDesignerChoiceValue } from "../utils/designerOptions";
import { resolveRuntimeAttachments } from "../utils/attachmentDisplay";
import { DynamicFieldControl } from "./ConfiguredProcessStartPage";
import "./free-flow.css";

const { Text, Title } = Typography;
const hasRichContent = (html: string) =>
  html.replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ").trim().length > 0 || /<(img|video)\b/i.test(html);

const isEmptyValue = (value: unknown) =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

const displayFieldValue = (field: Pick<StoredDesignerField, "type" | "options">, value: unknown) => {
  if (isEmptyValue(value)) return "—";
  if (["select", "radio", "checkbox", "cascader"].includes(field.type)) {
    return displayDesignerChoiceValue(field.options, value, { hierarchical: field.type === "cascader" }) || "—";
  }
  if (Array.isArray(value)) return value.join("、") || "—";
  return String(value);
};

function InitialFormView({
  fields,
  instance,
  onDownload,
}: {
  fields: StoredDesignerField[];
  instance: ProcessInstance;
  onDownload: (attachment: { id: string; name: string }) => void;
}) {
  const values = instance.formValues ?? {};
  const visibleFields = fields.filter((field) => isDesignerFieldVisible(field, values));
  const attachmentFields = fields.filter((field) => field.type === "attachment");

  const renderValue = (field: StoredDesignerField) => {
    const value = values[field.id];
    if (field.type === "richtext") {
      return isEmptyValue(value) ? <Typography.Text type="secondary">—</Typography.Text> : <RichTextContent html={String(value)} />;
    }
    if (field.type === "attachment") {
      const attachments = resolveRuntimeAttachments({
        fieldId: field.id,
        value,
        fallbackNames: instance.attachmentNames,
        attachmentIdsByField: instance.attachmentIdsByField,
        attachmentIds: instance.attachmentIds,
        primaryField: field.id === attachmentFields[0]?.id,
      });
      return attachments.length ? <Space wrap>{attachments.map((attachment) => attachment.id
        ? <Button key={attachment.id} size="small" icon={<DownloadOutlined />} onClick={() => onDownload({ id: attachment.id!, name: attachment.name })}>{attachment.name}</Button>
        : <Tag key={`${field.id}-${attachment.sourceIndex}`}>{attachment.name}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text>;
    }
    if (field.type === "table") {
      const rows = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
      if (!rows.length) return <Typography.Text type="secondary">—</Typography.Text>;
      return <Table
        bordered
        size="small"
        pagination={false}
        rowKey={(row) => String(row.key ?? rows.indexOf(row))}
        dataSource={rows}
        scroll={{ x: 680 }}
        columns={(field.columns ?? []).map((column) => ({
          title: column.label,
          dataIndex: column.id,
          width: column.width ?? 150,
          render: (cell: unknown) => column.type && column.type !== "text"
            ? <RuntimeReadonlyChoice type={column.type} size="small" value={cell} options={designerChoiceOptionsToAntd(column.options)} />
            : displayFieldValue({ type: "text", options: column.options }, cell),
        }))}
      />;
    }
    if (["select", "cascader", "radio", "checkbox"].includes(field.type)) {
      return <RuntimeReadonlyChoice
        type={field.type as "select" | "cascader" | "radio" | "checkbox"}
        value={value}
        options={designerChoiceOptionsToAntd(field.options)}
      />;
    }
    const text = displayFieldValue(field, value);
    return field.multiline
      ? <Input.TextArea readOnly value={text === "—" ? "" : text} placeholder="未填写" autoSize={{ minRows: 3, maxRows: 10 }} />
      : <Input readOnly value={text === "—" ? "" : text} placeholder="未填写" />;
  };

  return <Form className="runtime-process-form free-runtime-form" layout="vertical">
    <div className="free-runtime-form__grid">
      {visibleFields.map((field) => <Form.Item
        key={field.id}
        className={`runtime-form-item is-readonly${["richtext", "attachment", "table"].includes(field.type) ? " field-wide" : ""}`}
        label={field.label}
        extra={field.description || undefined}
      >{renderValue(field)}</Form.Item>)}
    </div>
  </Form>;
}

const attachmentFilesForEdit = (instance: ProcessInstance, fields: StoredDesignerField[]) => {
  const attachmentFields = fields.filter((field) => field.type === "attachment");
  return Object.fromEntries(attachmentFields.map((field) => {
    const attachments = resolveRuntimeAttachments({
      fieldId: field.id,
      value: instance.formValues?.[field.id],
      fallbackNames: instance.attachmentNames,
      attachmentIdsByField: instance.attachmentIdsByField,
      attachmentIds: instance.attachmentIds,
      primaryField: field.id === attachmentFields[0]?.id,
    });
    return [field.id, attachments.map((attachment): UploadFile<AttachmentRecord> => ({
      uid: attachment.id ?? `${field.id}-${attachment.sourceIndex}`,
      name: attachment.name,
      status: "done",
      response: attachment.id ? {
        id: attachment.id,
        name: attachment.name,
        size: 0,
        contentType: "application/octet-stream",
        uploadedById: instance.initiatorId,
        uploadedAt: instance.updatedAt,
        instanceId: instance.id,
        fieldId: field.id,
        purpose: "form-field",
        lifecycle: "active",
      } : undefined,
    }))];
  }));
};

const entryMeta: Record<Exclude<FreeFlowEntry["type"], "reply">, { label: string; color: string }> = {
  created: { label: "创建事项", color: "blue" },
  "reply-edited": { label: "编辑回复", color: "gold" },
  assigned: { label: "变更受理人", color: "purple" },
  closed: { label: "关闭事项", color: "gray" },
  reopened: { label: "重新打开", color: "green" },
  "form-edited": { label: "修改初始表单", color: "gold" },
  reassigned: { label: "变更受理人", color: "purple" },
};

interface FreeFlowDetailPageProps {
  instanceOverride?: ProcessInstance;
}

export function FreeFlowDetailPage({ instanceOverride }: FreeFlowDetailPageProps) {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    instances,
    personaId,
  } = usePrototypeStore();
  const instance = instanceOverride ?? instances.find((item) => item.id === id);
  const persona = findIdentityUser(personaId);
  const identityUsers = useIdentityStore((state) => state.users);
  useIdentityStore((state) => state.workflowGroups);
  const definition = useProcessDefinitionStore((state) => state.definitions.find((item) => item.id === instance?.definitionId));
  const lockedVersion = definition?.versions.find((version) => version.id === instance?.versionId);
  const configuredFields = (lockedVersion?.snapshot.form.fields ?? [])
    .filter((field) => (field.inputStage ?? "initiator") !== "reviewer");
  const assigneeIds = new Set((lockedVersion?.basic.assigneeGroups ?? []).flatMap(effectiveGroupMemberIds));
  const localUserOptions = identityUsers.filter((user) => assigneeIds.has(user.id)).map((user) => ({
    value: user.id,
    label: `${user.name} · ${user.departmentPath} · ${user.jobTitle}`,
  }));
  const userOptions = instance?.freeAssigneeCandidates?.map((user) => ({
    value: user.id,
    label: [user.name, user.departmentPath].filter(Boolean).join(" · "),
  })) ?? localUserOptions;
  const isSuperAdmin = isSessionSuperAdmin(personaId);
  const [replyContent, setReplyContent] = useState("");
  const [nextAssignee, setNextAssignee] = useState<string>();
  const [editEntry, setEditEntry] = useState<FreeFlowEntry>();
  const [editContent, setEditContent] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenAssignee, setReopenAssignee] = useState<string>();
  const [initialEditOpen, setInitialEditOpen] = useState(false);
  const [initialFormDirty, setInitialFormDirty] = useState(false);
  const [savingInitialForm, setSavingInitialForm] = useState(false);
  const [excelDialog, setExcelDialog] = useState<{
    field: StoredDesignerField;
    sourceName: string;
    result?: ExcelPdfConversionResult;
    error?: string;
    converting: boolean;
  }>();
  const [confirmingExcelUpload, setConfirmingExcelUpload] = useState(false);
  const [initialForm] = Form.useForm<Record<string, unknown>>();
  const watchedInitialValues = Form.useWatch([], initialForm) as Record<string, unknown> | undefined;
  const [resourceEtag, setResourceEtag] = useState<string>();

  const participants = instance?.participants ?? [];
  const isOpen = instance?.status === "进行中";
  const isStarter = Boolean(
    isSuperAdmin || lockedVersion?.basic.starterGroups.some((groupId) => isUserInWorkflowGroup(personaId, groupId)),
  );
  const canCloseByGroup = Boolean(instance && canUserCloseInstance(personaId, instance));
  const isParticipant = Boolean(
    instance?.participantIds?.includes(personaId)
    || participants.includes(persona?.name ?? ""),
  );
  const canTransfer = Boolean(instance && canUserTransferFreeFlow(instance, personaId));
  const canReply = Boolean(
    instance && canUserReplyFreeFlow(instance, personaId, isParticipant || isSuperAdmin),
  );
  const canClose = Boolean(isOpen && canCloseByGroup);
  const canReopen = Boolean(
    instance?.status === "已关闭" &&
    (participants.includes(persona?.name ?? "") || isStarter),
  );
  const canEditInitial = Boolean(
    isOpen && instance && persona && canEditProcessInstanceSubmission(instance, persona, isSuperAdmin),
  );
  const initialEntry = instance?.freeTimeline?.find((entry) => entry.type === "created");
  const hasReplyDraft = hasRichContent(replyContent);
  const collaborationActionLabel = nextAssignee
    ? hasReplyDraft ? "回复并变更" : "变更受理人"
    : canReply ? "发表回复" : "变更受理人";
  const collaborationActionDisabled = nextAssignee
    ? !canTransfer
    : !(canReply && hasReplyDraft);
  const { guard } = useUnsavedChangesGuard({
    dirty: Boolean(
      hasRichContent(replyContent)
      || nextAssignee
      || (editEntry && editContent !== editEntry.content)
      || closeReason.trim()
      || reopenReason.trim()
      || reopenAssignee
      || initialFormDirty
    ),
    title: "协作内容尚未提交",
    description: "离开后，当前回复、表单修改或操作理由将丢失。",
  });

  const timeline = useMemo(() => instance?.freeTimeline ?? [], [instance?.freeTimeline]);

  const refreshResource = async (instanceId: string) => {
    const resource = await flowPilotApi.instances.getResource(instanceId);
    cacheProcessRuntime(resource.data.instance, resource.data.tasks);
    setResourceEtag(resource.etag);
  };

  useEffect(() => {
    if (!instance?.id) return;
    let cancelled = false;
    void flowPilotApi.instances.getResource(instance.id).then((resource) => {
      if (cancelled) return;
      cacheProcessRuntime(resource.data.instance, resource.data.tasks);
      setResourceEtag(resource.etag);
    }).catch(() => {
      if (!cancelled) message.error("流程最新版本加载失败，请刷新后重试");
    });
    return () => { cancelled = true; };
  }, [instance?.id]);

  if (!instance) return null;

  const applyInstanceMutation = async (mutation: (etag: string) => Promise<ProcessInstance>) => {
    if (!resourceEtag) {
      message.warning("流程最新版本尚未加载完成，请稍后重试");
      return undefined;
    }
    try {
      const updated = await mutation(resourceEtag);
      cacheProcessRuntime(updated);
      try {
        await refreshResource(instance.id);
      } catch {
        setResourceEtag(undefined);
        message.warning("操作已完成，但最新流程版本加载失败，请刷新页面后继续操作");
      }
      return updated;
    } catch (error) {
      if (error instanceof ApiError && error.problem.status === 412) {
        void refreshResource(instance.id).catch(() => setResourceEtag(undefined));
        message.error("流程已被其他操作更新，已重新加载最新内容，请确认后再提交");
      } else {
        message.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
      }
      return undefined;
    }
  };

  const submitCollaboration = async () => {
    if (nextAssignee) {
      const assigneeName = findIdentityUser(nextAssignee)?.name ?? "所选人员";
      const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.transfer(
        instance.id,
        nextAssignee,
        hasReplyDraft ? replyContent : undefined,
        etag,
      ));
      if (!updated) return;
      if (hasReplyDraft) {
        setReplyContent("");
      }
      setNextAssignee(undefined);
      message.success(hasReplyDraft ? `回复已发表，受理人已变更为${assigneeName}` : `受理人已变更为${assigneeName}`);
      return;
    }
    if (!hasReplyDraft) return message.warning("请输入回复内容");
    const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.reply(
      instance.id,
      replyContent,
      etag,
    ));
    if (!updated) return;
    setReplyContent("");
    message.success("回复已发表，不改变当前受理人");
  };

  const downloadAttachment = async (attachment: { id: string; name: string }) => {
    try {
      const result = await flowPilotApi.attachments.content(attachment.id);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName || attachment.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "附件下载失败，请稍后重试");
    }
  };

  const beginExcelConversion = async (field: StoredDesignerField, file: File) => {
    setExcelDialog({ field, sourceName: file.name, converting: true });
    try {
      const result = await convertXlsxToPdf(file, field.attachment?.maxPreviewPages ?? 1);
      setExcelDialog({ field, sourceName: file.name, result, converting: false });
    } catch (error) {
      setExcelDialog({
        field,
        sourceName: file.name,
        error: error instanceof Error ? error.message : "Excel 转 PDF 失败",
        converting: false,
      });
    }
  };

  const confirmExcelUpload = async () => {
    if (!excelDialog?.result) return;
    const maxSizeMb = excelDialog.field.attachment?.maxSizeMb ?? 100;
    if (excelDialog.result.file.size > maxSizeMb * 1024 * 1024) {
      message.error(`生成的 PDF 超过 ${maxSizeMb} MB 限制，请减少工作表内容或最大页数`);
      return;
    }
    setConfirmingExcelUpload(true);
    try {
      const record = await flowPilotApi.attachments.upload(excelDialog.result.file, {
        instanceId: instance.id,
        fieldId: excelDialog.field.id,
      });
      const current = initialForm.getFieldValue(excelDialog.field.id) as UploadFile<AttachmentRecord>[] | undefined;
      initialForm.setFieldValue(excelDialog.field.id, [{
        uid: record.id,
        name: record.name,
        size: record.size,
        type: record.contentType,
        status: "done",
        response: record,
      } satisfies UploadFile<AttachmentRecord>]);
      setInitialFormDirty(true);
      setExcelDialog(undefined);
      await cleanupTemporaryAttachments(current, (id) => flowPilotApi.attachments.remove(id));
      message.success("PDF 已确认并暂存，保存初始表单后正式生效");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "PDF 上传失败，请稍后重试");
    } finally {
      setConfirmingExcelUpload(false);
    }
  };

  const removeInitialAttachment = async (file: UploadFile<AttachmentRecord>) => {
    if (file.response?.lifecycle !== "temporary") return true;
    try {
      await flowPilotApi.attachments.remove(file.response.id);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : "暂存附件删除失败");
      return false;
    }
  };

  const discardInitialFormChanges = async () => {
    const attachmentFiles = configuredFields
      .filter((field) => field.type === "attachment")
      .flatMap((field) => {
        const files = initialForm.getFieldValue(field.id) as UploadFile<AttachmentRecord>[] | undefined;
        return files ?? [];
      });
    setInitialEditOpen(false);
    setInitialFormDirty(false);
    setExcelDialog(undefined);
    await cleanupTemporaryAttachments(attachmentFiles, (id) => flowPilotApi.attachments.remove(id));
  };

  const renderInitialEditField = (field: StoredDesignerField) => {
    const wide = ["richtext", "attachment", "table"].includes(field.type);
    const rules = field.type === "table"
      ? [{
          validator: async (_: unknown, rows?: Array<Record<string, unknown>>) => {
            if (field.required && !rows?.length) throw new Error(`请填写${field.label}`);
            const missing = rows?.some((row) => (field.columns ?? [])
              .some((column) => column.required && isEmptyValue(row[column.id])));
            if (missing) throw new Error(`请完整填写${field.label}中的必填列`);
          },
        }]
      : [{ required: field.required, message: `请填写${field.label}` }];
    return <Form.Item
      key={field.id}
      className={wide ? "field-wide" : undefined}
      name={field.id}
      label={field.label}
      extra={field.description || undefined}
      rules={rules}
    >
      <DynamicFieldControl
        field={field}
        convertingExcel={excelDialog?.field.id === field.id && excelDialog.converting}
        onConvertExcel={(targetField, file) => void beginExcelConversion(targetField, file)}
        onRemoveUploadedAttachment={removeInitialAttachment}
      />
    </Form.Item>;
  };

  const saveInitialForm = async () => {
    if (!lockedVersion) return;
    if (!initialFormDirty) return message.warning("初始表单没有变化");
    const uploadedRecords: AttachmentRecord[] = [];
    setSavingInitialForm(true);
    try {
      const editedValues = await initialForm.validateFields();
      const attachmentIdsByField: Record<string, string[]> = {};
      const nextValues = { ...(instance.formValues ?? {}), ...editedValues };
      for (const field of configuredFields.filter((item) => item.type === "attachment")) {
        const files = Array.isArray(editedValues[field.id])
          ? editedValues[field.id] as UploadFile<AttachmentRecord>[]
          : [];
        const records: AttachmentRecord[] = [];
        for (const file of files) {
          if (file.response?.id) {
            records.push(file.response);
            continue;
          }
          if (!file.originFileObj) throw new Error(`无法读取附件“${file.name}”，请重新选择文件`);
          const record = await flowPilotApi.attachments.upload(file.originFileObj, {
            instanceId: instance.id,
            fieldId: field.id,
          });
          records.push(record);
          uploadedRecords.push(record);
        }
        attachmentIdsByField[field.id] = records.map((record) => record.id);
        nextValues[field.id] = records.map((record) => ({
          id: record.id,
          name: record.name,
          size: record.size,
          contentType: record.contentType,
        }));
      }
      const formValues = applyDesignerFieldVisibility(
        lockedVersion.snapshot.form.fields,
        normalizeDesignerFormValues(lockedVersion.snapshot.form.fields, nextValues),
      );
      const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.updateSubmission(instance.id, {
        formValues,
        attachmentIdsByField,
      }, etag));
      if (!updated) throw new Error("初始表单保存失败");
      setInitialEditOpen(false);
      setInitialFormDirty(false);
      message.success("初始表单已按当前流程版本保存，修改记录已写入时间线");
    } catch (error) {
      await Promise.allSettled(uploadedRecords.map((record) => flowPilotApi.attachments.remove(record.id)));
      if (error instanceof Error && error.message !== "初始表单保存失败") message.error(error.message);
    } finally {
      setSavingInitialForm(false);
    }
  };

  const renderSystemEvent = (entry: FreeFlowEntry) => {
    const meta = entryMeta[entry.type as Exclude<FreeFlowEntry["type"], "reply">];
    const changedFieldNames = entry.fieldChanges?.map((change) => change.field).join("、");
    const detail = entry.type === "created"
      ? <>创建事项，首位受理人 <strong>{entry.assignee}</strong></>
      : entry.type === "reply-edited"
        ? <>更新了一条回复内容</>
        : entry.type === "assigned"
          ? <>受理人变更为 <strong>{entry.assignee}</strong></>
          : entry.type === "form-edited"
            ? <>修改了{changedFieldNames || "初始表单"}</>
          : entry.type === "closed"
            ? <>关闭事项：{entry.content}</>
            : entry.type === "reopened"
              ? <>重新打开并指定 <strong>{entry.assignee}</strong>：{entry.content}</>
              : entry.type === "reassigned"
                ? <>将受理人从 <strong>{entry.previousAssignee}</strong> 改派为 <strong>{entry.assignee}</strong>：{entry.content}</>
                : <>{entry.content}</>;
    const fullDetail = entry.type === "form-edited" && entry.fieldChanges?.length
      ? entry.fieldChanges.map((change) => change.before !== undefined && change.after !== undefined
        ? `${change.field}：${change.before} → ${change.after}`
        : change.field).join("；")
      : undefined;
    return (
      <div className="free-system-event">
        <Avatar size={22}>{entry.actor.slice(-1)}</Avatar>
        <Text strong className="free-system-event__actor">{entry.actor}</Text>
        <Tag variant="filled" color={meta.color}>{meta.label}</Tag>
        <Tooltip title={fullDetail ?? (typeof entry.content === "string" ? entry.content : undefined)}>
          <Text className="free-system-event__detail">{detail}</Text>
        </Tooltip>
        <Text type="secondary" className="free-system-event__time">{formatDisplayDateTime(entry.time)}</Text>
      </div>
    );
  };

  return (
    <div className="free-flow-page">
      {guard}
      <div className="free-detail-topbar">
        <AppBackButton onClick={() => navigate("/processes?definitionId=free-collaboration")} />
      </div>
      <div className="free-flow-head free-detail-head">
        <div>
          <Space align="center" wrap>
            <Title level={3}>{instance.title}</Title>
            <StatusPill status={instance.status} />
          </Space>
          <Text type="secondary">{instance.code} · {instance.template} {instance.templateVersion}</Text>
        </div>
        <Space wrap>
          {canEditInitial && <Button icon={<EditOutlined />} onClick={() => {
            initialForm.setFieldsValue({
              ...(instance.formValues ?? {}),
              ...attachmentFilesForEdit(instance, configuredFields),
            });
            setInitialFormDirty(false);
            setInitialEditOpen(true);
          }}>编辑初始表单</Button>}
          {canClose && <Button danger icon={<LockOutlined />} onClick={() => setCloseOpen(true)}>关闭</Button>}
          {canReopen && <Button type="primary" icon={<ReloadOutlined />} onClick={() => setReopenOpen(true)}>重新打开</Button>}
        </Space>
      </div>

      <div className="free-flow-layout">
        <main className="free-flow-main">
          <Card className="free-initial-card" title="初始表单" extra={initialEntry?.editedAt ? <Tag color="gold">已编辑 · {formatDisplayDateTime(initialEntry.editedAt)}</Tag> : null}>
            {configuredFields.length
              ? <InitialFormView fields={configuredFields} instance={instance} onDownload={(attachment) => void downloadAttachment(attachment)} />
              : <Alert type="warning" showIcon title="该实例锁定的流程版本没有初始表单字段" />}
          </Card>

          <div className="free-timeline-heading"><HistoryOutlined /><strong>协作时间线</strong><Tag>{timeline.length} 条记录</Tag></div>
          <Timeline
            className="free-timeline"
            items={timeline.map((entry) => ({
              color: entry.type === "closed" ? "gray" : entry.type === "reopened" ? "green" : entry.type === "reply" ? "blue" : "purple",
              content: entry.type === "reply" ? (
                <Card className="free-reply-card" size="small">
                  <div className="free-reply-card__head">
                    <Space><Avatar size={30}>{entry.actor.slice(-1)}</Avatar><Text strong>{entry.actor}</Text></Space>
                    <Space>
                      {entry.editedAt && <Tooltip title={`首次发表：${formatDisplayDateTime(entry.time)}；最后编辑：${formatDisplayDateTime(entry.editedAt)}`}><Tag variant="filled">已编辑</Tag></Tooltip>}
                      <Text type="secondary">{entry.editedAt ? `最后编辑 ${formatDisplayDateTime(entry.editedAt)}` : formatDisplayDateTime(entry.time)}</Text>
                      {isOpen && entry.actor === persona?.name && (
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditEntry(entry); setEditContent(entry.content ?? ""); }}>编辑</Button>
                      )}
                    </Space>
                  </div>
                  <RichTextContent html={entry.content ?? ""} />
                  {entry.attachments?.length ? (
                    <Space wrap size={[8, 8]}>
                      {entry.attachments.map((attachment) => (
                        <Button
                          key={attachment.id}
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => downloadAttachment(attachment)}
                        >{attachment.name}</Button>
                      ))}
                    </Space>
                  ) : null}
                </Card>
              ) : renderSystemEvent(entry),
            }))}
          />

          {isOpen ? (
            canReply || canTransfer ? (
              <div className="free-compose">
                {canReply && <RichTextEditor value={replyContent} onChange={setReplyContent} placeholder="补充协作信息…" minHeight={180} />}
                <div className="free-compose-actions">
                  <Text type="secondary">发表回复不会改变当前受理人；发起或受理权限组成员可直接变更受理人。</Text>
                  <Space wrap>
                    {canTransfer && (
                      <Select allowClear showSearch optionFilterProp="label" placeholder="选择新受理人（可选）" value={nextAssignee} onChange={setNextAssignee} options={userOptions.filter((option) => option.value !== instance.currentAssigneeId)} style={{ width: 220 }} />
                    )}
                    <Button
                      type="primary"
                      disabled={collaborationActionDisabled}
                      icon={nextAssignee ? <SwapOutlined /> : <MessageOutlined />}
                      onClick={submitCollaboration}
                    >{collaborationActionLabel}</Button>
                  </Space>
                </div>
              </div>
            ) : <Alert showIcon type="info" title="当前为只读查看" description="发起人、当前或历史参与人可以回复；发起或受理权限组成员可以切换当前受理人。" />
          ) : <Alert showIcon icon={<LockOutlined />} type="warning" title="事项已关闭，内容已锁定" description="重新打开后，参与人可继续回复，原作者也可继续编辑自己的历史回复。" />}
        </main>

        <aside className="free-flow-side">
          <Card title="当前责任" size="small">
            {isOpen ? <div className="current-assignee"><Avatar size={42}>{instance.currentAssignee?.slice(-1)}</Avatar><div><Text type="secondary">当前受理人</Text><Text strong>{instance.currentAssignee}</Text></div></div> : <div className="closed-assignee"><LockOutlined /><Text>当前没有待办</Text></div>}
          </Card>
          <Card title="参与人员" size="small">
            <div className="participant-list">{participants.filter((name) => name !== "超级管理员").map((name) => <Tag icon={<UserOutlined />} key={name}>{name}</Tag>)}</div>
          </Card>
          <Card title="事项信息" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="创建时间">{formatDisplayDateTime(instance.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="最后更新">{formatDisplayDateTime(instance.updatedAt)}</Descriptions.Item>
              <Descriptions.Item label="流程版本">{instance.templateVersion}</Descriptions.Item>
            </Descriptions>
          </Card>
        </aside>
      </div>

      <Modal title="编辑我的回复" width={760} open={Boolean(editEntry)} okText="保存修改" onCancel={() => setEditEntry(undefined)} onOk={async () => {
        if (!editEntry || !hasRichContent(editContent)) return message.warning("回复内容不能为空");
        if (editContent.trim() === (editEntry.content ?? "").trim()) return message.warning("回复内容没有变化");
        const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.editReply(instance.id, editEntry.id, editContent, etag));
        if (!updated) return;
        setEditEntry(undefined);
        message.success("回复已更新，仅保留最新内容");
      }}><RichTextEditor value={editContent} onChange={setEditContent} minHeight={260} /></Modal>

      <Modal
        title="编辑初始表单"
        width={900}
        open={initialEditOpen}
        okText="保存修改"
        confirmLoading={savingInitialForm}
        onCancel={() => void discardInitialFormChanges()}
        onOk={() => void saveInitialForm()}
      >
        <Alert type="info" showIcon title="按该实例锁定的流程版本编辑" description="字段、顺序、选项和必填规则均来自发起时使用的版本；字段变化和修改时间会保留在流程记录中。" />
        <Form
          form={initialForm}
          className="free-initial-edit-form"
          layout="vertical"
          onValuesChange={() => setInitialFormDirty(true)}
        >
          <div className="free-runtime-form__grid">
            {configuredFields
              .filter((field) => isDesignerFieldVisible(field, watchedInitialValues ?? instance.formValues ?? {}))
              .map(renderInitialEditField)}
          </div>
        </Form>
      </Modal>

      <ExcelPdfPreviewModal
        sourceName={excelDialog?.sourceName}
        result={excelDialog?.result}
        converting={Boolean(excelDialog?.converting)}
        confirming={confirmingExcelUpload}
        error={excelDialog?.error}
        onCancel={() => setExcelDialog(undefined)}
        onConfirm={() => void confirmExcelUpload()}
      />

      <Modal title="关闭事项" open={closeOpen} okText="确认关闭" okButtonProps={{ danger: true }} onCancel={() => setCloseOpen(false)} onOk={async () => {
        if (!closeReason.trim()) return message.warning("请填写关闭理由");
        const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.close(instance.id, closeReason, etag));
        if (!updated) return;
        setCloseOpen(false); setCloseReason(""); message.success("事项已关闭，操作已进入时间线");
      }}><Input.TextArea rows={4} placeholder="关闭理由（必填）" value={closeReason} onChange={(event) => setCloseReason(event.target.value)} /></Modal>

      <Modal title="重新打开事项" open={reopenOpen} okText="重新打开" onCancel={() => setReopenOpen(false)} onOk={async () => {
        if (!reopenReason.trim() || !reopenAssignee) return message.warning("请填写理由并指定受理人");
        const updated = await applyInstanceMutation((etag) => flowPilotApi.freeFlows.reopen(instance.id, reopenReason, reopenAssignee, etag));
        if (!updated) return;
        setReopenOpen(false); setReopenReason(""); setReopenAssignee(undefined); message.success("事项已重新打开并生成待办");
      }}><div className="free-modal-form"><Alert type="info" showIcon title="重新打开后恢复回复和编辑能力" /><label><span>打开理由</span><Input.TextArea rows={4} value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} /></label><label><span>受理人</span><Select showSearch optionFilterProp="label" value={reopenAssignee} onChange={setReopenAssignee} options={userOptions} /></label></div></Modal>
    </div>
  );
}
