/** Thin WebHDFS file-driver translation; no native rename or MKDIRS claims are added. @module */
import type { WebhdfsClientType } from "./client.ts";
import { createWebhdfsDriver } from "./driver.ts";
import type { WebhdfsProjectionOptionsType } from "./driver.ts";
import { createFileAdapter } from "../../adapter/file.ts";
import type { AdapterType } from "../../adapter/definition.ts";

/** Credentials and protocol client remain caller-owned. */
export interface WebhdfsAdapterOptionsType extends WebhdfsProjectionOptionsType {
  readonly name?: string;
}

/** Canonical mkdir, copy/move, update and stream writes are refused by hard driver admission. */
export function createWebhdfsAdapter(client: WebhdfsClientType, options: WebhdfsAdapterOptionsType = {}): AdapterType {
  return createFileAdapter(createWebhdfsDriver(client, options), options);
}
