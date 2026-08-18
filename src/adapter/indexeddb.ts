import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createIndexedDbDriver,
  type IndexedDbDriverOptionsType,
  type IndexedDbOpenOptionsType,
  openIndexedDbDriver,
} from "../driver/indexeddb.ts";

/**
 * Options for an IndexedDB-backed filesystem adapter.
 *
 * These pass through to the IndexedDB record driver, then add the adapter's
 * OPFS translation behavior on top.
 */
export type IndexedDbAdapterOptionsType = IndexedDbDriverOptionsType;
export type { IndexedDbOpenOptionsType };

/**
 * Creates a filesystem adapter over an existing IndexedDB database.
 *
 * The caller keeps control over how the database was opened, versioned, and
 * shared with other application code.
 */
export function createIndexedDbAdapter(database: IDBDatabase, options: IndexedDbAdapterOptionsType = {}): AdapterType {
  const driver = createIndexedDbDriver(database, options);
  return createRecordAdapter(driver, {
    name: "indexeddb",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}

/**
 * Opens an owned IndexedDB database and returns its filesystem adapter.
 *
 * This is the convenience path when the package should both prepare the
 * database schema and expose the resulting OPFS-shaped adapter.
 */
export async function openIndexedDbAdapter(options: IndexedDbOpenOptionsType = {}): Promise<AdapterType> {
  const driver = await openIndexedDbDriver(options);
  return createRecordAdapter(driver, {
    name: "indexeddb",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}
