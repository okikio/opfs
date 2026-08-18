import type { AdapterType } from "./definition.ts";
import { createObjectAdapter, type ObjectAdapterOptionsType } from "./object.ts";
import type { S3ClientType } from "../s3.ts";
import { createS3DriverFromClient } from "../driver/s3.ts";

/** S3 filesystem mapping options. */
export type S3AdapterOptionsType = ObjectAdapterOptionsType;

/**
 * Creates the OPFS translation over a preconfigured S3 protocol client.
 *
 * The client remains independently useful. A configured S3 driver is inserted
 * between the protocol client and filesystem adapter so limits, requirements,
 * and provider optimization policy remain separately inspectable.
 */
export function createS3Adapter(client: S3ClientType, options: S3AdapterOptionsType = {}): AdapterType {
  return createObjectAdapter(createS3DriverFromClient(client), options);
}
