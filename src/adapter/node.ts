import type { AdapterType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { createNodeDriver, type NodeDriverOptionsType } from "../driver/node.ts";

/**
 * Options for the Node filesystem adapter.
 *
 * This convenience constructor simply forwards its options to the Node driver,
 * then exposes that driver through the generic file adapter translation.
 */
export type NodeAdapterOptionsType = NodeDriverOptionsType;

/**
 * Creates the OPFS primitive translation over a Node filesystem driver.
 *
 * The driver owns host filesystem mechanics. This adapter only exposes those
 * primitives to `FileSystemType`.
 */
export function createNodeAdapter(options: NodeAdapterOptionsType): AdapterType {
  return createFileAdapter(createNodeDriver(options), { disposeDriver: true });
}
