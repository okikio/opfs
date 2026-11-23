import { createGcsClient, GCS_CHUNK_BYTES, GCS_MAX_BYTES } from "../gcs.ts";
import type { GcsClientOptionsType, GcsClientType } from "../gcs.ts";
import type { DriverOwnershipType } from "../schema.ts";
import { defineObjectDriver } from "./object.ts";
import type { ObjectDriverType } from "./object.ts";

/** Explicit native GCS client configuration reused by its driver. */
export interface GcsDriverOptionsType extends GcsClientOptionsType {}

/** Native GCS metadata and conditions remain visible alongside portable driver inspection. */
export interface GcsDriverType extends Omit<ObjectDriverType, "head" | "get" | "put" | "delete" | "list" | "copy"> {
  head: GcsClientType["head"];
  get: GcsClientType["get"];
  put: GcsClientType["put"];
  delete: GcsClientType["delete"];
  list: GcsClientType["list"];
  copy: GcsClientType["copy"];
}

/** The driver describes provider limits separately from stream buffering policy. */
function createDriver(client: GcsClientType, ownership: DriverOwnershipType): GcsDriverType {
  const driver = defineObjectDriver(client, {
    name: client.name,
    ownership,
    requirements: [{ code: "gcs-endpoint", state: "available" }],
    limits: [
      { code: "file-bytes", kind: "hard", source: "provider", unit: "bytes", value: GCS_MAX_BYTES },
      { code: "upload-chunk-alignment", kind: "hard", source: "provider", unit: "bytes", value: GCS_CHUNK_BYTES },
    ],
    getMetrics: () => client.getMetrics(),
  });
  return {
    ...driver,
    head: (key, options) => client.head(key, options),
    get: (key, options) => client.get(key, options),
    put: (key, body, options) => client.put(key, body, options),
    delete: (key, options) => client.delete(key, options),
    list: (options) => client.list(options),
    copy: (source, destination, options) => client.copy(source, destination, options),
  };
}

/** Creates a GCS client and attaches native driver metadata without connecting on import. */
export function createGcsDriver(options: GcsDriverOptionsType): GcsDriverType {
  return createDriver(createGcsClient(options), "owned");
}

/** Borrows a caller-configured GCS client; closing a filesystem does not own its credentials. */
export function createGcsDriverFromClient(client: GcsClientType): GcsDriverType {
  return createDriver(client, "borrowed");
}
