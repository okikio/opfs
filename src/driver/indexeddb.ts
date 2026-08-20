import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import { defineRecordDriver, type RecordBackendType, type RecordDriverType, type RecordListType } from "./record.ts";
import type { FileDriverWriteOptionsType } from "./file.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { basename, dirname, type PathType } from "../path.ts";
import { RecordSchema, type RecordType } from "../schema.ts";

/**
 * Options for an existing IndexedDB database.
 *
 * The driver stores one logical filesystem record per object-store row. The
 * parent index keeps direct-child listing cheap without reparsing every stored
 * path on each read.
 */
export interface IndexedDbDriverOptionsType {
  /** Object store containing records. Defaults to `entries`. */
  readonly store?: string;
  /** Parent-path index. Defaults to `parent`. */
  readonly parentIndex?: string;
  /** Closes the injected database when the driver closes. */
  readonly disposeDatabase?: boolean;
  /** Prevents mutations. */
  readonly readOnly?: boolean;
}

/**
 * Options used when this package opens and owns an IndexedDB database.
 *
 * These settings describe the package-owned database shape. They do not apply
 * retroactively to a caller-owned database that already exists.
 */
export interface IndexedDbOpenOptionsType extends Omit<IndexedDbDriverOptionsType, "disposeDatabase"> {
  /** Database name. Defaults to `okikio-opfs`. */
  readonly name?: string;
  /** Database schema version. Defaults to 1. */
  readonly version?: number;
}

/**
 * Converts one `IDBRequest` completion into a Promise while retaining native errors.
 *
 * IndexedDB signals success and failure through events. The driver normalizes
 * that event lifecycle once so backend methods can use ordinary async control flow.
 */
export function result<T>(request: IDBRequest<T>): Promise<T> {
  const pending = Promise.withResolvers<T>();
  request.onsuccess = () => pending.resolve(request.result);
  request.onerror = () => pending.reject(request.error ?? new Error("IndexedDB request failed."));
  return pending.promise;
}

/**
 * Waits for transaction commit instead of treating request success as durable completion.
 *
 * Individual request success only means the operation was accepted into the
 * transaction. The write is not durable until the transaction completes.
 */
export function committed(transaction: IDBTransaction): Promise<void> {
  const pending = Promise.withResolvers<void>();
  transaction.oncomplete = () => pending.resolve();
  transaction.onabort = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  transaction.onerror = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  return pending.promise;
}

/** Builds the next complete file bytes while one IndexedDB transaction owns the current record. */
export function writeBytes(
  existing: Uint8Array,
  data: Uint8Array,
  mode: FileDriverWriteOptionsType["mode"],
  at: number | undefined,
  truncate: boolean,
): Uint8Array {
  if (mode === "replace") return data.slice();
  const position = mode === "append" ? existing.byteLength : at ?? 0;
  const size = Math.max(existing.byteLength, position + data.byteLength);
  let output = new Uint8Array(size);
  output.set(existing);
  output.set(data, position);
  if (truncate) output = output.slice(0, position + data.byteLength);
  return output;
}

/**
 * Applies the record-store object-store and parent-index schema during upgrade.
 *
 * The upgrade path is idempotent so repeated opens can reuse the same database
 * name without forcing callers to drop storage between test runs or upgrades.
 */
export function upgradeDatabase(request: IDBOpenDBRequest, storeName: string, parentIndex: string): void {
  const database = request.result;
  const store = database.objectStoreNames.contains(storeName)
    ? request.transaction!.objectStore(storeName)
    : database.createObjectStore(storeName, { keyPath: "path" });
  if (!store.indexNames.contains(parentIndex)) store.createIndex(parentIndex, "parent", { unique: false });
}

/**
 * Record-store projection over one prepared IndexedDB database.
 *
 * Every write waits for transaction completion rather than treating the
 * individual request success event as commit authority. Direct-child listing
 * uses the configured `parent` index.
 */
export class IndexedDbBackend implements RecordBackendType {
  /** IndexedDB database borrowed or owned according to driver options. */
  readonly #database: IDBDatabase;
  /** Object store containing validated filesystem records. */
  readonly #storeName: string;
  /** Index used for direct-child listing. */
  readonly #parentIndex: string;
  /** Whether disposal closes the database. */
  readonly #disposeDatabase: boolean;

  /** Resolves store/index names once for every transaction. */
  constructor(database: IDBDatabase, options: IndexedDbDriverOptionsType) {
    this.#database = database;
    this.#storeName = options.store ?? "entries";
    this.#parentIndex = options.parentIndex ?? "parent";
    this.#disposeDatabase = options.disposeDatabase ?? false;
  }

  /** Reads and validates one record in a readonly transaction. */
  async get(path: Parameters<RecordBackendType["get"]>[0]): Promise<RecordType | null> {
    const transaction = this.#database.transaction(this.#storeName, "readonly");
    const value = await result(transaction.objectStore(this.#storeName).get(path));
    return value === undefined ? null : RecordSchema.parse(value);
  }

  /** Replaces one record and waits for the readwrite transaction to commit. */
  async set(record: Parameters<RecordBackendType["set"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    transaction.objectStore(this.#storeName).put(record);
    await committed(transaction);
  }

  /**
   * Applies replace, append, or positioned update in one IndexedDB readwrite transaction.
   *
   * The generic record adapter cannot make `get()` followed by `set()` atomic
   * across tabs because each call opens its own transaction. Keeping the read,
   * byte-image update, and `put()` inside one transaction lets IndexedDB's
   * object-store serialization protect same-path read-modify-write operations
   * from independent package instances that use this driver.
   */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    const done = committed(transaction);
    const store = transaction.objectStore(this.#storeName);
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        // The transaction may have reached a terminal state between signal
        // delivery and this callback. Its existing result remains authoritative.
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      const value = await result(store.get(path));
      throwIfAborted(options.signal, "write", path);
      const previous = value === undefined ? null : RecordSchema.parse(value);
      if (previous?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
      }

      const existing = options.mode === "replace" || previous === null
        ? new Uint8Array()
        : decodeBase64(previous.data);
      const bytes = writeBytes(existing, data, options.mode, options.at, options.truncate ?? false);
      const record: RecordType = RecordSchema.parse({
        version: 1,
        path,
        parent: dirname(path),
        name: basename(path),
        kind: "file",
        data: encodeBase64(bytes),
        size: bytes.byteLength,
        lastModified: Date.now(),
        mediaType: options.mediaType ?? (previous?.kind === "file" ? previous.mediaType : ""),
      });
      store.put(record);
      await done;
    } catch (error) {
      abort();
      await done.catch(() => undefined);
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** Removes one record and waits for the readwrite transaction to commit. */
  async delete(path: Parameters<RecordBackendType["delete"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    transaction.objectStore(this.#storeName).delete(path);
    await committed(transaction);
  }

  /** Reads direct children through the parent-path index. */
  async *list(parent: Parameters<RecordBackendType["list"]>[0]): AsyncIterableIterator<RecordListType> {
    const transaction = this.#database.transaction(this.#storeName, "readonly");
    const values = await result(transaction.objectStore(this.#storeName).index(this.#parentIndex).getAll(parent));
    for (const value of values) yield RecordSchema.parse(value);
  }

  /** Closes the database only when ownership was explicitly transferred. */
  dispose(): void {
    if (this.#disposeDatabase) this.#database.close();
  }
}

/**
 * Creates an independently useful IndexedDB record driver.
 *
 * IndexedDB is the strongest browser-hosted record backend in this package's
 * default set because it can preserve transaction boundaries and asynchronous
 * durability without pretending to be native OPFS.
 */
export function createIndexedDbDriver(
  database: IDBDatabase,
  options: IndexedDbDriverOptionsType = {},
): RecordDriverType {
  const backend = new IndexedDbBackend(database, options);
  return defineRecordDriver(backend, {
    name: "indexeddb",
    capabilities: {
      writeModes: ["replace", "append", "update"],
      replacement: "atomic",
      transactions: true,
      binary: false,
    },
    requirements: [{ code: "indexeddb", state: "available" }],
    optimizations: [],
    readOnly: options.readOnly ?? false,
    disposeBackend: options.disposeDatabase ?? false,
  });
}

/**
 * Opens and owns an IndexedDB database prepared for OPFS records.
 *
 * Use this when the package should create the object store and parent index for
 * you. The returned driver owns the opened database handle and closes it when
 * the driver is disposed.
 */
export async function openIndexedDbDriver(options: IndexedDbOpenOptionsType = {}): Promise<RecordDriverType> {
  const name = options.name ?? "okikio-opfs";
  const version = options.version ?? 1;
  const storeName = options.store ?? "entries";
  const parentIndex = options.parentIndex ?? "parent";
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => upgradeDatabase(request, storeName, parentIndex);
  const database = await result(request);
  return createIndexedDbDriver(database, {
    store: storeName,
    parentIndex,
    disposeDatabase: true,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
}
