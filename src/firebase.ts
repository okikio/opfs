/** Firebase Storage's Rules-authenticated object and resumable upload protocol. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { readResponse } from "./response.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { assertRangeResponse, range } from "./range.ts";
import { openBytes, withAbortSignal } from "./stream.ts";

/** Implementation ceiling for each copied upload or materialized read; streams have no whole-file allocation. */
export const FIREBASE_BUFFER_BYTES = 64 * 1024 * 1024;
/** Nonfinal Firebase resumable chunks must be multiples of 256 KiB. */
export const FIREBASE_CHUNK_BYTES = 256 * 1024;
/** Firebase credentials are not Google Cloud IAM credentials. Omit tokens for anonymous Rules requests. */
export interface FirebaseCredentialsType {
  readonly idToken?: string;
  readonly appCheckToken?: string;
}
/** The caller owns Firebase authentication, App Check, Fetch, cancellation and account continuity. */
export interface FirebaseOptionsType {
  readonly bucket: string;
  readonly endpoint?: string | URL;
  readonly credentials?: (
    url: URL,
    signal?: AbortSignal,
  ) => FirebaseCredentialsType | PromiseLike<FirebaseCredentialsType>;
  readonly appId?: string;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  /** Explicit local emulator HTTP opt-in. No environment discovery is performed. */
  readonly allowHttp?: boolean;
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
}
/** Native object metadata. Generation values remain canonical decimal strings, never ETags or rounded numbers. */
export interface FirebaseMetadataType {
  readonly bucket: string;
  readonly name: string;
  readonly size: number;
  readonly generation: string;
  readonly metageneration: string;
  readonly contentType?: string;
  readonly md5Hash?: string;
  readonly updated?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}
/** Writable metadata is deliberately separate from server-owned identity and generation. */
export interface FirebaseWriteMetadataType {
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly contentLanguage?: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
}
/** Native list references do not imply that every object is returned or that pages form a snapshot. */
export interface FirebaseListType {
  readonly items: readonly string[];
  readonly prefixes: readonly string[];
  readonly nextPageToken?: string;
}
/** Finite byte selection. Zero length is local and does not prove object existence. */
export interface FirebaseReadOptionsType {
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Caller must consume or cancel bytes; metadata and media requests are not an atomic version snapshot. */
export interface FirebaseDownloadType {
  readonly metadata: FirebaseMetadataType;
  readonly bytes: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly evidence: "server-trusted";
}
/** Caller-owned session authority, not an immutable file identity or a durable publication receipt. */
export interface FirebaseSessionType {
  readonly url: string;
  readonly bucket: string;
  readonly name: string;
  readonly size: number;
}
/** Query-final proves native session finality without supplying final object metadata. */
export interface FirebaseStatusType {
  readonly state: "active" | "final";
  readonly offset: number;
  readonly size: number;
  readonly evidence: "session-status";
}
/** Only a final upload response can carry this matched object metadata receipt. */
export type FirebaseUploadType = FirebaseStatusType | {
  readonly state: "published";
  readonly metadata: FirebaseMetadataType;
  readonly evidence: "metadata-receipt";
};
/** Sanitized HTTP failure. Arbitrary injected errors may still contain caller-owned secrets. */
export class FirebaseError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Firebase Storage request failed: HTTP ${status}.`);
    this.name = "FirebaseError";
    this.status = status;
  }
}
/** Dispatch did not deliver a validated receipt; reconcile explicitly rather than blindly retrying. */
export class FirebasePublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Firebase Storage mutation outcome is unknown; reconcile before retrying.", { cause });
    this.name = "FirebasePublicationError";
  }
}
const MetadataSchema = z.object({
  bucket: z.string(),
  name: z.string(),
  size: z.string().regex(/^(0|[1-9][0-9]*)$/),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/).max(128),
  metageneration: z.string().regex(/^(0|[1-9][0-9]*)$/).max(128),
  contentType: z.string().max(1024).optional(),
  md5Hash: z.string().max(128).optional(),
  updated: z.string().max(128).optional(),
  metadata: z.record(z.string(), z.string().max(8192)).optional(),
});
const WriteMetadataSchema = z.object({
  contentType: z.string().max(1024).optional(),
  cacheControl: z.string().max(1024).optional(),
  contentDisposition: z.string().max(1024).optional(),
  contentEncoding: z.string().max(1024).optional(),
  contentLanguage: z.string().max(1024).optional(),
  customMetadata: z.record(z.string().max(1024), z.string().max(8192)).optional(),
}).strict();
function integer(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid Firebase ${label}.`);
  return value;
}
/** Preserve native object names literally, including slash/dot/%; only the complete name is URL encoded. */
function name(value: string, empty = false): string {
  if (
    typeof value !== "string" || value.length > 1024 || !value.isWellFormed() || value.includes("\0") ||
    value === "." || value === ".." || !empty && !value
  ) {
    throw new TypeError("Invalid Firebase object name.");
  }
  if (new TextEncoder().encode(value).length > 1024) {
    throw new RangeError("Firebase object name exceeds 1024 UTF-8 bytes.");
  }
  return value;
}
function parsedUrl(value: string | URL): URL {
  try {
    return new URL(value);
  } catch {
    throw new TypeError("Invalid Firebase URL.");
  }
}
function token(value: string): string {
  // deno-lint-ignore no-control-regex -- credentials cannot contain HTTP control characters.
  if (typeof value !== "string" || !value || value.length > 32768 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new TypeError("Invalid Firebase credential.");
  }
  return value;
}
/** Copy all caller metadata before any awaited credential acquisition. JSON output has a finite control budget. */
function writable(value: FirebaseWriteMetadataType): Record<string, unknown> {
  // Reject oversized caller maps before Zod copies them. The JSON envelope's
  // separate 64 KiB bound still applies after this allocation admission.
  let entries = 0, characters = 0;
  const custom = value.customMetadata, copied: Record<string, string> = {};
  if (custom !== undefined) {
    for (const key in custom) {
      if (!Object.hasOwn(custom, key)) continue;
      const entry = custom[key];
      if (
        ++entries > 128 || key.length > 1024 || typeof entry !== "string" || entry.length > 8192 ||
        (characters += key.length + entry.length) > 65536 || ["__proto__", "constructor", "prototype"].includes(key)
      ) {
        throw new RangeError("Firebase custom metadata exceeds its allocation budget.");
      }
      copied[key] = entry;
    }
  }
  const data = WriteMetadataSchema.parse({ ...value, ...(custom === undefined ? {} : { customMetadata: copied }) });
  for (const entry of Object.values(data)) {
    if (typeof entry === "string" && /[\r\n\0]/.test(entry)) {
      throw new TypeError("Firebase metadata cannot inject MIME headers.");
    }
  }
  const result = { ...data, ...(data.customMetadata === undefined ? {} : { metadata: { ...data.customMetadata } }) };
  delete result.customMetadata;
  if (JSON.stringify(result).length > 65536) throw new RangeError("Firebase writable metadata exceeds 64 KiB.");
  return result;
}
/** Native object metadata must agree with the selected authority before being exposed as a receipt. */
function metadata(value: unknown, bucket: string, selected?: string, size?: number): FirebaseMetadataType {
  const data = MetadataSchema.parse(value);
  if (data.bucket !== bucket || selected !== undefined && data.name !== selected) {
    throw new TypeError("Firebase metadata identity differs.");
  }
  name(data.name);
  const count = integer(Number(data.size), Number.MAX_SAFE_INTEGER, "object size");
  if (size !== undefined && count !== size) throw new TypeError("Firebase upload receipt size differs.");
  return {
    bucket,
    name: data.name,
    size: count,
    generation: data.generation,
    metageneration: data.metageneration,
    ...(data.contentType === undefined ? {} : { contentType: data.contentType }),
    ...(data.md5Hash === undefined ? {} : { md5Hash: data.md5Hash }),
    ...(data.updated === undefined ? {} : { updated: data.updated }),
    ...(data.metadata === undefined ? {} : { customMetadata: { ...data.metadata } }),
  };
}
/** Refuse duplicate authority fields and excessive nesting before ordinary JSON parsing. */
function json(text: string): unknown {
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget Firebase JSON.");
  };
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (at - start > 65536) fail();
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(depth: number): void {
    if (++tokens > 100000 || depth > 32) fail();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", end = object ? "}" : "]", keys = new Set<string>();
      space();
      if (text[at] === end) {
        at++;
        return;
      }
      while (true) {
        if (object) {
          space();
          if (text[at] !== '"') fail();
          const key = string();
          if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail();
          keys.add(key);
          space();
          if (text[at++] !== ":") fail();
        }
        value(depth + 1);
        space();
        const char = text[at++];
        if (char === end) return;
        if (char !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start > 128) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (
      !["true", "false", "null"].includes(raw) &&
      (!/^-?(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    ) fail();
  }
  value(0);
  space();
  if (at !== text.length) fail();
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}
/** Complete selected extents require real EOF; cancellation retains primary and independent cleanup failures. */
function extent(body: ReadableStream<Uint8Array>, length: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(body);
  let left = length, ended = false, empty = 0;
  return withAbortSignal(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await reader.read();
          } catch (reason) {
            ended = true;
            throw reason;
          }
          if (ended) return;
          if (next.done) {
            ended = true;
            reader.releaseLock();
            if (left) throw new TypeError("Firebase content is truncated.");
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Firebase content requires bytes.");
          const bytes = toView(next.value);
          if (bytes.length > left) throw new TypeError("Firebase content exceeds its selected extent.");
          if (!bytes.length) { if (++empty > 16) throw new TypeError("Firebase content makes no progress."); }
          else empty = 0;
          left -= bytes.length;
          controller.enqueue(bytes);
        } catch (reason) {
          try {
            await close([...(ended ? [] : [() => reader.cancel(reason)]), () => reader.releaseLock()], [reason]);
          } catch (failure) {
            controller.error(failure);
          }
          ended = true;
        }
      },
      async cancel(reason) {
        if (ended) return;
        ended = true;
        await close([() => reader.cancel(reason), () => reader.releaseLock()]);
      },
    }, { highWaterMark: 0 }),
    signal,
    "Firebase content",
    "download",
  );
}
/** Native Firebase protocol; this class does not supply an OPFS filesystem or immutable byte-source identity. */
export class FirebaseClient {
  readonly #api: URL;
  readonly #bucket: string;
  readonly #credentials: FirebaseOptionsType["credentials"];
  readonly #appId: string | undefined;
  readonly #fetch: FetchType;
  readonly #request: RequestPolicyType | undefined;
  readonly #bytes: number;
  readonly #pages: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: FirebaseOptionsType) {
    const api = parsedUrl(options.endpoint ?? "https://firebasestorage.googleapis.com/v0/");
    if (
      (api.protocol !== "https:" && !(options.allowHttp === true && api.protocol === "http:")) || api.username ||
      api.password || api.search || api.hash || !api.pathname.endsWith("/")
    ) throw new TypeError("Invalid Firebase API endpoint.");
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket)) throw new TypeError("Invalid Firebase bucket.");
    this.#api = api;
    this.#bucket = options.bucket;
    this.#credentials = options.credentials;
    this.#appId = options.appId === undefined ? undefined : token(options.appId);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#request = options.request === undefined ? undefined : { ...options.request };
    this.#bytes = integer(options.maxBytes ?? 8 * 1024 * 1024, FIREBASE_BUFFER_BYTES, "byte budget");
    this.#pages = integer(options.maxPages ?? 1000, 100000, "page budget");
    this.#entries = integer(options.maxEntries ?? 100000, 1000000, "entry budget");
  }
  #url(selected?: string): URL {
    return new URL(
      `b/${encodeURIComponent(this.#bucket)}/o${selected === undefined ? "" : "/" + encodeURIComponent(selected)}`,
      this.#api,
    );
  }
  /** All redirects are refused; credentials are acquired only for an already admitted exact API/session URL. */
  async #send<Value>(
    target: URL,
    method: string,
    headers: Headers,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    mutation: boolean,
    consume: (response: Response, text: () => PromiseLike<string>) => Value | PromiseLike<Value>,
    transfer = false,
  ): Promise<Value> {
    signal?.throwIfAborted();
    {
      const credentials = await this.#credentials?.(new URL(target), signal);
      signal?.throwIfAborted();
      if (credentials?.idToken !== undefined) headers.set("Authorization", `Firebase ${token(credentials.idToken)}`);
      if (credentials?.appCheckToken !== undefined) {
        headers.set("X-Firebase-AppCheck", token(credentials.appCheckToken));
      }
      if (this.#appId !== undefined) headers.set("X-Firebase-GMPID", this.#appId);
    }
    let dispatched = false;
    try {
      const response = await sendRequest(async (signal) => ({
        input: target,
        init: {
          method,
          headers,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(body === undefined ? {} : { body }),
          ...(signal === undefined ? {} : { signal }),
        },
      }), {
        fetch: (input, init) => {
          dispatched = true;
          return this.#fetch(input, init);
        },
        metrics: this.#metrics,
        replayable: false,
        ...(signal === undefined ? {} : { signal }),
        ...(this.#request === undefined ? {} : { policy: this.#request }),
      });
      if (transfer && response.status >= 200 && response.status < 300) {
        try {
          return await consume(response, () => {
            throw new TypeError("Transferred media cannot be read as control text.");
          });
        } catch (reason) {
          await close(response.body === null || response.body.locked ? [] : [() => response.body!.cancel(reason)], [
            reason,
          ]);
          throw reason;
        }
      }
      return await readResponse(response, async (text) => {
        if (response.status < 200 || response.status >= 300) throw new FirebaseError(response.status);
        return await consume(response, text);
      });
    } catch (reason) {
      if (mutation && dispatched) throw new FirebasePublicationError(reason);
      throw reason;
    }
  }
  /** Read metadata through Firebase Rules, without minting or consuming a download token. */
  stat(selected: string, signal?: AbortSignal): Promise<FirebaseMetadataType> {
    selected = name(selected);
    return this.#send(
      this.#url(selected),
      "GET",
      new Headers(),
      undefined,
      signal,
      false,
      async (_response, text) => metadata(json(await text()), this.#bucket, selected),
    );
  }
  /** A Rules-v2 delimiter page; prefixes are virtual and are not directory resources. */
  listPage(
    prefix = "",
    options: { readonly pageToken?: string; readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<FirebaseListType> {
    prefix = name(prefix, true);
    const signal = options.signal, pageToken = options.pageToken;
    const limit = integer(options.limit ?? 1000, 1000, "page size");
    if (!limit) throw new RangeError("Firebase page size must be positive.");
    const target = this.#url();
    target.searchParams.set("prefix", prefix);
    target.searchParams.set("delimiter", "/");
    target.searchParams.set("maxResults", String(limit));
    if (pageToken !== undefined) {
      if (!pageToken || pageToken.length > 16384) throw new TypeError("Invalid Firebase page token.");
      target.searchParams.set("pageToken", pageToken);
    }
    return this.#send(target, "GET", new Headers(), undefined, signal, false, async (_response, text) => {
      const data = z.object({
        items: z.array(z.object({ name: z.string(), bucket: z.string().optional() })).optional(),
        prefixes: z.array(z.string()).optional(),
        nextPageToken: z.string().min(1).max(16384).optional(),
      }).parse(json(await text()));
      const items = (data.items ?? []).map((item) => {
        if (item.bucket !== undefined && item.bucket !== this.#bucket) {
          throw new TypeError("Firebase listing bucket differs.");
        }
        return name(item.name);
      });
      const prefixes = (data.prefixes ?? []).map((item) => name(item));
      if (
        items.length + prefixes.length > limit ||
        new Set([...items, ...prefixes]).size !== items.length + prefixes.length
      ) throw new TypeError("Firebase listing exceeds page or uniqueness bounds.");
      for (const item of items) {
        if (!item.startsWith(prefix) || item.slice(prefix.length).includes("/")) {
          throw new TypeError("Firebase listed object escapes delimiter prefix.");
        }
      }
      for (const item of prefixes) {
        if (
          !item.startsWith(prefix) || !item.endsWith("/") || !item.slice(prefix.length, -1) ||
          item.slice(prefix.length, -1).includes("/")
        ) throw new TypeError("Firebase listed prefix is not a direct child.");
      }
      return { items, prefixes, ...(data.nextPageToken === undefined ? {} : { nextPageToken: data.nextPageToken }) };
    });
  }
  /** Bounded incremental pages; concurrent namespace changes can omit entries, so this is not a snapshot. */
  async *list(prefix = "", signal?: AbortSignal): AsyncGenerator<FirebaseListType> {
    prefix = name(prefix, true);
    const seen = new Set<string>(), names = new Set<string>();
    let pageToken: string | undefined, entries = 0;
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.listPage(prefix, {
        ...(pageToken === undefined ? {} : { pageToken }),
        ...(signal === undefined ? {} : { signal }),
      });
      entries += result.items.length + result.prefixes.length;
      if (entries > this.#entries) throw new RangeError("Firebase listing exceeds entry budget.");
      if (result.nextPageToken !== undefined && seen.has(result.nextPageToken)) {
        throw new TypeError("Firebase listing token does not advance.");
      }
      for (const entry of [...result.items, ...result.prefixes]) {
        if (names.has(entry)) throw new TypeError("Firebase listing repeated an entry across pages.");
        names.add(entry);
      }
      yield result;
      pageToken = result.nextPageToken;
      if (pageToken === undefined) return;
      seen.add(pageToken);
    }
    throw new RangeError("Firebase listing exceeds page budget.");
  }
  /** Native mutable metadata update, without a conditional metageneration promise. */
  updateMetadata(
    selected: string,
    value: FirebaseWriteMetadataType,
    signal?: AbortSignal,
  ): Promise<FirebaseMetadataType> {
    selected = name(selected);
    const body = JSON.stringify(writable(value));
    return this.#send(
      this.#url(selected),
      "PATCH",
      new Headers({ "Content-Type": "application/json" }),
      body,
      signal,
      true,
      async (_response, text) => metadata(json(await text()), this.#bucket, selected),
    );
  }
  /** Delete the current object, not a version-conditional filesystem primitive. No automatic retry occurs. */
  deleteObject(selected: string, signal?: AbortSignal): Promise<void> {
    selected = name(selected);
    return this.#send(this.#url(selected), "DELETE", new Headers(), undefined, signal, true, (response) => {
      if (![200, 204].includes(response.status)) throw new TypeError("Invalid Firebase deletion acknowledgment.");
    });
  }
  /** Materialized multipart upload copies bytes before credentials and validates the complete metadata receipt. */
  upload(
    selected: string,
    bytes: Uint8Array,
    value: FirebaseWriteMetadataType = {},
    signal?: AbortSignal,
  ): Promise<FirebaseMetadataType> {
    selected = name(selected);
    const data = this.#copy(bytes), info = writable(value);
    // A fixed boundary cannot collide with the binary body: scan before constructing the MIME envelope.
    const boundary = "opfs_firebase_multipart_20261105";
    const encoded = new TextEncoder(), marker = encoded.encode(boundary);
    outer: for (let at = 0; at <= data.length - marker.length; at++) {
      for (let i = 0; i < marker.length; i++) if (data[at + i] !== marker[i]) continue outer;
      throw new TypeError("Firebase upload bytes collide with multipart boundary.");
    }
    const head = encoded.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${
        JSON.stringify({ ...info, name: selected })
      }\r\n--${boundary}\r\nContent-Type: ${
        typeof info.contentType === "string" ? info.contentType : "application/octet-stream"
      }\r\n\r\n`,
    );
    const tail = encoded.encode(`\r\n--${boundary}--`), body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    const target = this.#url();
    target.searchParams.set("name", selected);
    return this.#send(
      target,
      "POST",
      new Headers({ "Content-Type": `multipart/related; boundary=${boundary}`, "X-Goog-Upload-Protocol": "multipart" }),
      body,
      signal,
      true,
      async (_response, text) => metadata(json(await text()), this.#bucket, selected, data.length),
    );
  }
  #copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (!isBytes(bytes)) throw new TypeError("Firebase upload requires Uint8Array bytes.");
    const view = toView(bytes);
    integer(view.length, this.#bytes, "upload byte budget");
    return new Uint8Array(view);
  }
  /** Exact authenticated media read. Equal-size overwrites between metadata and content remain possible. */
  async download(selected: string, options: FirebaseReadOptionsType = {}): Promise<FirebaseDownloadType> {
    selected = name(selected);
    const chosen = range(options);
    if (chosen.empty) throw new RangeError("Use read() for a local zero-length selection.");
    const info = await this.stat(selected, chosen.signal);
    const target = this.#url(selected);
    target.searchParams.set("alt", "media");
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (chosen.header !== undefined) headers.set("Range", chosen.header);
    return await this.#send<FirebaseDownloadType>(
      target,
      "GET",
      headers,
      undefined,
      chosen.signal,
      false,
      async (response) => {
        // The official emulator emits an empty Content-Encoding field. An empty
        // coding list applies no coding; retain rejection of every real coding.
        const headers = new Headers(response.headers);
        if (headers.get("content-encoding")?.trim() === "") headers.delete("content-encoding");
        await assertRangeResponse(new Response(null, { status: response.status, headers }), chosen);
        const total = chosen.header === undefined
          ? info.size
          : Number(response.headers.get("content-range")!.split("/")[1]);
        const length = chosen.header === undefined
          ? info.size
          : Math.min(chosen.end ?? total - 1, total - 1) - chosen.start + 1;
        if (
          total !== info.size || length < 0 ||
          response.headers.has("content-length") &&
            (!/^(0|[1-9][0-9]*)$/.test(response.headers.get("content-length")!) ||
              Number(response.headers.get("content-length")) !== length)
        ) throw new TypeError("Firebase media extent differs from metadata.");
        if (response.body === null) throw new TypeError("Firebase media has no body.");
        return {
          metadata: info,
          length,
          evidence: "server-trusted",
          bytes: extent(response.body, length, chosen.signal),
        };
      },
      true,
    );
  }
  /** Bounded materialized selection; zero length does not acquire credentials or prove existence. */
  async read(selected: string, options: FirebaseReadOptionsType = {}): Promise<Uint8Array<ArrayBuffer>> {
    selected = name(selected);
    const chosen = range(options);
    if (chosen.empty) return new Uint8Array();
    // Avoid opening a body before the local materialization limit is known.
    const info = await this.stat(selected, chosen.signal);
    const length = Math.max(
      0,
      Math.min(info.size - chosen.start, chosen.end === undefined ? info.size : chosen.end - chosen.start + 1),
    );
    integer(length, this.#bytes, "read byte budget");
    const result = await this.download(selected, {
      ...(chosen.header === undefined ? {} : { at: chosen.start }),
      ...(chosen.end === undefined ? {} : { length: chosen.end - chosen.start + 1 }),
      ...(chosen.signal === undefined ? {} : { signal: chosen.signal }),
    });
    if (result.length !== length) {
      await close([() => result.bytes.cancel()], [new TypeError("Firebase extent changed before materialization.")]);
    }
    const reader = openBytes(result.bytes);
    const output = new Uint8Array(length);
    let at = 0, terminal = false;
    try {
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (reason) {
          terminal = true;
          throw reason;
        }
        if (next.done) {
          terminal = true;
          break;
        }
        if (next.value.length > output.length - at) throw new RangeError("Firebase read exceeds admitted allocation.");
        output.set(next.value, at);
        at += next.value.length;
      }
      if (at !== length) throw new TypeError("Firebase read length changed.");
      return output;
    } catch (reason) {
      await close(terminal ? [] : [() => reader.cancel(reason)], [reason]);
      throw reason;
    } finally {
      reader.releaseLock();
    }
  }
  /** Explicit bearer download URL; do not log it. It is not a Rules-authenticated read. */
  getDownloadLink(selected: string, signal?: AbortSignal): Promise<string | undefined> {
    selected = name(selected);
    return this.#send(this.#url(selected), "GET", new Headers(), undefined, signal, false, async (_response, text) => {
      const raw = json(await text());
      metadata(raw, this.#bucket, selected);
      const data = z.object({ downloadTokens: z.string().max(65536).optional() }).parse(raw);
      if (!data.downloadTokens) return undefined;
      const target = this.#url(selected);
      target.searchParams.set("alt", "media");
      target.searchParams.set("token", token(data.downloadTokens.split(",")[0]!));
      return target.href;
    });
  }
  /** Start one fixed-size resumable session. This is Firebase's protocol, not GCS's Content-Range upload API. */
  startUpload(
    selected: string,
    size: number,
    value: FirebaseWriteMetadataType = {},
    signal?: AbortSignal,
  ): Promise<FirebaseSessionType> {
    selected = name(selected);
    size = integer(size, Number.MAX_SAFE_INTEGER, "upload size");
    const info = writable(value), target = this.#url();
    target.searchParams.set("name", selected);
    return this.#send(
      target,
      "POST",
      new Headers({
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(size),
        "X-Goog-Upload-Header-Content-Type": typeof info.contentType === "string"
          ? info.contentType
          : "application/octet-stream",
      }),
      JSON.stringify({ ...info, name: selected }),
      signal,
      true,
      (response) => {
        if (response.headers.get("X-Goog-Upload-Status") !== "active") {
          throw new TypeError(
            "Firebase upload did not become active.",
          );
        }
        return this.#session({
          url: response.headers.get("X-Goog-Upload-URL") ?? "",
          bucket: this.#bucket,
          name: selected,
          size,
        });
      },
    );
  }
  /** Bound and capture session URL authority before requesting credentials. Only the native bucket upload route is admitted. */
  #session(session: FirebaseSessionType): FirebaseSessionType {
    if (typeof session.url !== "string" || session.url.length > 65536) {
      throw new TypeError("Invalid Firebase session URL.");
    }
    const selected = name(session.name),
      size = integer(session.size, Number.MAX_SAFE_INTEGER, "session size"),
      target = parsedUrl(session.url),
      base = this.#url();
    if (
      session.bucket !== this.#bucket || target.origin !== base.origin || target.pathname !== base.pathname ||
      target.username || target.password || target.hash || target.searchParams.get("name") !== selected ||
      target.searchParams.getAll("name").length !== 1 || !target.searchParams.get("upload_id") ||
      target.searchParams.getAll("upload_id").length !== 1 || target.href.length > 65536
    ) throw new TypeError("Firebase session authority differs from its bucket/object.");
    if (
      target.searchParams.has("upload_protocol") &&
      (target.searchParams.get("upload_protocol") !== "resumable" ||
        target.searchParams.getAll("upload_protocol").length !== 1)
    ) throw new TypeError("Invalid Firebase session protocol.");
    for (const key of target.searchParams.keys()) {
      if (!["name", "upload_id", "upload_protocol"].includes(key)) {
        throw new TypeError("Unrecognized Firebase session query authority.");
      }
    }
    return { url: target.href, bucket: this.#bucket, name: selected, size };
  }
  /** Reconcile acknowledged native offset; final session status alone has no final object metadata receipt. */
  statusUpload(session: FirebaseSessionType, signal?: AbortSignal): Promise<FirebaseStatusType> {
    const captured = this.#session(session);
    return this.#send(
      parsedUrl(captured.url),
      "POST",
      new Headers({ "X-Goog-Upload-Command": "query" }),
      undefined,
      signal,
      false,
      (response) => {
        const state = response.headers.get("X-Goog-Upload-Status"),
          raw = response.headers.get("X-Goog-Upload-Size-Received");
        if (
          state !== "active" && state !== "final" || raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)
        ) throw new TypeError("Invalid Firebase upload status.");
        const offset = integer(Number(raw), captured.size, "acknowledged offset");
        if (state === "final" && offset !== captured.size) {
          throw new TypeError(
            "Firebase finalized an incomplete session.",
          );
        }
        return { state, offset, size: captured.size, evidence: "session-status" };
      },
    );
  }
  /** Caller owns exclusive session/source use. Unknown writes require explicit status reconciliation before retrying. */
  writeUpload(
    session: FirebaseSessionType,
    offset: number,
    bytes: Uint8Array,
    options: { readonly finalize: boolean; readonly signal?: AbortSignal },
  ): Promise<FirebaseUploadType> {
    const captured = this.#session(session),
      data = this.#copy(bytes),
      finalize = options.finalize,
      signal = options.signal;
    integer(offset, captured.size, "upload offset");
    if (
      typeof finalize !== "boolean" || data.length > captured.size - offset ||
      finalize && offset + data.length !== captured.size ||
      !finalize && (!data.length || data.length % FIREBASE_CHUNK_BYTES !== 0 || offset % FIREBASE_CHUNK_BYTES !== 0)
    ) throw new RangeError("Firebase upload chunk/finality differs from fixed-size session.");
    const command = finalize ? data.length ? "upload, finalize" : "finalize" : "upload";
    return this.#send<FirebaseUploadType>(
      parsedUrl(captured.url),
      "POST",
      new Headers({ "X-Goog-Upload-Command": command, "X-Goog-Upload-Offset": String(offset) }),
      data,
      signal,
      true,
      async (response, text) => {
        const state = response.headers.get("X-Goog-Upload-Status");
        if (state === "final") {
          if (!finalize) throw new TypeError("Firebase unexpectedly finalized an unfinished upload.");
          return {
            state: "published",
            evidence: "metadata-receipt",
            metadata: metadata(json(await text()), this.#bucket, captured.name, captured.size),
          };
        }
        if (state !== "active" || finalize) throw new TypeError("Firebase upload finality was not acknowledged.");
        // Successful active upload acknowledges this submitted extent, matching the native protocol contract.
        return { state: "active", offset: offset + data.length, size: captured.size, evidence: "session-status" };
      },
    );
  }
  /** Explicit cancellation of one native session; this does not promise deletion of a previously published object. */
  cancelUpload(session: FirebaseSessionType, signal?: AbortSignal): Promise<void> {
    const captured = this.#session(session);
    return this.#send(
      parsedUrl(captured.url),
      "POST",
      new Headers({ "X-Goog-Upload-Command": "cancel" }),
      undefined,
      signal,
      true,
      (response) => {
        const state = response.headers.get("X-Goog-Upload-Status");
        // The official emulator acknowledges cancel with HTTP 200 and no status
        // header. When present, the status must not contradict cancellation.
        if (response.status !== 200 || state !== null && state !== "cancelled") {
          throw new TypeError(
            "Firebase session cancellation was not acknowledged.",
          );
        }
      },
    );
  }
}
