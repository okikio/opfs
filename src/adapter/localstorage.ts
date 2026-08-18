import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createLocalStorageDriver,
  type LocalStorageDriverOptionsType,
  type LocalStorageType,
} from "../driver/localstorage.ts";

/** Options for the localStorage-backed adapter. */
export interface LocalStorageAdapterOptionsType extends LocalStorageDriverOptionsType {
  /** Prevents filesystem mutations. */
  readonly readOnly?: boolean;
}

/** Creates an OPFS-shaped adapter over localStorage or another Web Storage-compatible object. */
export function createLocalStorageAdapter(
  storage: LocalStorageType,
  options: LocalStorageAdapterOptionsType = {},
): AdapterType {
  return createRecordAdapter(createLocalStorageDriver(storage, options), {
    name: "localstorage",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}

export type { LocalStorageType } from "../driver/localstorage.ts";
