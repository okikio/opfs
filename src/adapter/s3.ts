import type { AdapterType } from "./definition.ts";
import { createObjectAdapter, type ObjectAdapterOptionsType } from "./object.ts";
import type { S3ClientType } from "../s3.ts";

/** S3 filesystem mapping options. */
export type S3AdapterOptionsType = ObjectAdapterOptionsType;

/**
 * Creates an OPFS-shaped adapter over a preconfigured S3-compatible client.
 *
 * The S3 client remains useful independently. The adapter adds virtual
 * directories, filesystem write modes, recursive facade operations, and path
 * coordination without hiding S3's object semantics. Injection keeps
 * credentials, endpoint selection, and client lifecycle outside the generic
 * filesystem layer.
 */
export function createS3Adapter(client: S3ClientType, options: S3AdapterOptionsType = {}): AdapterType {
  return createObjectAdapter(client, options);
}
