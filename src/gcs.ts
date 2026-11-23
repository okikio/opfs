import { z } from "zod";

import { isBytes, toRequestBytes } from "./bytes.ts";
import { isStream } from "./body.ts";
import { open } from "./chunk.ts";
import { close } from "./close.ts";
import type {
  ObjectBackendType,
  ObjectCopyOptionsType,
  ObjectGetOptionsType,
  ObjectListOptionsType,
  ObjectListType,
  ObjectPutOptionsType,
  ObjectReceiptType,
  ObjectRevisionType,
  ObjectStatType,
} from "./driver/object.ts";
import { range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import type { UploadDestinationType, UploadStatusType } from "./transfer.ts";

/** Google Cloud Storage upload alignment, independent of caller buffering policy. */
export const GCS_CHUNK_BYTES = 256 * 1024;
/** Maximum object size supported by the JSON API, in bytes. */
export const GCS_MAX_BYTES = 5 * 1024 ** 4;

/** Explicit configuration; the application owns token acquisition and refresh. */
export interface GcsClientOptionsType {
  /** Bucket name; each client addresses one bucket. */
  readonly bucket: string;
  /** Bearer token or refresh callback; omitted for public objects or an injected emulator. */
  readonly token?: string | (() => string | Promise<string>);
  /** Service origin. Defaults to https://storage.googleapis.com. */
  readonly endpoint?: string | URL;
  /** Transport acquired only when constructing this client, never on import. */
  readonly fetch?: FetchType;
  /** Read/status retry policy. Mutating requests are never blindly replayed. */
  readonly request?: RequestPolicyType;
  /** Stream upload buffer. Defaults to 8 MiB; must be a positive 256 KiB multiple. */
  readonly chunkSize?: number;
  /** Maximum rewrite requests for one copy. Defaults to 1024. */
  readonly maxRewriteRequests?: number;
}

/** Secret resumable-upload authority; protect it like a credential. */
export interface GcsUploadType {
  /** Provider session URI; do not log or expose it to other callers. */
  readonly url: string;
  /** Destination object key, retained for acknowledgement attribution. */
  readonly key: string;
  /** Expected complete encoded length, when known. */
  readonly size?: number;
}

/** Server-confirmed continuation or attributable final publication. */
export type GcsUploadStatusType =
  | Readonly<{ complete: false; offset: number }>
  | Readonly<{ complete: true; offset: number; receipt: ObjectReceiptType }>;

/** One bounded upload extent. Nonfinal extents must follow GCS alignment rules. */
export interface GcsUploadWriteOptionsType {
  /** Server-confirmed offset, not merely the bytes previously sent. */
  readonly offset: number;
  /** Complete encoded object size when known. */
  readonly total?: number;
  /** Declares this extent to be the final one; requires a complete total. */
  readonly final?: boolean;
  readonly signal?: AbortSignal;
}

/** GCS-native operations remain usable without a filesystem adapter. */
export interface GcsClientType extends ObjectBackendType {
  getMetrics(): RequestMetricsType;
  createUpload(key: string, options?: ObjectPutOptionsType): Promise<GcsUploadType>;
  queryUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<GcsUploadStatusType>;
  writeUpload(
    upload: GcsUploadType,
    body: Uint8Array,
    options: GcsUploadWriteOptionsType,
  ): Promise<GcsUploadStatusType>;
  cancelUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<void>;
  copy(source: string, destination: string, options?: ObjectCopyOptionsType): Promise<ObjectReceiptType>;
}

/** Provider HTTP failure without credential-bearing URLs in its message. */
export class GcsError extends Error {
  readonly status: number;
  readonly response: Response;
  constructor(response: Response) {
    super(`Google Cloud Storage request failed with HTTP ${response.status}.`);
    this.name = "GcsError";
    this.status = response.status;
    this.response = response;
  }
}

/** A dispatched publication has no validated acknowledgement; query its session. */
export class GcsPublicationError extends Error {
  readonly key: string;
  constructor(key: string, cause: unknown) {
    super("Google Cloud Storage publication could not be attributed from its acknowledgement.", { cause });
    this.name = "GcsPublicationError";
    this.key = key;
  }
}

/** Validate known fields while preserving GCS's independently extensible JSON grammar. */
const GcsMetadataSchema = z.object({
  name: z.string(),
  size: z.string().regex(/^\d+$/),
  generation: z.string().regex(/^[1-9]\d*$/),
  etag: z.string().optional(),
  contentType: z.string().optional(),
  updated: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).passthrough();

/** Admission uses encoded-byte safe integers before acquiring credentials or sources. */
function integer(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a nonnegative safe integer no greater than ${maximum}.`);
  }
  return value;
}

/** Generation identifiers are opaque decimal strings, never coerced through Number. */
function generation(revision: ObjectRevisionType | undefined): string | undefined {
  if (revision === undefined) return undefined;
  if (revision.kind !== "generation" || !/^\d+$/.test(revision.value)) {
    throw new TypeError("GCS conditions require a decimal generation revision, not an ETag.");
  }
  return revision.value;
}

/** GCS JSON writes use generation preconditions; an ETag is a different contract. */
function condition(options: Pick<ObjectPutOptionsType, "revision" | "ifMatch" | "ifNoneMatch">): string | undefined {
  if (options.ifMatch !== undefined || (options.ifNoneMatch !== undefined && options.ifNoneMatch !== "*")) {
    throw new TypeError("GCS writes require a generation revision or ifNoneMatch: '*'.");
  }
  const value = generation(options.revision);
  if (value !== undefined && options.ifNoneMatch !== undefined) throw new TypeError("Conflicting GCS preconditions.");
  return options.ifNoneMatch === "*" ? "0" : value;
}

/** Attribute only the completely validated operation response, not a later current HEAD. */
function metadata(value: unknown, key?: string): ObjectReceiptType & { readonly key: string } {
  const data = GcsMetadataSchema.parse(value);
  if (key !== undefined && data.name !== key) throw new TypeError("GCS acknowledgement names a different object.");
  const size = Number(data.size);
  integer(size, "Object size", GCS_MAX_BYTES);
  const modified = data.updated === undefined ? undefined : Date.parse(data.updated);
  if (modified !== undefined && !Number.isFinite(modified)) throw new TypeError("Invalid GCS update timestamp.");
  return {
    key: data.name,
    size,
    version: data.generation,
    revision: { kind: "generation", value: data.generation },
    ...(data.etag === undefined ? {} : { etag: data.etag }),
    ...(data.contentType === undefined ? {} : { mediaType: data.contentType }),
    ...(modified === undefined ? {} : { lastModified: modified }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
  };
}

/** Owns a configured service origin and request metrics; no background work starts. */
class GcsClient implements GcsClientType {
  readonly name = "gcs";
  /** Credential-free namespace used to bind persistent source identities. */
  readonly identity: string;
  readonly capabilities = Object.freeze({
    rangeRead: true,
    streamRead: true,
    streamWrite: true,
    copy: true,
    conditionalWrite: true,
    multipart: false,
    metadata: true,
    versions: true,
  });
  readonly limits = Object.freeze({ maxFileBytes: GCS_MAX_BYTES });
  readonly #origin: string;
  readonly #bucket: string;
  readonly #token: GcsClientOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #chunkSize: number;
  readonly #maxRewrite: number;
  readonly #metrics = new RequestMetrics();

  constructor(options: GcsClientOptionsType) {
    if (!options.bucket) throw new TypeError("A GCS bucket is required.");
    const endpoint = new URL(options.endpoint ?? "https://storage.googleapis.com");
    if (
      !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search ||
      endpoint.hash || endpoint.pathname !== "/"
    ) {
      throw new TypeError("GCS endpoint must be an HTTP(S) service origin without credentials, path or query.");
    }
    const size = options.chunkSize ?? 8 * 1024 * 1024;
    integer(size, "Upload chunk size");
    if (size === 0 || size % GCS_CHUNK_BYTES !== 0) {
      throw new RangeError("Upload chunk size must be a positive 256 KiB multiple.");
    }
    const maxRewrite = integer(options.maxRewriteRequests ?? 1024, "Rewrite request limit");
    if (maxRewrite === 0) throw new RangeError("Rewrite request limit must be positive.");
    this.identity = JSON.stringify(["gcs", endpoint.origin, endpoint.pathname, options.bucket]);
    this.#origin = endpoint.origin;
    this.#bucket = options.bucket;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#chunkSize = size;
    this.#maxRewrite = maxRewrite;
  }

  getMetrics(): RequestMetricsType {
    return this.#metrics.snapshot();
  }

  /** Object names are one encoded path component, including slash and question mark. */
  #path(key?: string, upload = false): string {
    return `${upload ? "/upload" : ""}/storage/v1/b/${encodeURIComponent(this.#bucket)}/o${
      key === undefined ? "" : `/${encodeURIComponent(key)}`
    }`;
  }

  /** Session authority never permits credentials to cross the configured service origin. */
  #session(upload: GcsUploadType): URL {
    const url = new URL(upload.url);
    if (url.origin !== this.#origin || url.username || url.password || url.hash) {
      throw new TypeError("GCS session is outside the configured origin.");
    }
    if (upload.size !== undefined) integer(upload.size, "Upload total", GCS_MAX_BYTES);
    return url;
  }

  /** Rebuild read credentials per attempt; mutation retry remains an explicit caller decision. */
  async #send(
    path: string | URL,
    method: string,
    options: {
      query?: Readonly<Record<string, string | undefined>>;
      headers?: HeadersInit;
      body?: BodyInit;
      signal?: AbortSignal;
      retry?: boolean;
      onDispatch?: () => void;
    } = {},
  ): Promise<Response> {
    const url = new URL(path, this.#origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return await sendRequest(async (signal) => {
      const headers = new Headers(options.headers);
      if (this.#token !== undefined) {
        const token = typeof this.#token === "function" ? await this.#token() : this.#token;
        if (!token || /[\r\n]/.test(token)) {
          throw new TypeError("A nonempty bearer token without line breaks is required.");
        }
        headers.set("authorization", `Bearer ${token}`);
      }
      return {
        input: new URL(url),
        init: {
          method,
          headers,
          redirect: "manual",
          ...(options.body === undefined ? {} : { body: options.body }),
          ...(signal === undefined ? {} : { signal }),
        },
      };
    }, {
      fetch: (input, init) => {
        options.onDispatch?.();
        return this.#fetch(input, init);
      },
      metrics: this.#metrics,
      replayable: options.retry ?? (method === "GET" || method === "HEAD"),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Bounded JSON response parsing and retirement use the common response owner. */
  async #json(response: Response): Promise<unknown> {
    return await readResponse(response, async (text) => {
      if (!response.ok) throw new GcsError(response);
      return JSON.parse(await text()) as unknown;
    });
  }

  async head(key: string, options: { readonly signal?: AbortSignal } = {}): Promise<ObjectStatType | null> {
    const response = await this.#send(this.#path(key), "GET", options);
    if (response.status === 404) return await readResponse(response, () => null);
    return metadata(await this.#json(response), key);
  }

  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    options = { ...options };
    const admitted = range(options);
    const version = generation(options.revision);
    if (admitted.empty) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    const response = await this.#send(this.#path(key), "GET", {
      query: { alt: "media", generation: version },
      headers: admitted.header === undefined ? {} : { range: admitted.header },
      ...(admitted.signal === undefined ? {} : { signal: admitted.signal }),
    });
    try {
      if (!response.ok) throw new GcsError(response);
      const reported = response.headers.get("x-goog-generation");
      if (version !== undefined && reported !== null && reported !== version) {
        throw new TypeError("GCS returned a different generation.");
      }
      for (const header of ["content-encoding", "x-goog-stored-content-encoding"]) {
        if ((response.headers.get(header) ?? "identity") !== "identity") {
          throw new TypeError("Encoded GCS objects cannot preserve stored bytes through transparent Fetch decoding.");
        }
      }
      let expected: number | undefined;
      if (admitted.header !== undefined) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        if (response.status !== 206 || match === null) {
          throw new TypeError("GCS did not honor the requested byte range.");
        }
        const start = integer(Number(match[1]), "Range start");
        const end = integer(Number(match[2]), "Range end");
        const total = integer(Number(match[3]), "Range total", GCS_MAX_BYTES);
        if (
          start !== (options.at ?? 0) || end < start || end >= total ||
          (options.length !== undefined && end !== Math.min(total - 1, start + options.length - 1))
        ) {
          throw new TypeError("GCS returned an inconsistent byte range.");
        }
        if ((response.headers.get("content-encoding") ?? "identity") !== "identity") {
          throw new TypeError("Encoded range responses cannot preserve byte offsets through Fetch decoding.");
        }
        expected = end - start + 1;
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) !== expected) {
          throw new TypeError("GCS range length is inconsistent.");
        }
      }
      if (response.body === null) throw new TypeError("GCS media response has no byte stream.");
      let read = 0;
      return response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            read += chunk.byteLength;
            if (expected !== undefined && read > expected) {
              throw new RangeError("GCS range body exceeded its declared extent.");
            }
            controller.enqueue(chunk);
          },
          flush() {
            if (expected !== undefined && read !== expected) throw new TypeError("GCS range body was truncated.");
          },
        }),
      );
    } catch (reason) {
      return await readResponse(response, () => {
        throw reason;
      });
    }
  }

  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    if (options.limit !== undefined && (integer(options.limit, "List limit", 1000) === 0)) {
      throw new RangeError("List limit must be positive.");
    }
    const data = z.object({
      items: z.array(GcsMetadataSchema).optional(),
      prefixes: z.array(z.string()).optional(),
      nextPageToken: z.string().optional(),
    }).passthrough().parse(
      await this.#json(
        await this.#send(this.#path(), "GET", {
          query: {
            prefix: options.prefix,
            delimiter: options.delimiter,
            maxResults: options.limit?.toString(),
            pageToken: options.cursor,
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      ),
    );
    return {
      objects: (data.items ?? []).map((item) => metadata(item)),
      prefixes: data.prefixes ?? [],
      ...(data.nextPageToken === undefined ? {} : { cursor: data.nextPageToken }),
    };
  }

  async delete(
    key: string,
    options: { readonly revision?: ObjectRevisionType; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const version = generation(options.revision);
    const response = await this.#send(this.#path(key), "DELETE", {
      query: { ifGenerationMatch: version },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await readResponse(response, () => {
      if (!response.ok && response.status !== 404) throw new GcsError(response);
    });
  }

  async createUpload(key: string, options: ObjectPutOptionsType = {}): Promise<GcsUploadType> {
    options = { ...options, ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }) };
    const match = condition(options);
    if (options.size !== undefined) integer(options.size, "Upload size", GCS_MAX_BYTES);
    const response = await this.#send(this.#path(undefined, true), "POST", {
      query: { uploadType: "resumable", name: key, ifGenerationMatch: match },
      headers: {
        "content-type": "application/json",
        ...(options.size === undefined ? {} : { "x-upload-content-length": String(options.size) }),
      },
      body: JSON.stringify({
        ...(options.mediaType === undefined ? {} : { contentType: options.mediaType }),
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return await readResponse(response, () => {
      if (!response.ok) throw new GcsError(response);
      const location = response.headers.get("location");
      if (location === null) throw new TypeError("GCS upload creation omitted its session URI.");
      const session = {
        url: new URL(location, this.#origin).href,
        key,
        ...(options.size === undefined ? {} : { size: options.size }),
      };
      this.#session(session);
      return Object.freeze(session);
    });
  }

  /** A 308 acknowledgement names retained bytes; sent bytes are never assumed committed. */
  async #uploadStatus(response: Response, upload: GcsUploadType, maximum?: number): Promise<GcsUploadStatusType> {
    return await readResponse(response, async (text) => {
      if (response.status === 308) {
        const value = response.headers.get("range");
        const match = value === null ? undefined : /^bytes=0-(\d+)$/.exec(value);
        if (value !== null && !match) throw new TypeError("GCS upload acknowledgement has an invalid retained range.");
        const offset = match === undefined ? 0 : integer(Number(match![1]) + 1, "Acknowledged offset", GCS_MAX_BYTES);
        if ((maximum !== undefined && offset > maximum) || (upload.size !== undefined && offset > upload.size)) {
          throw new TypeError("GCS acknowledged bytes beyond the submitted extent.");
        }
        return { complete: false, offset };
      }
      if (!response.ok) throw new GcsError(response);
      try {
        const receipt = metadata(JSON.parse(await text()) as unknown, upload.key);
        if (upload.size !== undefined && receipt.size !== upload.size) {
          throw new TypeError("GCS completed with an unexpected object size.");
        }
        if (maximum !== undefined && receipt.size !== maximum) {
          throw new TypeError("GCS publication size does not match the submitted final extent.");
        }
        return { complete: true, offset: receipt.size, receipt };
      } catch (cause) {
        throw new GcsPublicationError(upload.key, cause);
      }
    });
  }

  async queryUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<GcsUploadStatusType> {
    upload = { ...upload };
    const url = this.#session(upload);
    return await this.#uploadStatus(
      await this.#send(url, "PUT", {
        headers: { "content-range": `bytes */${upload.size ?? "*"}` },
        body: new Uint8Array(),
        retry: true,
        ...(signal === undefined ? {} : { signal }),
      }),
      upload,
    );
  }

  async writeUpload(
    upload: GcsUploadType,
    body: Uint8Array,
    options: GcsUploadWriteOptionsType,
  ): Promise<GcsUploadStatusType> {
    upload = { ...upload };
    const url = this.#session(upload);
    const offset = integer(options.offset, "Upload offset", GCS_MAX_BYTES);
    const bytes = toRequestBytes(body);
    const end = integer(offset + bytes.byteLength, "Upload extent", GCS_MAX_BYTES);
    const total = options.total ?? upload.size;
    if (total !== undefined) integer(total, "Upload total", GCS_MAX_BYTES);
    if (upload.size !== undefined && total !== upload.size) {
      throw new TypeError("Upload total changed from session creation.");
    }
    if (total !== undefined && end > total) throw new RangeError("Upload extent exceeds the declared total.");
    if (
      options.final === true
        ? total === undefined || end !== total
        : bytes.byteLength === 0 || bytes.byteLength % GCS_CHUNK_BYTES !== 0
    ) {
      throw new RangeError("A final upload must end at its total; nonfinal chunks must be nonempty 256 KiB multiples.");
    }
    const header = bytes.byteLength === 0
      ? `bytes */${total}`
      : `bytes ${offset}-${end - 1}/${options.final === true ? total : "*"}`;
    let dispatched = false;
    let response: Response;
    try {
      response = await this.#send(url, "PUT", {
        headers: { "content-range": header, "content-type": "application/octet-stream" },
        body: bytes,
        onDispatch: () => {
          dispatched = true;
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      if (dispatched) throw new GcsPublicationError(upload.key, cause);
      throw cause;
    }
    return await this.#uploadStatus(response, upload, end);
  }

  async cancelUpload(upload: GcsUploadType, signal?: AbortSignal): Promise<void> {
    const response = await this.#send(this.#session(upload), "DELETE", { ...(signal === undefined ? {} : { signal }) });
    await readResponse(response, () => {
      if (!response.ok && ![404, 410, 499].includes(response.status)) throw new GcsError(response);
    });
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectReceiptType> {
    options = {
      ...options,
      ...(options.revision === undefined ? {} : { revision: { ...options.revision } }),
      ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
    };
    condition(options);
    options.signal?.throwIfAborted();
    const bytes = isBytes(body) ? toRequestBytes(body) : undefined;
    if (bytes !== undefined && options.size !== undefined && bytes.byteLength !== options.size) {
      throw new RangeError("Upload size does not match the supplied bytes.");
    }
    if (bytes !== undefined) {
      const upload = await this.createUpload(key, { ...options, size: bytes.byteLength });
      const result = await this.writeUpload(upload, bytes, {
        offset: 0,
        total: bytes.byteLength,
        final: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!result.complete) {
        throw new TypeError("GCS did not acknowledge a complete upload; query the session before retrying.");
      }
      return result.receipt;
    }
    if (!isStream(body)) throw new TypeError("A GCS upload body must be bytes or a native readable stream.");
    if (options.size !== undefined) integer(options.size, "Upload size", GCS_MAX_BYTES);
    const chunks = open(body, this.#chunkSize, options.signal);
    let primary: readonly unknown[] = [];
    try {
      const upload = await this.createUpload(key, options);
      let next = await chunks.next();
      let offset = 0;
      while (true) {
        const current = next.done ? new Uint8Array() : next.value;
        const following = next.done ? next : await chunks.next();
        const final = following.done === true;
        const total = final ? offset + current.byteLength : options.size;
        const result = await this.writeUpload(upload, current, {
          offset,
          final,
          ...(total === undefined ? {} : { total }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (result.complete) {
          if (!final) throw new TypeError("GCS completed before the source ended.");
          return result.receipt;
        }
        if (result.offset !== offset + current.byteLength) {
          throw new TypeError("GCS retained a partial extent; reconcile the session before retrying.");
        }
        if (final) throw new TypeError("GCS did not acknowledge a complete upload.");
        offset = result.offset;
        next = following;
      }
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => chunks.return()], primary);
    }
  }

  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectReceiptType> {
    options = { ...options };
    const match = condition(options);
    const sourceMatch = generation(options.sourceRevision);
    if (
      options.sourceIfMatch !== undefined || options.sourceIfNoneMatch !== undefined ||
      options.sourceIfModifiedSince !== undefined || options.sourceIfUnmodifiedSince !== undefined
    ) throw new TypeError("GCS rewrite requires a source generation condition.");
    let token: string | undefined;
    for (let request = 0; request < this.#maxRewrite; request++) {
      let dispatched = false;
      let response: Response;
      try {
        response = await this.#send(
          `${this.#path(source)}/rewriteTo/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(destination)}`,
          "POST",
          {
            query: { ifGenerationMatch: match, ifSourceGenerationMatch: sourceMatch, rewriteToken: token },
            onDispatch: () => {
              dispatched = true;
            },
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      } catch (cause) {
        if (dispatched) throw new GcsPublicationError(destination, cause);
        throw cause;
      }
      const data = await readResponse(response, async (text) => {
        if (!response.ok) throw new GcsError(response);
        try {
          return z.object({
            done: z.boolean(),
            rewriteToken: z.string().optional(),
            resource: GcsMetadataSchema.optional(),
          }).passthrough().parse(JSON.parse(await text()) as unknown);
        } catch (cause) {
          throw new GcsPublicationError(destination, cause);
        }
      });
      if (data.done) {
        if (data.resource === undefined) {
          throw new GcsPublicationError(destination, new TypeError("GCS rewrite omitted its final object receipt."));
        }
        try {
          return metadata(data.resource, destination);
        } catch (cause) {
          throw new GcsPublicationError(destination, cause);
        }
      }
      if (!data.rewriteToken) throw new TypeError("GCS rewrite did not provide a continuation token.");
      token = data.rewriteToken;
    }
    throw new RangeError("GCS rewrite exceeded the configured request limit; publication is not confirmed.");
  }
}

/** Creates an import-safe native JSON API client; credentials remain application-owned. */
export function createGcsClient(options: GcsClientOptionsType): GcsClientType {
  return new GcsClient(options);
}

/**
 * Borrows a known-size GCS session for the checkpoint transfer coordinator.
 *
 * Session status supplies acknowledged offsets; final publication requires an
 * actual GCS receipt. The caller owns exclusive writing, source identity and
 * protected checkpoint persistence. No network request occurs during wrapping.
 */
export function createGcsUploadDestination(client: GcsClientType, upload: GcsUploadType): UploadDestinationType {
  upload = Object.freeze({ ...upload });
  if (upload.size === undefined) throw new TypeError("Checkpoint transfer requires a known GCS session size.");
  const size = integer(upload.size, "Upload total", GCS_MAX_BYTES);
  let completed: UploadStatusType | undefined;
  const status = (result: GcsUploadStatusType): UploadStatusType => {
    const value = { offset: result.offset, size, complete: result.complete };
    if (result.complete) completed = value;
    return value;
  };
  return {
    protocol: "gcs-resumable",
    url: upload.url,
    async status(options = {}) {
      options.signal?.throwIfAborted();
      return completed ?? status(await client.queryUpload(upload, options.signal));
    },
    async write(offset, bytes, options = {}) {
      if (completed !== undefined) throw new TypeError("The GCS upload has already completed.");
      const result = await client.writeUpload(upload, bytes, {
        offset,
        total: size,
        final: offset + bytes.byteLength === size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      status(result);
      return result.offset;
    },
    async finish(options = {}) {
      options.signal?.throwIfAborted();
      if (completed !== undefined) return completed;
      const remote = await client.queryUpload(upload, options.signal);
      if (remote.complete || remote.offset !== size) return status(remote);
      return status(
        await client.writeUpload(upload, new Uint8Array(), {
          offset: size,
          total: size,
          final: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
    },
    async terminate(options = {}) {
      await client.cancelUpload(upload, options.signal);
    },
  };
}
