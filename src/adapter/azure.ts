import type { AdapterType } from "./definition.ts";
import { createObjectAdapter, type ObjectAdapterOptionsType } from "./object.ts";
import type { AzureClientType } from "../azure.ts";

/** Azure Blob filesystem mapping options. */
export type AzureAdapterOptionsType = ObjectAdapterOptionsType;

/** Creates an OPFS-shaped adapter over an injected Azure Blob REST client. */
export function createAzureAdapter(client: AzureClientType, options: AzureAdapterOptionsType = {}): AdapterType {
  return createObjectAdapter(client, options);
}
