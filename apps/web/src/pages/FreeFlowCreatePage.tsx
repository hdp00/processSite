import { InboxOutlined, SendOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Input, Select, Upload, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppBackButton } from "../components/AppBackButton";
import { RichTextEditor } from "../components/RichTextEditor";
import { getEffectiveVersion, useProcessDefinitionStore } from "../state/useProcessDefinitionStore";
import { personas, usePrototypeStore } from "../state/usePrototypeStore";
import "./free-flow.css";

const assigneeOptions = personas
  .filter((persona) => persona.id !== "hejing" && persona.id !== "superadmin")
  .map((persona) => ({ value: persona.name, label: `${persona.name} · ${persona.role}` }));

export function FreeFlowCreatePage() {
  const navigate = useNavigate();
  const createFreeFlow = usePrototypeStore((state) => state.createFreeFlow);
  const instancePrefix = useProcessDefinitionStore((state) => {
    const definition = state.definitions.find((item) => item.id === "free-collaboration");
    return getEffectiveVersion(definition)?.basic.instancePrefix
      ?? definition?.draft?.basic.instancePrefix
      ?? "ISSUE";
  });
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("一般协作");
  const [priority, setPriority] = useState<"普通" | "紧急">("普通");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [attachmentName, setAttachmentName] = useState<string>();
  const [assignee, setAssignee] = useState<string>();

  const submit = () => {
    const plainContent = content.replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ").trim();
    if (!title.trim() || !description.trim() || !plainContent || !assignee) {
      message.warning("请完整填写标题、摘要、初始说明和首位受理人");
      return;
    }
    const id = createFreeFlow({ title, category, priority, description, initialContent: content, attachmentName, assignee, instancePrefix });
    message.success("自由协作事项已创建，并生成首位受理人的待办");
    navigate(`/processes/${id}`);
  };

  return (
    <div className="free-create-page">
      <div className="free-flow-head free-create-actions">
        <AppBackButton onClick={() => navigate("/processes?definitionId=free-collaboration")} />
        <Button type="primary" size="large" icon={<SendOutlined />} onClick={submit}>创建并发布</Button>
      </div>

      <Card className="free-create-card" title="初始表单">
        <Alert type="info" showIcon message="事项进行中时，发起人可以修改初始表单" description="关闭后自动锁定；重新打开后恢复编辑，所有修改都会写入时间线。" />
        <div className="free-create-form">
          <label><span>事项标题 *</span><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="用一句话说明需要协作处理的事项" maxLength={120} showCount /></label>
          <div className="free-modal-grid">
            <label><span>事项分类 *</span><Select value={category} onChange={setCategory} options={["生产异常", "质量问题", "设计问题", "测试记录", "一般协作"].map((value) => ({ value }))} /></label>
            <label><span>优先级 *</span><Select value={priority} onChange={setPriority} options={["普通", "紧急"].map((value) => ({ value }))} /></label>
          </div>
          <label><span>事项摘要 *</span><Input.TextArea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="供流程清单和任务中心快速了解事项" /></label>
          <label><span>初始说明 *</span><RichTextEditor value={content} onChange={setContent} placeholder="详细描述背景、现象、期望结果，可插入图片和视频…" minHeight={240} /></label>
          <label>
            <span>附件</span>
            <Upload.Dragger beforeUpload={(file) => { setAttachmentName(file.name); return false; }} maxCount={1} onRemove={() => setAttachmentName(undefined)}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或拖拽上传补充附件</p>
              <p className="ant-upload-hint">富文本中的图片和视频可直接插入；其他文件在此上传。</p>
            </Upload.Dragger>
          </label>
          <label><span>首位受理人 *</span><Select showSearch optionFilterProp="label" placeholder="搜索并选择一位受理人" value={assignee} onChange={setAssignee} options={assigneeOptions} /></label>
        </div>
      </Card>
    </div>
  );
}
