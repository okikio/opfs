import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createUnstorageDriver,
  type UnstorageDriverOptionsType,
  type UnstorageStorageType,
} from "../driver/unstorage.ts";

/** Options forwarded to the unstorage-backed record driver. */
export type UnstorageAdapterOptionsType = UnstorageDriverOptionsType;

/** High-level unstorage `Storage` contract consumed by the record driver. */
export type { UnstorageStorageType };

/**
 * Creates the OPFS primitive translation over an injected unstorage `Storage`.
 *
 * The driver targets the high-level Storage contract, so the caller can choose
 * any unstorage backend that satisfies the required semantics. The injected
 * Storage remains borrowed unless `disposeStorage` is enabled.
 */
export function createUnstorageAdapter(
  storage: UnstorageStorageType,
  options: UnstorageAdapterOptionsType = {},
): AdapterType {
  return createRecordAdapter(createUnstorageDriver(storage, options), {
    name: "unstorage",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}
