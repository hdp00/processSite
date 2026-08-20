import { createClientUuid } from "./clientId";

const DATABASE_NAME = "flowpilot-rich-media";
const DATABASE_VERSION = 1;
const STORE_NAME = "media";

export interface StoredRichMedia {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  blob: Blob;
}

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (typeof indexedDB === "undefined") {
    reject(new Error("当前浏览器不支持 IndexedDB，无法保存富媒体文件。"));
    return;
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      database.createObjectStore(STORE_NAME, { keyPath: "id" });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("无法打开富媒体存储。"));
});

const withStore = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("富媒体文件存储失败。"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("富媒体文件事务失败。"));
    };
  });
};

export const saveRichMedia = async (file: File) => {
  const record: StoredRichMedia = {
    id: createClientUuid(),
    name: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: new Date().toISOString(),
    blob: file,
  };
  await withStore("readwrite", (store) => store.put(record));
  return record;
};

export const getRichMedia = (id: string) => withStore<StoredRichMedia | undefined>(
  "readonly",
  (store) => store.get(id),
);

export const clearRichMedia = async () => {
  if (typeof indexedDB === "undefined") return;
  await withStore("readwrite", (store) => store.clear());
};

export const richMediaSource = (id: string) => `flowpilot-media:${id}`;

export const richMediaIdFromSource = (source: string | null | undefined) => {
  const matched = source?.match(/^flowpilot-media:([\w-]+)$/);
  return matched?.[1];
};
