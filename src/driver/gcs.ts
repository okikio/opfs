import { createGcsClient, GCS_CHUNK_BYTES, GCS_MAX_BYTES } from "../gcs.ts";
import type { GcsClientOptionsType, GcsClientType } from "../gcs.ts";
import type { DriverOwnershipType } from "../schema.ts";
import { defineObjectDriver } from "./object.ts";
import type { ObjectDriverType } from "./object.ts";

/** Explicit native GCS client configuration reused by its driver. */
export interface GcsDriverOptionsType extends GcsClientOptionsType {}

/** The driver describes provider limits separately from stream buffering policy. */
function createDriver(client: GcsClientType, ownership: DriverOwnershipType): ObjectDriverType {
  return defineObjectDriver(client, {
    name: client.name,
    ownership,
    requirements: [{ code: "gcs-endpoint", state: "available" }],
    limits: [
      { code: "file-bytes", kind: "hard", source: "provider", unit: "bytes", value: GCS_MAX_BYTES },
      { code: "upload-chunk-alignment", kind: "hard", source: "provider", unit: "bytes", value: GCS_CHUNK_BYTES },
    ],
    getMetrics: () => client.getMetrics(),
  });
}

/** Creates a GCS client and attaches native driver metadata without connecting on import. */
export function createGcsDriver(options: GcsDriverOptionsType): ObjectDriverType {
  return createDriver(createGcsClient(options), "owned");
}

/** Borrows a caller-configured GCS client; closing a filesystem does not own its credentials. */
export function createGcsDriverFromClient(client: GcsClientType): ObjectDriverType {
  return createDriver(client, "borrowed");
}
