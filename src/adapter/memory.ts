import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import type { PathType } from "../path.ts";
import type { RecordType } from "../schema.ts";

/** In-memory record store useful for tests, demos, and temporary data. */
export interface MemoryRecordStoreType extends RecordStoreType {
  /** Removes every stored record. */
  clear(): void;
  /** Number of stored files and directories, excluding the implicit root. */
  readonly size: number;
}

/**
 * Deterministic process-local record store.
 *
 * The store clones records on both write and read. A test that retains and
 * mutates an object reference therefore cannot mutate persistence without a
 * `set()` call. The class owns only its Map and has no disposal lifecycle.
 */
class MemoryRecordStore implements MemoryRecordStoreType {
  /** Durable state for the lifetime of this JavaScript realm/store instance. */
  readonly #records = new Map<string, RecordType>();

  /** Number of explicit file/directory records. Root remains implicit. */
  get size(): number {
    return this.#records.size;
  }

  /** Removes every explicit record. */
  clear(): void {
    this.#records.clear();
  }

  /** Returns a cloned record so callers cannot mutate stored state by reference. */
  async get(path: PathType): Promise<RecordType | null> {
    const record = this.#records.get(path);
    return record === undefined ? null : structuredClone(record);
  }

  /** Replaces one record with an owned clone. */
  async set(record: RecordType): Promise<void> {
    this.#records.set(record.path, structuredClone(record));
  }

  /** Removes one exact record. */
  async delete(path: PathType): Promise<void> {
    this.#records.delete(path);
  }

  /** Lazily yields cloned direct children. */
  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    for (const record of this.#records.values()) {
      if (record.parent === parent) yield structuredClone(record);
    }
  }
}

/**
 * Creates a deterministic in-memory record store.
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
  return new MemoryRecordStore();
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
