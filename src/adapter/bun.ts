import type { AdapterType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { type BunDriverOptionsType, createBunDriver } from "../driver/bun.ts";

/** Options for the Bun filesystem adapter. */
export type BunAdapterOptionsType = BunDriverOptionsType;

/** Creates the OPFS primitive translation over a Bun filesystem driver. */
export function createBunAdapter(options: BunAdapterOptionsType): AdapterType {
  return createFileAdapter(createBunDriver(options), { disposeDriver: true });
}
