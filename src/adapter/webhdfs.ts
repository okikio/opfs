/** Thin WebHDFS file-driver translation; no native rename or MKDIRS claims are added. @module */
import type { WebhdfsClientType } from "../webhdfs.ts";
import { createWebhdfsDriverFromClient } from "../driver/webhdfs.ts";
import type { WebhdfsProjectionOptionsType } from "../driver/webhdfs.ts";
import { createFileAdapter } from "./file.ts";
import type { AdapterType } from "./definition.ts";

/** Credentials and protocol client remain caller-owned. */
export interface WebhdfsAdapterOptionsType extends WebhdfsProjectionOptionsType {
  readonly name?: string;
}

/** Canonical mkdir, copy/move, update and stream writes are refused by hard driver admission. */
export function createWebhdfsAdapter(client: WebhdfsClientType, options: WebhdfsAdapterOptionsType = {}): AdapterType {
  return createFileAdapter(createWebhdfsDriverFromClient(client, options), options);
}
