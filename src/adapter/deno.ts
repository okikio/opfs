import type { AdapterType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { createDenoDriver, type DenoDriverOptionsType } from "../driver/deno.ts";

/**
 * Options for the Deno filesystem adapter.
 *
 * This convenience constructor forwards its options to the Deno driver, then
 * exposes that driver through the generic file adapter translation.
 */
export type DenoAdapterOptionsType = DenoDriverOptionsType;

/**
 * Creates the OPFS primitive translation over a Deno filesystem driver.
 *
 * Deno-specific host filesystem behavior remains below the adapter in the
 * driver layer.
 */
export function createDenoAdapter(options: DenoAdapterOptionsType): AdapterType {
  return createFileAdapter(createDenoDriver(options), { disposeDriver: true });
}
