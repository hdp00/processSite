import {
  BoldOutlined,
  ItalicOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  StrikethroughOutlined,
  UnorderedListOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import { mergeAttributes, Node } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { App, Button, Space, Tooltip } from "antd";
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { flowPilotApi } from "../api/flowPilotApi";
import "./rich-text-editor.css";

const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-attachment-id"),
        renderHTML: (attributes) => attributes.attachmentId ? { "data-attachment-id": attributes.attachmentId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "video[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(HTMLAttributes, { controls: "true" })];
  },
});

const StoredImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-attachment-id"),
        renderHTML: (attributes) => attributes.attachmentId ? { "data-attachment-id": attributes.attachmentId } : {},
      },
    };
  },
});

const attachmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const attachmentIdFromSource = (source: string | null) =>
  source?.match(/\/attachments\/([0-9a-f-]{36})\/content(?:\?|$)/i)?.[1];

const attachmentMediaSource = (attachmentId: string) => {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL || "/api/flowpilot/v1").replace(/\/$/, "");
  return `${baseUrl}/attachments/${encodeURIComponent(attachmentId)}/content?disposition=inline`;
};

const normalizeMediaSourcesForStorage = (documentNode: Document) => {
  documentNode.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img,video").forEach((node) => {
    const attachmentId = node.getAttribute("data-attachment-id") ?? attachmentIdFromSource(node.getAttribute("src"));
    if (attachmentId && attachmentIdPattern.test(attachmentId)) {
      node.setAttribute("data-attachment-id", attachmentId);
      node.setAttribute("src", attachmentMediaSource(attachmentId));
      return;
    }
    node.remove();
  });
};

export const sanitizeRichText = (html: string) => {
  if (typeof window === "undefined") return "";
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  normalizeMediaSourcesForStorage(documentNode);
  documentNode.querySelectorAll<HTMLAnchorElement>("a").forEach((node) => {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  });
  return DOMPurify.sanitize(documentNode.body.innerHTML, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "s", "ul", "ol", "li", "blockquote", "code", "pre",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "video",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "src", "controls", "data-attachment-id"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
};

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "输入处理内容…",
  minHeight = 150,
  disabled = false,
}: RichTextEditorProps) {
  const { message } = App.useApp();
  const lastEmittedValueRef = useRef<string | undefined>(undefined);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit,
      StoredImage.configure({ allowBase64: false }),
      Video,
      Placeholder.configure({ placeholder }),
    ],
    content: value || "",
    onUpdate: ({ editor: currentEditor }) => {
      const nextValue = sanitizeRichText(currentEditor.getHTML());
      lastEmittedValueRef.current = nextValue;
      onChange(nextValue);
    },
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || value === lastEmittedValueRef.current) return;
    editor.commands.setContent(sanitizeRichText(value || ""), { emitUpdate: false });
  }, [editor, value]);

  const insertMedia = async (file: File, kind: "image" | "video") => {
    if (!editor) return;
    const maxSize = kind === "image" ? 1.5 : 6;
    if (file.size > maxSize * 1024 * 1024) {
      message.warning(`${kind === "image" ? "图片" : "视频"}请控制在 ${maxSize} MB 以内`);
      return;
    }
    setUploadingMedia(true);
    try {
      const record = await flowPilotApi.attachments.upload(file, { purpose: "rich-text-media" });
      const src = attachmentMediaSource(record.id);
      if (kind === "image") {
        editor.chain().focus().insertContent({ type: "image", attrs: { src, attachmentId: record.id } }).run();
      } else {
        editor.chain().focus().insertContent({ type: "video", attrs: { src, attachmentId: record.id } }).run();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "富媒体文件保存失败");
    } finally {
      setUploadingMedia(false);
    }
  };

  const selectMedia = (kind: "image" | "video") => {
    (kind === "image" ? imageInputRef : videoInputRef).current?.click();
  };

  const handleMediaSelection = (kind: "image" | "video", file: File | undefined, input: HTMLInputElement) => {
    input.value = "";
    if (file) void insertMedia(file, kind);
  };

  if (!editor) return null;

  return (
    <div className={`rich-editor${disabled ? " is-disabled" : ""}`} style={{ ["--rich-editor-min-height" as string]: `${minHeight}px` }}>
      {!disabled && (
        <div className="rich-editor__toolbar" aria-label="富文本工具栏">
          <Space size={2}>
            <Tooltip title="加粗"><Button aria-label="加粗" className={editor.isActive("bold") ? "is-active" : ""} type="text" size="small" icon={<BoldOutlined />} onClick={() => editor.chain().focus().toggleBold().run()} /></Tooltip>
            <Tooltip title="斜体"><Button aria-label="斜体" className={editor.isActive("italic") ? "is-active" : ""} type="text" size="small" icon={<ItalicOutlined />} onClick={() => editor.chain().focus().toggleItalic().run()} /></Tooltip>
            <Tooltip title="删除线"><Button aria-label="删除线" className={editor.isActive("strike") ? "is-active" : ""} type="text" size="small" icon={<StrikethroughOutlined />} onClick={() => editor.chain().focus().toggleStrike().run()} /></Tooltip>
            <Tooltip title="无序列表"><Button aria-label="无序列表" className={editor.isActive("bulletList") ? "is-active" : ""} type="text" size="small" icon={<UnorderedListOutlined />} onClick={() => editor.chain().focus().toggleBulletList().run()} /></Tooltip>
            <Tooltip title="有序列表"><Button aria-label="有序列表" className={editor.isActive("orderedList") ? "is-active" : ""} type="text" size="small" icon={<OrderedListOutlined />} onClick={() => editor.chain().focus().toggleOrderedList().run()} /></Tooltip>
            <Tooltip title="插入链接"><Button aria-label="插入链接" type="text" size="small" icon={<LinkOutlined />} onClick={() => {
              const url = window.prompt("请输入链接地址", editor.getAttributes("link").href ?? "https://");
              if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            }} /></Tooltip>
            <Tooltip title="上传图片"><Button aria-label="上传图片" type="text" size="small" loading={uploadingMedia} icon={<PictureOutlined />} onClick={() => selectMedia("image")} /></Tooltip>
            <Tooltip title="上传视频"><Button aria-label="上传视频" type="text" size="small" loading={uploadingMedia} icon={<VideoCameraOutlined />} onClick={() => selectMedia("video")} /></Tooltip>
            <input ref={imageInputRef} className="rich-editor__file-input" type="file" accept="image/*" hidden tabIndex={-1} aria-hidden="true" onChange={(event) => handleMediaSelection("image", event.currentTarget.files?.[0], event.currentTarget)} />
            <input ref={videoInputRef} className="rich-editor__file-input" type="file" accept="video/*" hidden tabIndex={-1} aria-hidden="true" onChange={(event) => handleMediaSelection("video", event.currentTarget.files?.[0], event.currentTarget)} />
          </Space>
          <span className="rich-editor__hint">Tiptap · 支持文字、图片、视频和链接</span>
        </div>
      )}
      <EditorContent editor={editor} className="rich-editor__content" />
    </div>
  );
}

export function RichTextContent({ html }: { html: string }) {
  return <div className="rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichText(html) }} />;
}
