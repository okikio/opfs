import type { AdapterType } from "./definition.ts";
import { createObjectAdapter, type ObjectAdapterOptionsType } from "./object.ts";
import type { AzureClientType } from "../azure.ts";
import { createAzureDriverFromClient } from "../driver/azure.ts";

/** Azure Blob filesystem mapping options. */
export type AzureAdapterOptionsType = ObjectAdapterOptionsType;

/** Creates the OPFS translation over an injected Azure Blob protocol client. */
export function createAzureAdapter(client: AzureClientType, options: AzureAdapterOptionsType = {}): AdapterType {
  return createObjectAdapter(createAzureDriverFromClient(client), options);
}
