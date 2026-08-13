import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import type { RecordType } from "../schema.ts";

/** In-memory record store useful for tests, demos, and temporary data. */
export interface MemoryRecordStoreType extends RecordStoreType {
  /** Removes every stored record. */
  clear(): void;
  /** Number of stored files and directories, excluding the implicit root. */
  readonly size: number;
}

/**
 * Creates a deterministic in-memory record store.
 *
 * The returned store owns one Map and has no external resources. Records are
 * cloned on read and write so tests cannot mutate persistence by retaining an
 * object reference. The store is process-local and disappears with the realm.
 *
 * @example Inspect records while testing a record-store wrapper.
 * ```ts
 * const store = createMemoryRecordStore();
 * await store.set(record);
 * assertEquals(store.size, 1);
 * store.clear();
 * ```
 */
export function createMemoryRecordStore(): MemoryRecordStoreType {
  const records = new Map<string, RecordType>();
  return {
    get size() { return records.size; },
    clear() { records.clear(); },
    async get(path) { return records.get(path) ?? null; },
    async set(record) { records.set(record.path, structuredClone(record)); },
    async delete(path) { records.delete(path); },
    async *list(parent) {
      for (const record of records.values()) {
        if (record.parent === parent) yield structuredClone(record);
      }
    },
  };
}

/**
 * Creates an in-memory OPFS-shaped adapter.
 *
 * It uses the same record adapter as RxDB, unstorage, db0, and Drizzle, which
 * makes it useful for testing facade semantics without a browser or database.
 * It is not durable and does not advertise native streaming or sync access.
 *
 * @example Use File System API-shaped handles without browser OPFS.
 * ```ts
 * const fileSystem = createFileSystem(createMemoryAdapter());
 * const file = await fileSystem.root.getFileHandle("hello.txt", { create: true });
 * const writable = await file.createWritable();
 * await writable.write("hello");
 * await writable.close();
 * ```
 */
export function createMemoryAdapter(): AdapterType {
  return createRecordAdapter(createMemoryRecordStore(), { name: "memory" });
}
