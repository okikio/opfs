/** Native Swift driver metadata; filesystem translation belongs to adapter/swift. @module */
import { createSwiftClient } from "../swift.ts";
import type { SwiftClientOptionsType, SwiftClientType } from "../swift.ts";
import { defineObjectDriver } from "./object.ts";
import type { ObjectDriverType } from "./object.ts";
import type { DriverOwnershipType } from "../schema.ts";

/** Same explicit account, transport and token policy as the independently useful client. */
export interface SwiftDriverOptionsType extends SwiftClientOptionsType {}

/** A single regular-object limit is caller policy; no configured Swift cluster was probed. */
function driver(client: SwiftClientType, ownership: DriverOwnershipType): ObjectDriverType {
  return defineObjectDriver(client, {
    name: client.name,
    ownership,
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

/** Creates a regular-object client; does not obtain a token or contact the account. */
export function createSwiftDriver(options: SwiftDriverOptionsType): ObjectDriverType {
  return driver(createSwiftClient(options), "owned");
}

/** Borrows a configured client and its credential owner. */
export function createSwiftDriverFromClient(client: SwiftClientType): ObjectDriverType {
  return driver(client, "borrowed");
}
