/** Native CouchDB attachments. Document revisions are not attachment digests or filesystem paths. @module */
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Implementation ceiling for materialized payloads; server/document quotas remain separate. */
export const COUCHDB_BUFFER_BYTES = 64 * 1024 * 1024;
/** Cancellation is borrowed, and must remain live while a returned stream is consumed. */
export interface CouchdbOperationType {
  readonly signal?: AbortSignal;
}
/** A native document revision selects retained history, which compaction can remove. */
export interface CouchdbReadType extends CouchdbOperationType {
  readonly revision?: string;
}
/** Single HTTP range; length zero returns no existence or revision evidence. */
export interface CouchdbRangeType extends CouchdbReadType {
  readonly at?: number;
  readonly length?: number;
}
/** Creation applies only when the whole document does not exist; revision changes conflict across sibling attachments. */
export type CouchdbPutType =
  & CouchdbOperationType
  & { readonly mediaType?: string }
  & ({ readonly createDocument: true; readonly revision?: never } | {
    readonly revision: string;
    readonly createDocument?: never;
  });
/** Removing an attachment retains the document and may retain historical bytes until native compaction. */
export interface CouchdbRemoveType extends CouchdbOperationType {
  readonly revision: string;
}
/** Native stub metadata. Digest is server-supplied md5-* evidence, not verification or document identity. */
export interface CouchdbAttachmentType {
  readonly name: string;
  readonly mediaType: string;
  readonly length: number;
  readonly digest: string;
  readonly revisionPosition: number;
  readonly encoding?: string;
  readonly encodedLength?: number;
}
/** Only the native identity and attachment stubs are returned; application document fields remain application-owned. */
export interface CouchdbDocumentType {
  readonly id: string;
  readonly revision: string;
  readonly attachments: readonly CouchdbAttachmentType[];
}
/** HEAD reports wire representation size; encoding means this can differ from the logical stub length. */
export interface CouchdbStatType {
  readonly size: number;
  readonly etag: string;
  readonly mediaType: string;
  readonly encoding?: string;
  readonly acceptsRanges: boolean;
}
/** Bytes are server-trusted. Caller must consume or cancel this stream, including when preview stops early. */
export interface CouchdbDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly etag?: string;
}
/** Native acknowledgement; accepted means HTTP 202 and does not establish disk storage. Neither state proves cross-cluster replication. */
export interface CouchdbReceiptType {
  readonly id: string;
  readonly revision: string;
  readonly state: "stored" | "accepted";
}
/** Exact database ownership; no endpoint discovery, cookies, ambient credentials, admin operations or general JSON mutation. */
export interface CouchdbClientOptionsType {
  readonly endpoint: string | URL;
  readonly database: string;
  readonly credentials?: (url: URL, signal?: AbortSignal) => HeadersInit | undefined | Promise<HeadersInit | undefined>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 8 MiB; max 64 MiB. Applies to copied uploads and materialized reads, not streamed payload size. */
  readonly maxBytes?: number;
  /** Defaults to 1000, capped at 10000; bounded control JSON is independently limited to 8 MiB. */
  readonly maxAttachments?: number;
}
/** Status-only error messages never echo server-controlled body text or credential-bearing URLs. */
export class CouchdbError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`CouchDB request failed with HTTP ${status}.`);
    this.name = "CouchdbError";
    this.status = status;
  }
}
/** A dispatched mutation lacks a complete receipt. Reconcile the document and attachment before choosing a new operation. */
export class CouchdbPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "put" | "remove";
  readonly document: string;
  readonly attachment: string;
  readonly revision: string | undefined;
  constructor(
    operation: "put" | "remove",
    document: string,
    attachment: string,
    revision: string | undefined,
    cause: unknown,
  ) {
    super("CouchDB attachment mutation has no complete acknowledgement.", { cause });
    this.name = "CouchdbPublicationError";
    this.operation = operation;
    this.document = document;
    this.attachment = attachment;
    this.revision = revision;
  }
}
/** Bounded UTF-8 input is never silently repaired by URL or FormData conversion. */
function text(value: unknown, maximum = 4096): string {
  if (
    typeof value !== "string" || !value.length || value.length > maximum ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new TypeError("Invalid CouchDB text.");
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw new TypeError("Invalid CouchDB text encoding.");
  }
  return value;
}
/** Ordinary document IDs exclude CouchDB's separately routed design/local namespaces and URL dot normalization aliases. */
function documentId(value: unknown): string {
  const result = text(value);
  if (result.startsWith("_") || result === "." || result === "..") {
    throw new TypeError("Unsupported CouchDB document ID.");
  }
  return result;
}
function attachmentId(value: unknown): string {
  const result = text(value);
  if (result.startsWith("_") || result === "." || result === "..") {
    throw new TypeError("Unsupported CouchDB attachment name.");
  }
  return result;
}
/** Revisions remain opaque bounded protocol tokens, never inferred from attachment ETags. */
function revision(value: unknown): string {
  const result = text(value, 1024);
  if (!/^[1-9][0-9]*-[A-Za-z0-9]+$/u.test(result)) throw new TypeError("Invalid CouchDB revision token.");
  return result;
}
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError("CouchDB integer exceeds its finite bound.");
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid CouchDB object.");
  }
  return value as Record<string, unknown>;
}
/** Selected native sizes require canonical safe integers before any binary64 conversion. Other application numbers are inert. */
class Numeric {
  readonly raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}
function size(value: unknown): number {
  if (!(value instanceof Numeric) || !/^(0|[1-9][0-9]{0,15})$/u.test(value.raw)) {
    throw new TypeError("Unsupported CouchDB numeric field.");
  }
  return integer(Number(value.raw));
}
function length(response: Response): number {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]{0,15})$/u.test(raw)) {
    throw new TypeError("CouchDB byte reads require a safe Content-Length.");
  }
  return integer(Number(raw));
}
function etag(response: Response): string {
  const value = response.headers.get("etag");
  if (value === null || !/^"[A-Za-z0-9+/]{22}=="$/u.test(value)) {
    throw new TypeError("CouchDB attachment requires a native MD5 ETag.");
  }
  return value;
}

/** Bounded lossless control parsing rejects duplicate/prototype keys before interpreting selected native fields. */
function json(text: string): unknown {
  if (text.length > 8 * 1024 * 1024) throw new RangeError("CouchDB JSON exceeds its lexical budget.");
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget CouchDB JSON.");
  };
  const whitespace = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const count = (): void => {
    if (++tokens > 100000) fail();
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (at - start > 524288) fail();
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        let value: unknown;
        // Native SyntaxError context may contain the signed URL inside this string.
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          return fail();
        }
        if (typeof value !== "string") fail();
        return value as string;
      }
    }
    return fail();
  }
  function value(depth: number): unknown {
    count();
    if (depth > 32) fail();
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      whitespace();
      const object: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return object;
      }
      while (true) {
        count();
        whitespace();
        if (text[at] !== '"') fail();
        const key = string();
        if (key === "__proto__" || key === "constructor" || key === "prototype" || Object.hasOwn(object, key)) fail();
        whitespace();
        if (text[at++] !== ":") fail();
        object[key] = value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === "}") return object;
        if (end !== ",") fail();
      }
    }
    if (text[at] === "[") {
      at++;
      whitespace();
      const array: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        const end = text[at++];
        if (end === "]") return array;
        if (end !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start > 128) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (raw.length > 128) fail();
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/u.test(raw)) return fail();
    return new Numeric(raw);
  }
  const result = value(0);
  whitespace();
  if (at !== text.length) fail();
  return result;
}

/** A single byte reader owns actual EOF validation and cancellation, including failed native reads. */
function extent(body: ReadableStream<Uint8Array>, expected: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(body);
  let seen = 0, empty = 0, terminal = false;
  return withAbortSignal(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await reader.read();
          } catch (reason) {
            terminal = true;
            throw reason;
          }
          if (next.done) {
            terminal = true;
            if (seen !== expected) throw new TypeError("CouchDB body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("CouchDB body requires bytes.");
          const bytes = toView(next.value);
          if (bytes.length > expected - seen) throw new TypeError("CouchDB body exceeds its declared extent.");
          seen += bytes.length;
          if (!bytes.length) { if (++empty > 16) throw new TypeError("CouchDB body makes no progress."); }
          else empty = 0;
          controller.enqueue(bytes);
        } catch (reason) {
          try {
            await close([...(terminal ? [] : [() => reader.cancel(reason)]), () => reader.releaseLock()], [reason]);
          } catch (failure) {
            controller.error(failure);
          }
          terminal = true;
        }
      },
      async cancel(reason) {
        if (terminal) return;
        terminal = true;
        await close([() => reader.cancel(reason), () => reader.releaseLock()]);
      },
    }, { highWaterMark: 0 }),
    signal,
    "CouchDB",
    "download",
  );
}

/** Independent operations borrow Fetch and credentials. No background work or client-owned connection pool is acquired. */
export class CouchdbClient {
  readonly #endpoint: URL;
  readonly #database: string;
  readonly #fetch: FetchType;
  readonly #credentials: CouchdbClientOptionsType["credentials"];
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  readonly #attachments: number;
  constructor(options: CouchdbClientOptionsType) {
    const raw = String(options.endpoint);
    if (
      raw.length > 8192 || /[^\u0021-\u007e]/u.test(raw) || /\\|%(?:2e|2f|5c)/iu.test(raw) ||
      raw.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new TypeError("Invalid CouchDB endpoint.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new TypeError("Invalid CouchDB endpoint.");
    }
    if (
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/") ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && options.allowHttp === true)
    ) {
      throw new TypeError(
        "CouchDB endpoint requires an explicit trailing-slash API base without credentials or query.",
      );
    }
    const database = text(options.database, 238);
    if (!/^[a-z][a-z0-9_$()+-]*$/u.test(database)) throw new TypeError("Unsupported CouchDB database name.");
    this.#endpoint = endpoint;
    this.#database = database;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
    this.#max = integer(options.maxBytes ?? 8 * 1024 * 1024, COUCHDB_BUFFER_BYTES);
    this.#attachments = integer(options.maxAttachments ?? 1000, 10000);
  }
  #url(document: string, attachment?: string, rev?: string): URL {
    const url = new URL(
      `${encodeURIComponent(this.#database)}/${encodeURIComponent(document)}${
        attachment === undefined ? "" : `/${encodeURIComponent(attachment)}`
      }`,
      this.#endpoint,
    );
    if (rev !== undefined) url.searchParams.set("rev", rev);
    return url;
  }
  /** Credential capabilities see only a detached URL and cannot alter the admitted route, condition or byte authority. */
  async #send(
    url: URL,
    method: string,
    signal?: AbortSignal,
    extra = new Headers(),
    bytes?: Uint8Array,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      attemptSignal?.throwIfAborted();
      const supplied = new Headers(await this.#credentials?.(new URL(url), attemptSignal));
      attemptSignal?.throwIfAborted();
      for (const key of supplied.keys()) {
        if (key !== "authorization") throw new TypeError("CouchDB credentials may supply only Authorization.");
      }
      for (const [key, value] of extra) supplied.set(key, value);
      supplied.set("accept-encoding", "identity");
      supplied.set("accept", "application/json");
      return {
        input: url,
        init: {
          method,
          headers: supplied,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(bytes === undefined ? {} : { body: toRequestBytes(bytes) }),
        },
      };
    }, {
      fetch: async (input, init) => {
        dispatch?.();
        return await this.#fetch(input, init);
      },
      replayable: false,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  async #control(response: Response): Promise<unknown> {
    return await readResponse(response, async (body) => {
      if (response.status !== 200) throw new CouchdbError(response.status);
      return json(await body());
    });
  }
  /** Inspect one document without downloading inline attachment data. Unknown application fields do not become library records. */
  async document(id: string, options: CouchdbReadType = {}): Promise<CouchdbDocumentType> {
    id = documentId(id);
    const signal = options.signal, rawRevision = options.revision;
    const rev = rawRevision === undefined ? undefined : revision(rawRevision);
    const url = this.#url(id, undefined, rev);
    url.searchParams.set("attachments", "false");
    url.searchParams.set("att_encoding_info", "true");
    const data = record(await this.#control(await this.#send(url, "GET", signal)));
    const actual = revision(data._rev);
    if (data._id !== id || (rev !== undefined && actual !== rev) || data._deleted !== undefined) {
      throw new TypeError("CouchDB document response differs from the requested document/revision.");
    }
    const attachments: CouchdbAttachmentType[] = [];
    if (data._attachments !== undefined) {
      const stubs = record(data._attachments), names = Object.keys(stubs);
      if (names.length > this.#attachments) throw new RangeError("CouchDB attachment count exceeds its policy.");
      for (const name of names) {
        const stub = record(stubs[name]);
        if (stub.stub !== true || stub.data !== undefined || stub.follows !== undefined) {
          throw new TypeError("CouchDB metadata requires attachment stubs.");
        }
        const digest = text(stub.digest, 128);
        if (!/^md5-[A-Za-z0-9+/]{22}==$/u.test(digest)) throw new TypeError("Unsupported CouchDB attachment digest.");
        const encoding = stub.encoding === undefined ? undefined : text(stub.encoding, 128);
        const encoded = stub.encoded_length === undefined ? undefined : size(stub.encoded_length);
        if ((encoding === undefined) !== (encoded === undefined)) {
          throw new TypeError("Incomplete CouchDB encoded metadata.");
        }
        const position = size(stub.revpos);
        if (position === 0) throw new TypeError("Invalid CouchDB attachment revision position.");
        attachments.push(Object.freeze({
          name: attachmentId(name),
          mediaType: text(stub.content_type, 1024),
          length: size(stub.length),
          digest,
          revisionPosition: position,
          ...(encoding === undefined ? {} : { encoding }),
          ...(encoded === undefined ? {} : { encodedLength: encoded }),
        }));
      }
    }
    signal?.throwIfAborted();
    return Object.freeze({ id, revision: actual, attachments: Object.freeze(attachments) });
  }
  /** Inspect the selected wire representation. A gzip HEAD length is not the uncompressed attachment length. */
  async stat(id: string, name: string, options: CouchdbReadType = {}): Promise<CouchdbStatType> {
    id = documentId(id);
    name = attachmentId(name);
    const signal = options.signal, rawRevision = options.revision;
    const rev = rawRevision === undefined ? undefined : revision(rawRevision);
    const response = await this.#send(this.#url(id, name, rev), "HEAD", signal);
    return await readResponse(response, () => {
      if (response.status !== 200) throw new CouchdbError(response.status);
      const encoding = response.headers.get("content-encoding");
      signal?.throwIfAborted();
      return Object.freeze({
        size: length(response),
        etag: etag(response),
        mediaType: text(response.headers.get("content-type"), 1024),
        acceptsRanges: response.headers.get("accept-ranges") === "bytes",
        ...(encoding === null ? {} : { encoding: text(encoding, 128) }),
      });
    });
  }
  /** Open identity-encoded bytes; the caller owns stream consumption/cancellation. No full-object MD5 verification is performed. */
  async get(id: string, name: string, options: CouchdbRangeType = {}): Promise<CouchdbDownloadType> {
    id = documentId(id);
    name = attachmentId(name);
    const rawRevision = options.revision, signal = options.signal;
    signal?.throwIfAborted();
    const at = options.at, count = options.length;
    const selected = range({
      ...(at === undefined ? {} : { at }),
      ...(count === undefined ? {} : { length: count }),
      ...(signal === undefined ? {} : { signal }),
    });
    const rev = rawRevision === undefined ? undefined : revision(rawRevision);
    if (selected.empty) {
      return {
        bytes: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        size: 0,
      };
    }
    const headers = new Headers();
    if (selected.header !== undefined) headers.set("range", selected.header);
    const response = await this.#send(this.#url(id, name, rev), "GET", selected.signal, headers);
    if (response.status !== 200 && response.status !== 206) {
      return await readResponse(response, () => {
        throw new CouchdbError(response.status);
      });
    }
    await assertRangeResponse(response, selected);
    try {
      const count = length(response), digest = etag(response), body = response.body;
      if (body === null) throw new TypeError("CouchDB download has no body.");
      return Object.freeze({ bytes: extent(body, count, selected.signal), size: count, etag: digest });
    } catch (reason) {
      await readResponse(response, () => {
        throw reason;
      });
      throw reason;
    }
  }
  /** Materialize within maxBytes. Stream failures retain their original identity and do not trigger duplicate cancellation errors. */
  async read(id: string, name: string, options: CouchdbRangeType = {}): Promise<Uint8Array> {
    const download = await this.get(id, name, options);
    return await collectBytes(download.bytes, this.#max, undefined, "read", "CouchDB attachment");
  }
  /** One acknowledged mutation. Failed 4xx are native refusals, while ambiguous dispatched responses retain reconciliation context. */
  async #mutate(
    id: string,
    name: string,
    rev: string | undefined,
    operation: "put" | "remove",
    signal?: AbortSignal,
    bytes?: Uint8Array,
    mediaType?: string,
  ): Promise<CouchdbReceiptType> {
    let dispatched = false, acknowledged = false, refused = false;
    try {
      const response = await this.#send(
        this.#url(id, name, rev),
        operation === "put" ? "PUT" : "DELETE",
        signal,
        new Headers(mediaType === undefined ? {} : { "content-type": mediaType }),
        bytes,
        () => {
          dispatched = true;
        },
      );
      return await readResponse(response, async (body) => {
        const status = response.status;
        if (status !== (operation === "put" ? 201 : 200) && status !== 202) {
          // Own native refusal evidence before cleanup can aggregate a separate body cancellation failure.
          refused = status >= 400 && status < 500 && status !== 408;
          throw new CouchdbError(status);
        }
        const data = record(json(await body())), next = revision(data.rev);
        if (data.ok !== true || data.id !== id || next === rev) {
          throw new TypeError("CouchDB receipt does not describe the intended mutation.");
        }
        acknowledged = true;
        signal?.throwIfAborted();
        return Object.freeze({ id, revision: next, state: status === 202 ? "accepted" : "stored" });
      });
    } catch (cause) {
      if (!dispatched || acknowledged || refused) throw cause;
      throw new CouchdbPublicationError(operation, id, name, rev, cause);
    }
  }
  /** Copy bounded caller bytes before credentials. No implicit revision refresh, append, stream upload, resumable session or retry. */
  async put(id: string, name: string, bytes: Uint8Array, options: CouchdbPutType): Promise<CouchdbReceiptType> {
    id = documentId(id);
    name = attachmentId(name);
    const signal = options.signal, rawRevision = options.revision, create = options.createDocument;
    signal?.throwIfAborted();
    if ((create === true) === (rawRevision !== undefined) || (create !== undefined && create !== true)) {
      throw new TypeError("CouchDB put needs exactly one explicit document creation/revision condition.");
    }
    const rev = rawRevision === undefined ? undefined : revision(rawRevision);
    const mediaType = text(options.mediaType ?? "application/octet-stream", 1024);
    if (/[^\u0020-\u007e]/u.test(mediaType)) throw new TypeError("Invalid CouchDB media type.");
    if (!isBytes(bytes)) throw new TypeError("CouchDB uploads require bytes.");
    const view = toView(bytes);
    integer(view.length, this.#max);
    const owned = new Uint8Array(view);
    return await this.#mutate(id, name, rev, "put", signal, owned, mediaType);
  }
  /** Delete only this attachment under the supplied whole-document revision. History may remain; no repository maintenance is performed. */
  async remove(id: string, name: string, options: CouchdbRemoveType): Promise<CouchdbReceiptType> {
    id = documentId(id);
    name = attachmentId(name);
    const rev = revision(options.revision), signal = options.signal;
    return await this.#mutate(id, name, rev, "remove", signal);
  }
}
/** Construct without network, credential acquisition, global configuration or resource discovery. */
export function createCouchdbClient(options: CouchdbClientOptionsType): CouchdbClient {
  return new CouchdbClient(options);
}
