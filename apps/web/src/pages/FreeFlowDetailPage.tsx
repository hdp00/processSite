import {
  ArrowLeftOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  LockOutlined,
  MessageOutlined,
  ReloadOutlined,
  SendOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Descriptions,
  Divider,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from "antd";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { RichTextContent, RichTextEditor } from "../components/RichTextEditor";
import type { FreeFlowEntry, ProcessInstance } from "../data/types";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";
import "./free-flow.css";

const { Text, Title } = Typography;
const userOptions = personas
  .filter((persona) => persona.id !== "hejing")
  .map((persona) => ({ value: persona.name, label: `${persona.name} · ${persona.role}` }));

const hasRichContent = (html: string) =>
  html.replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ").trim().length > 0 || /<(img|video)\b/i.test(html);

const entryMeta: Record<Exclude<FreeFlowEntry["type"], "reply">, { label: string; color: string }> = {
  created: { label: "创建事项", color: "blue" },
  assigned: { label: "转交受理", color: "purple" },
  closed: { label: "关闭事项", color: "gray" },
  reopened: { label: "重新打开", color: "green" },
  "form-edited": { label: "修改初始表单", color: "gold" },
  reassigned: { label: "异常改派", color: "orange" },
};

interface FreeFlowDetailPageProps {
  instanceOverride?: ProcessInstance;
}

export function FreeFlowDetailPage({ instanceOverride }: FreeFlowDetailPageProps) {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    instances,
    personaId,
    replyFreeFlow,
    transferFreeFlow,
    editFreeFlowReply,
    updateFreeFlowInitial,
    forceReassignFreeFlow,
    closeFreeFlow,
    reopenFreeFlow,
  } = usePrototypeStore();
  const instance = instanceOverride ?? instances.find((item) => item.id === id);
  const persona = personas.find((item) => item.id === personaId) ?? personas[0];
  const [replyContent, setReplyContent] = useState("");
  const [nextAssignee, setNextAssignee] = useState<string>();
  const [editEntry, setEditEntry] = useState<FreeFlowEntry>();
  const [editContent, setEditContent] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopenAssignee, setReopenAssignee] = useState<string>();
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignReason, setReassignReason] = useState("");
  const [reassignAssignee, setReassignAssignee] = useState<string>();
  const [initialEditOpen, setInitialEditOpen] = useState(false);
  const [draftInitial, setDraftInitial] = useState({
    title: instance?.title ?? "",
    category: instance?.category ?? "",
    priority: instance?.priority ?? ("普通" as const),
    description: instance?.description ?? "",
    initialContent: instance?.freeTimeline?.find((entry) => entry.type === "created")?.content ?? "",
  });

  const participants = instance?.participants ?? [];
  const isOpen = instance?.status === "进行中";
  const isCurrentAssignee = isOpen && instance?.currentAssignee === persona.name;
  const canReply = Boolean(isOpen && (participants.includes(persona.name) || personaId === "admin"));
  const canClose = Boolean(isCurrentAssignee || (isOpen && ["wangmin", "admin"].includes(personaId)));
  const canReopen = Boolean(
    instance?.status === "已关闭" &&
    (participants.includes(persona.name) || ["wangmin", "admin"].includes(personaId)),
  );
  const canEditInitial = Boolean(isOpen && instance?.initiator === persona.name);
  const canForceReassign = Boolean(isOpen && ["wangmin", "admin"].includes(personaId));
  const initialEntry = instance?.freeTimeline?.find((entry) => entry.type === "created");

  const timeline = useMemo(() => instance?.freeTimeline ?? [], [instance?.freeTimeline]);

  if (!instance) return null;

  const postReply = () => {
    if (!hasRichContent(replyContent)) return message.warning("请输入回复内容");
    replyFreeFlow(instance.id, replyContent);
    setReplyContent("");
    message.success("回复已发表，不改变当前受理人");
  };

  const transfer = () => {
    if (!hasRichContent(replyContent)) return message.warning("请填写本次处理内容");
    if (!nextAssignee) return message.warning("请选择下一位受理人");
    transferFreeFlow(instance.id, replyContent, nextAssignee);
    setReplyContent("");
    setNextAssignee(undefined);
    message.success(`事项已转交给${nextAssignee}`);
  };

  const renderSystemEvent = (entry: FreeFlowEntry) => {
    const meta = entryMeta[entry.type as Exclude<FreeFlowEntry["type"], "reply">];
    const detail = entry.type === "created"
      ? <>创建事项，首位受理人 <strong>{entry.assignee}</strong></>
      : entry.type === "assigned"
        ? <>转交给 <strong>{entry.assignee}</strong></>
        : entry.type === "closed"
          ? <>关闭事项：{entry.content}</>
          : entry.type === "reopened"
            ? <>重新打开并指定 <strong>{entry.assignee}</strong>：{entry.content}</>
            : entry.type === "reassigned"
              ? <>将受理人从 <strong>{entry.previousAssignee}</strong> 改派为 <strong>{entry.assignee}</strong>：{entry.content}</>
              : <>{entry.content}</>;
    const fullDetail = entry.type === "form-edited" && entry.fieldChanges?.length
      ? entry.fieldChanges.map((change) => `${change.field}：${change.before} → ${change.after}`).join("；")
      : undefined;
    return (
      <div className="free-system-event">
        <Avatar size={22}>{entry.actor.slice(-1)}</Avatar>
        <Text strong className="free-system-event__actor">{entry.actor}</Text>
        <Tag bordered={false} color={meta.color}>{meta.label}</Tag>
        <Tooltip title={fullDetail ?? (typeof entry.content === "string" ? entry.content : undefined)}>
          <Text className="free-system-event__detail">{detail}</Text>
        </Tooltip>
        <Text type="secondary" className="free-system-event__time">{entry.time}</Text>
      </div>
    );
  };

  return (
    <div className="free-flow-page">
      <div className="free-detail-topbar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate("/processes?definitionId=free-collaboration")}>返回流程清单</Button>
      </div>
      <div className="free-flow-head free-detail-head">
        <div>
          <Space align="center" wrap>
            <Title level={3}>{instance.title}</Title>
            <span className={`status-pill ${isOpen ? "is-reviewing" : "is-closed"}`}><span className="status-pill-dot" />{instance.status}</span>
          </Space>
          <Text type="secondary">{instance.code} · {instance.template} {instance.templateVersion}</Text>
        </div>
        <Space wrap>
          {canEditInitial && <Button icon={<EditOutlined />} onClick={() => {
            setDraftInitial({
              title: instance.title,
              category: instance.category ?? "",
              priority: instance.priority,
              description: instance.description,
              initialContent: initialEntry?.content ?? "",
            });
            setInitialEditOpen(true);
          }}>编辑初始表单</Button>}
          {canForceReassign && <Button icon={<SwapOutlined />} onClick={() => setReassignOpen(true)}>异常改派</Button>}
          {canClose && <Button danger icon={<LockOutlined />} onClick={() => setCloseOpen(true)}>关闭事项</Button>}
          {canReopen && <Button type="primary" icon={<ReloadOutlined />} onClick={() => setReopenOpen(true)}>重新打开</Button>}
        </Space>
      </div>

      <div className="free-flow-layout">
        <main className="free-flow-main">
          <Card className="free-initial-card" title="初始表单" extra={initialEntry?.editedAt ? <Tag color="gold">已编辑 · {initialEntry.editedAt}</Tag> : null}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="事项分类">{instance.category}</Descriptions.Item>
              <Descriptions.Item label="优先级"><Tag color={instance.priority === "紧急" ? "red" : "default"}>{instance.priority}</Tag></Descriptions.Item>
              <Descriptions.Item label="发起人">{instance.initiator}</Descriptions.Item>
              <Descriptions.Item label="附件">{instance.pdfName}</Descriptions.Item>
              <Descriptions.Item label="事项摘要" span={2}>{instance.description}</Descriptions.Item>
            </Descriptions>
            <Divider />
            <RichTextContent html={initialEntry?.content ?? ""} />
          </Card>

          <div className="free-timeline-heading"><HistoryOutlined /><strong>协作时间线</strong><Tag>{timeline.length} 条记录</Tag></div>
          <Timeline
            className="free-timeline"
            items={timeline.map((entry) => ({
              color: entry.type === "closed" ? "gray" : entry.type === "reopened" ? "green" : entry.type === "reply" ? "blue" : "purple",
              children: entry.type === "reply" ? (
                <Card className="free-reply-card" size="small">
                  <div className="free-reply-card__head">
                    <Space><Avatar size={30}>{entry.actor.slice(-1)}</Avatar><Text strong>{entry.actor}</Text>{entry.assignee && <Tag color="purple">处理并转交</Tag>}</Space>
                    <Space>
                      {entry.editedAt && <Tooltip title={`最后编辑：${entry.editedAt}；后台保留 ${entry.revisions?.length ?? 0} 个历史版本`}><Tag bordered={false}>已编辑</Tag></Tooltip>}
                      <Text type="secondary">{entry.time}</Text>
                      {isOpen && entry.actor === persona.name && (
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setEditEntry(entry); setEditContent(entry.content ?? ""); }}>编辑</Button>
                      )}
                    </Space>
                  </div>
                  <RichTextContent html={entry.content ?? ""} />
                </Card>
              ) : renderSystemEvent(entry),
            }))}
          />

          {isOpen ? (
            canReply ? (
              <Card className="free-compose-card" title={<Space><MessageOutlined />新增回复</Space>}>
                <RichTextEditor value={replyContent} onChange={setReplyContent} placeholder="补充信息，或由当前受理人填写处理结果…" minHeight={180} />
                <div className="free-compose-actions">
                  <Text type="secondary">发表回复不会改变当前受理人。</Text>
                  <Space wrap>
                    <Button icon={<MessageOutlined />} onClick={postReply}>发表回复</Button>
                    {isCurrentAssignee && (
                      <>
                        <Select showSearch optionFilterProp="label" placeholder="选择下一位受理人" value={nextAssignee} onChange={setNextAssignee} options={userOptions.filter((option) => option.value !== persona.name)} style={{ width: 210 }} />
                        <Button type="primary" icon={<SendOutlined />} onClick={transfer}>处理并转交</Button>
                      </>
                    )}
                  </Space>
                </div>
              </Card>
            ) : <Alert showIcon type="info" message="当前为只读查看" description="只有发起人、当前或历史参与人可以新增回复。" />
          ) : <Alert showIcon icon={<LockOutlined />} type="warning" message="事项已关闭，内容已锁定" description="重新打开后，参与人可继续回复，原作者也可继续编辑自己的历史回复。" />}
        </main>

        <aside className="free-flow-side">
          <Card title="当前责任" size="small">
            {isOpen ? <div className="current-assignee"><Avatar size={42}>{instance.currentAssignee?.slice(-1)}</Avatar><div><Text type="secondary">当前受理人</Text><Text strong>{instance.currentAssignee}</Text></div></div> : <div className="closed-assignee"><LockOutlined /><Text>当前没有待办</Text></div>}
          </Card>
          <Card title="参与人员" size="small">
            <div className="participant-list">{participants.map((name) => <Tag icon={<UserOutlined />} key={name}>{name}</Tag>)}</div>
          </Card>
          <Card title="事项信息" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="创建时间">{instance.createdAt}</Descriptions.Item>
              <Descriptions.Item label="最后更新">{instance.updatedAt}</Descriptions.Item>
              <Descriptions.Item label="流程版本">{instance.templateVersion}</Descriptions.Item>
              <Descriptions.Item label="打印">不支持 PDF 打印</Descriptions.Item>
            </Descriptions>
          </Card>
        </aside>
      </div>

      <Modal title="编辑我的回复" width={760} open={Boolean(editEntry)} okText="保存修改" onCancel={() => setEditEntry(undefined)} onOk={() => {
        if (!editEntry || !hasRichContent(editContent)) return message.warning("回复内容不能为空");
        editFreeFlowReply(instance.id, editEntry.id, editContent);
        setEditEntry(undefined);
        message.success("回复已更新并保留历史版本");
      }}><RichTextEditor value={editContent} onChange={setEditContent} minHeight={260} /></Modal>

      <Modal title="编辑初始表单" width={800} open={initialEditOpen} okText="保存修改" onCancel={() => setInitialEditOpen(false)} onOk={() => {
        if (!draftInitial.title.trim() || !hasRichContent(draftInitial.initialContent)) return message.warning("请填写标题和初始说明");
        updateFreeFlowInitial(instance.id, draftInitial);
        setInitialEditOpen(false);
        message.success("初始表单已更新，修改记录已写入时间线");
      }}>
        <Alert type="info" showIcon message="进行中允许发起人修改，关闭后自动锁定" description="字段变化和修改时间会保留在流程记录中。" />
        <div className="free-modal-form">
          <label><span>事项标题</span><Input value={draftInitial.title} onChange={(event) => setDraftInitial((current) => ({ ...current, title: event.target.value }))} /></label>
          <div className="free-modal-grid">
            <label><span>事项分类</span><Select value={draftInitial.category} onChange={(category) => setDraftInitial((current) => ({ ...current, category }))} options={["生产异常", "质量问题", "设计问题", "测试记录", "一般协作"].map((value) => ({ value }))} /></label>
            <label><span>优先级</span><Select value={draftInitial.priority} onChange={(priority) => setDraftInitial((current) => ({ ...current, priority }))} options={["普通", "紧急"].map((value) => ({ value }))} /></label>
          </div>
          <label><span>事项摘要</span><Input.TextArea value={draftInitial.description} onChange={(event) => setDraftInitial((current) => ({ ...current, description: event.target.value }))} /></label>
          <label><span>初始说明</span><RichTextEditor value={draftInitial.initialContent} onChange={(initialContent) => setDraftInitial((current) => ({ ...current, initialContent }))} minHeight={220} /></label>
        </div>
      </Modal>

      <Modal title="关闭事项" open={closeOpen} okText="确认关闭" okButtonProps={{ danger: true }} onCancel={() => setCloseOpen(false)} onOk={() => {
        if (!closeReason.trim()) return message.warning("请填写关闭理由");
        closeFreeFlow(instance.id, closeReason);
        setCloseOpen(false); setCloseReason(""); message.success("事项已关闭，操作已进入时间线");
      }}><Input.TextArea rows={4} placeholder="关闭理由（必填）" value={closeReason} onChange={(event) => setCloseReason(event.target.value)} /></Modal>

      <Modal title="重新打开事项" open={reopenOpen} okText="重新打开" onCancel={() => setReopenOpen(false)} onOk={() => {
        if (!reopenReason.trim() || !reopenAssignee) return message.warning("请填写理由并指定受理人");
        reopenFreeFlow(instance.id, reopenReason, reopenAssignee);
        setReopenOpen(false); setReopenReason(""); setReopenAssignee(undefined); message.success("事项已重新打开并生成待办");
      }}><div className="free-modal-form"><Alert type="info" showIcon message="重新打开后恢复回复和编辑能力" /><label><span>打开理由</span><Input.TextArea rows={4} value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} /></label><label><span>受理人</span><Select showSearch optionFilterProp="label" value={reopenAssignee} onChange={setReopenAssignee} options={userOptions} /></label></div></Modal>

      <Modal title="异常改派" open={reassignOpen} okText="确认改派" onCancel={() => setReassignOpen(false)} onOk={() => {
        if (!reassignReason.trim() || !reassignAssignee) return message.warning("请填写改派理由并选择新受理人");
        forceReassignFreeFlow(instance.id, reassignReason, reassignAssignee);
        setReassignOpen(false); setReassignReason(""); setReassignAssignee(undefined); message.success("已改派，原待办取消并生成新待办");
      }}><div className="free-modal-form"><Alert type="warning" showIcon icon={<ExclamationCircleOutlined />} message="仅发起流程权限组可执行" description={`当前受理人：${instance.currentAssignee}。异常改派会写入时间线。`} /><label><span>新受理人</span><Select showSearch optionFilterProp="label" value={reassignAssignee} onChange={setReassignAssignee} options={userOptions.filter((option) => option.value !== instance.currentAssignee)} /></label><label><span>改派理由</span><Input.TextArea rows={4} value={reassignReason} onChange={(event) => setReassignReason(event.target.value)} /></label></div></Modal>
    </div>
  );
}
