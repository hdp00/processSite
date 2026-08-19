import type { AttachmentRecord } from "../api/contracts";

const DATABASE_NAME = "flowpilot-mock-api";
const DATABASE_VERSION = 1;
const STORE_NAME = "attachments";

interface StoredAttachment {
  record: AttachmentRecord;
  blob: Blob;
}

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onerror = () => reject(request.error ?? new Error("无法打开 Mock 附件数据库"));
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "record.id" });
  };
  request.onsuccess = () => resolve(request.result);
});

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("Mock 附件事务失败"));
  transaction.onabort = () => reject(transaction.error ?? new Error("Mock 附件事务已取消"));
});

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Mock 附件读取失败"));
});

export const putAttachment = async (stored: StoredAttachment, replaceScope?: { instanceId: string; fieldId: string }) => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  if (replaceScope) {
    const all = await requestResult(store.getAll()) as StoredAttachment[];
    all.filter((item) => item.record.instanceId === replaceScope.instanceId && item.record.fieldId === replaceScope.fieldId)
      .forEach((item) => store.delete(item.record.id));
  }
  store.put(stored);
  await transactionDone(transaction);
  database.close();
  return stored.record;
};

export const getStoredAttachment = async (id: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const result = await requestResult(transaction.objectStore(STORE_NAME).get(id)) as StoredAttachment | undefined;
  await transactionDone(transaction);
  database.close();
  return result;
};

export const getAttachmentRecords = async (ids?: string[]) => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const all = await requestResult(transaction.objectStore(STORE_NAME).getAll()) as StoredAttachment[];
  await transactionDone(transaction);
  database.close();
  return all.map((item) => item.record).filter((record) => !ids || ids.includes(record.id));
};

export const assignAttachmentsToInstance = async (
  ids: string[],
  instanceId: string,
  attachmentIdsByField: Record<string, string[]>,
) => {
  if (!ids.length) return [];
  const fieldByAttachmentId = new Map(
    Object.entries(attachmentIdsByField).flatMap(([fieldId, fieldIds]) => fieldIds.map((id) => [id, fieldId] as const)),
  );
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const all = await requestResult(store.getAll()) as StoredAttachment[];
  const updated = all
    .filter((item) => ids.includes(item.record.id))
    .map((item) => ({
      ...item,
      record: {
        ...item.record,
        instanceId,
        fieldId: fieldByAttachmentId.get(item.record.id),
      },
    }));
  updated.forEach((item) => store.put(item));
  await transactionDone(transaction);
  database.close();
  return updated.map((item) => item.record);
};

export const deleteAttachment = async (id: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(id);
  await transactionDone(transaction);
  database.close();
};

export const clearAttachments = async () => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).clear();
  await transactionDone(transaction);
  database.close();
};
