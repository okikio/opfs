import { GCS_CHUNK_BYTES, GCS_MAX_BYTES } from "./client.ts";
import type { GcsClientType } from "./client.ts";
import type { DriverOwnershipType } from "../../schema/mod.ts";
import { defineObjectDriver } from "../../driver/object.ts";
import type { ObjectDriverType } from "../../driver/object.ts";

/** Native GCS metadata and conditions remain visible alongside portable driver inspection. */
export interface GcsDriverType
  extends Omit<ObjectDriverType<GcsClientType>, "head" | "get" | "put" | "delete" | "list" | "copy"> {
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

/**
 * Creates the Gcs driver over a Google Cloud Storage client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Keeps GCS generations and preconditions visible next to the portable driver methods.
 *
 * @example
 * ```ts
 * const client = createGcsClient({ bucket, token });
 * const driver = createGcsDriver(client);
 * ```
 */
export function createGcsDriver(client: GcsClientType): GcsDriverType {
  return createDriver(client, "borrowed");
}
