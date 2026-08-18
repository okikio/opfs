import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createLocalStorageDriver,
  type LocalStorageDriverOptionsType,
  type LocalStorageType,
} from "../driver/localstorage.ts";

/**
 * Options for the localStorage-backed adapter.
 *
 * These pass directly through to the record driver and then add adapter-level
 * read-only behavior for the OPFS translation layer.
 */
export interface LocalStorageAdapterOptionsType extends LocalStorageDriverOptionsType {
  /** Prevents filesystem mutations. */
  readonly readOnly?: boolean;
}

/**
 * Creates an OPFS-shaped adapter over localStorage or another Web Storage-compatible object.
 *
 * The adapter keeps Web Storage's real characteristics visible through the
 * underlying record driver while exposing the portable filesystem facade above it.
 */
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
