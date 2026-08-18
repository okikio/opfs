import type { AdapterType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { type BunDriverOptionsType, createBunDriver } from "../driver/bun.ts";

/**
 * Options for the Bun filesystem adapter.
 *
 * This constructor is the convenience form of `createBunDriver()` plus the
 * generic file adapter translation.
 */
export type BunAdapterOptionsType = BunDriverOptionsType;

/**
 * Creates the OPFS primitive translation over a Bun filesystem driver.
 *
 * Bun-specific filesystem behavior remains in the driver. The adapter only
 * exposes those primitives to `FileSystemType`.
 */
export function createBunAdapter(options: BunAdapterOptionsType): AdapterType {
  return createFileAdapter(createBunDriver(options), { disposeDriver: true });
}
