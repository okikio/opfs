/** One raw KV value plus associated versioned metadata; no base64 record tree or Worker discovery. @module */
import { z } from "zod";
import { isBytes, toView } from "../bytes.ts";
import { openBytes } from "../stream.ts";
import { close } from "../close.ts";
import { range } from "../range.ts";
import { putOptions } from "../publication.ts";
import type { ObjectBackendType, ObjectDriverType, ObjectListOptionsType, ObjectStatType } from "./object.ts";
import { defineObjectDriver } from "./object.ts";
import { DriverPlanInputSchema, DriverPlanSchema } from "./definition.ts";

/** Standard Workers KV value limit; KV Instant has a different contract and is not supported. */
export const CLOUDFLARE_KV_BYTES = 25 * 1024 * 1024;
/** Narrow native binding surface. The caller owns credentials, runtime and namespace lifetime. */
export interface CloudflareKvBindingType {
  getWithMetadata(
    key: string,
    options: { type: "stream"; cacheTtl?: number },
  ): Promise<{ value: ReadableStream<Uint8Array> | null; metadata: unknown }>;
  put(key: string, value: ArrayBuffer, options?: { metadata?: object; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(
    options?: { prefix?: string; limit?: number; cursor?: string },
  ): Promise<
    { keys: { name: string; expiration?: number; metadata?: unknown }[]; list_complete: boolean; cursor?: string }
  >;
}
/** Reserve this prefix exclusively for the versioned raw-value layout; values outside it are never inspected. */
export interface CloudflareKvOptionsType {
  readonly prefix: string;
  readonly maxReadBytes?: number;
  readonly maxUploadBytes?: number;
  readonly maxChunkBytes?: number;
  readonly cacheTtl?: number;
  /** Applies to all writes, including directory markers. Defaults to no expiration. Minimum 60 seconds. */
  readonly expirationTtl?: number;
  readonly identity?: string;
}
/** Direct native listing retains expiration facts which portable ObjectStatType cannot represent. */
export interface CloudflareKvPageType {
  readonly keys: readonly (ObjectStatType & { readonly key: string; readonly expiration?: number })[];
  readonly cursor?: string;
}
/** Native one-page listing stays independently usable, with eventual consistency explicitly retained. */
export interface CloudflareKvDriverType extends ObjectDriverType {
  readonly consistency: "eventual";
  listKeys(options: Omit<ObjectListOptionsType, "delimiter">): Promise<CloudflareKvPageType>;
}
/** A failed native mutation has no receipt proving rollback or publication. */
export class CloudflareKvPublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Workers KV mutation outcome is unknown; do not blindly replay it.", { cause });
    this.name = "CloudflareKvPublicationError";
  }
}
/** Key identity in the associated metadata prevents foreign/copy-corrupted records from being reinterpreted as files. */
const MetadataSchema = z.object({
  opfs: z.literal(1),
  key: z.string().max(512),
  size: z.number().int().nonnegative().max(CLOUDFLARE_KV_BYTES),
  mediaType: z.string().max(1024).optional(),
  metadata: z.record(z.string().max(1024), z.string().max(1024)),
}).strict();
type MetadataType = z.infer<typeof MetadataSchema>;
/** Finite policy checks occur before binding invocation or byte copying. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} exceeds its nonnegative safe-integer limit.`);
  }
  return value;
}
/** Keep string allocation bounded before UTF-8 validation and refuse replacement encoding. */
function text(value: string, maximum: number): void {
  if (typeof value !== "string" || value.length > maximum || new TextEncoder().encode(value).byteLength > maximum) {
    throw new RangeError("Workers KV string exceeds its byte limit.");
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("Workers KV key contains an unpaired surrogate.");
  }
}
/** Validate this reserved wire layout and its exact logical key before trusting sizes or directory metadata. */
function envelope(value: unknown, key: string): MetadataType {
  const parsed = MetadataSchema.parse(value);
  if (parsed.key !== key || new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 1024) {
    throw new TypeError("Workers KV metadata is foreign, oversized or belongs to another key.");
  }
  return parsed;
}
/** There is deliberately no ETag or revision: KV cannot pin reads to an acknowledged write. */
function stat(value: MetadataType): ObjectStatType {
  return {
    size: value.size,
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    metadata: { ...value.metadata },
  };
}
/**
 * Project a caller-reserved Workers KV prefix as whole binary objects. Values and
 * associated metadata use one native put; no cross-key transaction is invented.
 * Reads materialize one bounded value for byte slicing. All observations remain
 * eventual, including absence and directory membership. No compare-and-swap,
 * authoritative absence, revision snapshot or native range request is claimed.
 */
export function createCloudflareKvDriver(
  binding: CloudflareKvBindingType,
  options: CloudflareKvOptionsType,
): CloudflareKvDriverType {
  const prefix = options.prefix;
  text(prefix, 256);
  if (!prefix || !prefix.endsWith("/")) {
    throw new TypeError("Workers KV needs an explicitly reserved prefix ending in a slash.");
  }
  const maxReadBytes = integer(
    options.maxReadBytes ?? CLOUDFLARE_KV_BYTES,
    "Workers KV read policy",
    CLOUDFLARE_KV_BYTES,
  );
  const maxUploadBytes = integer(
    options.maxUploadBytes ?? CLOUDFLARE_KV_BYTES,
    "Workers KV upload policy",
    CLOUDFLARE_KV_BYTES,
  );
  const maxChunkBytes = integer(options.maxChunkBytes ?? 1024 * 1024, "Workers KV chunk policy", CLOUDFLARE_KV_BYTES);
  if (!maxChunkBytes) throw new RangeError("Workers KV chunk policy must be positive.");
  const cacheTtl = options.cacheTtl;
  const expirationTtl = options.expirationTtl;
  if (cacheTtl !== undefined && integer(cacheTtl, "Workers KV cache TTL") < 30) {
    throw new RangeError("Workers KV cache TTL must be at least 30 seconds.");
  }
  if (expirationTtl !== undefined && integer(expirationTtl, "Workers KV expiration TTL") < 60) {
    throw new RangeError("Workers KV expiration TTL must be at least 60 seconds.");
  }
  /** No encoding layer aliases arbitrary provider keys into another path. */
  function physical(key: string, empty = false): string {
    text(key, 512);
    const result = `${prefix}${key}`;
    text(result, 512);
    if ((!empty && !key) || result === "." || result === "..") throw new TypeError("Invalid Workers KV object key.");
    return result;
  }
  /** Metadata and value come from the same native lookup, but may be an old regional observation. */
  async function open(key: string, signal?: AbortSignal) {
    const name = physical(key);
    signal?.throwIfAborted();
    const result = await binding.getWithMetadata(name, {
      type: "stream",
      ...(cacheTtl === undefined ? {} : { cacheTtl }),
    });
    if (result.value === null) {
      signal?.throwIfAborted();
      return null;
    }
    try {
      signal?.throwIfAborted();
      return { value: result.value, metadata: envelope(result.metadata, key) };
    } catch (cause) {
      await close([() => result.value!.cancel(cause)], [cause]);
      throw cause;
    }
  }
  /** Native cursors can advance through empty pages; no logical directory grouping is fabricated. */
  async function listKeys(request: Omit<ObjectListOptionsType, "delimiter">): Promise<CloudflareKvPageType> {
    const selected = physical(request.prefix, true);
    const limit = integer(request.limit ?? 1000, "Workers KV page limit", 1000);
    if (!limit) throw new RangeError("Workers KV page limit must be positive.");
    if (request.cursor !== undefined) text(request.cursor, 8192);
    request.signal?.throwIfAborted();
    const page = await binding.list({
      prefix: selected,
      limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
    request.signal?.throwIfAborted();
    if (
      page.keys.length > limit || typeof page.list_complete !== "boolean" ||
      (!page.list_complete && (!page.cursor || page.cursor === request.cursor))
    ) throw new TypeError("Workers KV listing has no advancing bounded cursor.");
    const keys = page.keys.map((entry) => {
      text(entry.name, 512);
      if (!entry.name.startsWith(selected)) throw new TypeError("Workers KV listing escaped its reserved prefix.");
      const key = entry.name.slice(prefix.length);
      const value = envelope(entry.metadata, key);
      if (entry.expiration !== undefined) integer(entry.expiration, "Workers KV expiration");
      return { key, ...stat(value), ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }) };
    });
    return { keys, ...(page.list_complete ? {} : { cursor: page.cursor! }) };
  }
  const backend: ObjectBackendType = {
    name: "cloudflare-kv",
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    capabilities: {
      rangeRead: false,
      streamRead: false,
      streamWrite: false,
      copy: false,
      conditionalWrite: false,
      metadata: true,
      versions: false,
      multipart: false,
    },
    async head(key, request = {}) {
      const result = await open(key, request.signal);
      if (result === null) return null;
      await result.value.cancel();
      return stat(result.metadata);
    },
    async get(key, request = {}) {
      const selected = range(request);
      if (request.revision !== undefined) throw new TypeError("Workers KV cannot enforce revision-bound reads.");
      physical(key);
      if (selected.empty) return new Blob().stream();
      const result = await open(key, selected.signal);
      if (result === null) throw new TypeError("Workers KV object was not found in this regional observation.");
      let reader: ReturnType<typeof openBytes> | undefined;
      let complete = false;
      let primary: { reason: unknown } | undefined;
      let output: Uint8Array<ArrayBuffer> | undefined;
      try {
        if (result.metadata.size > maxReadBytes) {
          throw new RangeError("Workers KV full-value read exceeds its byte budget.");
        }
        reader = openBytes(
          result.value.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>(),
            selected.signal === undefined ? {} : { signal: selected.signal },
          ),
        );
        const bytes = new Uint8Array(result.metadata.size);
        let count = 0;
        while (true) {
          selected.signal?.throwIfAborted();
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (cause) {
            complete = true;
            throw cause;
          }
          selected.signal?.throwIfAborted();
          if (chunk.done) {
            complete = true;
            break;
          }
          if (!isBytes(chunk.value)) throw new TypeError("Workers KV value must contain bytes.");
          const part = toView(chunk.value);
          if (part.byteLength > maxChunkBytes || part.byteLength > bytes.byteLength - count) {
            throw new RangeError("Workers KV body exceeds its admitted chunk or metadata extent.");
          }
          bytes.set(part, count);
          count += part.byteLength;
        }
        if (count !== bytes.byteLength) throw new TypeError("Workers KV body disagrees with its associated metadata.");
        const start = Math.min(selected.start, count);
        const end = selected.end === undefined ? count : Math.min(selected.end + 1, count);
        output = bytes.slice(start, end);
      } catch (cause) {
        primary = { reason: cause };
      }
      const owned = reader;
      await close(
        owned === undefined
          ? [() => result.value.cancel(primary?.reason)]
          : [...(complete ? [] : [() => owned.cancel(primary?.reason)]), () => owned.releaseLock()],
        primary === undefined ? [] : [primary.reason],
      );
      return new Blob([output!.buffer]).stream();
    },
    async put(key, body, options = {}) {
      const name = physical(key);
      const request = putOptions(options);
      if (request.revision !== undefined || request.ifMatch !== undefined || request.ifNoneMatch !== undefined) {
        throw new TypeError("Workers KV has no native conditional write.");
      }
      request.signal?.throwIfAborted();
      if (!isBytes(body)) throw new TypeError("Workers KV requires materialized upload bytes in this profile.");
      const view = toView(body);
      if (view.byteLength > maxUploadBytes || (request.size !== undefined && request.size !== view.byteLength)) {
        throw new RangeError("Workers KV upload exceeds its policy or declared size.");
      }
      const info: Record<string, string> = Object.create(null);
      for (const [field, value] of Object.entries(request.metadata ?? {})) {
        text(field, 1024);
        text(value, 1024);
        info[field] = value;
      }
      if (request.mediaType !== undefined) text(request.mediaType, 1024);
      const metadata = envelope({
        opfs: 1,
        key,
        size: view.byteLength,
        metadata: info,
        ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
      }, key);
      const bytes = new Uint8Array(view);
      try {
        await binding.put(name, bytes.buffer, { metadata, ...(expirationTtl === undefined ? {} : { expirationTtl }) });
      } catch (cause) {
        throw new CloudflareKvPublicationError(cause);
      }
      return stat(metadata);
    },
    async delete(key, request = {}) {
      const name = physical(key);
      if (request.revision !== undefined) throw new TypeError("Workers KV deletion cannot enforce a revision.");
      request.signal?.throwIfAborted();
      try {
        await binding.delete(name);
      } catch (cause) {
        throw new CloudflareKvPublicationError(cause);
      }
    },
    async list(request) {
      if (request.delimiter !== undefined && request.delimiter !== "/") {
        throw new TypeError("Workers KV projection admits only a slash delimiter.");
      }
      // Return a flat native page. The object adapter performs bounded hierarchy translation.
      const page = await listKeys(request);
      return {
        objects: page.keys.map(({ expiration: _expiration, ...entry }) => entry),
        prefixes: [],
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    },
  };
  const driver = defineObjectDriver(backend, {
    name: "cloudflare-kv",
    ownership: "borrowed",
    limits: [
      { code: "file-bytes", kind: "hard", source: "provider", unit: "bytes", value: CLOUDFLARE_KV_BYTES },
      { code: "upload-bytes", kind: "policy", source: "user", unit: "bytes", value: maxUploadBytes },
      { code: "read-bytes", kind: "policy", source: "user", unit: "bytes", value: maxReadBytes },
      {
        code: "consistency",
        kind: "dynamic",
        source: "provider",
        unit: "count",
        detail:
          "Regional observations are eventually consistent, including absence; no authoritative directory or CAS.",
      },
    ],
    plan(input) {
      const request = DriverPlanInputSchema.parse(input);
      const failed = request.operation === "write" && (request.size ?? 0) > maxUploadBytes;
      return DriverPlanSchema.parse({
        operation: request.operation,
        supported: !failed,
        support: failed ? "unsupported" : "native",
        problems: failed
          ? [{
            code: "upload-too-large",
            layer: "driver",
            severity: "error",
            message: "Workers KV upload exceeds its configured value policy.",
          }]
          : [],
        actions: failed ? [{ kind: "reduce-input" }] : [],
      });
    },
  });
  return { ...driver, consistency: "eventual", listKeys };
}
