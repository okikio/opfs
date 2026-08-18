import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import { type CacheDriverOptionsType, createCacheDriver } from "../driver/cache.ts";

/**
 * Options for a Cache Storage-backed filesystem adapter.
 *
 * These pass through to the record driver and then control the adapter's
 * portable filesystem projection.
 */
export type CacheAdapterOptionsType = CacheDriverOptionsType;

/**
 * Creates a filesystem adapter over one injected Cache Storage cache.
 *
 * The adapter keeps Cache Storage's real lifecycle and quota behavior visible
 * through the driver while exposing the OPFS-shaped facade above it.
 */
export function createCacheAdapter(cache: Cache, options: CacheAdapterOptionsType = {}): AdapterType {
  return createRecordAdapter(createCacheDriver(cache, options), {
    name: "cache",
    readOnly: options.readOnly ?? false,
    disposeDriver: true,
  });
}
