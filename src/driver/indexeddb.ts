import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";
import { RecordSchema } from "../schema.ts";

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
function result<T>(request: IDBRequest<T>): Promise<T> {
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
function committed(transaction: IDBTransaction): Promise<void> {
  const pending = Promise.withResolvers<void>();
  transaction.oncomplete = () => pending.resolve();
  transaction.onabort = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  transaction.onerror = () => pending.reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  return pending.promise;
}

/**
 * Applies the record-store object-store and parent-index schema during upgrade.
 *
 * The upgrade path is idempotent so repeated opens can reuse the same database
 * name without forcing callers to drop storage between test runs or upgrades.
 */
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
class IndexedDbBackend implements RecordBackendType {
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
  async get(path: Parameters<RecordBackendType["get"]>[0]) {
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

  /** Removes one record and waits for the readwrite transaction to commit. */
  async delete(path: Parameters<RecordBackendType["delete"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    transaction.objectStore(this.#storeName).delete(path);
    await committed(transaction);
  }

  /** Reads direct children through the parent-path index. */
  async *list(parent: Parameters<RecordBackendType["list"]>[0]) {
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
