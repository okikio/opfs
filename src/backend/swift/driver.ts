/** Native Swift driver metadata; filesystem translation belongs to adapter/swift. @module */
import type { SwiftClientType } from "./client.ts";
import { defineObjectDriver } from "../../driver/object.ts";
import type { ObjectDriverType } from "../../driver/object.ts";

/** A single regular-object limit is caller policy; no configured Swift cluster was probed. */
function driver(client: SwiftClientType): ObjectDriverType<SwiftClientType> {
  return defineObjectDriver(client, {
    name: client.name,
    ownership: "borrowed",
    requirements: [{ code: "swift-account-endpoint", state: "available" }],
    limits: client.limits?.maxFileBytes === undefined ? [] : [{
      code: "file-bytes",
      kind: "policy",
      source: "user",
      unit: "bytes",
      value: client.limits.maxFileBytes,
    }],
    getMetrics: () => client.getMetrics(),
  });
}

/**
 * Creates the Swift driver over an OpenStack Swift client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Adds the regular-object size limit you configured on the client.
 *
 * @example
 * ```ts
 * const client = createSwiftClient({ endpoint, container, token });
 * const driver = createSwiftDriver(client);
 * ```
 */
export function createSwiftDriver(client: SwiftClientType): ObjectDriverType<SwiftClientType> {
  return driver(client);
}
