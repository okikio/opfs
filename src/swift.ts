/** Native regular-object subset of the OpenStack Swift v1 REST API. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { assertRequestStream, isStream } from "./body.ts";
import { open } from "./chunk.ts";
import type { ChunkSourceType } from "./chunk.ts";
import { close } from "./close.ts";
import { objectETag, putOptions } from "./publication.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import type {
  ObjectBackendType,
  ObjectDeleteOptionsType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectReceiptType,
  ObjectStatType,
} from "./driver/object.ts";

/** Caller-owned account endpoint and authorization; Keystone discovery stays in the application. */
export interface SwiftClientOptionsType {
  /** Account storage URL, for example https://storage.example/v1/AUTH_project. */
  readonly endpoint: string | URL;
  readonly container: string;
  /** Swift X-Auth-Token, refreshed for each read attempt; omit for an explicitly public deployment. */
  readonly token?: string | (() => string | Promise<string>);
  readonly fetch?: FetchType;
  /** Read retry policy. PUT and DELETE are never automatically retried. */
  readonly request?: RequestPolicyType;
  /** Application policy, not cluster discovery. Defaults to 5 GiB for single regular objects. */
  readonly maxObjectBytes?: number;
  /** Requested JSON page size; default 1000, implementation ceiling 10000. */
  readonly pageSize?: number;
}

/** Native client operations do not need a filesystem projection. */
export interface SwiftClientType extends ObjectBackendType {
  readonly identity: string;
  getMetrics(): RequestMetricsType;
}

/** HTTP failure retaining request identity without token-bearing messages. */
export class SwiftError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;
  constructor(response: Response) {
    super(`Swift request failed with HTTP ${response.status}.`);
    this.name = "SwiftError";
    this.status = response.status;
    this.requestId = response.headers.get("x-trans-id") ?? response.headers.get("x-openstack-request-id") ?? undefined;
  }
}

/** A dispatched PUT has no attributable acknowledgement. A later HEAD cannot prove which writer published. */
export class SwiftPublicationError extends Error {
  readonly key: string;
  constructor(key: string, cause: unknown) {
    super("Swift publication has no validated acknowledgement; do not blindly replay it.", { cause });
    this.name = "SwiftPublicationError";
    this.key = key;
  }
}

/** JSON entries are independent protocol records; preserve extra deployment fields. */
const SwiftEntrySchema = z.union([
  z.object({ subdir: z.string().min(1) }).passthrough(),
  z.object({
    name: z.string().min(1),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    hash: z.string(),
    content_type: z.string(),
    last_modified: z.string(),
  }).passthrough(),
]);
const SwiftListSchema = z.array(SwiftEntrySchema).max(10000);

/** Admit safe arithmetic before credentials, allocations or source acquisition. */
function integer(value: number, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Regular Swift hashes are unquoted MD5 values on some deployments; normalize to one strong HTTP entity tag. */
function etag(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (/^[a-fA-F0-9]{32}$/.test(value)) return `"${value}"`;
  if (/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) return value;
  throw new TypeError("Swift did not return one strong regular-object ETag.");
}

/** Manifest and symlink reads have different consistency/size contracts and cannot masquerade as regular objects. */
function regular(headers: Headers): void {
  if (
    headers.has("x-object-manifest") || headers.get("x-static-large-object")?.toLowerCase() === "true" ||
    headers.has("x-symlink-target")
  ) {
    throw new TypeError("Swift large-object manifests and symlinks require a separate profile.");
  }
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new TypeError("Encoded Swift objects cannot preserve byte offsets.");
  }
}

/** HEAD metadata is attributable to one response; control-response length is never a PUT object's length. */
function stat(headers: Headers): ObjectStatType {
  regular(headers);
  const length = headers.get("content-length");
  if (length === null || !/^\d+$/.test(length)) throw new TypeError("Swift object metadata needs a byte length.");
  const size = integer(Number(length), "Swift object size");
  const tag = etag(headers.get("etag"));
  const modified = headers.get("last-modified");
  const lastModified = modified === null ? undefined : Date.parse(modified);
  if (lastModified !== undefined && !Number.isFinite(lastModified)) throw new TypeError("Invalid Swift object date.");
  const metadata: Record<string, string> = Object.create(null);
  for (const [name, value] of headers) {
    if (name.startsWith("x-object-meta-")) metadata[name.slice(14)] = value;
  }
  return {
    size,
    ...(tag === undefined ? {} : { etag: tag, revision: { kind: "etag", value: tag } }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** A configured account/container; no network or credential acquisition occurs at import or construction. */
class SwiftClient implements SwiftClientType {
  readonly name = "swift";
  readonly identity: string;
  readonly capabilities = Object.freeze({
    rangeRead: true,
    streamRead: true,
    streamWrite: true,
    copy: false,
    conditionalWrite: false,
    multipart: false,
    metadata: true,
    versions: false,
  });
  readonly limits: { readonly maxFileBytes: number };
  readonly #endpoint: URL;
  readonly #container: string;
  readonly #token: SwiftClientOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #nativeFetch: boolean;
  readonly #policy: RequestPolicyType | undefined;
  readonly #pageSize: number;
  readonly #metrics = new RequestMetrics();

  constructor(options: SwiftClientOptionsType) {
    const endpoint = new URL(options.endpoint);
    if (
      !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    ) {
      throw new TypeError("Swift endpoint must be an HTTP(S) account URL without credentials, query or fragment.");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
    if (endpoint.pathname === "/" || endpoint.pathname === "") throw new TypeError("Swift needs an account URL path.");
    if (
      !options.container || options.container.includes("/") ||
      [...options.container].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
    ) {
      throw new TypeError("Swift needs a nonempty container without slashes or control characters.");
    }
    this.#endpoint = endpoint;
    this.#container = options.container;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#nativeFetch = options.fetch === undefined;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#pageSize = integer(options.pageSize ?? 1000, "pageSize", 1, 10000);
    this.limits = Object.freeze({ maxFileBytes: integer(options.maxObjectBytes ?? 5 * 1024 ** 3, "maxObjectBytes") });
    this.identity = JSON.stringify(["swift", endpoint.origin, endpoint.pathname, this.#container]);
    this.#url(); // Validate the namespace before any request.
  }

  getMetrics(): RequestMetricsType {
    return this.#metrics.snapshot();
  }

  /** Fetch normalizes dot segments; refuse names it would silently address as another object. */
  #url(key?: string): URL {
    if (key !== undefined && (!key || key.split("/").some((part) => part === "." || part === ".."))) {
      throw new TypeError("Swift object keys must be nonempty and contain no dot segments.");
    }
    const path = `${this.#endpoint.pathname}/${encodeURIComponent(this.#container)}${
      key === undefined ? "" : `/${key.split("/").map(encodeURIComponent).join("/")}`
    }`;
    const url = new URL(this.#endpoint);
    url.pathname = path;
    if (url.pathname !== path) throw new TypeError("Fetch cannot preserve this Swift object path.");
    return url;
  }

  /** Build authentication per attempt; scoped token refresh and redirect policy never escape this account. */
  async #send(
    url: URL,
    method: string,
    headers: Headers,
    signal?: AbortSignal,
    body?: BodyInit,
    dispatch?: () => void,
  ): Promise<Response> {
    return await sendRequest(async (attemptSignal) => {
      const authorized = new Headers(headers);
      if (this.#token !== undefined) {
        const token = typeof this.#token === "function" ? await this.#token() : this.#token;
        if (!token || /[\r\n]/.test(token)) throw new TypeError("Swift token must be nonempty without line breaks.");
        authorized.set("x-auth-token", token);
      }
      return {
        input: new URL(url),
        init: {
          method,
          headers: authorized,
          redirect: "manual",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(body === undefined ? {} : { body }),
          ...(isStream(body) ? { duplex: "half" } : {}),
        },
      };
    }, {
      fetch: (input, init) => {
        dispatch?.();
        return this.#fetch(input, init);
      },
      metrics: this.#metrics,
      replayable: method === "GET" || method === "HEAD",
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Retire header-only responses without materializing untrusted provider error text. */
  async #accepted(response: Response, statuses: readonly number[]): Promise<void> {
    await readResponse(response, () => {
      if (!statuses.includes(response.status)) throw new SwiftError(response);
    });
  }

  async head(key: string, options: { readonly signal?: AbortSignal } = {}): Promise<ObjectStatType | null> {
    const signal = options.signal;
    const url = this.#url(key);
    url.searchParams.set("multipart-manifest", "get");
    url.searchParams.set("symlink", "get");
    const response = await this.#send(url, "HEAD", new Headers(), signal);
    return await readResponse(response, () => {
      if (response.status === 404) return null;
      if (response.status !== 200) throw new SwiftError(response);
      return stat(response.headers);
    });
  }

  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    const selected = range(options);
    const condition = objectETag(options.revision);
    const url = this.#url(key);
    if (selected.empty) return new Blob().stream();
    const headers = new Headers();
    if (selected.header !== undefined) headers.set("range", selected.header);
    if (condition !== undefined) headers.set("if-match", condition);
    url.searchParams.set("multipart-manifest", "get");
    url.searchParams.set("symlink", "get");
    const response = await this.#send(url, "GET", headers, selected.signal);
    if (!response.ok) await this.#accepted(response, [200, 206]);
    // The range validator owns rejected bodies; other header failures use the same response owner.
    try {
      regular(response.headers);
      if (condition !== undefined && etag(response.headers.get("etag")) !== condition) {
        throw new TypeError("Swift returned a different object ETag than requested.");
      }
    } catch (reason) {
      await close(response.body === null ? [] : [() => response.body!.cancel()], [reason]);
      throw reason;
    }
    await assertRangeResponse(response, selected);
    return response.body ?? new Blob().stream();
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectReceiptType> {
    const request = putOptions(options);
    const url = this.#url(key);
    request.signal?.throwIfAborted();
    if (
      request.revision !== undefined || request.ifMatch !== undefined ||
      (request.ifNoneMatch !== undefined && request.ifNoneMatch !== "*")
    ) {
      throw new TypeError("Swift only admits the native create condition If-None-Match:* for PUT.");
    }
    const headers = new Headers();
    if (request.ifNoneMatch !== undefined) headers.set("if-none-match", request.ifNoneMatch);
    if (request.mediaType !== undefined) headers.set("content-type", request.mediaType);
    const metadata: Record<string, string> = Object.create(null);
    for (const [name, value] of Object.entries(request.metadata ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new TypeError("Swift metadata names must be ASCII tokens.");
      headers.set(`x-object-meta-${name}`, value);
      metadata[name.toLowerCase()] = headers.get(`x-object-meta-${name}`)!;
    }
    if (request.size !== undefined) integer(request.size, "Upload size", 0, this.limits.maxFileBytes);
    let count = 0;
    let complete = false;
    let chunks: ChunkSourceType | undefined;
    let payload: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
    if (isBytes(body)) {
      const view = toView(body);
      integer(view.byteLength, "Upload size", 0, this.limits.maxFileBytes);
      if (request.size !== undefined && request.size !== view.byteLength) throw new RangeError("Swift size mismatch.");
      payload = new Uint8Array(view);
      count = payload.byteLength;
      complete = true;
    } else {
      if (!isStream(body) || Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")!.get!.call(body)) {
        throw new TypeError("Swift PUT needs native unlocked byte input.");
      }
      if (this.#nativeFetch) assertRequestStream();
      payload = new ReadableStream<Uint8Array>({
        pull: async (output) => {
          try {
            chunks ??= open(body, 64 * 1024, request.signal);
            const next = await chunks.next();
            if (next.done) {
              if (request.size !== undefined && count !== request.size) throw new RangeError("Swift size mismatch.");
              complete = true;
              output.close();
            } else {
              integer(count + next.value.byteLength, "Upload size", 0, this.limits.maxFileBytes);
              if (request.size !== undefined && count + next.value.byteLength > request.size) {
                throw new RangeError("Swift stream exceeds its declared size.");
              }
              count += next.value.byteLength;
              output.enqueue(next.value);
            }
          } catch (reason) {
            output.error(reason);
          }
        },
        async cancel() {
          await chunks?.interrupt();
        },
      }, { highWaterMark: 0 });
    }
    let dispatched = false;
    let primary: readonly unknown[] = [];
    try {
      let response: Response;
      try {
        response = await this.#send(url, "PUT", headers, request.signal, payload, () => {
          dispatched = true;
        });
      } catch (cause) {
        if (dispatched) throw new SwiftPublicationError(key, cause);
        throw cause;
      }
      return await readResponse(response, () => {
        if (response.status !== 201) {
          const cause = new SwiftError(response);
          if (response.status >= 500 || response.status === 408 || (response.status >= 200 && response.status < 300)) {
            throw new SwiftPublicationError(key, cause);
          }
          throw cause;
        }
        try {
          if (!complete) throw new TypeError("Swift acknowledged before the complete input was consumed.");
          const tag = etag(response.headers.get("etag"));
          if (tag === undefined) throw new TypeError("Swift PUT acknowledgement omitted ETag.");
          return {
            size: count,
            etag: tag,
            revision: { kind: "etag" as const, value: tag },
            ...(headers.get("content-type") === null ? {} : { mediaType: headers.get("content-type")! }),
            ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
            ...(response.headers.get("x-trans-id") === null ? {} : { requestId: response.headers.get("x-trans-id")! }),
          };
        } catch (cause) {
          throw new SwiftPublicationError(key, cause);
        }
      });
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([async () => {
        if (chunks !== undefined) {
          await chunks.interrupt();
          await chunks.return();
        }
      }], primary);
    }
  }

  async delete(key: string, options: ObjectDeleteOptionsType = {}): Promise<void> {
    const signal = options.signal;
    if (options.revision !== undefined) throw new TypeError("Swift DELETE has no supported revision condition.");
    const response = await this.#send(this.#url(key), "DELETE", new Headers(), signal);
    await this.#accepted(response, [204, 404]);
  }

  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    const { prefix, delimiter, cursor, signal } = options;
    const limit = integer(options.limit ?? this.#pageSize, "Page size", 1, 10000);
    if (delimiter !== undefined && [...delimiter].length !== 1) {
      throw new TypeError("Swift delimiter is one character.");
    }
    const url = this.#url();
    url.searchParams.set("format", "json");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("limit", String(limit));
    if (delimiter !== undefined) url.searchParams.set("delimiter", delimiter);
    if (cursor !== undefined) url.searchParams.set("marker", cursor);
    const response = await this.#send(url, "GET", new Headers(), signal);
    return await readResponse(response, async (text) => {
      if (response.status === 204) return { objects: [], prefixes: [] };
      if (response.status !== 200) throw new SwiftError(response);
      const entries = SwiftListSchema.parse(JSON.parse(await text()));
      if (entries.length > limit) throw new TypeError("Swift listing exceeded its requested page size.");
      const objects: ObjectListType["objects"][number][] = [];
      const prefixes: string[] = [];
      let last = cursor;
      let previous = cursor === undefined ? undefined : new TextEncoder().encode(cursor);
      for (const entry of entries) {
        const name = "subdir" in entry ? entry.subdir as string : entry.name as string;
        const encoded = new TextEncoder().encode(name);
        let order = previous === undefined ? 1 : encoded.length - previous.length;
        if (previous !== undefined) {
          for (let index = 0; index < Math.min(previous.length, encoded.length); index++) {
            if (previous[index] !== encoded[index]) {
              order = encoded[index]! - previous[index]!;
              break;
            }
          }
        }
        if (!name.startsWith(prefix) || order <= 0) {
          throw new TypeError("Swift listing did not advance within the requested prefix.");
        }
        last = name;
        previous = encoded;
        if ("subdir" in entry) {
          prefixes.push(name);
          continue;
        }
        const value = entry as {
          name: string;
          bytes: number;
          hash: string;
          content_type: string;
          last_modified: string;
        };
        const modified = Date.parse(
          /[zZ]|[+-]\d\d:\d\d$/.test(value.last_modified) ? value.last_modified : `${value.last_modified}Z`,
        );
        if (!Number.isFinite(modified)) throw new TypeError("Swift listing returned an invalid date.");
        const tag = etag(value.hash);
        objects.push({
          key: name,
          size: value.bytes,
          mediaType: value.content_type,
          lastModified: modified,
          ...(tag === undefined ? {} : { etag: tag }),
        });
      }
      // A nonempty page always gets a marker: cluster-side caps may be lower
      // than our requested limit. One terminal empty request avoids silent loss.
      return { objects, prefixes, ...(entries.length === 0 ? {} : { cursor: last! }) };
    });
  }
}

/** Configure the native Swift regular-object profile without discovery or credential reads. */
export function createSwiftClient(options: SwiftClientOptionsType): SwiftClientType {
  return new SwiftClient(options);
}
