import { normalizePath, type PathType, splitPath } from "../path.ts";
import { RecordSchema, type RecordType } from "../schema.ts";
import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";

/**
 * Minimal synchronous Web Storage contract used by the driver.
 *
 * The driver only needs the small key/value surface shared by `localStorage`
 * and compatible test doubles. Quota, eviction, and persistence guarantees stay
 * owned by the browser runtime.
 */
export interface LocalStorageType {
  /** Current key count visible in the storage area. */
  readonly length: number;
  /** Returns the key at one index, or `null` when the index is out of range. */
  key(index: number): string | null;
  /** Returns one stored string value. */
  getItem(key: string): string | null;
  /** Replaces one stored string value. */
  setItem(key: string, value: string): void;
  /** Removes one stored key. */
  removeItem(key: string): void;
}

/**
 * Options for the localStorage record driver.
 *
 * The prefix keeps filesystem records isolated from unrelated application keys.
 * `readOnly` is useful when a caller wants to expose inspection or migration
 * behavior without letting the facade mutate browser storage.
 */
export interface LocalStorageDriverOptionsType {
  /** Key prefix reserved for filesystem records. Defaults to `opfs`. */
  readonly prefix?: string;
  /** Prevents mutations at the driver layer. */
  readonly readOnly?: boolean;
}

/**
 * Creates the reversible key used for one canonical virtual path.
 *
 * The driver stores the canonical path verbatim after URL encoding so it can be
 * recovered without inventing a second path-normalization rule.
 */
function getKey(prefix: string, path: PathType): string {
  return `${prefix}:${encodeURIComponent(path)}`;
}

/**
 * Returns a canonical path from one driver-owned key.
 *
 * Invalid or foreign keys are ignored instead of throwing so the driver can
 * coexist with unrelated storage entries under the same Web Storage area.
 */
function getPath(prefix: string, key: string): PathType | null {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  try {
    return normalizePath(decodeURIComponent(key.slice(marker.length)));
  } catch {
    return null;
  }
}

/** Complete-record projection over one synchronous Web Storage area. */
class LocalStorageBackend implements RecordBackendType {
  /** Record replacement is synchronous but still bounded by browser quota policy. */
  readonly capabilities = { replacement: "atomic", binary: false, transactions: false } as const;
  readonly #storage: LocalStorageType;
  readonly #prefix: string;

  /** Binds one storage area and reserves one key prefix for filesystem records. */
  constructor(storage: LocalStorageType, options: LocalStorageDriverOptionsType) {
    this.#storage = storage;
    this.#prefix = (options.prefix ?? "opfs").replace(/:+$/g, "") || "opfs";
  }

  /** Reads and validates one record from the prefixed key namespace. */
  async get(path: PathType): Promise<RecordType | null> {
    const value = this.#storage.getItem(getKey(this.#prefix, path));
    return value === null ? null : RecordSchema.parse(JSON.parse(value));
  }

  /** Replaces one complete record as one synchronous string write. */
  async set(record: RecordType): Promise<void> {
    this.#storage.setItem(getKey(this.#prefix, record.path), JSON.stringify(record));
  }

  /** Removes one exact record key. */
  async delete(path: PathType): Promise<void> {
    this.#storage.removeItem(getKey(this.#prefix, path));
  }

  /** Scans all prefixed keys and yields only direct children of the requested parent. */
  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    const parentDepth = splitPath(parent).length;
    for (let index = 0; index < this.#storage.length; index += 1) {
      const key = this.#storage.key(index);
      if (key === null) continue;
      const path = getPath(this.#prefix, key);
      if (path === null || splitPath(path).length !== parentDepth + 1) continue;
      const value = this.#storage.getItem(key);
      if (value === null) continue;
      const record = RecordSchema.parse(JSON.parse(value));
      if (record.parent === parent) yield record;
    }
  }
}

/**
 * Creates a localStorage or Web Storage record driver.
 *
 * This driver is useful when you want an inspectable OPFS-shaped projection
 * over browser storage that is fundamentally synchronous and string-oriented.
 * It does not upgrade Web Storage into transactional or durable filesystem
 * semantics.
 */
export function createLocalStorageDriver(
  storage: LocalStorageType,
  options: LocalStorageDriverOptionsType = {},
): RecordDriverType {
  return defineRecordDriver(new LocalStorageBackend(storage, options), {
    name: "localstorage",
    ownership: "borrowed",
    requirements: [{ code: "web-storage", state: "available" }],
    limits: [{
      code: "quota-bytes",
      kind: "dynamic",
      source: "probe",
      unit: "bytes",
      detail: "Web Storage quota depends on the browser, origin, and storage policy.",
    }],
    optimizations: [],
    capabilities: { replacement: "atomic", binary: false, transactions: false },
    readOnly: options.readOnly ?? false,
  });
}
