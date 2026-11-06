import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

import { defineRecordDriver, type RecordBackendType, type RecordDriverType, type RecordListType } from "./record.ts";
import type { FileDriverWriteOptionsType } from "./file.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { aggregate } from "../close.ts";
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

/** One observed failure occurrence; equal values do not establish a shared event. */
interface FailureType {
  readonly reason: unknown;
}

/** Private transfer of an already-recorded event across an awaited request. */
class Refusal {
  readonly owner: Listeners;
  readonly failure: FailureType;

  constructor(owner: Listeners, failure: FailureType) {
    this.owner = owner;
    this.failure = failure;
  }
}

/**
 * Owns listener installation and removal, including partial borrowed setup.
 *
 * Reserve removal before calling addEventListener: a borrowed method can install
 * the listener and then throw. Removal is claimed before its effect, so reentry
 * cannot repeat it. Every listener is attempted even if an earlier removal fails.
 */
class Listeners {
  readonly failures: FailureType[] = [];
  readonly #releases: Array<() => void> = [];
  readonly #work = new Set<Promise<void>>();
  #retired = false;

  note(reason: unknown): FailureType {
    const failure = { reason };
    this.failures.push(failure);
    return failure;
  }

  listen(target: EventTarget, type: string, callback: EventListener): boolean {
    this.#releases.push(() => target.removeEventListener(type, callback));
    try {
      target.addEventListener(type, callback);
      return true;
    } catch (reason) {
      this.note(reason);
      return false;
    }
  }

  /**
   * Keeps a declared on* channel when listener installation is refused.
   *
   * Both callbacks can receive the very same native Event after install-then-
   * throw. Event receipt identity correlates that delivery; error value identity
   * never does. The original attribute handler runs with its original receiver
   * and its return value is preserved, including false for event cancellation.
   */
  observe(target: EventTarget, type: string, callback: EventListener): boolean {
    const delivered = new WeakSet<Event>();
    const once = (event: Event) => {
      if (delivered.has(event)) return;
      delivered.add(event);
      callback(event);
    };
    if (this.listen(target, type, once)) return true;
    const key = `on${type}`;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const previous: unknown = Reflect.get(target, key);
      this.#releases.push(() => {
        try {
          if (!Reflect.set(target, key, previous)) {
            throw new TypeError("IndexedDB event handler restoration was refused.");
          }
        } catch (reason) {
          this.note(reason);
        }
        try {
          if (descriptor) Object.defineProperty(target, key, descriptor);
          else if (!Reflect.deleteProperty(target, key)) {
            throw new TypeError("IndexedDB event descriptor restoration was refused.");
          }
        } catch (reason) {
          this.note(reason);
        }
      });
      const observer = (event: Event) => {
        let returned: unknown;
        if (typeof previous === "function") {
          try {
            returned = Reflect.apply(previous, target, [event]);
            this.#observe(returned);
          } catch (reason) {
            this.note(reason);
          }
        }
        once(event);
        return returned;
      };
      if (!Reflect.set(target, key, observer)) throw new TypeError("IndexedDB event handler installation was refused.");
      return true;
    } catch (reason) {
      this.note(reason);
      return false;
    }
  }

  /**
   * Observe explicitly returned PromiseLike work without replacing its value.
   *
   * This is package retirement ownership, not native event dispatch waiting.
   * Reserve before the borrowed then getter and invocation; a callback rejection
   * and an invocation that throws after settling are distinct occurrences.
   */
  #observe(value: unknown): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    const pending = Promise.withResolvers<unknown>();
    const work = pending.promise.then(() => undefined, (reason) => {
      this.note(reason);
    });
    this.#work.add(work);
    void work.then(() => {
      this.#work.delete(work);
    });
    let settled = false;
    const resolve = (value?: unknown) => {
      if (settled) return;
      settled = true;
      // Native resolution adopts the first value, including nested PromiseLike
      // settlement. A later reject or resolve cannot replace that choice.
      pending.resolve(value);
    };
    const reject = (reason: unknown) => {
      if (settled) return;
      this.note(reason);
      resolve();
    };
    try {
      const then: unknown = Reflect.get(value, "then");
      if (typeof then === "function") Reflect.apply(then, value, [resolve, reject]);
      else resolve();
    } catch (reason) {
      this.note(reason);
      resolve();
    }
  }

  /** Join only the actual saved-handler work, after physical detach and close. */
  async join(): Promise<void> {
    while (this.#work.size > 0) await Promise.all(this.#work);
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    for (const release of this.#releases) {
      try {
        release();
      } catch (reason) {
        this.note(reason);
      }
    }
  }

  finish(): void {
    const reasons = this.failures.map((failure) => failure.reason);
    if (reasons.length === 1) throw reasons[0];
    if (reasons.length > 1) {
      throw aggregate(reasons, "IndexedDB operation and retirement failed.");
    }
  }
}

/** Physical observation admission, kept private to unpublished database rollback. */
interface ObservationType {
  observed?: boolean;
  terminal?: Promise<void>;
  late?: () => void;
}

/**
 * Observes one request without replacing caller-owned on* handlers.
 *
 * Callbacks resolve an owned receipt instead of throwing into event dispatch.
 * A failed installation is retained even when the fallback observes completion.
 * If both channels refuse, logical failure can precede actual completion; any
 * admitted late callback remains observed through its owner's retirement.
 */
function requested<T>(
  request: IDBRequest<T>,
  listeners: Listeners,
  acquired?: (value: T) => void,
  observation?: ObservationType,
): Promise<T> {
  const pending = Promise.withResolvers<{ value: T } | { failure: FailureType }>();
  let settled = false;
  let stateReceipt = false;
  const terminal = Promise.withResolvers<void>();
  if (observation) observation.terminal = terminal.promise;
  const settle = (read: () => T) => {
    if (settled) {
      if (!stateReceipt) {
        try {
          const value = read();
          acquired?.(value);
        } catch (reason) {
          listeners.note(reason);
        }
      }
      terminal.resolve();
      if (observation?.observed === false) observation.late?.();
      return;
    }
    settled = true;
    try {
      const value = read();
      acquired?.(value);
      pending.resolve({ value });
    } catch (reason) {
      pending.resolve({ failure: listeners.note(reason) });
    }
    terminal.resolve();
  };
  const success = listeners.observe(request, "success", () => settle(() => request.result));
  const error = listeners.observe(request, "error", () => {
    if (stateReceipt) return;
    // A setup refusal can win before native request failure. Retain that later
    // observation while the transaction is still physically retiring.
    settled = true;
    let failure: FailureType;
    try {
      failure = listeners.note(request.error ?? new Error("IndexedDB request failed."));
    } catch (reason) {
      failure = listeners.note(reason);
    }
    pending.resolve({ failure });
    terminal.resolve();
    if (observation?.observed === false) observation.late?.();
  });
  if (observation) observation.observed = success && error;
  if (!success || !error) {
    settled = true;
    pending.resolve({ failure: listeners.failures[0]! });
  }
  // This acquired request's final fields replay its terminal state after its
  // event has passed. Cache that receipt only after field admission succeeds;
  // replay of the same request state does not reread fields or add a new error.
  try {
    const state = request.readyState;
    if (!settled && state === "done") {
      const reason = request.error;
      if (reason !== null) {
        settled = true;
        stateReceipt = true;
        pending.resolve({ failure: listeners.note(reason) });
        terminal.resolve();
      } else {
        const value = request.result;
        acquired?.(value);
        stateReceipt = true;
        settled = true;
        pending.resolve({ value });
        terminal.resolve();
      }
    }
  } catch (reason) {
    // A field-admission fault is not a certified native request error. The
    // transaction/open owner still joins and observes an actual later event.
    const failure = listeners.note(reason);
    settled = true;
    pending.resolve({ failure });
  }
  return pending.promise.then((outcome) => {
    if ("failure" in outcome) throw new Refusal(listeners, outcome.failure);
    return outcome.value;
  });
}

/**
 * Converts an IDBRequest completion to a Promise and releases its observation.
 *
 * This does not certify transaction commit. Use committed(transaction) for that
 * boundary. A completed request can be acquired after its native event using
 * its final readyState/error/result receipt. Request field and observation
 * retirement faults are retained in order.
 */
export async function result<T>(request: IDBRequest<T>): Promise<T> {
  const listeners = new Listeners();
  let value!: T;
  try {
    value = await requested(request, listeners);
  } catch (reason) {
    if (!(reason instanceof Refusal && reason.owner === listeners)) listeners.note(reason);
  }
  listeners.retire();
  await listeners.join();
  listeners.finish();
  return value;
}

/**
 * Acquired transaction owner. Only complete and abort are terminal events.
 *
 * A bubbling request error can be canceled by the caller and followed by a
 * successful commit. Abort requested by this owner is rollback acknowledgement;
 * its null transaction.error is not an additional failure occurrence. A non-null
 * terminal error remains an observation even when it resembles a request error.
 */
class Transaction {
  readonly listeners = new Listeners();
  readonly #transaction: IDBTransaction;
  readonly #done = Promise.withResolvers<void>();
  readonly #observed: boolean;
  #terminal = false;
  #aborting = false;
  #retirement: Promise<void> | undefined;

  constructor(transaction: IDBTransaction) {
    this.#transaction = transaction;
    const complete = this.listeners.observe(transaction, "complete", () => this.#settle(false));
    const abort = this.listeners.observe(transaction, "abort", () => this.#settle(true));
    this.#observed = complete && abort;
  }

  #settle(aborted: boolean): void {
    if (this.#terminal) return;
    this.#terminal = true;
    try {
      if (aborted) {
        const reason = this.#transaction.error;
        if (reason !== null) this.listeners.note(reason);
        else if (!this.#aborting) this.listeners.note(new Error("IndexedDB transaction aborted."));
      }
    } catch (reason) {
      this.listeners.note(reason);
    }
    this.#done.resolve();
  }

  abort(): void {
    if (this.#terminal || this.#aborting) return;
    this.#aborting = true;
    try {
      this.#transaction.abort();
    } catch (reason) {
      this.listeners.note(reason);
    }
  }

  /** The signal event claims its refusal before invoking borrowed transaction.abort. */
  signal(signal: AbortSignal | undefined, path: PathType): void {
    if (!signal) return;
    let admitted = false;
    const abort = () => {
      if (admitted) return;
      try {
        throwIfAborted(signal, "write", path);
      } catch (reason) {
        admitted = true;
        this.listeners.note(reason);
        this.abort();
      }
    };
    this.listeners.listen(signal, "abort", abort);
    try {
      if (signal.aborted) abort();
    } catch (reason) {
      this.listeners.note(reason);
    }
  }

  request<T>(request: IDBRequest<T>): Promise<T> {
    const count = this.listeners.failures.length;
    const pending = requested(request, this.listeners);
    if (this.listeners.failures.length > count) this.abort();
    return pending;
  }

  /** Cache before effects, join native terminal, then attempt every owned detach. */
  retire(): Promise<void> {
    if (this.#retirement) return this.#retirement;
    const pending = Promise.withResolvers<void>();
    this.#retirement = pending.promise;
    void (async () => {
      if (this.listeners.failures.length > 0) this.abort();
      // If terminal observation itself was refused, there is no honest Promise
      // with which to certify terminal delivery. Abort is still attempted and
      // every possibly installed listener is removed; success is never published.
      if (this.#observed) await this.#done.promise;
      this.listeners.retire();
      await this.listeners.join();
      this.listeners.finish();
    })().then(pending.resolve, pending.reject);
    return pending.promise;
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    let value!: T;
    if (this.listeners.failures.length === 0) {
      try {
        value = await action();
      } catch (reason) {
        if (!(reason instanceof Refusal && reason.owner === this.listeners)) this.listeners.note(reason);
      }
    }
    await this.retire();
    return value;
  }
}

/**
 * Waits for transaction completion, then releases its terminal observation.
 *
 * Completion certifies commit under the browser's selected durability policy;
 * it does not universally imply strict disk flushing. This function does not
 * overwrite caller handlers or treat a canceled request error as terminal.
 * Install before terminal dispatch: transactions expose no completion replay.
 */
export function committed(transaction: IDBTransaction): Promise<void> {
  return new Transaction(transaction).retire();
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
  upgrade(request.result, request.transaction, storeName, parentIndex);
}

/** Keep the acquired database and upgrade transaction stable through schema effects. */
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
