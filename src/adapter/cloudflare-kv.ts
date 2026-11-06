import { createCloudflareKvDriver } from "../driver/cloudflare-kv.ts";
import type { CloudflareKvBindingType, CloudflareKvOptionsType } from "../driver/cloudflare-kv.ts";
import { createObjectAdapter } from "./object.ts";
import type { ObjectAdapterOptionsType } from "./object.ts";
import type { AdapterType } from "./definition.ts";

/** Eventual object-name projection. The reserved driver prefix and optional virtual prefix remain separate. */
export function createCloudflareKvAdapter(
  binding: CloudflareKvBindingType,
  options: CloudflareKvOptionsType,
  projection: ObjectAdapterOptionsType = {},
): AdapterType {
  return createObjectAdapter(createCloudflareKvDriver(binding, options), projection);
}
