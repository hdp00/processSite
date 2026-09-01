import type { UploadFile } from "antd";
import type { AttachmentRecord } from "../api/contracts";

export const temporaryAttachmentRecords = (files?: readonly UploadFile<AttachmentRecord>[]) =>
  (files ?? []).flatMap((file) => file.response?.lifecycle === "temporary" ? [file.response] : []);

export const cleanupTemporaryAttachments = (
  files: readonly UploadFile<AttachmentRecord>[] | undefined,
  remove: (attachmentId: string) => Promise<unknown>,
) => Promise.allSettled(temporaryAttachmentRecords(files).map((record) => remove(record.id)));
