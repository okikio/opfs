import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import {
  defineRecordDriver,
  type RecordBackendType,
  type RecordDriverType,
  type RecordListType,
} from "../../driver/record.ts";
import type { FileDriverWriteOptionsType } from "../../driver/file.ts";
import { FileSystemError, throwIfAborted } from "../../error.ts";
import { basename, dirname, type PathType } from "../../path.ts";
import { RecordSchema, type RecordType } from "../../schema/mod.ts";
import { Listeners, type ObservationType, Refusal, requested, Transaction } from "./transaction.ts";

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

/** Builds the next complete file bytes while one IndexedDB transaction owns the current record. */
function writeBytes(
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
 * Creates the record object store and its parent index during a version upgrade.
 *
 * The step is idempotent, so repeated opens can reuse the same database name without callers dropping
 * storage between test runs or upgrades. It keeps the acquired database and upgrade transaction stable
 * through schema effects.
 */
function upgrade(
  database: IDBDatabase,
  transaction: IDBTransaction | null,
  storeName: string,
  parentIndex: string,
): void {
  const store = database.objectStoreNames.contains(storeName)
    ? transaction!.objectStore(storeName)
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
    const owner = new Transaction(transaction);
    const value = await owner.run(() => owner.request(transaction.objectStore(this.#storeName).get(path)));
    return value === undefined ? null : RecordSchema.parse(value);
  }

  /** Replaces one record and waits for the readwrite transaction to commit. */
  async set(record: Parameters<RecordBackendType["set"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    const owner = new Transaction(transaction);
    await owner.run(() => owner.request(transaction.objectStore(this.#storeName).put(record)));
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
    const signal = options.signal;
    throwIfAborted(signal, "write", path);
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    const owner = new Transaction(transaction);
    owner.signal(signal, path);
    await owner.run(async () => {
      const store = transaction.objectStore(this.#storeName);
      const value = await owner.request(store.get(path));
      // A signal callback has already recorded its event. Avoid manufacturing
      // another observation by throwing the same checkpoint a second time.
      if (owner.listeners.failures.length > 0) return;
      const previous = value === undefined ? null : RecordSchema.parse(value);
      if (previous?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", path, `'${path}' is a directory.`);
      }

      const existing = options.mode === "replace" || previous === null ? new Uint8Array() : decodeBase64(previous.data);
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
      if (owner.listeners.failures.length > 0) return;
      await owner.request(store.put(record));
    });
  }

  /** Removes one record and waits for the readwrite transaction to commit. */
  async delete(path: Parameters<RecordBackendType["delete"]>[0]): Promise<void> {
    const transaction = this.#database.transaction(this.#storeName, "readwrite");
    const owner = new Transaction(transaction);
    await owner.run(() => owner.request(transaction.objectStore(this.#storeName).delete(path)));
  }

  /** Reads direct children after the readonly transaction has completed. */
  async *list(parent: Parameters<RecordBackendType["list"]>[0]): AsyncIterableIterator<RecordListType> {
    const transaction = this.#database.transaction(this.#storeName, "readonly");
    const owner = new Transaction(transaction);
    const values = await owner.run(() => {
      return owner.request(transaction.objectStore(this.#storeName).index(this.#parentIndex).getAll(parent));
    });
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
 * commit acknowledgement without pretending to be native OPFS.
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
  const listeners = new Listeners();
  let database: IDBDatabase | undefined;
  let transaction: IDBTransaction | null | undefined;
  let acquired = false;
  let aborting = false;
  const upgradeTransaction = () => {
    if (!acquired) {
      acquired = true;
      transaction = request.transaction;
    }
    return transaction;
  };
  const abort = () => {
    if (aborting) return;
    aborting = true;
    try {
      upgradeTransaction()?.abort();
    } catch (reason) {
      listeners.note(reason);
    }
  };
  const schema: EventListener = () => {
    try {
      // Reserve the unpublished native handle and transaction before schema
      // effects. An abort that performs its effect and then throws is not retried.
      database = request.result;
      const transaction = upgradeTransaction();
      if (listeners.failures.length > 0) abort();
      else upgrade(database, transaction ?? null, storeName, parentIndex);
    } catch (reason) {
      listeners.note(reason);
      abort();
    }
  };
  let closed = false;
  const retire = () => {
    if (database && !closed && listeners.failures.length > 0) {
      closed = true;
      try {
        database.close();
      } catch (reason) {
        listeners.note(reason);
      }
    }
    listeners.retire();
    // Late refusal has no remaining public cleanup channel; keep the actual
    // work observed without inventing another rejection from event dispatch.
    void listeners.join();
  };
  const observation: ObservationType = { late: retire };
  // Observe success/error before exposing any upgrade-schema effects.
  const done = requested(request, listeners, (value) => {
    database = value;
  }, observation);
  void done.catch(() => undefined);
  listeners.observe(request, "upgradeneeded", schema);
  try {
    database = await done;
  } catch (reason) {
    if (!(reason instanceof Refusal && reason.owner === listeners)) listeners.note(reason);
  }
  // Native open has no interruption before its upgrade transaction is acquired.
  // If both declared terminal channels refuse installation, keep best-effort
  // hooks until any actual late terminal delivery, which closes its unpublished
  // handle. The immediate refusal cannot certify physical cleanup or deliver a
  // later retirement fault through this Promise; no success is published.
  if (observation.observed !== false) {
    await observation.terminal;
    listeners.retire();
    retire();
    await listeners.join();
  }
  listeners.finish();
  try {
    const readOnly = options.readOnly;
    return createIndexedDbDriver(database!, {
      store: storeName,
      parentIndex,
      disposeDatabase: true,
      ...(readOnly === undefined ? {} : { readOnly }),
    });
  } catch (reason) {
    listeners.note(reason);
    retire();
    await listeners.join();
    listeners.finish();
    throw reason;
  }
}
