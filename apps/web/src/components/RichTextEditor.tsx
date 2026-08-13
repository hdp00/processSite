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
import { Button, Space, Tooltip, message } from "antd";
import { useEffect, useRef, type ChangeEvent } from "react";
import "./rich-text-editor.css";

const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "video[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(HTMLAttributes, { controls: "true" })];
  },
});

export const sanitizeRichText = (html: string) => {
  if (typeof window === "undefined") return html;
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  documentNode.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
  documentNode.querySelectorAll("*").forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  return documentNode.body.innerHTML;
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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit,
      Image.configure({ allowBase64: true }),
      Video,
      Placeholder.configure({ placeholder }),
    ],
    content: value || "",
    onUpdate: ({ editor: currentEditor }) => onChange(sanitizeRichText(currentEditor.getHTML())),
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [editor, value]);

  const insertMedia = (event: ChangeEvent<HTMLInputElement>, kind: "image" | "video") => {
    const file = event.target.files?.[0];
    if (!file || !editor) return;
    const maxSize = kind === "image" ? 1.5 : 6;
    if (file.size > maxSize * 1024 * 1024) {
      message.warning(`原型中的${kind === "image" ? "图片" : "视频"}请控制在 ${maxSize} MB 以内`);
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      if (kind === "image") {
        editor.chain().focus().setImage({ src, alt: file.name, title: file.name }).run();
      } else {
        editor.chain().focus().insertContent({ type: "video", attrs: { src, title: file.name } }).run();
      }
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  if (!editor) return null;

  return (
    <div className={`rich-editor${disabled ? " is-disabled" : ""}`} style={{ ["--rich-editor-min-height" as string]: `${minHeight}px` }}>
      {!disabled && (
        <div className="rich-editor__toolbar" aria-label="富文本工具栏">
          <Space size={2}>
            <Tooltip title="加粗"><Button className={editor.isActive("bold") ? "is-active" : ""} type="text" size="small" icon={<BoldOutlined />} onClick={() => editor.chain().focus().toggleBold().run()} /></Tooltip>
            <Tooltip title="斜体"><Button className={editor.isActive("italic") ? "is-active" : ""} type="text" size="small" icon={<ItalicOutlined />} onClick={() => editor.chain().focus().toggleItalic().run()} /></Tooltip>
            <Tooltip title="删除线"><Button className={editor.isActive("strike") ? "is-active" : ""} type="text" size="small" icon={<StrikethroughOutlined />} onClick={() => editor.chain().focus().toggleStrike().run()} /></Tooltip>
            <Tooltip title="无序列表"><Button className={editor.isActive("bulletList") ? "is-active" : ""} type="text" size="small" icon={<UnorderedListOutlined />} onClick={() => editor.chain().focus().toggleBulletList().run()} /></Tooltip>
            <Tooltip title="有序列表"><Button className={editor.isActive("orderedList") ? "is-active" : ""} type="text" size="small" icon={<OrderedListOutlined />} onClick={() => editor.chain().focus().toggleOrderedList().run()} /></Tooltip>
            <Tooltip title="插入链接"><Button type="text" size="small" icon={<LinkOutlined />} onClick={() => {
              const url = window.prompt("请输入链接地址", editor.getAttributes("link").href ?? "https://");
              if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            }} /></Tooltip>
            <Tooltip title="上传图片"><Button type="text" size="small" icon={<PictureOutlined />} onClick={() => imageInputRef.current?.click()} /></Tooltip>
            <Tooltip title="上传视频"><Button type="text" size="small" icon={<VideoCameraOutlined />} onClick={() => videoInputRef.current?.click()} /></Tooltip>
          </Space>
          <span className="rich-editor__hint">Tiptap · 支持文字、图片、视频和链接</span>
        </div>
      )}
      <EditorContent editor={editor} className="rich-editor__content" />
      <input ref={imageInputRef} hidden type="file" accept="image/*" onChange={(event) => insertMedia(event, "image")} />
      <input ref={videoInputRef} hidden type="file" accept="video/*" onChange={(event) => insertMedia(event, "video")} />
    </div>
  );
}

export function RichTextContent({ html }: { html: string }) {
  return <div className="rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichText(html) }} />;
}
