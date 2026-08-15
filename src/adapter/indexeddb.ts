import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { RecordSchema } from "../schema.ts";

/** Options for an existing IndexedDB database. */
export interface IndexedDbAdapterOptionsType {
  /** Object store containing records. Defaults to `entries`. */
  readonly store?: string;
  /** Parent-path index. Defaults to `parent`. */
  readonly parentIndex?: string;
  /** Closes the injected database when the adapter closes. */
  readonly disposeDatabase?: boolean;
  /** Prevents mutations. */
  readonly readOnly?: boolean;
}

/** Options used when this package opens and owns an IndexedDB database. */
export interface IndexedDbOpenOptionsType extends Omit<IndexedDbAdapterOptionsType, "disposeDatabase"> {
  /** Database name. Defaults to `okikio-opfs`. */
  readonly name?: string;
  /** Database schema version. Defaults to 1. */
  readonly version?: number;
}

/** Converts one IDBRequest completion into a Promise while retaining native errors. */
function result<T>(request: IDBRequest<T>): Promise<T> {
  const pending = Promise.withResolvers<T>();
  request.onsuccess = () => pending.resolve(request.result);
  request.onerror = () => pending.reject(request.error ?? new Error("IndexedDB request failed."));
  return pending.promise;
}

/** Waits for transaction commit instead of treating request success as durable completion. */
function committed(transaction: IDBTransaction): Promise<void> {
  const pending = Promise.withResolvers<void>();
  transaction.oncomplete = () => pending.resolve();
  transaction.onabort = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  transaction.onerror = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  return pending.promise;
}

/** Applies the record-store object-store/index schema during an IndexedDB upgrade event. */
function upgradeDatabase(request: IDBOpenDBRequest, storeName: string, parentIndex: string): void {
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
class IndexedDbRecordStore implements RecordStoreType {
  /** IndexedDB database borrowed or owned according to adapter options. */
  readonly #database: IDBDatabase;
  /** Object store containing validated filesystem records. */
  readonly #storeName: string;
  /** Index used for direct-child listing. */
  readonly #parentIndex: string;
  /** Whether disposal closes the database. */
  readonly #disposeDatabase: boolean;

  /** Resolves store/index names once for every transaction. */
  constructor(database: IDBDatabase, options: IndexedDbAdapterOptionsType) {
    this.#database = database;
    this.#storeName = options.store ?? "entries";
    this.#parentIndex = options.parentIndex ?? "parent";
    this.#disposeDatabase = options.disposeDatabase ?? false;
  }

  /** Reads and validates one record in a readonly transaction. */
  async get(path: Parameters<RecordStoreType["get"]>[0]) {
    const transaction = this.#database.transaction(this.#storeName, "readonly");
    const value = await result(transaction.objectStore(this.#storeName).get(path));
    return value === undefined ? null : RecordSchema.parse(value);
  }

  /** Replaces one record and waits for the readwrite transaction to commit. */
  async set(record: Parameters<RecordStoreType["set"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    transaction.objectStore(this.#storeName).put(record);
    await committed(transaction);
  }

  /** Removes one record and waits for the readwrite transaction to commit. */
  async delete(path: Parameters<RecordStoreType["delete"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    transaction.objectStore(this.#storeName).delete(path);
    await committed(transaction);
  }

  /** Reads direct children through the parent-path index. */
  async *list(parent: Parameters<RecordStoreType["list"]>[0]) {
    const transaction = this.#database.transaction(this.#storeName, "readonly");
    const values = await result(transaction.objectStore(this.#storeName).index(this.#parentIndex).getAll(parent));
    for (const value of values) yield RecordSchema.parse(value);
  }

  /** Closes the database only when ownership was explicitly transferred. */
  dispose(): void {
    if (this.#disposeDatabase) this.#database.close();
  }
}

/** Creates a record store over a prepared IndexedDB database. */
export function createIndexedDbRecordStore(
  database: IDBDatabase,
  options: IndexedDbAdapterOptionsType = {},
): RecordStoreType {
  return new IndexedDbRecordStore(database, options);
}

/** Creates an OPFS-shaped adapter over an existing IndexedDB database. */
export function createIndexedDbAdapter(database: IDBDatabase, options: IndexedDbAdapterOptionsType = {}): AdapterType {
  return createRecordAdapter(createIndexedDbRecordStore(database, options), {
    name: "indexeddb",
    readOnly: options.readOnly ?? false,
    disposeStore: true,
  });
}

/**
 * Opens an IndexedDB database with the record schema expected by this adapter.
 *
 * The created object store uses `path` as its key and indexes `parent`, so one
 * directory lookup does not scan the complete database. The returned adapter
 * owns the opened database and closes it with the filesystem lifecycle.
 */
export async function openIndexedDbAdapter(options: IndexedDbOpenOptionsType = {}): Promise<AdapterType> {
  const name = options.name ?? "okikio-opfs";
  const version = options.version ?? 1;
  const storeName = options.store ?? "entries";
  const parentIndex = options.parentIndex ?? "parent";
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => upgradeDatabase(request, storeName, parentIndex);
  const database = await result(request);
  return createIndexedDbAdapter(database, {
    store: storeName,
    parentIndex,
    disposeDatabase: true,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
}
