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
 * Creates a record store over any unstorage `Storage` instance.
 *
 * Directory listing asks unstorage for keys below the encoded directory prefix
 * and filters to direct descendants. `maxDepth: 1` is supplied as an optional
 * optimization; drivers that do not implement the flag still preserve correct
 * results through the direct-child filter. The Storage object is borrowed unless
 * `disposeStorage` explicitly transfers disposal.
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
  const prefix = normalizePrefix(options.prefix ?? "opfs");
  return {
    async get(path) {
      const value = await storage.getItem(getKey(prefix, path));
      return value === null ? null : RecordSchema.parse(value);
    },
    async set(record) {
      await storage.setItem(getKey(prefix, record.path), record);
    },
    async delete(path) {
      await storage.removeItem(getKey(prefix, path));
    },
    async *list(parent) {
      const parentDepth = splitPath(parent).length;
      const keys = await storage.getKeys(getKey(prefix, parent), { maxDepth: 1 });
      for (const key of keys) {
        const path = getPath(prefix, key);
        if (path === null || path === parent || splitPath(path).length !== parentDepth + 1) continue;
        const value = await storage.getItem(key);
        if (value !== null) yield RecordSchema.parse(value);
      }
    },
    async dispose() {
      if (options.disposeStorage) await storage.dispose?.();
    },
  };
}

/**
 * Creates an OPFS-shaped filesystem adapter backed by unstorage.
 *
 * The returned adapter works transitively with every unstorage driver that
 * satisfies the high-level Storage methods used above. Individual driver
 * limitations still apply, such as a read-only provider rejecting mutations.
 * The Storage object is borrowed unless `disposeStorage` is true.
 *
 * @example
 * ```ts
 * const fs = createFileSystem(createUnstorageAdapter(storage));
 * await fs.writeFile("/cache/item.json", "{}", { parents: true });
 * ```
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
