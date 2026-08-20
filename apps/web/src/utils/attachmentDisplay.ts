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

const attachmentName = (item: unknown) => typeof item === "string"
  ? item
  : item && typeof item === "object" && "name" in item
    ? String((item as { name?: unknown }).name ?? "")
    : "";

const attachmentId = (item: unknown) => item && typeof item === "object" && "id" in item
  ? String((item as { id?: unknown }).id ?? "")
  : "";

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
  })).filter((entry) => Boolean(entry.name));
  if (fromValues.length) return fromValues;
  if (!primaryField) return [];
  return fallbackNames.map((name, sourceIndex) => ({
    id: fallbackIds[sourceIndex],
    name,
    sourceIndex,
  })).filter((entry) => Boolean(entry.name));
};

export const pdfPreviewBlob = (blob: Blob, fileName: string) =>
  fileName.toLowerCase().endsWith(".pdf") && blob.type.toLowerCase() !== "application/pdf"
    ? new Blob([blob], { type: "application/pdf" })
    : blob;
