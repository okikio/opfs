import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";
import { normalizePath, type PathType, splitPath } from "../path.ts";
import { RecordSchema } from "../schema.ts";

/**
 * Structural subset of unstorage's current `Storage` API used by this driver.
 *
 * The driver intentionally depends on the high-level Storage object, not a
 * specific driver. A storage created with memory, IndexedDB, Redis, S3, db0,
 * Cloudflare, filesystem, or another current unstorage driver can therefore be
 * supplied without a second OPFS storage implementation.
 */
export interface UnstorageStorageType {
  /** Reads one decoded storage value. */
  getItem<T = unknown>(key: string, options?: Record<string, unknown>): Promise<T | null>;
  /** Stores one serializable value. */
  setItem<T>(key: string, value: T, options?: Record<string, unknown>): Promise<void>;
  /** Removes one key. */
  removeItem(key: string, options?: Record<string, unknown> | boolean): Promise<void>;
  /** Lists keys below an optional base key. */
  getKeys(base?: string, options?: Record<string, unknown>): Promise<string[]>;
  /** Releases mounted drivers owned by the Storage object. */
  dispose?(): Promise<void>;
}

/** Options for the unstorage-backed record driver. */
export interface UnstorageDriverOptionsType {
  /** Key prefix reserved for filesystem records. Defaults to `opfs`. */
  readonly prefix?: string;
  /** Prevents all mutations. Useful with read-only HTTP/GitHub drivers. */
  readonly readOnly?: boolean;
  /** Disposes the injected Storage object when the filesystem closes. */
  readonly disposeStorage?: boolean;
}

/** Encodes one virtual path name into an unstorage key segment without `:` or `%`. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/~/g, "%7E").replace(/%/g, "~");
}

/** Reverses {@link encodeSegment} for keys owned by this driver. */
function decodeSegment(value: string): string {
  return decodeURIComponent(value.replace(/~/g, "%"));
}

/** Removes trailing unstorage separators while retaining a non-empty namespace. */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/:+$/g, "") || "opfs";
}

/**
 * Escapes the entire canonical path into one leaf key. A hierarchical record
 * key cannot also contain children on filesystem-backed unstorage drivers.
 */
function getKey(prefix: string, path: string): string {
  return `${prefix}:record:${encodeSegment(path)}`;
}

/** Retains readability of records written before the flat-key layout. */
function getLegacyKey(prefix: string, path: string): string {
  const parts = splitPath(path);
  return parts.length === 0 ? `${prefix}:entry` : `${prefix}:entry:${parts.map(encodeSegment).join(":")}`;
}

/** Maps a driver-owned unstorage key back to a canonical path, or null for foreign keys. */
function getPath(prefix: string, key: string): PathType | null {
  try {
    const flatBase = `${prefix}:record:`;
    if (key.startsWith(flatBase)) {
      const path = normalizePath(decodeSegment(key.slice(flatBase.length)));
      return getKey(prefix, path) === key ? path : null;
    }
    const base = `${prefix}:entry`;
    if (key === base) return "/";
    if (!key.startsWith(`${base}:`)) return null;
    const encoded = key.slice(base.length + 1).split(":");
    const path = normalizePath(encoded.map(decodeSegment).join("/"));
    return getLegacyKey(prefix, path) === key ? path : null;
  } catch {
    return null;
  }
}

/**
 * Record-store projection over any compatible unstorage `Storage` instance.
 *
 * The class targets the high-level Storage surface rather than one driver.
 * Driver-specific replication, retries, durability, limits, and provider SDKs
 * remain owned by unstorage and the selected driver.
 */
class UnstorageBackend implements RecordBackendType {
  /** unstorage Storage borrowed from or transferred by the caller. */
  readonly #storage: UnstorageStorageType;
  /** Reserved unstorage namespace for filesystem records. */
  readonly #prefix: string;
  /** Whether disposal also disposes the injected Storage. */
  readonly #disposeStorage: boolean;

  /** Resolves namespace and ownership policy once. */
  constructor(storage: UnstorageStorageType, options: UnstorageDriverOptionsType) {
    this.#storage = storage;
    this.#prefix = normalizePrefix(options.prefix ?? "opfs");
    this.#disposeStorage = options.disposeStorage ?? false;
  }

  /** Reads and validates one exact unstorage record. */
  async get(path: PathType) {
    const value = await this.#storage.getItem(getKey(this.#prefix, path)) ??
      await this.#storage.getItem(getLegacyKey(this.#prefix, path));
    return value === null ? null : RecordSchema.parse(value);
  }

  /** Replaces one exact unstorage record. */
  async set(record: Parameters<RecordBackendType["set"]>[0]): Promise<void> {
    await this.#storage.setItem(getKey(this.#prefix, record.path), record);
  }

  /** Removes one exact unstorage record. */
  async delete(path: PathType): Promise<void> {
    await this.#storage.removeItem(getKey(this.#prefix, path));
    await this.#storage.removeItem(getLegacyKey(this.#prefix, path));
  }

  /**
   * Lists flat and legacy records, preferring the current layout when both
   * exist. Flat leaf keys need a namespace scan; explicit parent comparison
   * supplies correctness independently of upstream depth optimizations.
   */
  async *list(parent: PathType) {
    const keys = [
      ...await this.#storage.getKeys(`${this.#prefix}:record`),
      ...await this.#storage.getKeys(getLegacyKey(this.#prefix, parent)),
    ];
    const seen = new Set<PathType>();
    for (const storageKey of keys) {
      const path = getPath(this.#prefix, storageKey);
      if (path === null || path === "/" || seen.has(path)) continue;
      const parts = splitPath(path);
      const actualParent = normalizePath(parts.slice(0, -1).join("/"));
      if (actualParent !== parent) continue;
      seen.add(path);
      const value = await this.get(path);
      if (value !== null) yield RecordSchema.parse(value);
    }
  }

  /** Disposes the injected Storage only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeStorage) await this.#storage.dispose?.();
  }
}

/** Creates an independently useful record driver from one unstorage `Storage`. */
export function createUnstorageDriver(
  storage: UnstorageStorageType,
  options: UnstorageDriverOptionsType = {},
): RecordDriverType {
  return defineRecordDriver(new UnstorageBackend(storage, options), {
    name: "unstorage",
    capabilities: { replacement: "best-effort", transactions: false, binary: false },
    requirements: [{ code: "unstorage", state: "available" }],
    optimizations: [],
    readOnly: options.readOnly ?? false,
    disposeBackend: options.disposeStorage ?? false,
  });
}
