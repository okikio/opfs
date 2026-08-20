import { z } from "zod";

import type { AdapterLimitsType } from "../schema.ts";
import {
  defineDriver,
  type DefineDriverOptionsType,
  DriverPlanInputSchema,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
  type DriverType,
} from "./definition.ts";

/**
 * Native behavior exposed by an object-storage backend.
 *
 * These flags preserve object-store truth. A backend may stream writes, support
 * provider-side copy, or retain metadata without ever pretending it can update a
 * file in place like a host filesystem.
 */
export const ObjectDriverCapabilitiesSchema: z.ZodType<ObjectDriverCapabilitiesType, ObjectDriverCapabilitiesType> = z.object({
  rangeRead: z.boolean(),
  streamRead: z.boolean(),
  streamWrite: z.boolean(),
  copy: z.boolean(),
  conditionalWrite: z.boolean(),
  multipart: z.boolean(),
  metadata: z.boolean(),
  versions: z.boolean(),
}).strict();

/** A validated native object-driver capability description. */
export type ObjectDriverCapabilitiesType = import("../_schema_types.ts").ObjectDriverCapabilitiesType;

/** Portable object metadata returned by {@link ObjectBackendType.head}. */
export interface ObjectStatType {
  /** Object length in bytes. */
  readonly size: number;
  /** Last-modified Unix epoch milliseconds when the provider reports one. */
  readonly lastModified?: number;
  /** Media type retained by the provider when known. */
  readonly mediaType?: string;
  /** Entity tag or equivalent provider revision token. */
  readonly etag?: string;
  /** Provider version identifier when versioning is enabled. */
  readonly version?: string;
  /** Provider metadata retained with the object when available. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** One object returned from a prefix listing. */
export interface ObjectEntryType extends ObjectStatType {
  /** Provider object key. */
  readonly key: string;
}

/** One page from an object-store prefix listing. */
export interface ObjectListType {
  /** Objects returned in this page. */
  readonly objects: readonly ObjectEntryType[];
  /** Prefix markers returned when the provider groups results hierarchically. */
  readonly prefixes: readonly string[];
  /** Opaque continuation token for the next page. */
  readonly cursor?: string;
}

/** Options for one object GET. */
export interface ObjectGetOptionsType {
  /** Zero-based byte offset. */
  readonly at?: number;
  /** Maximum bytes to return. */
  readonly length?: number;
  /** Stops provider work before the response body completes. */
  readonly signal?: AbortSignal;
}

/** Options for one object PUT. */
export interface ObjectPutOptionsType {
  /** Media type retained with the object when the provider supports it. */
  readonly mediaType?: string;
  /** Provider metadata stored with the object when supported. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Conditional write precondition on the current object revision. */
  readonly ifMatch?: string;
  /** Conditional create/write precondition that rejects matching objects. */
  readonly ifNoneMatch?: string;
  /** Caller-known size for streamed uploads when the provider benefits from it. */
  readonly size?: number;
  /** Stops provider work before the upload commits. */
  readonly signal?: AbortSignal;
}

/** Options for one provider-side object copy. */
export interface ObjectCopyOptionsType {
  /** Conditional precondition on the destination object. */
  readonly ifMatch?: string;
  /** Destination precondition that rejects matching objects. */
  readonly ifNoneMatch?: string;
  /** Conditional precondition on the source object revision. */
  readonly sourceIfMatch?: string;
  /** Source precondition that rejects matching source revisions. */
  readonly sourceIfNoneMatch?: string;
  /** Source precondition based on modification time. */
  readonly sourceIfModifiedSince?: Date;
  /** Source precondition that requires an older or equal modification time. */
  readonly sourceIfUnmodifiedSince?: Date;
  /** Stops provider work before the server-side copy completes. */
  readonly signal?: AbortSignal;
}

/** Options for prefix listing. */
export interface ObjectListOptionsType {
  /** Prefix to enumerate. */
  readonly prefix: string;
  /** Delimiter used to request hierarchical grouping from the provider. */
  readonly delimiter?: string;
  /** Maximum results requested for this page. */
  readonly limit?: number;
  /** Opaque continuation token from a previous page. */
  readonly cursor?: string;
  /** Stops provider work before the page completes. */
  readonly signal?: AbortSignal;
}

/**
 * Provider/client object mechanics before driver metadata is attached.
 *
 * This is the honest native object contract. It works for S3, Azure Blob, and
 * similar stores before any OPFS translation or filesystem-shaped fallback is
 * applied.
 */
export interface ObjectBackendType {
  readonly name: string;
  readonly capabilities: {
    readonly rangeRead: boolean;
    readonly streamRead: boolean;
    readonly streamWrite: boolean;
    readonly copy: boolean;
    readonly conditionalWrite: boolean;
    readonly multipart?: boolean;
    readonly metadata?: boolean;
    readonly versions?: boolean;
  };
  readonly limits?: AdapterLimitsType;
  head(key: string, options?: { readonly signal?: AbortSignal }): Promise<ObjectStatType | null>;
  get(key: string, options?: ObjectGetOptionsType): Promise<ReadableStream<Uint8Array>>;
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options?: ObjectPutOptionsType,
  ): Promise<ObjectStatType>;
  delete(key: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  list(options: ObjectListOptionsType): Promise<ObjectListType>;
  copy?(source: string, destination: string, options?: ObjectCopyOptionsType): Promise<ObjectStatType>;
  dispose?(): void | Promise<void>;
}

/**
 * Independently useful object-storage driver.
 *
 * The driver keeps object semantics visible even when an adapter later projects
 * those objects into a hierarchical filesystem view.
 */
export interface ObjectDriverType extends DriverType, Omit<ObjectBackendType, "limits"> {
  readonly kind: "object";
  /** Native object-store behaviors the backend can expose directly. */
  readonly capabilities: ObjectDriverCapabilitiesType;
  /** Adapter-oriented numeric limit summary retained for the object translation layer. */
  readonly portableLimits?: AdapterLimitsType;
}

/** Construction options for an object driver. */
export interface DefineObjectDriverOptionsType extends Omit<DefineDriverOptionsType, "kind" | "plan" | "dispose"> {
  /** Optional backend-native planner override. */
  readonly plan?: (input: DriverPlanInputType) => DriverPlanType;
  /** Transfers backend disposal ownership from the caller to the driver. */
  readonly disposeBackend?: boolean;
}

/** Creates the default object-driver preflight result from known provider limits. */
function createObjectPlan(base: DriverType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const maxFile = base.limits.find((limit) => limit.code === "file-bytes" && limit.value !== undefined);
  if (request.size !== undefined && maxFile?.value !== undefined && request.size > maxFile.value) {
    return DriverPlanSchema.parse({
      operation: request.operation,
      supported: false,
      support: "unsupported",
      problems: [{
        code: "object-too-large",
        layer: "driver",
        severity: "error",
        message: `Requested size ${request.size} exceeds the configured object limit ${maxFile.value}.`,
        limit: maxFile,
      }],
      actions: [{ kind: "reduce-input" }, { kind: "select-driver" }],
    });
  }
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported: true,
    support: "native",
    problems: [],
    actions: [],
  });
}

/**
 * Attaches capability, requirement, limit, and optimization metadata to an
 * object backend without changing the provider's object semantics.
 *
 * @example Wrap an S3-like client contract before creating an object adapter.
 * ```ts
 * import { defineObjectDriver } from "@okikio/opfs/driver/object";
 *
 * const driver = defineObjectDriver(backend, {
 *   name: "custom-s3",
 *   limits: [],
 * });
 * ```
 */
export function defineObjectDriver(
  backend: ObjectBackendType,
  options: DefineObjectDriverOptionsType,
): ObjectDriverType {
  const capabilities = ObjectDriverCapabilitiesSchema.parse({
    rangeRead: backend.capabilities.rangeRead,
    streamRead: backend.capabilities.streamRead,
    streamWrite: backend.capabilities.streamWrite,
    copy: backend.capabilities.copy,
    conditionalWrite: backend.capabilities.conditionalWrite,
    multipart: backend.capabilities.multipart ?? false,
    metadata: backend.capabilities.metadata ?? true,
    versions: backend.capabilities.versions ?? false,
  });

  const base = defineDriver({
    ...options,
    name: options.name || backend.name,
    kind: "object",
    provides: options.provides ?? [
      "stat",
      "read",
      "write",
      "remove",
      "list",
      ...(backend.capabilities.rangeRead ? ["range-read"] : []),
      ...(backend.capabilities.streamRead ? ["stream-read"] : []),
      ...(backend.capabilities.streamWrite ? ["stream-write"] : []),
      ...(backend.copy === undefined ? [] : ["copy"]),
    ],
    ownership: options.ownership ??
      (backend.dispose === undefined ? "none" : options.disposeBackend ? "owned" : "borrowed"),
    plan: options.plan ?? ((input) => createObjectPlan(base, input)),
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  });

  return {
    ...base,
    kind: "object",
    capabilities,
    ...(backend.limits === undefined ? {} : { portableLimits: backend.limits }),
    head: (key, requestOptions) => backend.head(key, requestOptions),
    get: (key, requestOptions) => backend.get(key, requestOptions),
    put: (key, body, requestOptions) => backend.put(key, body, requestOptions),
    delete: (key, requestOptions) => backend.delete(key, requestOptions),
    list: (requestOptions) => backend.list(requestOptions),
    ...(backend.copy === undefined ? {} : {
      copy: (source: string, destination: string, requestOptions?: ObjectCopyOptionsType) =>
        backend.copy!(source, destination, requestOptions),
    }),
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  };
}
