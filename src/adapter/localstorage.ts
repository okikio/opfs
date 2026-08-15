import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { normalizePath, splitPath, type PathType } from "../path.ts";
import { RecordSchema } from "../schema.ts";

/** Minimal synchronous Web Storage contract used by the adapter. */
export interface LocalStorageType {
  /** Number of keys in the storage area. */
  readonly length: number;
  /** Returns the key at one storage index. */
  key(index: number): string | null;
  /** Reads one string value. */
  getItem(key: string): string | null;
  /** Replaces one string value. */
  setItem(key: string, value: string): void;
  /** Removes one key. */
  removeItem(key: string): void;
}

/** Options for the localStorage-backed adapter. */
export interface LocalStorageAdapterOptionsType {
  /** Key prefix reserved for filesystem records. Defaults to `opfs`. */
  readonly prefix?: string;
  /** Prevents filesystem mutations. */
  readonly readOnly?: boolean;
}

/** Creates the reversible key used for one canonical virtual path. */
function getKey(prefix: string, path: PathType): string {
  return `${prefix}:${encodeURIComponent(path)}`;
}

/** Returns a canonical path from one adapter-owned key. */
function getPath(prefix: string, key: string): PathType | null {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  try {
    return normalizePath(decodeURIComponent(key.slice(marker.length)));
  } catch {
    // Ignore malformed foreign keys inside the reserved prefix. Exact adapter
    // reads still surface malformed stored records through RecordSchema.
    return null;
  }
}

/**
 * Record-store projection over one synchronous Web Storage area.
 *
 * Web Storage is string-only and has index-based key iteration. The store
 * therefore serializes complete records as JSON and scans only the reserved
 * namespace when it needs direct children. It does not claim streaming or
 * filesystem-scale directory performance.
 */
class LocalStorageRecordStore implements RecordStoreType {
  /** Browser Storage-like object borrowed from the caller. */
  readonly #storage: LocalStorageType;
  /** Normalized key prefix reserved for this filesystem. */
  readonly #prefix: string;

  /** Resolves the private namespace once for every later record operation. */
  constructor(storage: LocalStorageType, options: LocalStorageAdapterOptionsType) {
    this.#storage = storage;
    this.#prefix = (options.prefix ?? "opfs").replace(/:+$/g, "") || "opfs";
  }

  /** Reads and validates one JSON record. */
  async get(path: PathType) {
    const value = this.#storage.getItem(getKey(this.#prefix, path));
    return value === null ? null : RecordSchema.parse(JSON.parse(value));
  }

  /** Replaces one complete JSON record synchronously. */
  async set(record: Parameters<RecordStoreType["set"]>[0]): Promise<void> {
    this.#storage.setItem(getKey(this.#prefix, record.path), JSON.stringify(record));
  }

  /** Removes one exact adapter-owned key. */
  async delete(path: PathType): Promise<void> {
    this.#storage.removeItem(getKey(this.#prefix, path));
  }

  /** Scans the reserved namespace and yields direct child records only. */
  async *list(parent: PathType) {
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
 * Creates the record-store layer over the Web Storage `Storage` contract.
 *
 * File bytes use the normal record adapter's Base64 representation. This path
 * is useful for small settings/cache data, not large files.
 */
export function createLocalStorageRecordStore(
  storage: LocalStorageType,
  options: LocalStorageAdapterOptionsType = {},
): RecordStoreType {
  return new LocalStorageRecordStore(storage, options);
}

/** Creates an OPFS-shaped facade adapter over localStorage or another Web Storage-compatible object. */
export function createLocalStorageAdapter(
  storage: LocalStorageType,
  options: LocalStorageAdapterOptionsType = {},
): AdapterType {
  return createRecordAdapter(createLocalStorageRecordStore(storage, options), {
    name: "localstorage",
    readOnly: options.readOnly ?? false,
    disposeStore: false,
  });
}
