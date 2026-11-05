/** Injected Cloudflare R2 bindings; this module never discovers Worker globals or opens a service. @module */
import type { ObjectBackendType, ObjectStatType } from "./driver/object.ts";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { etagPutOptions, objectETag } from "./publication.ts";
import { range } from "./range.ts";

/** Materialized upload safety ceiling, independent of R2's larger provider upload limits. */
export const R2_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Narrow structural view of metadata returned by a real R2 binding. */
export interface R2ObjectType {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: { readonly contentType?: string; readonly contentEncoding?: string };
  readonly customMetadata?: Record<string, string>;
  readonly range?: { readonly offset?: number; readonly length?: number; readonly suffix?: number };
}
/** Conditional GET returns metadata without a body when its condition fails. */
export interface R2BodyType extends R2ObjectType {
  readonly body: ReadableStream<Uint8Array>;
}
/** The application supplies the actual bucket binding; no Cloudflare type package is required. */
export interface R2BindingType {
  head(key: string): Promise<R2ObjectType | null>;
  get(
    key: string,
    options?: { onlyIf?: Headers; range?: { offset: number; length?: number } },
  ): Promise<R2BodyType | R2ObjectType | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { onlyIf?: Headers; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<R2ObjectType | null>;
  delete(key: string): Promise<void>;
  list(
    options?: {
      limit?: number;
      prefix?: string;
      cursor?: string;
      delimiter?: string;
      include?: ("httpMetadata" | "customMetadata")[];
    },
  ): Promise<{ objects: R2ObjectType[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }>;
}
/** Separate caller policies for returned read bytes and admitted buffered uploads. */
export interface R2ClientOptionsType {
  readonly maxUploadBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxChunkBytes?: number;
  /** Caller assertion binding this bucket and account, never an inferred environment name. */
  readonly identity?: string;
}
/** Object mechanics plus inspectable upload/read policies. */
export interface R2ClientType extends ObjectBackendType {
  readonly maxUploadBytes: number;
  readonly maxReadBytes: number;
}
/** Native binding absence and failed conditional operations remain machine-readable. */
export class R2Error extends Error {
  readonly code: "not-found" | "locked";
  constructor(code: "not-found" | "locked") {
    super(`R2 operation failed: ${code}.`);
    this.name = "R2Error";
    this.code = code;
  }
}
/** The binding call was dispatched but no valid receipt proves this write's outcome. */
export class R2PublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("R2 publication outcome is unknown; do not blindly retry.", { cause });
    this.name = "R2PublicationError";
  }
}
/** Validate safe arithmetic before native calls and byte allocation. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} exceeds its nonnegative safe-integer limit.`);
  }
  return value;
}
/** Refuse lossy Unicode encoding and provider key overflow before calling a binding. */
function key(value: string, empty = false): void {
  if (
    typeof value !== "string" || (!empty && !value) || value.length > 1024 ||
    new TextEncoder().encode(value).byteLength > 1024
  ) throw new TypeError("R2 key exceeds its UTF-8 byte limit.");
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError("R2 key contains an unpaired surrogate.");
  }
}
/** Bound control metadata independently of payload bytes; JSON overhead is a conservative admission policy. */
function metadata(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let bytes = 2;
  for (const [name, text] of Object.entries(value ?? {})) {
    if (typeof text !== "string" || name.length > 8192 || text.length > 8192) {
      throw new TypeError("R2 custom metadata must contain bounded strings.");
    }
    bytes += new TextEncoder().encode(JSON.stringify([name, text])).byteLength;
    if (bytes > 8192) throw new RangeError("R2 custom metadata exceeds the 8192-byte control budget.");
    result[name] = text;
  }
  return result;
}
/** R2's actual quoted HTTP validator controls reads; its separate upload version is not addressable by get(). */
function stat(object: R2ObjectType, expected: string): ObjectStatType {
  if (
    object.key !== expected || !object.version || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(object.httpEtag) ||
    object.httpEtag !== `"${object.etag}"`
  ) throw new TypeError("R2 metadata has inconsistent key, version or ETag.");
  const size = integer(object.size, "R2 object size");
  const uploaded = Date.prototype.getTime.call(object.uploaded);
  if (!Number.isFinite(uploaded)) throw new TypeError("R2 upload date is invalid.");
  return {
    size,
    lastModified: uploaded,
    etag: object.httpEtag,
    revision: { kind: "etag", value: object.httpEtag },
    version: object.version,
    ...(object.httpMetadata?.contentType === undefined ? {} : { mediaType: object.httpMetadata.contentType }),
    metadata: metadata(object.customMetadata),
  };
}
/** Strong single ETags and the HTTP wildcard are passed as native Headers, avoiding raw/quoted tag conversion. */
function condition(value: string | undefined): void {
  if (value !== undefined && value !== "*" && !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) {
    throw new TypeError("R2 conditions require one strong HTTP ETag or wildcard.");
  }
}
/** Compose the portable object API over a borrowed native binding. Construction performs no binding calls. */
export function createR2Client(binding: R2BindingType, options: R2ClientOptionsType = {}): R2ClientType {
  const maxUploadBytes = integer(options.maxUploadBytes ?? R2_UPLOAD_BYTES, "R2 upload policy", R2_UPLOAD_BYTES);
  const maxReadBytes = integer(options.maxReadBytes ?? 64 * 1024 * 1024, "R2 read policy");
  const maxChunkBytes = integer(options.maxChunkBytes ?? 1024 * 1024, "R2 chunk policy");
  if (maxChunkBytes === 0) throw new RangeError("R2 chunk policy must be positive.");
  return {
    name: "r2",
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    maxUploadBytes,
    maxReadBytes,
    capabilities: {
      rangeRead: true,
      streamRead: true,
      streamWrite: false,
      copy: false,
      conditionalWrite: true,
      multipart: false,
      metadata: true,
      versions: false,
    },
    async head(name, request = {}) {
      key(name);
      request.signal?.throwIfAborted();
      const object = await binding.head(name);
      request.signal?.throwIfAborted();
      return object === null ? null : stat(object, name);
    },
    async get(name, request = {}) {
      key(name);
      const selected = range(request);
      const tag = objectETag(request.revision);
      condition(tag);
      if (selected.empty) return new Blob().stream();
      if (request.length !== undefined && request.length > maxReadBytes) {
        throw new RangeError("R2 requested read exceeds its byte budget.");
      }
      const onlyIf = new Headers();
      if (tag !== undefined) onlyIf.set("if-match", tag);
      const object = await binding.get(name, {
        ...(tag === undefined ? {} : { onlyIf }),
        ...(selected.header === undefined
          ? {}
          : { range: { offset: selected.start, ...(request.length === undefined ? {} : { length: request.length }) } }),
      });
      if (object === null) throw new R2Error("not-found");
      const body = "body" in object ? object.body : undefined;
      try {
        selected.signal?.throwIfAborted();
        const value = stat(object, name);
        if (body === undefined) throw new R2Error("locked");
        if (tag !== undefined && tag !== "*" && value.etag !== tag) throw new TypeError("R2 returned another ETag.");
        if (selected.start > value.size) throw new RangeError("R2 range starts beyond the object.");
        const expected = Math.min(request.length ?? value.size - selected.start, value.size - selected.start);
        if (expected > maxReadBytes) throw new RangeError("R2 returned read exceeds its byte budget.");
        if (
          selected.header !== undefined && (object.range?.offset !== selected.start || object.range.length !== expected)
        ) throw new TypeError("R2 returned a different native byte range.");
        let count = 0;
        return body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              if (!isBytes(chunk)) throw new TypeError("R2 body must contain bytes.");
              const bytes = toView(chunk);
              if (bytes.byteLength > maxChunkBytes || bytes.byteLength > expected - count) {
                throw new RangeError("R2 body exceeds its chunk or range extent.");
              }
              count += bytes.byteLength;
              controller.enqueue(bytes);
            },
            flush() {
              if (count !== expected) throw new TypeError("R2 body ended before its declared extent.");
            },
          }),
          selected.signal === undefined ? {} : { signal: selected.signal },
        );
      } catch (cause) {
        await close(body === undefined ? [] : [() => body.cancel(cause)], [cause]);
        throw cause;
      }
    },
    async put(name, body, options = {}) {
      key(name);
      const request = etagPutOptions(options);
      condition(request.ifMatch);
      condition(request.ifNoneMatch);
      if (request.ifMatch !== undefined && request.ifNoneMatch !== undefined) {
        throw new TypeError("R2 accepts one destination condition per operation.");
      }
      request.signal?.throwIfAborted();
      if (!isBytes(body)) {
        throw new TypeError(
          "This R2 profile requires materialized upload bytes; native known-length stream acquisition is not implemented.",
        );
      }
      const view = toView(body);
      if (view.byteLength > maxUploadBytes || (request.size !== undefined && request.size !== view.byteLength)) {
        throw new RangeError("R2 upload exceeds policy or differs from declared size.");
      }
      const info = metadata(request.metadata);
      const bytes = new Uint8Array(view);
      const onlyIf = new Headers();
      if (request.ifMatch !== undefined) onlyIf.set("if-match", request.ifMatch);
      if (request.ifNoneMatch !== undefined) onlyIf.set("if-none-match", request.ifNoneMatch);
      let object: R2ObjectType | null;
      try {
        object = await binding.put(name, bytes.buffer, {
          onlyIf,
          customMetadata: info,
          ...(request.mediaType === undefined ? {} : { httpMetadata: { contentType: request.mediaType } }),
        });
      } catch (cause) {
        throw new R2PublicationError(cause);
      }
      if (object === null) throw new R2Error("locked");
      try {
        const receipt = stat(object, name);
        if (receipt.size !== bytes.byteLength) throw new TypeError("R2 upload receipt has another size.");
        for (const [field, value] of Object.entries(info)) {
          if (receipt.metadata?.[field] !== value) throw new TypeError("R2 receipt lost admitted metadata.");
        }
        if (request.mediaType !== undefined && receipt.mediaType !== request.mediaType) {
          throw new TypeError("R2 receipt changed the media type.");
        }
        return receipt;
      } catch (cause) {
        throw new R2PublicationError(cause);
      }
    },
    async delete(name, request = {}) {
      key(name);
      if (request.revision !== undefined) {
        throw new TypeError("R2 binding deletion does not support a revision condition.");
      }
      request.signal?.throwIfAborted();
      try {
        await binding.delete(name);
      } catch (cause) {
        throw new R2PublicationError(cause);
      }
    },
    async list(request) {
      key(request.prefix, true);
      const limit = integer(request.limit ?? 1000, "R2 page limit", 1000);
      if (!limit) throw new RangeError("R2 page limit must be positive.");
      if (request.delimiter !== undefined && request.delimiter !== "/") {
        throw new TypeError("This R2 profile admits only a slash delimiter.");
      }
      request.signal?.throwIfAborted();
      const page = await binding.list({
        prefix: request.prefix,
        limit,
        include: ["httpMetadata", "customMetadata"],
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.delimiter === undefined ? {} : { delimiter: request.delimiter }),
      });
      request.signal?.throwIfAborted();
      if (
        page.objects.length + page.delimitedPrefixes.length > limit || typeof page.truncated !== "boolean" ||
        (page.truncated && (!page.cursor || page.cursor === request.cursor))
      ) throw new TypeError("R2 returned an inconsistent listing page.");
      const objects = page.objects.map((object) => {
        key(object.key);
        if (!object.key.startsWith(request.prefix)) throw new TypeError("R2 listing escaped its prefix.");
        return { key: object.key, ...stat(object, object.key) };
      });
      const prefixes = page.delimitedPrefixes.map((prefix) => {
        key(prefix);
        if (!prefix.startsWith(request.prefix)) throw new TypeError("R2 prefix escaped its namespace.");
        return prefix;
      });
      return { objects, prefixes, ...(page.truncated ? { cursor: page.cursor! } : {}) };
    },
  };
}
