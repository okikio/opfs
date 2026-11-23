import type { AdapterType } from "../../adapter/definition.ts";
import { createObjectAdapter, type ObjectAdapterOptionsType } from "../../adapter/object.ts";
import type { AzureClientType } from "./client.ts";
import { createAzureDriverFromClient } from "./driver.ts";

/** Azure Blob filesystem mapping options. */
export type AzureAdapterOptionsType = ObjectAdapterOptionsType;

/** Creates the OPFS translation over an injected Azure Blob protocol client. */
export function createAzureAdapter(client: AzureClientType, options: AzureAdapterOptionsType = {}): AdapterType {
  return createObjectAdapter(createAzureDriverFromClient(client), options);
}
