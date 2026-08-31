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
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { getRichMedia, richMediaIdFromSource, richMediaSource, saveRichMedia } from "../utils/richMediaRepository";
import "./rich-text-editor.css";

const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      mediaId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-media-id"),
        renderHTML: (attributes) => attributes.mediaId ? { "data-media-id": attributes.mediaId } : {},
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
      mediaId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-media-id"),
        renderHTML: (attributes) => attributes.mediaId ? { "data-media-id": attributes.mediaId } : {},
      },
    };
  },
});

const normalizeMediaSourcesForStorage = (documentNode: Document) => {
  documentNode.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img,video").forEach((node) => {
    const mediaId = node.getAttribute("data-media-id") ?? richMediaIdFromSource(node.getAttribute("src"));
    if (mediaId) {
      node.setAttribute("data-media-id", mediaId);
      node.setAttribute("src", richMediaSource(mediaId));
      return;
    }
    const source = node.getAttribute("src") ?? "";
    if (/^(data|blob):/i.test(source)) node.remove();
  });
};

export const sanitizeRichText = (html: string) => {
  if (typeof window === "undefined") return "";
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  normalizeMediaSourcesForStorage(documentNode);
  documentNode.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img,video").forEach((node) => {
    if (!richMediaIdFromSource(node.getAttribute("src"))) node.remove();
  });
  documentNode.querySelectorAll<HTMLAnchorElement>("a").forEach((node) => {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  });
  return DOMPurify.sanitize(documentNode.body.innerHTML, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "s", "ul", "ol", "li", "blockquote", "code", "pre",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "video",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "title", "controls", "data-media-id"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
};

const hydrateRichText = async (html: string) => {
  if (typeof window === "undefined" || !html) return { html, objectUrls: [] as string[] };
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  const objectUrls: string[] = [];
  await Promise.all([...documentNode.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img[data-media-id],video[data-media-id]")].map(async (node) => {
    const mediaId = node.dataset.mediaId;
    if (!mediaId) return;
    try {
      const record = await getRichMedia(mediaId);
      if (!record) {
        node.replaceWith(documentNode.createTextNode(`【媒体文件已不存在：${node.getAttribute("title") ?? mediaId}】`));
        return;
      }
      const objectUrl = URL.createObjectURL(record.blob);
      objectUrls.push(objectUrl);
      node.setAttribute("src", objectUrl);
    } catch {
      node.replaceWith(documentNode.createTextNode("【媒体文件读取失败】"));
    }
  }));
  return { html: documentNode.body.innerHTML, objectUrls };
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
  const objectUrlsRef = useRef<string[]>([]);
  const lastEmittedValueRef = useRef<string | undefined>(undefined);
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
    let cancelled = false;
    void hydrateRichText(value || "").then((hydrated) => {
      if (cancelled) {
        hydrated.objectUrls.forEach(URL.revokeObjectURL);
        return;
      }
      objectUrlsRef.current.forEach(URL.revokeObjectURL);
      objectUrlsRef.current = hydrated.objectUrls;
      editor.commands.setContent(hydrated.html, { emitUpdate: false });
    });
    return () => { cancelled = true; };
  }, [editor, value]);

  useEffect(() => () => objectUrlsRef.current.forEach(URL.revokeObjectURL), []);

  const insertMedia = async (file: File, kind: "image" | "video") => {
    if (!editor) return;
    const maxSize = kind === "image" ? 1.5 : 6;
    if (file.size > maxSize * 1024 * 1024) {
      message.warning(`原型中的${kind === "image" ? "图片" : "视频"}请控制在 ${maxSize} MB 以内`);
      return;
    }
    setUploadingMedia(true);
    try {
      const record = await saveRichMedia(file);
      const src = URL.createObjectURL(record.blob);
      objectUrlsRef.current.push(src);
      if (kind === "image") {
        editor.chain().focus().insertContent({ type: "image", attrs: { src, alt: file.name, title: file.name, mediaId: record.id } }).run();
      } else {
        editor.chain().focus().insertContent({ type: "video", attrs: { src, title: file.name, mediaId: record.id } }).run();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "富媒体文件保存失败");
    } finally {
      setUploadingMedia(false);
    }
  };

  const selectMedia = (kind: "image" | "video") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "image" ? "image/*" : "video/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void insertMedia(file, kind);
    };
    input.click();
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
            <Tooltip title="上传图片"><Button type="text" size="small" loading={uploadingMedia} icon={<PictureOutlined />} onClick={() => selectMedia("image")} /></Tooltip>
            <Tooltip title="上传视频"><Button type="text" size="small" loading={uploadingMedia} icon={<VideoCameraOutlined />} onClick={() => selectMedia("video")} /></Tooltip>
          </Space>
          <span className="rich-editor__hint">Tiptap · 支持文字、图片、视频和链接</span>
        </div>
      )}
      <EditorContent editor={editor} className="rich-editor__content" />
    </div>
  );
}

export function RichTextContent({ html }: { html: string }) {
  const [hydratedHtml, setHydratedHtml] = useState(() => sanitizeRichText(html));
  useEffect(() => {
    let cancelled = false;
    let objectUrls: string[] = [];
    void hydrateRichText(sanitizeRichText(html)).then((hydrated) => {
      objectUrls = hydrated.objectUrls;
      if (cancelled) objectUrls.forEach(URL.revokeObjectURL);
      else setHydratedHtml(hydrated.html);
    });
    return () => {
      cancelled = true;
      objectUrls.forEach(URL.revokeObjectURL);
    };
  }, [html]);
  return <div className="rich-content" dangerouslySetInnerHTML={{ __html: hydratedHtml }} />;
}
