/** Thin WebDAV filesystem translation; client and driver own protocol and publication limits. @module */
import type { WebdavClientType } from "./client.ts";
import { createWebdavDriverFromClient } from "./driver.ts";
import type { WebdavProjectionOptionsType } from "./driver.ts";
import { createFileAdapter } from "../../adapter/file.ts";
import type { AdapterType } from "../../adapter/definition.ts";

/** Materialization ceiling is explicit; the client and credentials remain borrowed. */
export interface WebdavAdapterOptionsType extends WebdavProjectionOptionsType {
  readonly name?: string;
}

/** Rejects append/update and streamed writes before I/O through driver hard admission. */
export function createWebdavAdapter(client: WebdavClientType, options: WebdavAdapterOptionsType = {}): AdapterType {
  return createFileAdapter(createWebdavDriverFromClient(client, options), options);
}
