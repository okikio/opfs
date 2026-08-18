import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import { type CacheDriverOptionsType, createCacheDriver } from "../driver/cache.ts";

/** Options for a Cache Storage-backed filesystem adapter. */
export type CacheAdapterOptionsType = CacheDriverOptionsType;

/** Creates a filesystem adapter over one injected Cache Storage cache. */
export function createCacheAdapter(cache: Cache, options: CacheAdapterOptionsType = {}): AdapterType {
  return createRecordAdapter(createCacheDriver(cache, options), {
    name: "cache",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}
