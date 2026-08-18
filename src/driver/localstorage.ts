import { normalizePath, type PathType, splitPath } from "../path.ts";
import { RecordSchema, type RecordType } from "../schema.ts";
import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";

/** Minimal synchronous Web Storage contract used by the driver. */
export interface LocalStorageType {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Options for the localStorage record driver. */
export interface LocalStorageDriverOptionsType {
  /** Key prefix reserved for filesystem records. Defaults to `opfs`. */
  readonly prefix?: string;
  /** Prevents mutations at the driver layer. */
  readonly readOnly?: boolean;
}

/** Creates the reversible key used for one canonical virtual path. */
function getKey(prefix: string, path: PathType): string {
  return `${prefix}:${encodeURIComponent(path)}`;
}

/** Returns a canonical path from one driver-owned key. */
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
  readonly capabilities = { replacement: "atomic", binary: false, transactions: false } as const;
  readonly #storage: LocalStorageType;
  readonly #prefix: string;

  constructor(storage: LocalStorageType, options: LocalStorageDriverOptionsType) {
    this.#storage = storage;
    this.#prefix = (options.prefix ?? "opfs").replace(/:+$/g, "") || "opfs";
  }

  async get(path: PathType): Promise<RecordType | null> {
    const value = this.#storage.getItem(getKey(this.#prefix, path));
    return value === null ? null : RecordSchema.parse(JSON.parse(value));
  }

  async set(record: RecordType): Promise<void> {
    this.#storage.setItem(getKey(this.#prefix, record.path), JSON.stringify(record));
  }

  async delete(path: PathType): Promise<void> {
    this.#storage.removeItem(getKey(this.#prefix, path));
  }

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

/** Creates a localStorage/Web Storage record driver. */
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
