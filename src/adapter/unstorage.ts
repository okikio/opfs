import type { AdapterType } from "./definition.ts";
import { createRecordAdapter, type RecordStoreType } from "./record.ts";
import { normalizePath, splitPath, type PathType } from "../path.ts";
import { RecordSchema } from "../schema.ts";

/**
 * Structural subset of unstorage's current `Storage` API used by this adapter.
 *
 * The bridge intentionally depends on the high-level Storage object, not a
 * specific driver. A storage created with memory, IndexedDB, Redis, S3, db0,
 * Cloudflare, filesystem, or another current unstorage driver can therefore be
 * supplied without a second adapter implementation.
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

/** Options for the unstorage-backed filesystem adapter. */
export interface UnstorageAdapterOptionsType {
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

/** Reverses {@link encodeSegment} for keys owned by this adapter. */
function decodeSegment(value: string): string {
  return decodeURIComponent(value.replace(/~/g, "%"));
}

/** Removes trailing unstorage separators while retaining a non-empty namespace. */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/:+$/g, "") || "opfs";
}

/** Maps one canonical virtual path to the private unstorage record namespace. */
function getKey(prefix: string, path: string): string {
  const parts = splitPath(path);
  return parts.length === 0 ? `${prefix}:entry` : `${prefix}:entry:${parts.map(encodeSegment).join(":")}`;
}

/** Maps an adapter-owned unstorage key back to a canonical path, or null for foreign keys. */
function getPath(prefix: string, key: string): PathType | null {
  const base = `${prefix}:entry`;
  if (key === base) return "/";
  if (!key.startsWith(`${base}:`)) return null;
  const encoded = key.slice(base.length + 1).split(":");
  return normalizePath(encoded.map(decodeSegment).join("/"));
}

/**
 * Record-store projection over any compatible unstorage `Storage` instance.
 *
 * The class targets the high-level Storage surface rather than one driver.
 * Driver-specific replication, retries, durability, limits, and provider SDKs
 * remain owned by unstorage and the selected driver.
 */
class UnstorageRecordStore implements RecordStoreType {
  /** unstorage Storage borrowed from or transferred by the caller. */
  readonly #storage: UnstorageStorageType;
  /** Reserved unstorage namespace for filesystem records. */
  readonly #prefix: string;
  /** Whether disposal also disposes the injected Storage. */
  readonly #disposeStorage: boolean;

  /** Resolves namespace and ownership policy once. */
  constructor(storage: UnstorageStorageType, options: UnstorageAdapterOptionsType) {
    this.#storage = storage;
    this.#prefix = normalizePrefix(options.prefix ?? "opfs");
    this.#disposeStorage = options.disposeStorage ?? false;
  }

  /** Reads and validates one exact unstorage record. */
  async get(path: PathType) {
    const value = await this.#storage.getItem(getKey(this.#prefix, path));
    return value === null ? null : RecordSchema.parse(value);
  }

  /** Replaces one exact unstorage record. */
  async set(record: Parameters<RecordStoreType["set"]>[0]): Promise<void> {
    await this.#storage.setItem(getKey(this.#prefix, record.path), record);
  }

  /** Removes one exact unstorage record. */
  async delete(path: PathType): Promise<void> {
    await this.#storage.removeItem(getKey(this.#prefix, path));
  }

  /**
   * Lists direct children below one encoded directory key.
   *
   * `maxDepth: 1` is an optional upstream optimization. Correctness still comes
   * from the explicit path-depth filter because not every unstorage driver
   * advertises or honors the same listing acceleration.
   */
  async *list(parent: PathType) {
    const parentDepth = splitPath(parent).length;
    const keys = await this.#storage.getKeys(getKey(this.#prefix, parent), { maxDepth: 1 });
    for (const storageKey of keys) {
      const path = getPath(this.#prefix, storageKey);
      if (path === null || path === parent || splitPath(path).length !== parentDepth + 1) continue;
      const value = await this.#storage.getItem(storageKey);
      if (value !== null) yield RecordSchema.parse(value);
    }
  }

  /** Disposes the injected Storage only when ownership was explicitly transferred. */
  async dispose(): Promise<void> {
    if (this.#disposeStorage) await this.#storage.dispose?.();
  }
}

/**
 * Creates a record store over any unstorage `Storage` instance.
 *
 * @example Reserve one key namespace for filesystem records.
 * ```ts
 * const store = createUnstorageRecordStore(storage, {
 *   prefix: "application-fs",
 *   disposeStorage: false,
 * });
 * ```
 */
export function createUnstorageRecordStore(
  storage: UnstorageStorageType,
  options: UnstorageAdapterOptionsType = {},
): RecordStoreType {
  return new UnstorageRecordStore(storage, options);
}

/**
 * Creates an OPFS-shaped filesystem adapter backed by unstorage.
 *
 * The Storage object is borrowed unless `disposeStorage` is true. Individual
 * upstream driver limits still apply and are not replaced by the filesystem
 * facade.
 */
export function createUnstorageAdapter(
  storage: UnstorageStorageType,
  options: UnstorageAdapterOptionsType = {},
): AdapterType {
  return createRecordAdapter(createUnstorageRecordStore(storage, options), {
    name: "unstorage",
    readOnly: options.readOnly ?? false,
    disposeStore: true,
  });
}
