/**
 * The IndexedDB layout the record driver expects: one object store keyed by `path`, with a non-unique index on
 * `parent` for listing a directory's direct children.
 *
 * `openIndexedDbDriver()` applies this layout itself. Published at `@okikio/opfs/driver/indexeddb/_store` for
 * code that opens its own database, for example to add stores of its own in the same upgrade, and then hands
 * it to `createIndexedDbDriver()`.
 *
 * @module
 */

/**
 * Creates the record object store and its parent index during a version upgrade.
 *
 * The step is idempotent, so repeated opens can reuse the same database name without callers dropping
 * storage between test runs or upgrades. It keeps the acquired database and upgrade transaction stable
 * through schema effects.
 */
export function upgrade(
  database: IDBDatabase,
  transaction: IDBTransaction | null,
  storeName: string,
  parentIndex: string,
): void {
  const store = database.objectStoreNames.contains(storeName)
    ? transaction!.objectStore(storeName)
    : database.createObjectStore(storeName, { keyPath: "path" });
  if (!store.indexNames.contains(parentIndex)) store.createIndex(parentIndex, "parent", { unique: false });
}

/**
 * Applies the record driver's store layout from an `upgradeneeded` event on a database you open yourself.
 *
 * Call it inside your own upgrade handler, with the same store and index names you later pass to
 * `createIndexedDbDriver()`:
 *
 * ```ts
 * const request = indexedDB.open("app", 2);
 * request.onupgradeneeded = () => {
 *   upgradeDatabase(request, "files", "parent");
 *   request.result.createObjectStore("settings");
 * };
 * request.onsuccess = () => {
 *   const driver = createIndexedDbDriver(request.result, { store: "files", parentIndex: "parent" });
 * };
 * ```
 *
 * It is idempotent: an existing store or index is left as it is.
 */
export function upgradeDatabase(request: IDBOpenDBRequest, storeName: string, parentIndex: string): void {
  upgrade(request.result, request.transaction, storeName, parentIndex);
}
