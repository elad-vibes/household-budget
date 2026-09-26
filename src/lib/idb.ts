// Tiny IndexedDB store for the on-device receipt queue. Images live only here
// until they are parsed (then deleted, unless "keep for warranty").

export type ReceiptStatus = "queued" | "sending" | "submitted" | "done" | "failed";

export interface QueuedReceipt {
  id: string;             // client id, also the batch custom_id
  householdId: string;
  personId: string | null;
  blob: Blob | null;      // null once deleted after parsing
  thumb: string;          // small data: URL for the list
  status: ReceiptStatus;
  jobId: string | null;
  keep: boolean;          // keep the image for warranty (on this device only)
  blur: number;
  createdAt: number;
  sentAt: number | null;
  error: string | null;
}

const DB = "hb-app";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("receipts")) db.createObjectStore("receipts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(r ? r.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export const queue = {
  async all(householdId: string): Promise<QueuedReceipt[]> {
    const rows = ((await tx<QueuedReceipt[]>("receipts", "readonly", (s) => s.getAll())) ?? []) as QueuedReceipt[];
    return rows.filter((r) => r.householdId === householdId).sort((a, b) => a.createdAt - b.createdAt);
  },
  put: (r: QueuedReceipt) => tx("receipts", "readwrite", (s) => s.put(r)),
  remove: (id: string) => tx("receipts", "readwrite", (s) => s.delete(id)),
  async removeHousehold(householdId: string) {
    for (const r of await queue.all(householdId)) await queue.remove(r.id);
  },
};

export const meta = {
  get: async <T>(key: string): Promise<T | undefined> => (await tx<T>("meta", "readonly", (s) => s.get(key))) as T | undefined,
  set: (key: string, value: unknown) => tx("meta", "readwrite", (s) => s.put(value, key)),
};
