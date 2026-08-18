import type { AdapterType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { createDenoDriver, type DenoDriverOptionsType } from "../driver/deno.ts";

/** Options for the Deno filesystem adapter. */
export type DenoAdapterOptionsType = DenoDriverOptionsType;

/** Creates the OPFS primitive translation over a Deno filesystem driver. */
export function createDenoAdapter(options: DenoAdapterOptionsType): AdapterType {
  return createFileAdapter(createDenoDriver(options), { disposeDriver: true });
}
