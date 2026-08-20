export interface RuntimeAttachmentDisplayItem {
  id?: string;
  name: string;
  sourceIndex: number;
}

interface ResolveRuntimeAttachmentsInput {
  fieldId: string;
  value: unknown;
  fallbackNames?: string[];
  attachmentIdsByField?: Record<string, string[]>;
  attachmentIds?: string[];
  primaryField?: boolean;
}

interface ResolveRuntimeAttachmentNamesInput {
  fields: Array<{ id: string; type: string }>;
  values?: Record<string, unknown>;
  fallbackNames?: string[];
}

const attachmentName = (item: unknown) => typeof item === "string"
  ? item
  : item && typeof item === "object" && "name" in item
    ? String((item as { name?: unknown }).name ?? "")
    : "";

const attachmentId = (item: unknown) => item && typeof item === "object" && "id" in item
  ? String((item as { id?: unknown }).id ?? "")
  : "";

const validAttachmentName = (name: string) => name.trim() && !["无附件", "—"].includes(name.trim());

export const resolveRuntimeAttachmentNames = ({
  fields,
  values = {},
  fallbackNames = [],
}: ResolveRuntimeAttachmentNamesInput) => {
  const attachmentFields = fields.filter((field) => field.type === "attachment");
  if (!attachmentFields.length) return [];
  const hasVersionFieldValue = attachmentFields.some((field) => Object.prototype.hasOwnProperty.call(values, field.id));
  const configuredNames = attachmentFields.flatMap((field) => {
    const value = values[field.id];
    return Array.isArray(value) ? value.map(attachmentName) : [];
  });
  const source = hasVersionFieldValue ? configuredNames : fallbackNames;
  return [...new Set(source.map((name) => name.trim()).filter(validAttachmentName))];
};

export const resolveRuntimeAttachments = ({
  fieldId,
  value,
  fallbackNames = [],
  attachmentIdsByField,
  attachmentIds,
  primaryField,
}: ResolveRuntimeAttachmentsInput): RuntimeAttachmentDisplayItem[] => {
  const fallbackIds = attachmentIdsByField?.[fieldId]
    ?? (primaryField ? attachmentIds ?? [] : []);
  const values = Array.isArray(value) ? value : [];
  const fromValues = values.map((entry, sourceIndex) => ({
    id: attachmentId(entry) || fallbackIds[sourceIndex] || undefined,
    name: attachmentName(entry),
    sourceIndex,
  })).filter((entry) => validAttachmentName(entry.name));
  if (fromValues.length) return fromValues;
  if (!primaryField) return [];
  return fallbackNames.map((name, sourceIndex) => ({
    id: fallbackIds[sourceIndex],
    name,
    sourceIndex,
  })).filter((entry) => validAttachmentName(entry.name));
};

export const pdfPreviewBlob = (blob: Blob, fileName: string) =>
  fileName.toLowerCase().endsWith(".pdf") && blob.type.toLowerCase() !== "application/pdf"
    ? new Blob([blob], { type: "application/pdf" })
    : blob;

export const shouldReplaceUploadedAttachment = (inlinePdf: boolean, configuredMaxCount?: number) =>
  inlinePdf || (configuredMaxCount ?? 20) === 1;
