import { Observable } from "@okikio/observables";

import type { PathType } from "../../path.ts";
import { FileSystemError } from "../../error.ts";
import { RecordSchema } from "../../schema/mod.ts";
import { getPath, type StorageAreaType, type StorageChangeListenerType, toPrefix } from "./area.ts";

/**
 * One filesystem change seen in a storage area.
 *
 * `change` is `write` when the key has a new value and `remove` when the key
 * is gone. `kind` is the entry kind of the new value, or of the old value for
 * a removal. It is absent when the stored value is not a valid record.
 */
export interface StorageAreaEventType {
  /** Canonical path of the entry. */
  readonly path: PathType;
  /** Whether the entry was written or removed. */
  readonly change: "write" | "remove";
  /** Entry kind, when the value is a valid record. */
  readonly kind?: "file" | "directory";
}

/** Options for {@link watchStorageArea}. */
export interface WatchStorageAreaOptionsType {
  /** Key prefix used by the driver. Defaults to `opfs`. */
  readonly prefix?: string;
}

/** Returns the record kind of a stored value without trusting the value. */
function getKind(value: unknown): "file" | "directory" | undefined {
  const parsed = RecordSchema.safeParse(value);
  return parsed.success ? parsed.data.kind : undefined;
}

/**
 * Returns an Observable of filesystem changes in one storage area.
 *
 * The browser calls `area.onChanged` for writes from every extension context:
 * the service worker, popups, options pages and content scripts. Subscribe in
 * one context to see writes that another context made through its own
 * filesystem. Keys outside the driver prefix are ignored.
 *
 * Nothing is registered until you subscribe. Unsubscribing removes the
 * browser listener, so a disposed subscription holds no event handler.
 *
 * @example Refresh a popup when the service worker writes a file.
 * ```ts
 * import { watchStorageArea } from "@okikio/opfs/adapter/extension";
 *
 * using subscription = watchStorageArea(chrome.storage.local).subscribe((event) => {
 *   if (event.change === "write" && event.path === "/settings.json") render();
 * });
 * ```
 *
 * One browser event can change many keys, for example a `set()` with several
 * items. Each changed path becomes one Observable value, in key order.
 *
 * @throws {FileSystemError} `not-supported` when the area has no `onChanged`
 * event. Older Chrome versions and some polyfills only offer the global
 * `storage.onChanged`.
 */
export function watchStorageArea(
  area: StorageAreaType,
  options: WatchStorageAreaOptionsType = {},
): Observable<StorageAreaEventType> {
  const events = area.onChanged;
  if (events === undefined) {
    throw new FileSystemError("not-supported", "watch", undefined, "This storage area has no onChanged event.");
  }
  const prefix = toPrefix(options.prefix);
  return new Observable<StorageAreaEventType>((observer) => {
    const listener: StorageChangeListenerType = (changes) => {
      for (const [key, change] of Object.entries(changes)) {
        const path = getPath(prefix, key);
        if (path === null) continue;
        const removed = !("newValue" in change) || change.newValue === undefined;
        const kind = getKind(removed ? change.oldValue : change.newValue);
        observer.next({ path, change: removed ? "remove" : "write", ...(kind === undefined ? {} : { kind }) });
      }
    };
    events.addListener(listener);
    return () => events.removeListener(listener);
  });
}
