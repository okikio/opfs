import type { AdapterType } from "../../adapter/definition.ts";
import { createRecordAdapter } from "../../adapter/record.ts";
import type { StorageAreaNameType, StorageAreaType } from "./area.ts";
import { createExtensionDriver, type ExtensionDriverOptionsType } from "./driver.ts";

/** Options for {@link createExtensionAdapter}. The driver options pass through. */
export type ExtensionAdapterOptionsType = ExtensionDriverOptionsType;

/**
 * Creates an OPFS-shaped adapter over a WebExtensions storage area.
 *
 * This is the short path from `chrome.storage.local` or
 * `browser.storage.sync` to a filesystem. The adapter owns the driver it
 * creates. You still own the area.
 *
 * @example Open `storage.local` in a service worker.
 * ```ts
 * import { createExtensionAdapter } from "@okikio/opfs/adapter/extension";
 * import { createFileSystem } from "@okikio/opfs";
 *
 * const fs = createFileSystem(createExtensionAdapter(chrome.storage.local, { area: "local" }));
 * await fs.writeFile("/notes/today.md", new TextEncoder().encode("# Today"));
 * ```
 */
export function createExtensionAdapter(
  area: StorageAreaType,
  options: ExtensionAdapterOptionsType,
): AdapterType<StorageAreaType> {
  return createRecordAdapter(createExtensionDriver(area, options), {
    name: `extension-${options.area}`,
    readOnly: options.area === "managed" || options.readOnly === true,
    disposeDriver: true,
  });
}

/** The global namespaces that carry `storage` in Chrome, Firefox and Safari. */
interface ExtensionGlobalType {
  readonly browser?: { readonly storage?: Partial<Record<StorageAreaNameType, StorageAreaType>> };
  readonly chrome?: { readonly storage?: Partial<Record<StorageAreaNameType, StorageAreaType>> };
}

/**
 * Returns the browser's storage area with this name, or `undefined`.
 *
 * Firefox and Safari expose `browser.storage`. Chrome exposes
 * `chrome.storage`, and Safari exposes that too. The function checks
 * `browser` first, because its methods return promises in every browser that
 * has it. It reads the globals only when you call it, so importing this module
 * stays safe outside an extension.
 *
 * `undefined` means the area is not available here: outside an extension,
 * without the `storage` permission, `session` in an old browser, or `managed`
 * in Safari.
 *
 * @example Fall back to `local` when `session` is missing.
 * ```ts
 * import { createExtensionAdapter, getStorageArea } from "@okikio/opfs/adapter/extension";
 *
 * const session = getStorageArea("session");
 * const adapter = session === undefined
 *   ? createExtensionAdapter(getStorageArea("local")!, { area: "local", prefix: "tmp" })
 *   : createExtensionAdapter(session, { area: "session" });
 * ```
 */
export function getStorageArea(name: StorageAreaNameType): StorageAreaType | undefined {
  const scope = globalThis as ExtensionGlobalType;
  return scope.browser?.storage?.[name] ?? scope.chrome?.storage?.[name];
}

export { watchStorageArea } from "./watch.ts";
export type { StorageAreaEventType, WatchStorageAreaOptionsType } from "./watch.ts";
export type { StorageAreaNameType, StorageAreaType } from "./area.ts";
