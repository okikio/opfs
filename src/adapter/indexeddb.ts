import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createIndexedDbDriver,
  type IndexedDbDriverOptionsType,
  type IndexedDbOpenOptionsType,
  openIndexedDbDriver,
} from "../driver/indexeddb.ts";

/** Options for an IndexedDB-backed filesystem adapter. */
export type IndexedDbAdapterOptionsType = IndexedDbDriverOptionsType;
export type { IndexedDbOpenOptionsType };

/** Creates a filesystem adapter over an existing IndexedDB database. */
export function createIndexedDbAdapter(database: IDBDatabase, options: IndexedDbAdapterOptionsType = {}): AdapterType {
  const driver = createIndexedDbDriver(database, options);
  return createRecordAdapter(driver, {
    name: "indexeddb",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}

/** Opens an owned IndexedDB database and returns its filesystem adapter. */
export async function openIndexedDbAdapter(options: IndexedDbOpenOptionsType = {}): Promise<AdapterType> {
  const driver = await openIndexedDbDriver(options);
  return createRecordAdapter(driver, {
    name: "indexeddb",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}
