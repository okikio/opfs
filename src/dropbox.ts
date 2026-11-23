/** Dropbox native metadata, revision reads and sequential upload sessions. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Provider limit per content-upload call, distinct from the smaller local policy. */
export const DROPBOX_REQUEST_BYTES = 150 * 1024 * 1024;
/** Provider limit for a complete upload session. */
export const DROPBOX_FILE_BYTES = 2 ** 41 - 2 ** 22;
const blockBytes = 4 * 1024 * 1024;
const defaultBytes = 8 * 1024 * 1024;
const MetadataSchema = z.object({
  ".tag": z.enum(["file", "folder", "deleted"]),
  name: z.string().max(8192),
  id: z.string().min(4).max(1024).optional(),
  rev: z.string().regex(/^[0-9a-f]{9,}$/).max(128).optional(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  path_lower: z.string().max(8192).optional(),
  path_display: z.string().max(8192).optional(),
  is_downloadable: z.boolean().optional(),
});
/** Native paths are case-insensitive service addresses, not an OPFS namespace. */
export interface DropboxMetadataType {
  readonly kind: "file" | "folder" | "deleted";
  readonly name: string;
  readonly id?: string;
  readonly rev?: string;
  readonly size?: number;
  /** Dropbox's block-composed SHA-256 hash, not a single SHA-256 of the file. */
  readonly contentHash?: string;
  readonly pathLower?: string;
  readonly pathDisplay?: string;
  readonly downloadable?: boolean;
}
/** A downloadable stored file has an ID, revision and safe byte size. */
export interface DropboxFileType extends DropboxMetadataType {
  readonly kind: "file";
  readonly id: string;
  readonly rev: string;
  readonly size: number;
}
/** Account selection is caller-owned; construction does not discover tokens or team roots. */
export interface DropboxOptionsType {
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly endpoint?: string | URL;
  readonly contentEndpoint?: string | URL;
  /** HTTP is only for explicit private fixtures. Production endpoints require HTTPS. */
  readonly allowHttp?: boolean;
  readonly namespaceId?: string;
  readonly selectUser?: string;
  readonly request?: RequestPolicyType;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  /** Materialized upload/read admission; default 8 MiB, maximum 150 MiB. */
  readonly maxBytes?: number;
}
/** Native continuation evidence is not an atomic directory snapshot. */
export interface DropboxPageType {
  readonly entries: readonly DropboxMetadataType[];
  readonly cursor: string;
  readonly hasMore: boolean;
}
/** A download transfers its exact-extent stream to the caller, who must consume or cancel it. */
export interface DropboxDownloadType {
  readonly file: DropboxFileType;
  readonly bytes: ReadableStream<Uint8Array>;
}
/** Paths and IDs remain distinct from immutable revision read references. */
export interface DropboxReadOptionsType {
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Strict conflicts and disabled autorename prevent an update from silently choosing another target. */
export interface DropboxCommitType {
  readonly path: string;
  readonly mode: "add" | "overwrite" | Readonly<{ update: string }>;
}
/** Sensitive session ID and acknowledged offset. No status endpoint or final receipt is implied. */
export interface DropboxSessionType {
  readonly sessionId: string;
  readonly offset: number;
}
/** Full-file receipt admission is separate from hashing the bytes in the final session call. */
export interface DropboxFinishOptionsType {
  readonly size: number;
  readonly contentHash?: string;
  readonly signal?: AbortSignal;
}
/** Only safe provider classification is exposed; bodies and credential-bearing arguments stay private. */
export class DropboxError extends Error {
  readonly status: number;
  readonly tag?: string;
  readonly correctOffset?: number;
  constructor(status: number, tag?: string, correctOffset?: number) {
    super(`Dropbox request failed with HTTP ${status}.`);
    this.name = "DropboxError";
    this.status = status;
    if (tag !== undefined) this.tag = tag;
    if (correctOffset !== undefined) this.correctOffset = correctOffset;
  }
}
/** A dispatched mutation without its validated acknowledgement must not be blindly repeated. */
export class DropboxPublicationError extends Error {
  constructor(cause: unknown) {
    super("Dropbox mutation has no validated acknowledgement; reconcile before retrying.", { cause });
    this.name = "DropboxPublicationError";
  }
}
/** Admission precedes buffers, credentials and transport. */
function integer(value: number, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid Dropbox ${label}.`);
  return value;
}
/** Limit code units before regular expressions or serialization allocate another representation. */
function text(value: string, label: string, max = 8192): string {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new TypeError(`Invalid Dropbox ${label}.`);
  }
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 31 || code === 127) throw new TypeError(`Invalid Dropbox ${label}.`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`Invalid Dropbox ${label}.`);
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`Invalid Dropbox ${label}.`);
  }
  return value;
}
/** No path normalization changes the literal provider address. Root is only valid for listing. */
function address(value: string, revision = false, root = false): string {
  if (root && value === "") return value;
  text(value, "address");
  if (value.startsWith("/") || /^id:.+$/u.test(value) || /^ns:\d+(?:\/.*)?$/u.test(value)) return value;
  if (revision && /^rev:[0-9a-f]{9,128}$/u.test(value)) return value;
  throw new TypeError("Invalid Dropbox address.");
}
/** Metadata validation preserves omitted wire optionals under exactOptionalPropertyTypes. */
function metadata(value: unknown): DropboxMetadataType {
  const data = MetadataSchema.parse(value);
  if (data[".tag"] !== "deleted" && (data.id === undefined || !data.id.startsWith("id:"))) {
    throw new TypeError("Dropbox metadata requires a native ID.");
  }
  if (data[".tag"] === "file" && (data.rev === undefined || data.size === undefined)) {
    throw new TypeError("Dropbox file metadata requires revision and size.");
  }
  return Object.freeze({
    kind: data[".tag"],
    name: data.name,
    ...(data.id === undefined ? {} : { id: data.id }),
    ...(data.rev === undefined ? {} : { rev: data.rev }),
    ...(data.size === undefined ? {} : { size: data.size }),
    ...(data.content_hash === undefined ? {} : { contentHash: data.content_hash }),
    ...(data.path_lower === undefined ? {} : { pathLower: data.path_lower }),
    ...(data.path_display === undefined ? {} : { pathDisplay: data.path_display }),
    ...(data.is_downloadable === undefined ? {} : { downloadable: data.is_downloadable }),
  });
}
/** IDs and revisions are response conditions, never inferred from a mutable name. */
function file(value: unknown, selected?: string): DropboxFileType {
  // Concrete FileMetadata receipts omit the union discriminator. An explicit
  // foreign discriminator is still rejected instead of being overwritten.
  const concrete = typeof value === "object" && value !== null && !Object.hasOwn(value, ".tag")
    ? { ...value, ".tag": "file" }
    : value;
  const data = metadata(concrete);
  if (data.kind !== "file" || data.id === undefined || data.rev === undefined || data.size === undefined) {
    throw new TypeError("Dropbox operation requires a stored file.");
  }
  if (data.downloadable === false) throw new TypeError("Dropbox file requires a separate export operation.");
  if (
    (selected?.startsWith("id:") && data.id !== selected) ||
    (selected?.startsWith("rev:") && data.rev !== selected.slice(4))
  ) {
    throw new TypeError("Dropbox receipt names another file or revision.");
  }
  return { ...data, kind: "file", id: data.id, rev: data.rev, size: data.size };
}
/** HTTP-header-safe JSON keeps non-ASCII names out of URL arguments. */
function argument(value: unknown): string {
  const encoded = JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (encoded.length > 64 * 1024) throw new RangeError("Dropbox argument header exceeds 64 KiB.");
  return encoded;
}
/** Endpoint configuration is an explicit credential grant, never a redirect policy. */
function endpoint(value: string | URL, allowHttp: boolean): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password ||
    url.search || url.hash || !url.pathname.endsWith("/")
  ) throw new TypeError("Invalid Dropbox endpoint.");
  return url;
}
/** Serialize commit state synchronously, including the revision nested in the caller object. */
function commit(value: DropboxCommitType): { path: string; mode: unknown; autorename: false; strict_conflict: true } {
  const path = address(value.path);
  const input = value.mode;
  let mode: unknown;
  if (input === "add" || input === "overwrite") mode = input;
  else if (
    typeof input === "object" && input !== null && typeof input.update === "string" &&
    /^[0-9a-f]{9,128}$/.test(input.update)
  ) {
    mode = { ".tag": "update", update: input.update };
  } else throw new TypeError("Invalid Dropbox write mode.");
  return { path, mode, autorename: false, strict_conflict: true };
}
/** Bounded shallow error traversal extracts only safe native tags and offset evidence. */
function failure(status: number, value: unknown): DropboxError {
  let current: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "error") : undefined;
  let tag: string | undefined;
  let offset: number | undefined;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const next = Reflect.get(current, ".tag");
    if (typeof next !== "string" || !/^[a-z_]{1,80}$/.test(next)) break;
    tag = next;
    if (next === "incorrect_offset") {
      const amount = Reflect.get(current, "correct_offset");
      if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 && amount <= DROPBOX_FILE_BYTES) {
        offset = amount;
      }
      break;
    }
    current = Reflect.get(current, next);
  }
  return new DropboxError(status, tag, offset);
}

/**
 * Compute Dropbox's full-file hash using explicitly borrowed cryptography.
 * Input is copied before the first await. Default admission is 8 MiB and its hard
 * ceiling is 150 MiB. Each digest uses at most a 4 MiB owned block plus 32 bytes
 * per block; the complete snapshot and WebCrypto's internal copies are additional.
 * The returned hash lets the caller compare bytes with a trusted declaration.
 * Computing it does not establish authenticity.
 */
export async function contentHash(
  bytes: Uint8Array,
  options: { readonly subtle: Pick<SubtleCrypto, "digest">; readonly maxBytes?: number },
): Promise<string> {
  const limit = integer(options.maxBytes ?? defaultBytes, "hash byte budget", DROPBOX_REQUEST_BYTES);
  if (!isBytes(bytes)) throw new TypeError("Dropbox hashing requires Uint8Array bytes.");
  const view = toView(bytes);
  if (view.byteLength > limit) throw new RangeError("Dropbox hash input exceeds its byte budget.");
  const owned = new Uint8Array(view);
  const subtle = options.subtle;
  const hashes = new Uint8Array(Math.ceil(owned.length / blockBytes) * 32);
  for (let at = 0; at < owned.length; at += blockBytes) {
    const digest = new Uint8Array(await subtle.digest("SHA-256", owned.slice(at, at + blockBytes)));
    if (digest.length !== 32) throw new TypeError("SHA-256 capability returned an invalid digest length.");
    hashes.set(digest, at / blockBytes * 32);
  }
  const result = new Uint8Array(await subtle.digest("SHA-256", hashes));
  if (result.length !== 32) throw new TypeError("SHA-256 capability returned an invalid digest length.");
  return Array.from(result, (value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Exact-length owner detects truncation and extra bytes at EOF, with no prefetch.
 * Upstream cancellation/release faults remain beside the original admission fault.
 */
function extent(source: ReadableStream<Uint8Array>, length: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(source);
  let remaining = length;
  let ended = false;
  let empty = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (reason) {
          // Read rejection is already terminal source evidence. Re-cancelling
          // an errored native stream would observe its stored failure twice.
          ended = true;
          throw reason;
        }
        // Cancellation can settle a pending read with done:true. That is not
        // producer EOF and must not invent a truncation fault beside abort.
        if (ended) return;
        if (next.done) {
          ended = true;
          if (remaining !== 0) throw new TypeError("Dropbox content body is truncated.");
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!isBytes(next.value)) throw new TypeError("Dropbox content body requires byte chunks.");
        const chunk = toView(next.value);
        if (chunk.byteLength > remaining) throw new TypeError("Dropbox content body exceeds its extent.");
        if (chunk.byteLength === 0) {
          if (++empty > 16) throw new TypeError("Dropbox content body makes no byte progress.");
        } else empty = 0;
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
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
  }, { highWaterMark: 0 });
  return withAbortSignal(stream, signal, "Dropbox content", "download");
}

/** Native client owns no ambient account, credential, pool or filesystem. */
export class DropboxClient {
  readonly #rpc: URL;
  readonly #content: URL;
  readonly #token: DropboxOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #context: Headers;
  readonly #pages: number;
  readonly #entries: number;
  readonly #bytes: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: DropboxOptionsType) {
    this.#rpc = endpoint(options.endpoint ?? "https://api.dropboxapi.com/2/", options.allowHttp === true);
    this.#content = endpoint(
      options.contentEndpoint ?? "https://content.dropboxapi.com/2/",
      options.allowHttp === true,
    );
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#pages = integer(options.maxPages ?? 1000, "page budget", 100000);
    this.#entries = integer(options.maxEntries ?? 100000, "entry budget", 1000000);
    this.#bytes = integer(options.maxBytes ?? defaultBytes, "byte budget", DROPBOX_REQUEST_BYTES);
    this.#context = new Headers();
    if (options.namespaceId !== undefined) {
      if (!/^\d{1,128}$/.test(options.namespaceId)) throw new TypeError("Invalid Dropbox namespace ID.");
      this.#context.set(
        "Dropbox-API-Path-Root",
        argument({ ".tag": "namespace_id", namespace_id: options.namespaceId }),
      );
    }
    if (options.selectUser !== undefined) {
      this.#context.set("Dropbox-API-Select-User", text(options.selectUser, "selected user", 1024));
    }
  }
  /** All calls are single-attempt, including mutations and cursor reconciliation. */
  async #send(
    url: URL,
    headers: Headers,
    method: "GET" | "POST",
    body: BodyInit | undefined,
    signal?: AbortSignal,
    fetch = this.#fetch,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const token = await this.#token(new URL(url), signal);
    signal?.throwIfAborted();
    if (typeof token !== "string" || !token || token.length > 32768 || /[\r\n]/.test(token)) {
      throw new TypeError("Invalid Dropbox bearer token.");
    }
    headers.set("Authorization", `Bearer ${token}`);
    return await sendRequest(async (signal) => ({
      input: url,
      init: {
        method,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
      },
    }), {
      fetch,
      replayable: false,
      metrics: this.#metrics,
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  /** Native RPC arguments are a bounded owned JSON body, not route/query fragments. */
  #request(route: string, arg: unknown, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.#context);
    headers.set("Content-Type", "application/json");
    return this.#send(new URL(`files/${route}`, this.#rpc), headers, "POST", argument(arg), signal);
  }
  async #json<Value>(response: Response, parse: (value: unknown) => Value, mutation = false): Promise<Value> {
    return await readResponse(response, async (text) => {
      if (!response.ok) {
        if (mutation && (response.status >= 500 || (response.status >= 300 && response.status < 400))) {
          throw new DropboxPublicationError(new DropboxError(response.status));
        }
        let value: unknown;
        try {
          value = JSON.parse(await text());
        } catch {
          throw new DropboxError(response.status);
        }
        throw failure(response.status, value);
      }
      try {
        if (response.status !== 200) throw new TypeError("Dropbox receipt requires HTTP 200.");
        return parse(JSON.parse(await text()));
      } catch (reason) {
        if (mutation) throw new DropboxPublicationError(reason);
        throw reason;
      }
    });
  }
  /** Native metadata read. IDs pin the resource; revisions pin a retained version, not retention duration. */
  async stat(path: string, signal?: AbortSignal): Promise<DropboxMetadataType> {
    const selected = address(path, true);
    const value = metadata(
      await this.#json(await this.#request("get_metadata", { path: selected }, signal), (value) => value),
    );
    if (
      selected.startsWith("id:") && value.id !== selected ||
      selected.startsWith("rev:") && value.rev !== selected.slice(4)
    ) {
      throw new TypeError("Dropbox metadata names another file or revision.");
    }
    return value;
  }
  #page(value: unknown): DropboxPageType {
    const parsed = z.object({
      entries: z.array(z.unknown()).max(this.#entries),
      cursor: z.string().min(1).max(16384),
      has_more: z.boolean(),
    }).parse(value);
    return { entries: parsed.entries.map(metadata), cursor: parsed.cursor, hasMore: parsed.has_more };
  }
  /** Initial direct children only; no search, recursion, longpoll or sync-state persistence. */
  async listPage(path = "", signal?: AbortSignal): Promise<DropboxPageType> {
    const selected = address(path, false, true);
    return await this.#json(
      await this.#request(
        "list_folder",
        { path: selected, recursive: false, include_deleted: false, limit: 2000 },
        signal,
      ),
      (value) => this.#page(value),
    );
  }
  /** Native cursor can also represent changes. It is opaque and must stay in the same account context. */
  async continuePage(cursor: string, signal?: AbortSignal): Promise<DropboxPageType> {
    const selected = text(cursor, "cursor", 16384);
    return await this.#json(
      await this.#request("list_folder/continue", { cursor: selected }, signal),
      (value) => this.#page(value),
    );
  }
  /** Bounded traversal preserves provider order and rejects cursor cycles, without deduplicating changes. */
  async *list(path = "", signal?: AbortSignal): AsyncIterableIterator<DropboxMetadataType> {
    const selected = address(path, false, true);
    const seen = new Set<string>();
    let count = 0;
    let cursor: string | undefined;
    for (let page = 0; page < this.#pages; page++) {
      const result = cursor === undefined
        ? await this.listPage(selected, signal)
        : await this.continuePage(cursor, signal);
      count += result.entries.length;
      if (count > this.#entries) throw new RangeError("Dropbox listing exceeds its entry budget.");
      for (const entry of result.entries) {
        signal?.throwIfAborted();
        yield entry;
      }
      if (!result.hasMore) return;
      if (seen.has(result.cursor)) throw new TypeError("Dropbox listing repeated a continuation cursor.");
      seen.add(result.cursor);
      cursor = result.cursor;
    }
    throw new RangeError("Dropbox listing exceeds its page budget.");
  }
  /** Server-trusted exact response bytes. A finite range is not full-file content-hash verification. */
  async download(path: string, options: DropboxReadOptionsType = {}): Promise<DropboxDownloadType> {
    const selected = address(path, true);
    const extentRequest = range(options);
    if (extentRequest.empty) throw new RangeError("Dropbox download requires a nonempty extent to obtain metadata.");
    const response = await this.#downloadRequest(selected, extentRequest.header, extentRequest.signal);
    if (!response.ok) {
      return await this.#json(response, () => {
        throw new TypeError("Invalid Dropbox download.");
      });
    }
    await assertRangeResponse(response, extentRequest);
    try {
      const header = response.headers.get("Dropbox-API-Result");
      if (header === null || header.length > 64 * 1024) {
        throw new TypeError("Dropbox download requires bounded metadata.");
      }
      const data = file(JSON.parse(header), selected);
      let length = data.size;
      if (extentRequest.header !== undefined) {
        const total = Number(response.headers.get("content-range")!.split("/")[1]);
        if (total !== data.size) throw new TypeError("Dropbox range total differs from file metadata.");
        length = Math.min(extentRequest.end ?? data.size - 1, data.size - 1) - extentRequest.start + 1;
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) {
        throw new TypeError("Dropbox declared length differs from file metadata.");
      }
      if (response.body === null && length !== 0) throw new TypeError("Dropbox download is missing its body.");
      return {
        file: data,
        bytes: extent(
          response.body ?? new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          length,
          extentRequest.signal,
        ),
      };
    } catch (reason) {
      await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
      throw reason;
    }
  }
  /** Separate GET path keeps byte-range headers captured before OAuth acquisition. */
  async #downloadRequest(path: string, selectedRange: string | undefined, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.#context);
    headers.set("Dropbox-API-Arg", argument({ path }));
    headers.set("Accept-Encoding", "identity");
    if (selectedRange !== undefined) headers.set("Range", selectedRange);
    const url = new URL("files/download", this.#content);
    return await this.#send(url, headers, "GET", undefined, signal);
  }
  /** Finite read refuses oversized metadata before accumulating bytes. */
  async read(path: string, options: DropboxReadOptionsType = {}): Promise<Uint8Array> {
    const selected = range(options);
    if (selected.empty) return new Uint8Array();
    const downloaded = await this.download(path, {
      ...(options.at === undefined ? {} : { at: selected.start }),
      ...(options.length === undefined ? {} : { length: options.length }),
      ...(selected.signal === undefined ? {} : { signal: selected.signal }),
    });
    const expected = selected.header === undefined
      ? downloaded.file.size
      : Math.max(0, Math.min(selected.end ?? downloaded.file.size - 1, downloaded.file.size - 1) - selected.start + 1);
    if (expected > this.#bytes) {
      const reason = new RangeError("Dropbox read exceeds its byte budget.");
      await close([() => downloaded.bytes.cancel(reason)], [reason]);
    }
    return await collectBytes(downloaded.bytes, this.#bytes, selected.signal, "read", "Dropbox content");
  }
  #owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (!isBytes(bytes)) throw new TypeError("Dropbox uploading requires Uint8Array bytes.");
    const view = toView(bytes);
    if (view.byteLength > this.#bytes) throw new RangeError("Dropbox upload exceeds its byte budget.");
    return new Uint8Array(view);
  }
  /** Catch transport uncertainty only after Fetch dispatch, not rejected credentials or local admission. */
  async #upload<Value>(
    route: string,
    arg: unknown,
    bytes: Uint8Array,
    parse: (value: unknown) => Value,
    signal?: AbortSignal,
  ): Promise<Value> {
    // The wrapper marks actual Fetch dispatch without changing the configured authority.
    let dispatched = false;
    const fetch = this.#fetch;
    const mark: FetchType = (input, init) => {
      dispatched = true;
      return fetch(input, init);
    };
    const response = await this.#requestMutation(route, arg, bytes, mark, signal).catch((reason: unknown) => {
      if (dispatched) throw new DropboxPublicationError(reason);
      throw reason;
    });
    return await this.#json(response, parse, true);
  }
  /** Request-local dispatch capture avoids mutable client state under concurrent operations. */
  async #requestMutation(
    route: string,
    arg: unknown,
    bytes: Uint8Array,
    fetch: FetchType,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers(this.#context);
    headers.set("Dropbox-API-Arg", argument(arg));
    headers.set("Content-Type", "application/octet-stream");
    const body = toRequestBytes(bytes);
    const url = new URL(`files/${route}`, this.#content);
    return await this.#send(url, headers, "POST", body, signal, fetch);
  }
  /** Materialized native upload; receipt checks size, target ID and optional trusted expected hash. */
  async upload(
    target: DropboxCommitType,
    bytes: Uint8Array,
    options: { readonly contentHash?: string; readonly signal?: AbortSignal } = {},
  ): Promise<DropboxFileType> {
    const selected = commit(target);
    const owned = this.#owned(bytes);
    const expected = options.contentHash;
    const signal = options.signal;
    if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) {
      throw new TypeError("Invalid Dropbox content hash.");
    }
    return await this.#upload(
      "upload",
      { ...selected, ...(expected === undefined ? {} : { content_hash: expected }) },
      owned,
      (value) => {
        const data = file(value, selected.path);
        if (data.size !== owned.length || expected !== undefined && data.contentHash !== expected) {
          throw new TypeError(
            "Dropbox upload receipt differs from expected bytes.",
          );
        }
        return data;
      },
      signal,
    );
  }
  /** Sequential session begins with owned bytes. Session IDs must be retained privately for recovery. */
  async startUpload(bytes: Uint8Array = new Uint8Array(), signal?: AbortSignal): Promise<DropboxSessionType> {
    const owned = this.#owned(bytes);
    return await this.#upload("upload_session/start", { close: false, session_type: "sequential" }, owned, (value) => {
      const parsed = z.object({ session_id: z.string().min(1).max(4096) }).parse(value);
      return { sessionId: text(parsed.session_id, "session ID", 4096), offset: owned.length };
    }, signal);
  }
  /** Offset conflict exposes correctOffset; it does not resend bytes or publish a file. */
  async appendUpload(
    session: DropboxSessionType,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DropboxSessionType> {
    const sessionId = text(session.sessionId, "session ID", 4096);
    const offset = integer(session.offset, "session offset", DROPBOX_FILE_BYTES);
    const owned = this.#owned(bytes);
    if (owned.length > DROPBOX_FILE_BYTES - offset) throw new RangeError("Dropbox session exceeds its file limit.");
    await this.#upload(
      "upload_session/append_v2",
      { cursor: { session_id: sessionId, offset }, close: false },
      owned,
      (value) => {
        if (value !== null) throw new TypeError("Dropbox append requires a null acknowledgement.");
        return null;
      },
      signal,
    );
    return { sessionId, offset: offset + owned.length };
  }
  /** Empty-body commit separates acknowledged buffer bytes from publication. No synthetic status/abort endpoint. */
  async finishUpload(
    session: DropboxSessionType,
    target: DropboxCommitType,
    options: DropboxFinishOptionsType,
  ): Promise<DropboxFileType> {
    const sessionId = text(session.sessionId, "session ID", 4096);
    const offset = integer(session.offset, "session offset", DROPBOX_FILE_BYTES);
    const size = integer(options.size, "file size", DROPBOX_FILE_BYTES);
    const selected = commit(target);
    const expected = options.contentHash;
    const signal = options.signal;
    if (offset !== size) throw new TypeError("Dropbox finish requires the complete acknowledged source extent.");
    if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) {
      throw new TypeError("Invalid Dropbox content hash.");
    }
    return await this.#upload(
      "upload_session/finish",
      { cursor: { session_id: sessionId, offset }, commit: selected },
      new Uint8Array(),
      (value) => {
        const data = file(value, selected.path);
        if (data.size !== size || expected !== undefined && data.contentHash !== expected) {
          throw new TypeError(
            "Dropbox final receipt differs from the expected file.",
          );
        }
        return data;
      },
      signal,
    );
  }
}
