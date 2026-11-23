import { createCloudflareKvDriver } from "./driver.ts";
import type { CloudflareKvBindingType, CloudflareKvOptionsType } from "./driver.ts";
import { createObjectAdapter } from "../../adapter/object.ts";
import type { ObjectAdapterOptionsType } from "../../adapter/object.ts";
import type { AdapterType } from "../../adapter/definition.ts";

/** Eventual object-name projection. The reserved driver prefix and optional virtual prefix remain separate. */
export function createCloudflareKvAdapter(
  binding: CloudflareKvBindingType,
  options: CloudflareKvOptionsType,
  projection: ObjectAdapterOptionsType = {},
): AdapterType {
  return createObjectAdapter(createCloudflareKvDriver(binding, options), projection);
}
