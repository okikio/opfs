import { normalizePath, type PathType } from "../../path.ts";

/**
 * Name of one WebExtensions storage area.
 *
 * The names match `browser.storage.<name>` and `chrome.storage.<name>`:
 *
 * | Area      | Chrome | Firefox | Safari                 |
 * | --------- | ------ | ------- | ---------------------- |
 * | `local`   | yes    | yes     | 14+                    |
 * | `session` | 102+   | 115+    | 16.4+                  |
 * | `sync`    | yes    | yes     | stored, not synced     |
 * | `managed` | yes    | yes     | no                     |
 *
 * `managed` is set by an administrator policy. Extensions can only read it.
 */
export type StorageAreaNameType = "local" | "session" | "sync" | "managed";

/**
 * One change that the browser reports for a key.
 *
 * `oldValue` is absent when the key is new. `newValue` is absent when the key
 * was removed.
 */
export interface StorageChangeType {
  /** Value before the change. */
  readonly oldValue?: unknown;
  /** Value after the change. */
  readonly newValue?: unknown;
}

/** Listener that a `StorageArea.onChanged` event calls. */
export type StorageChangeListenerType = (changes: Record<string, StorageChangeType>) => void;

/**
 * The part of the WebExtensions `StorageArea` that the driver uses.
 *
 * Pass `browser.storage.local`, `chrome.storage.sync` or a test double. The
 * type is structural so it accepts the Chrome, Firefox and Safari objects
 * without a dependency on their type packages.
 *
 * `getKeys()` exists in Chrome 130+, Firefox 143+ and Safari 18.4+. When it is
 * missing, the driver lists keys with `get(null)`, which also reads values.
 * The quota constants are present only on areas that have them, for example
 * `sync.QUOTA_BYTES_PER_ITEM`.
 *
 * @example Use the real area in an extension.
 * ```ts
 * import { createExtensionDriver } from "@okikio/opfs/driver/extension";
 *
 * const driver = createExtensionDriver(chrome.storage.local, { area: "local" });
 * ```
 */
export interface StorageAreaType {
  /** Reads keys. `null` reads every key in the area. */
  get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>>;
  /** Writes keys. The browser stores JSON-compatible values only. */
  set(items: Record<string, unknown>): Promise<void>;
  /** Removes keys. */
  remove(keys: string | readonly string[]): Promise<void>;
  /** Lists keys without reading values. Missing in older browsers. */
  getKeys?(): Promise<string[]>;
  /** Returns bytes used by some keys, or by the whole area for `null`. */
  getBytesInUse?(keys?: string | readonly string[] | null): Promise<number>;
  /** Change events for this area only. */
  readonly onChanged?: {
    addListener(listener: StorageChangeListenerType): void;
    removeListener(listener: StorageChangeListenerType): void;
  };
  /** Total bytes the area can hold. */
  readonly QUOTA_BYTES?: number;
  /** Bytes one key plus its JSON value can use. */
  readonly QUOTA_BYTES_PER_ITEM?: number;
  /** Number of keys the area can hold. */
  readonly MAX_ITEMS?: number;
  /** Writes allowed each minute. */
  readonly MAX_WRITE_OPERATIONS_PER_MINUTE?: number;
  /** Writes allowed each hour. */
  readonly MAX_WRITE_OPERATIONS_PER_HOUR?: number;
}

/**
 * Removes trailing colons from a key prefix and falls back to `opfs`.
 *
 * The driver and the change feed must agree on the prefix, so both use this.
 */
export function toPrefix(prefix: string | undefined): string {
  return (prefix ?? "opfs").replace(/:+$/g, "") || "opfs";
}

/**
 * Creates the key for one canonical path.
 *
 * The path is URL encoded so the key can be decoded back to the same path.
 */
export function getKey(prefix: string, path: PathType): string {
  return `${prefix}:${encodeURIComponent(path)}`;
}

/**
 * Returns the canonical path for one driver key, or `null` for other keys.
 *
 * Other code in the extension can use the same area. Keys that do not round
 * trip are ignored instead of read.
 */
export function getPath(prefix: string, key: string): PathType | null {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  try {
    const path = normalizePath(decodeURIComponent(key.slice(marker.length)));
    return getKey(prefix, path) === key ? path : null;
  } catch {
    return null;
  }
}

/**
 * Returns the bytes the browser counts for one item.
 *
 * Chrome and Firefox (MDN, `storage.sync`) both count the key length plus the
 * length of `JSON.stringify(value)`. This uses UTF-8 length, which is never
 * smaller than a UTF-16 length count, so the check does not let through an
 * item the browser refuses.
 */
export function getItemBytes(key: string, value: unknown): number {
  const encoder = new TextEncoder();
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}
