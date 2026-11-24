import { FileSystemError, getErrorMessage } from "../../error.ts";
import { type PathType, splitPath } from "../../path.ts";
import { type LimitType, RecordSchema, type RecordType } from "../../schema/mod.ts";
import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "../../driver/record.ts";
import { getItemBytes, getKey, getPath, type StorageAreaNameType, type StorageAreaType, toPrefix } from "./area.ts";

/**
 * Options for {@link createExtensionDriver}.
 *
 * `area` names the storage area you passed in. The driver cannot read the name
 * from the object, and the name decides two rules: `managed` is always read
 * only, and `local` drops its byte quota when the extension has the
 * `unlimitedStorage` permission.
 */
export interface ExtensionDriverOptionsType {
  /** Which area the `StorageArea` object is. */
  readonly area: StorageAreaNameType;
  /** Key prefix reserved for filesystem records. Defaults to `opfs`. */
  readonly prefix?: string;
  /** Prevents mutations. `managed` is read only whatever this says. */
  readonly readOnly?: boolean;
  /**
   * Set this when the manifest requests `unlimitedStorage`.
   *
   * Chrome still reports `local.QUOTA_BYTES` with the permission, but does not
   * enforce it. With this flag the driver leaves that limit out.
   */
  readonly unlimitedStorage?: boolean;
}

/** Returns whether a browser failure means a quota or rate limit was reached. */
function isQuota(error: unknown): boolean {
  // Chrome rejects with messages such as "QUOTA_BYTES_PER_ITEM quota exceeded"
  // and "MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded". Firefox uses a
  // QuotaExceededError name. Safari reports "Exceeded storage quota".
  const name = typeof error === "object" && error !== null ? Reflect.get(error, "name") : undefined;
  return name === "QuotaExceededError" || /quota|MAX_ITEMS|MAX_WRITE_OPERATIONS/i.test(getErrorMessage(error));
}

/** Converts quota failures to `quota-exceeded` and keeps other failures unchanged. */
function failure(error: unknown, operation: string, path: PathType): unknown {
  if (!isQuota(error)) return error;
  return new FileSystemError(
    "quota-exceeded",
    operation,
    path,
    `Extension storage ${operation} failed: ${getErrorMessage(error)}`,
    error,
  );
}

/**
 * Returns the limits that one storage area reports.
 *
 * The values come from the area's own constants, so the same code reports
 * Chrome, Firefox and Safari numbers without a per-browser table. An area
 * without constants gets one dynamic byte quota.
 */
function getLimits(area: StorageAreaType, options: ExtensionDriverOptionsType): LimitType[] {
  const limits: LimitType[] = [];
  const quota = options.area === "local" && options.unlimitedStorage === true ? undefined : area.QUOTA_BYTES;
  if (quota !== undefined) {
    limits.push({ code: "quota-bytes", kind: "hard", source: "provider", unit: "bytes", value: quota });
  } else if (options.unlimitedStorage !== true || options.area !== "local") {
    limits.push({
      code: "quota-bytes",
      kind: "dynamic",
      source: "provider",
      unit: "bytes",
      detail: "The area does not report QUOTA_BYTES. The browser decides the quota.",
    });
  }
  const item = area.QUOTA_BYTES_PER_ITEM;
  if (item !== undefined) {
    limits.push({ code: "item-bytes", kind: "hard", source: "provider", unit: "bytes", value: item });
    limits.push({
      code: "file-bytes",
      kind: "hard",
      source: "implementation",
      unit: "bytes",
      // Base64 turns 3 bytes into 4 characters. The record's path and metadata
      // also count, so this is an upper bound. `set()` checks the exact size.
      value: Math.floor(item * 3 / 4),
      detail: "Upper bound from QUOTA_BYTES_PER_ITEM after base64. The key and record metadata use part of each item.",
    });
  }
  if (area.MAX_ITEMS !== undefined) {
    limits.push({ code: "item-count", kind: "hard", source: "provider", unit: "count", value: area.MAX_ITEMS });
  }
  if (area.MAX_WRITE_OPERATIONS_PER_MINUTE !== undefined) {
    limits.push({
      code: "writes-per-minute",
      kind: "hard",
      source: "provider",
      unit: "operations",
      value: area.MAX_WRITE_OPERATIONS_PER_MINUTE,
    });
  }
  if (area.MAX_WRITE_OPERATIONS_PER_HOUR !== undefined) {
    limits.push({
      code: "writes-per-hour",
      kind: "hard",
      source: "provider",
      unit: "operations",
      value: area.MAX_WRITE_OPERATIONS_PER_HOUR,
    });
  }
  return limits;
}

/**
 * Whole-record projection over one WebExtensions storage area.
 *
 * Layout: key `<prefix>:<encodeURIComponent(path)>`, value one `RecordType`
 * object. File bytes are base64 in `data`, because storage areas keep JSON
 * values only. One file is one item, so `sync` holds files up to about 6 KB.
 */
class ExtensionBackend implements RecordBackendType {
  /** One `set()` call replaces one item. The browser applies it as one write. */
  readonly capabilities = { replacement: "atomic", binary: false, transactions: false } as const;
  readonly #area: StorageAreaType;
  readonly #prefix: string;

  /** Binds one area and reserves one key prefix. */
  constructor(area: StorageAreaType, prefix: string) {
    this.#area = area;
    this.#prefix = prefix;
  }

  /** Validates one stored value and checks that it belongs to its key. */
  #parse(value: unknown, path: PathType): RecordType {
    const record = RecordSchema.parse(value);
    // A valid record stored under another key is corruption, not a new entry.
    if (record.path !== path) throw new TypeError("Stored extension record does not match its key.");
    return record;
  }

  /** Reads one record. */
  async get(path: PathType): Promise<RecordType | null> {
    const key = getKey(this.#prefix, path);
    const value = (await this.#area.get(key))[key];
    return value === undefined ? null : this.#parse(value, path);
  }

  /** Replaces one record after checking the per-item quota locally. */
  async set(record: RecordType): Promise<void> {
    const key = getKey(this.#prefix, record.path);
    const limit = this.#area.QUOTA_BYTES_PER_ITEM;
    if (limit !== undefined) {
      // Checking first gives a clear error and does not spend a rate-limited write.
      const bytes = getItemBytes(key, record);
      if (bytes > limit) {
        throw new FileSystemError(
          "quota-exceeded",
          "write",
          record.path,
          `Extension storage item needs ${bytes} bytes; the area allows ${limit} bytes per item.`,
        );
      }
    }
    try {
      await this.#area.set({ [key]: record });
    } catch (error) {
      throw failure(error, "write", record.path);
    }
  }

  /** Removes one record key. */
  async delete(path: PathType): Promise<void> {
    try {
      await this.#area.remove(getKey(this.#prefix, path));
    } catch (error) {
      throw failure(error, "remove", path);
    }
  }

  /** Lists direct children of `parent`. */
  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    const depth = splitPath(parent).length + 1;
    let values: Record<string, unknown>;
    if (this.#area.getKeys !== undefined) {
      // Read keys first, then fetch only this directory's values in one call.
      const keys = (await this.#area.getKeys()).filter((key) => {
        const path = getPath(this.#prefix, key);
        return path !== null && splitPath(path).length === depth;
      });
      values = keys.length === 0 ? {} : await this.#area.get(keys);
    } else {
      values = await this.#area.get(null);
    }
    for (const [key, value] of Object.entries(values)) {
      const path = getPath(this.#prefix, key);
      if (path === null || splitPath(path).length !== depth) continue;
      const record = this.#parse(value, path);
      if (record.parent === parent) yield record;
    }
  }
}

/**
 * Creates a record driver over a WebExtensions storage area.
 *
 * Use it in Chrome, Firefox or Safari extensions to give extension code an
 * OPFS-shaped tree in `storage.local`, `storage.session`, `storage.sync` or
 * the read-only `storage.managed`. You pass the area in, so importing this
 * module touches no browser global.
 *
 * `fs.backend` returns the area, for calls the filesystem does not model, such
 * as `getBytesInUse()` or `setAccessLevel()`.
 *
 * @example Store settings files in `storage.sync`.
 * ```ts
 * import { createExtensionDriver } from "@okikio/opfs/driver/extension";
 * import { createRecordAdapter } from "@okikio/opfs/adapter/record";
 * import { createFileSystem } from "@okikio/opfs";
 *
 * const fs = createFileSystem(createRecordAdapter(createExtensionDriver(chrome.storage.sync, { area: "sync" })));
 * await fs.writeFile("/settings.json", new TextEncoder().encode("{}"));
 * console.log(await fs.backend.getBytesInUse?.(null));
 * ```
 *
 * Limits: every file is one item. In `sync` that is 8192 bytes per item in
 * Chrome and Firefox, about 6 KB of file bytes after base64. Writes larger than
 * that fail with `quota-exceeded` before any browser call. `sync` also allows
 * 120 writes each minute and 1800 each hour.
 */
export function createExtensionDriver(
  area: StorageAreaType,
  options: ExtensionDriverOptionsType,
): RecordDriverType<StorageAreaType> {
  const prefix = toPrefix(options.prefix);
  const readOnly = options.area === "managed" || options.readOnly === true;
  return defineRecordDriver<StorageAreaType>(new ExtensionBackend(area, prefix), {
    name: `extension-${options.area}`,
    ownership: "borrowed",
    backend: area,
    requirements: [{ code: "extension-storage", state: "available" }],
    limits: getLimits(area, options),
    optimizations: [],
    capabilities: { replacement: "atomic", binary: false, transactions: false },
    readOnly,
  });
}

export type { StorageAreaNameType, StorageAreaType, StorageChangeListenerType, StorageChangeType } from "./area.ts";
