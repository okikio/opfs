/** Box native IDs, versioned downloads and part-based upload sessions. @module */
import { encodeBase64 } from "@std/encoding/base64";
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

const fields = "id,type,name,size,sha1,etag,file_version,parent";
/** Local finite-buffer ceiling, not an account's provider upload allowance. */
export const BOX_BUFFER_BYTES = 64 * 1024 * 1024;
const ItemSchema = z.object({
  id: z.string().regex(/^\d{1,128}$/),
  type: z.enum(["file", "folder", "web_link"]),
  name: z.string().max(8192),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  sha1: z.string().regex(/^[a-fA-F0-9]{40}$/).optional(),
  etag: z.string().max(1024).optional(),
  file_version: z.object({ id: z.string().regex(/^\d{1,128}$/) }).optional(),
  parent: z.object({ id: z.string().regex(/^\d{1,128}$/) }).nullable().optional(),
});
const PartSchema = z.object({
  part_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha1: z.string().regex(/^[a-fA-F0-9]{40}$/),
});
/** Native items retain IDs and kinds instead of being projected into portable paths. */
export interface BoxItemType {
  readonly id: string;
  readonly kind: "file" | "folder" | "web_link";
  readonly name: string;
  readonly size?: number;
  /** Legacy provider checksum; not collision-resistant content authentication. */
  readonly sha1?: string;
  /** Native opaque metadata condition. Do not strengthen it into an HTTP representation validator. */
  readonly etag?: string;
  readonly versionId?: string;
  readonly parentId?: string;
}
/** Stored-file metadata is different from a folder or web link. */
export interface BoxFileType extends BoxItemType {
  readonly kind: "file";
  readonly size: number;
  readonly versionId: string;
}
/** A specific retained version belongs to the requested file route. Retention remains provider-owned. */
export interface BoxVersionType {
  readonly id: string;
  readonly size: number;
  readonly sha1?: string;
}
/** OAuth, account selection and refresh belong to the caller, never a capability redirect. */
export interface BoxOptionsType {
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly endpoint?: string | URL;
  readonly uploadEndpoint?: string | URL;
  readonly asUser?: string;
  /** Exact origins to which server-supplied session endpoints may grant OAuth. Default: configured upload origin only. */
  readonly uploadOrigins?: readonly string[];
  /** Exact origins for signed file capabilities. Default empty; no implicit Box suffix trust. */
  readonly downloadOrigins?: readonly string[];
  readonly allowHttp?: boolean;
  readonly request?: RequestPolicyType;
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
  readonly maxParts?: number;
}
/** Creation names are literal provider names. Replacement uses a stable native ID. */
export type BoxTargetType =
  | Readonly<{ kind: "create"; folderId: string; name: string }>
  | Readonly<{ kind: "replace"; fileId: string; ifMatch?: string }>;
/** Native marker pages do not establish a directory snapshot. */
export interface BoxPageType {
  readonly entries: readonly BoxItemType[];
  readonly nextMarker?: string;
}
/** Download is pinned to a selected native version and transfers stream ownership. */
export interface BoxDownloadType {
  readonly fileId: string;
  readonly version: BoxVersionType;
  readonly bytes: ReadableStream<Uint8Array>;
}
/** Byte ranges retain ordinary EOF clamping; no range digest proof is implied. */
export interface BoxReadOptionsType {
  readonly versionId?: string;
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Caller-retained session context contains its fixed source size and exact admitted endpoints. */
export interface BoxUploadType {
  readonly id: string;
  readonly size: number;
  readonly partSize: number;
  readonly totalParts: number;
  readonly expires: string;
  readonly target: BoxTargetType;
  readonly endpoint: string;
}
/** A part receipt acknowledges one extent, not a contiguous prefix or published file. */
export interface BoxPartType {
  readonly id: string;
  readonly offset: number;
  readonly size: number;
  readonly sha1: string;
}
/** Processing counts do not identify which extents are present. */
export interface BoxUploadStatusType {
  readonly upload: BoxUploadType;
  readonly processedParts: number;
}
/** Offset pagination can contain sparse positions; offset/total are provider item positions. */
export interface BoxPartsPageType {
  readonly parts: readonly BoxPartType[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}
/** HTTP 202 is an explicit pending commit, never a fabricated file receipt. */
export type BoxCommitType =
  | Readonly<{ complete: false; retryAfterSeconds: number }>
  | Readonly<{ complete: true; file: BoxFileType }>;
/** Fixed messages exclude signed URLs, tokens and raw provider bodies. */
export class BoxError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Box request failed with HTTP ${status}.`);
    this.name = "BoxError";
    this.status = status;
  }
}
/** A dispatched mutation without a validated receipt must not be blindly repeated. */
export class BoxPublicationError extends Error {
  constructor(cause: unknown) {
    super("Box mutation has no validated acknowledgement; reconcile before retrying.", { cause });
    this.name = "BoxPublicationError";
  }
}
/** A version may exist while its download capability is not ready yet. */
export class BoxPendingError extends Error {
  readonly retryAfterSeconds: number;
  constructor(seconds: number) {
    super("Box file content is not ready.");
    this.name = "BoxPendingError";
    this.retryAfterSeconds = seconds;
  }
}
/** Bound arithmetic before credentials and materialization. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid Box ${label}.`);
  return value;
}
/** IDs remain strings even if they exceed JavaScript's integer precision. */
function id(value: string): string {
  if (typeof value !== "string" || !/^\d{1,128}$/.test(value)) throw new TypeError("Invalid Box ID.");
  return value;
}
/** Control characters and malformed Unicode cannot enter HTTP headers or provider names. */
function text(value: string, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new TypeError(`Invalid Box ${label}.`);
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 31 || code === 127) throw new TypeError(`Invalid Box ${label}.`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`Invalid Box ${label}.`);
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError(`Invalid Box ${label}.`);
  }
  return value;
}
/** A checksum is native compatibility evidence, not an authenticity primitive. */
function sha1(value: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) throw new TypeError("Invalid Box SHA-1 checksum.");
  return value.toLowerCase();
}
/** Digest wire encoding is base64 of the binary hash, never base64 of its hex spelling. */
function digest(value: string): string {
  const hex = sha1(value);
  return `sha=${encodeBase64(Uint8Array.from({ length: 20 }, (_, at) => parseInt(hex.slice(at * 2, at * 2 + 2), 16)))}`;
}
/** Metadata wire optionals are mapped to absent public properties. */
function item(value: unknown): BoxItemType {
  const data = ItemSchema.parse(value);
  return {
    id: data.id,
    kind: data.type,
    name: data.name,
    ...(data.size === undefined ? {} : { size: data.size }),
    ...(data.sha1 === undefined ? {} : { sha1: sha1(data.sha1) }),
    ...(data.etag === undefined ? {} : { etag: data.etag }),
    ...(data.file_version === undefined ? {} : { versionId: data.file_version.id }),
    ...(data.parent == null ? {} : { parentId: data.parent.id }),
  };
}
/** Only stored files with an explicit current version support selected-version reads. */
function file(value: unknown, selected?: string): BoxFileType {
  const data = item(value);
  if (
    data.kind !== "file" || data.size === undefined || data.versionId === undefined ||
    selected !== undefined && selected !== data.id
  ) throw new TypeError("Box receipt requires the selected stored file and version.");
  return { ...data, kind: "file", size: data.size, versionId: data.versionId };
}
/** Snapshot nested targets before any token/hash await; names never become route segments. */
function target(value: BoxTargetType): BoxTargetType {
  if (value.kind === "create") {
    const name = text(value.name, "file name", 255);
    if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new TypeError("Invalid Box file name.");
    return { kind: "create", folderId: id(value.folderId), name };
  }
  if (value.kind !== "replace") throw new TypeError("Invalid Box upload target.");
  const ifMatch = value.ifMatch;
  return {
    kind: "replace",
    fileId: id(value.fileId),
    ...(ifMatch === undefined ? {} : { ifMatch: text(ifMatch, "native ETag", 1024) }),
  };
}
/** Explicit authorities admit credentials; URLs returned by a server do not enlarge this set. */
function endpoint(value: string | URL, allowHttp: boolean): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password ||
    url.search || url.hash || !url.pathname.endsWith("/")
  ) throw new TypeError("Invalid Box endpoint.");
  return url;
}
/** No wildcard, credentials, query, path suffix or fragment can masquerade as an origin. */
function origins(values: readonly string[], allowHttp: boolean): ReadonlySet<string> {
  return new Set(values.map((value) => {
    const url = endpoint(`${value.replace(/\/$/u, "")}/`, allowHttp);
    if (url.pathname !== "/") throw new TypeError("Box origin must not contain a path.");
    return url.origin;
  }));
}
/** Retry-After is explicit finite native advice. The library never sleeps or retries automatically. */
function retry(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d{1,8}$/.test(value)) {
    throw new TypeError("Box pending receipt requires bounded Retry-After seconds.");
  }
  return integer(Number(value), "Retry-After", 86400);
}
/** One exact body owner observes real EOF, not merely a declared Content-Length. */
function extent(source: ReadableStream<Uint8Array>, length: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(source);
  let remaining = length, ended = false, empty = 0;
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
            if (remaining !== 0) throw new TypeError("Box body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Box body requires byte chunks.");
          const chunk = toView(next.value);
          if (chunk.length > remaining) throw new TypeError("Box body exceeds the selected extent.");
          if (chunk.length === 0) { if (++empty > 16) throw new TypeError("Box body makes no progress."); }
          else empty = 0;
          remaining -= chunk.length;
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
    }, { highWaterMark: 0 }),
    signal,
    "Box content",
    "download",
  );
}

/** Native stateless client. Import and construction perform no network or account discovery. */
export class BoxClient {
  readonly #api: URL;
  readonly #upload: URL;
  readonly #uploadOrigins: ReadonlySet<string>;
  readonly #downloads: ReadonlySet<string>;
  readonly #http: boolean;
  readonly #token: BoxOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #context: Headers;
  readonly #bytes: number;
  readonly #pages: number;
  readonly #entries: number;
  readonly #parts: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: BoxOptionsType) {
    this.#http = options.allowHttp === true;
    this.#api = endpoint(options.endpoint ?? "https://api.box.com/2.0/", this.#http);
    this.#upload = endpoint(options.uploadEndpoint ?? "https://upload.box.com/api/2.0/", this.#http);
    this.#uploadOrigins = origins([this.#upload.origin, ...options.uploadOrigins ?? []], this.#http);
    this.#downloads = origins(options.downloadOrigins ?? [], this.#http);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#bytes = integer(options.maxBytes ?? 8 * 1024 * 1024, "byte budget", BOX_BUFFER_BYTES);
    this.#pages = integer(options.maxPages ?? 1000, "page budget", 100000);
    this.#entries = integer(options.maxEntries ?? 100000, "entry budget", 1000000);
    this.#parts = integer(options.maxParts ?? 10000, "part budget", 10000);
    this.#context = new Headers();
    if (options.asUser !== undefined) this.#context.set("As-User", id(options.asUser));
  }
  /** A request-local mutation receipt tracks actual transport dispatch, never shared mutable client state. */
  async #send(
    url: URL,
    method: string,
    headers: Headers,
    body: BodyInit | undefined,
    signal?: AbortSignal,
    mutation = false,
    authenticate = true,
  ): Promise<Response> {
    signal?.throwIfAborted();
    if (authenticate) {
      const token = await this.#token(new URL(url), signal);
      signal?.throwIfAborted();
      headers.set("Authorization", `Bearer ${text(token, "bearer token", 32768)}`);
      for (const [key, value] of this.#context) headers.set(key, value);
    }
    let dispatched = false;
    try {
      return await sendRequest(
        async (signal) => ({
          input: url,
          init: {
            method,
            headers,
            redirect: "manual",
            ...(body === undefined ? {} : { body }),
            ...(signal === undefined ? {} : { signal }),
          },
        }),
        {
          fetch: (input, init) => {
            dispatched = true;
            return this.#fetch(input, init);
          },
          replayable: false,
          metrics: this.#metrics,
          ...(this.#policy === undefined ? {} : { policy: this.#policy }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (reason) {
      if (mutation && dispatched) throw new BoxPublicationError(reason);
      throw reason;
    }
  }
  /** Response validation happens before cleanup; cleanup cannot erase a valid publication receipt. */
  async #json<Value>(
    response: Response,
    status: number,
    parse: (value: unknown) => Value,
    mutation = false,
  ): Promise<Value> {
    return await readResponse(response, async (text) => {
      if (response.status !== status) {
        const failure = new BoxError(response.status);
        if (mutation && (response.ok || response.status >= 500 || response.status >= 300 && response.status < 400)) {
          throw new BoxPublicationError(failure);
        }
        throw failure;
      }
      try {
        return parse(JSON.parse(await text()));
      } catch (reason) {
        if (mutation) throw new BoxPublicationError(reason);
        throw reason;
      }
    });
  }
  #url(route: string): URL {
    const url = new URL(route, this.#api);
    url.searchParams.set("fields", fields);
    return url;
  }
  /** Get one file by ID, with the explicit current version required for a pinned read. */
  async statFile(fileId: string, signal?: AbortSignal): Promise<BoxFileType> {
    const selected = id(fileId);
    return await this.#json(
      await this.#send(this.#url(`files/${selected}`), "GET", new Headers(), undefined, signal),
      200,
      (value) => file(value, selected),
    );
  }
  /** A retained version has its own ID and size, selected through the requested file route. */
  async statVersion(fileId: string, versionId: string, signal?: AbortSignal): Promise<BoxVersionType> {
    const selected = id(versionId);
    const url = new URL(`files/${id(fileId)}/versions/${selected}`, this.#api);
    url.searchParams.set("fields", "id,type,size,sha1");
    return await this.#json(
      await this.#send(url, "GET", new Headers(), undefined, signal),
      200,
      (value) => {
        const data = z.object({
          id: z.string(),
          type: z.literal("file_version"),
          size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          sha1: z.string().optional(),
        }).parse(value);
        if (data.id !== selected) throw new TypeError("Box returned another version.");
        return { id: selected, size: data.size, ...(data.sha1 === undefined ? {} : { sha1: sha1(data.sha1) }) };
      },
    );
  }
  /** Direct native children, marker pagination only. No folder snapshot or name uniqueness claim. */
  async listPage(
    folderId: string,
    options: { readonly marker?: string; readonly signal?: AbortSignal } = {},
  ): Promise<BoxPageType> {
    const url = this.#url(`folders/${id(folderId)}/items`);
    url.searchParams.set("usemarker", "true");
    url.searchParams.set("limit", "1000");
    if (options.marker !== undefined) url.searchParams.set("marker", text(options.marker, "marker", 8192));
    return await this.#json(await this.#send(url, "GET", new Headers(), undefined, options.signal), 200, (value) => {
      const data = z.object({
        entries: z.array(z.unknown()).max(Math.min(this.#entries, 1000)),
        next_marker: z.string().max(8192).nullable().optional(),
      }).parse(value);
      return {
        entries: data.entries.map(item),
        ...(data.next_marker ? { nextMarker: text(data.next_marker, "marker", 8192) } : {}),
      };
    });
  }
  /** Bound all pages and preserve provider order. Early return performs no background requests. */
  async *list(folderId: string, signal?: AbortSignal): AsyncIterableIterator<BoxItemType> {
    const selected = id(folderId), seen = new Set<string>();
    let marker: string | undefined, count = 0;
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.listPage(selected, {
        ...(marker === undefined ? {} : { marker }),
        ...(signal === undefined ? {} : { signal }),
      });
      count += result.entries.length;
      if (count > this.#entries) throw new RangeError("Box listing exceeds its entry budget.");
      for (const entry of result.entries) {
        signal?.throwIfAborted();
        yield entry;
      }
      if (result.nextMarker === undefined) return;
      if (seen.has(result.nextMarker)) throw new TypeError("Box listing repeated a marker.");
      seen.add(result.nextMarker);
      marker = result.nextMarker;
    }
    throw new RangeError("Box listing exceeds its page budget.");
  }
  /** Reject every capability outside caller-granted origins; signed query contents remain opaque secrets. */
  #capability(value: string, seen: ReadonlySet<string>): URL {
    if (value.length > 16384) throw new TypeError("Box download capability exceeds its URL budget.");
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid Box download capability.");
    }
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) || url.username || url.password ||
      url.hash || !this.#downloads.has(url.origin) || seen.has(url.href) || url.href.length > 16384
    ) throw new TypeError("Box download capability is outside its admitted authority or repeats.");
    return url;
  }
  /** Pin native version selection, then transfer server-trusted exact bytes. No range checksum claim. */
  async download(fileId: string, options: BoxReadOptionsType = {}): Promise<BoxDownloadType> {
    const selected = id(fileId),
      selectedRange = range(options),
      selectedVersion = options.versionId === undefined ? undefined : id(options.versionId);
    if (selectedRange.empty) throw new RangeError("Box download requires a nonempty extent.");
    const signal = selectedRange.signal;
    let version: BoxVersionType;
    if (selectedVersion !== undefined) version = await this.statVersion(selected, selectedVersion, signal);
    else {
      const data = await this.statFile(selected, signal);
      version = { id: data.versionId, size: data.size, ...(data.sha1 === undefined ? {} : { sha1: data.sha1 }) };
    }
    let url = new URL(`files/${selected}/content`, this.#api);
    url.searchParams.set("version", version.id);
    let authenticate = true;
    const seen = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      const headers = new Headers({ "Accept-Encoding": "identity" });
      if (selectedRange.header !== undefined) headers.set("Range", selectedRange.header);
      const response = await this.#send(url, "GET", headers, undefined, signal, false, authenticate);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = await readResponse(response, () => {
          if (hop === 3) throw new TypeError("Box download exceeded its redirect budget.");
          const location = response.headers.get("location");
          if (location === null) throw new TypeError("Box download redirect requires Location.");
          return this.#capability(location, seen);
        });
        seen.add(url.href);
        authenticate = false;
        continue;
      }
      if (
        response.status === 202 ||
        response.headers.has("retry-after") && response.status !== 200 && response.status !== 206
      ) {
        await readResponse(response, () => {
          throw new BoxPendingError(retry(response));
        });
      }
      if (!response.ok) {
        return await this.#json(response, 200, () => {
          throw new TypeError("Invalid Box download.");
        });
      }
      await assertRangeResponse(response, selectedRange);
      try {
        let length = version.size;
        if (selectedRange.header !== undefined) {
          if (Number(response.headers.get("content-range")!.split("/")[1]) !== version.size) {
            throw new TypeError("Box range total differs from selected version size.");
          }
          length = Math.min(selectedRange.end ?? version.size - 1, version.size - 1) - selectedRange.start + 1;
        }
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) {
          throw new TypeError("Box declared length differs from selected version size.");
        }
        if (response.body === null && length !== 0) throw new TypeError("Box download is missing its body.");
        return {
          fileId: selected,
          version,
          bytes: extent(
            response.body ?? new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            length,
            signal,
          ),
        };
      } catch (reason) {
        await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
        throw reason;
      }
    }
    throw new TypeError("Box download redirect budget exhausted.");
  }
  /** Finite read checks metadata admission before buffering. Zero length is local without existence evidence. */
  async read(fileId: string, options: BoxReadOptionsType = {}): Promise<Uint8Array> {
    const selected = range(options);
    if (selected.empty) return new Uint8Array();
    const captured = {
      ...(options.versionId === undefined ? {} : { versionId: id(options.versionId) }),
      ...(options.at === undefined ? {} : { at: selected.start }),
      ...(options.length === undefined ? {} : { length: options.length }),
      ...(selected.signal === undefined ? {} : { signal: selected.signal }),
    };
    const data = await this.download(fileId, captured);
    const length = selected.header === undefined
      ? data.version.size
      : Math.max(0, Math.min(selected.end ?? data.version.size - 1, data.version.size - 1) - selected.start + 1);
    if (length > this.#bytes) {
      const reason = new RangeError("Box read exceeds its byte budget.");
      await close([() => data.bytes.cancel(reason)], [reason]);
    }
    return await collectBytes(data.bytes, this.#bytes, selected.signal, "read", "Box content");
  }
  /** Native slots prevent byteLength/property shadowing from bypassing admission. */
  #owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (!isBytes(bytes)) throw new TypeError("Box upload requires Uint8Array bytes.");
    const view = toView(bytes);
    if (view.length > this.#bytes) throw new RangeError("Box upload exceeds its byte budget.");
    return new Uint8Array(view);
  }
  /** Exactly one complete File receipt is required before reporting publication. */
  #receipt(value: unknown, selected: BoxTargetType, size: number, expected?: string): BoxFileType {
    const data = z.object({ total_count: z.literal(1), entries: z.array(z.unknown()).length(1) }).parse(value);
    const stored = file(data.entries[0], selected.kind === "replace" ? selected.fileId : undefined);
    if (
      stored.size !== size || expected !== undefined && stored.sha1 !== expected ||
      selected.kind === "create" && stored.parentId !== undefined && stored.parentId !== selected.folderId
    ) throw new TypeError("Box publication receipt differs from the requested file.");
    return stored;
  }
  /** Bounded multipart upload; FormData owns copied bytes before OAuth awaits. */
  async upload(
    selectedTarget: BoxTargetType,
    bytes: Uint8Array,
    options: { readonly sha1?: string; readonly name?: string; readonly signal?: AbortSignal } = {},
  ): Promise<BoxFileType> {
    const selected = target(selectedTarget),
      owned = this.#owned(bytes),
      expected = options.sha1 === undefined ? undefined : sha1(options.sha1),
      signal = options.signal;
    // The pinned OpenAPI calls name optional in prose but requires it in the
    // multipart schema. This profile requires an explicit replacement name.
    const name = selected.kind === "create" ? selected.name : text(options.name!, "replacement file name", 255);
    if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new TypeError("Invalid Box file name.");
    const body = new FormData();
    body.append(
      "attributes",
      JSON.stringify(selected.kind === "create" ? { name, parent: { id: selected.folderId } } : { name }),
    );
    body.append("file", new Blob([owned]), name);
    const headers = new Headers();
    if (expected !== undefined) headers.set("Content-MD5", expected);
    if (selected.kind === "replace" && selected.ifMatch !== undefined) headers.set("If-Match", selected.ifMatch);
    const url = new URL(
      selected.kind === "create" ? "files/content" : `files/${selected.fileId}/content`,
      this.#upload,
    );
    url.searchParams.set("fields", fields);
    return await this.#json(
      await this.#send(url, "POST", headers, body, signal, true),
      selected.kind === "create" ? 201 : 200,
      (value) => this.#receipt(value, selected, owned.length, expected),
      true,
    );
  }
  /** Session paths bind every advertised endpoint to its ID and configured upload path. */
  #sessionUrl(value: string, sessionId: string, suffix = ""): URL {
    if (typeof value !== "string" || value.length > 16384) {
      throw new TypeError("Box session endpoint exceeds its URL budget.");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid Box session endpoint.");
    }
    const expected = new URL(`files/upload_sessions/${sessionId}${suffix}`, this.#upload).pathname;
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) ||
      !this.#uploadOrigins.has(url.origin) || url.username || url.password || url.search || url.hash ||
      url.pathname !== expected
    ) throw new TypeError("Box session endpoint differs from its admitted authority, path or ID.");
    return url;
  }
  /** Captures a resumed session before any I/O; caller still owns source identity/exclusive use. */
  #capture(upload: BoxUploadType): BoxUploadType {
    const sessionId = text(upload.id, "session ID", 256);
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError("Invalid Box session ID.");
    const size = integer(upload.size, "session file size"),
      partSize = integer(upload.partSize, "part size", this.#bytes),
      totalParts = integer(upload.totalParts, "total parts", this.#parts);
    if (size === 0 || partSize === 0 || totalParts !== Math.ceil(size / partSize)) {
      throw new TypeError("Box session has inconsistent fixed extents.");
    }
    return {
      id: sessionId,
      size,
      partSize,
      totalParts,
      expires: text(upload.expires, "session expiry", 128),
      target: target(upload.target),
      endpoint: this.#sessionUrl(upload.endpoint, sessionId).href,
    };
  }
  /** Server-selected part size and every endpoint are validated before follow-up OAuth grants. */
  #session(value: unknown, selected: BoxTargetType, size: number, expectedId?: string): BoxUploadStatusType {
    const data = z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
      type: z.literal("upload_session"),
      session_expires_at: z.string().max(128),
      part_size: z.number(),
      total_parts: z.number(),
      num_parts_processed: z.number(),
      session_endpoints: z.object({
        upload_part: z.string().max(16384),
        status: z.string().max(16384),
        abort: z.string().max(16384),
        commit: z.string().max(16384),
        list_parts: z.string().max(16384),
      }),
    }).parse(value);
    if (expectedId !== undefined && data.id !== expectedId) throw new TypeError("Box returned another upload session.");
    const authority = this.#sessionUrl(data.session_endpoints.upload_part, data.id).origin;
    for (
      const [key, suffix] of [["upload_part", ""], ["status", ""], ["abort", ""], ["commit", "/commit"], [
        "list_parts",
        "/parts",
      ]] as const
    ) {
      if (this.#sessionUrl(data.session_endpoints[key], data.id, suffix).origin !== authority) {
        throw new TypeError("Box session endpoints must share one explicitly admitted authority in this profile.");
      }
    }
    const upload = this.#capture({
      id: data.id,
      size,
      partSize: data.part_size,
      totalParts: data.total_parts,
      expires: data.session_expires_at,
      target: selected,
      endpoint: data.session_endpoints.upload_part,
    });
    return { upload, processedParts: integer(data.num_parts_processed, "processed part count", upload.totalParts) };
  }
  /** Native create/replace sessions; account size permissions and minimum-size enforcement remain provider-owned. */
  async startUpload(selectedTarget: BoxTargetType, size: number, signal?: AbortSignal): Promise<BoxUploadType> {
    const selected = target(selectedTarget), amount = integer(size, "file size");
    if (amount === 0) {
      throw new RangeError("Box chunked sessions require a nonempty file; use multipart for empty files.");
    }
    const url = new URL(
      selected.kind === "create" ? "files/upload_sessions" : `files/${selected.fileId}/upload_sessions`,
      this.#upload,
    );
    const body = JSON.stringify(
      selected.kind === "create"
        ? { folder_id: selected.folderId, file_name: selected.name, file_size: amount }
        : { file_size: amount },
    );
    return await this.#json(
      await this.#send(url, "POST", new Headers({ "Content-Type": "application/json" }), body, signal, true),
      201,
      (value) => this.#session(value, selected, amount).upload,
      true,
    );
  }
  /** A processed count is not an acknowledged prefix. Inspect individual parts to recover gaps. */
  async statusUpload(upload: BoxUploadType, signal?: AbortSignal): Promise<BoxUploadStatusType> {
    const captured = this.#capture(upload);
    return await this.#json(
      await this.#send(new URL(captured.endpoint), "GET", new Headers(), undefined, signal),
      200,
      (value) => {
        const data = this.#session(value, captured.target, captured.size, captured.id);
        if (
          data.upload.partSize !== captured.partSize || data.upload.totalParts !== captured.totalParts ||
          data.upload.endpoint !== captured.endpoint
        ) throw new TypeError("Box upload session changed its fixed layout.");
        return data;
      },
    );
  }
  #part(value: unknown, upload: BoxUploadType): BoxPartType {
    const data = PartSchema.parse(value);
    if (
      data.offset % upload.partSize !== 0 || data.offset >= upload.size ||
      data.size !== Math.min(upload.partSize, upload.size - data.offset)
    ) throw new TypeError("Box part differs from its fixed source extent.");
    return { id: data.part_id, offset: data.offset, size: data.size, sha1: sha1(data.sha1) };
  }
  /** One native offset page of processed parts. This SHA-1 profile rejects foreign hash-only part receipts. */
  async partsPage(
    upload: BoxUploadType,
    options: { readonly offset?: number; readonly signal?: AbortSignal } = {},
  ): Promise<BoxPartsPageType> {
    const captured = this.#capture(upload),
      offset = integer(options.offset ?? 0, "part page offset", 10000),
      signal = options.signal;
    const url = new URL(`${captured.endpoint}/parts`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "1000");
    return await this.#json(await this.#send(url, "GET", new Headers(), undefined, signal), 200, (value) => {
      const data = z.object({
        entries: z.array(z.unknown()).max(1000),
        offset: z.number(),
        limit: z.number(),
        total_count: z.number(),
      }).parse(value);
      const total = integer(data.total_count, "part collection bound", this.#parts),
        limit = integer(data.limit, "part page limit", 1000);
      if (
        data.offset !== offset || limit === 0 || data.entries.length > limit || total < offset + data.entries.length
      ) throw new TypeError("Box part page has inconsistent positions.");
      const parts = data.entries.map((value) => this.#part(value, captured));
      this.#validateParts(parts, captured, false);
      return { parts, offset, limit, total };
    });
  }
  /** Bounded complete traversal advances by returned limit, not sparse entry count. */
  async listParts(upload: BoxUploadType, signal?: AbortSignal): Promise<readonly BoxPartType[]> {
    const captured = this.#capture(upload), parts: BoxPartType[] = [];
    let offset = 0, total: number | undefined;
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.partsPage(captured, { offset, ...(signal === undefined ? {} : { signal }) });
      if (total !== undefined && result.total !== total) {
        throw new TypeError("Box part collection changed during traversal.");
      }
      total = result.total;
      parts.push(...result.parts);
      this.#validateParts(parts, captured, false);
      offset += result.limit;
      if (offset >= total) return parts;
    }
    throw new RangeError("Box parts exceed the page budget.");
  }
  /** Hash and snapshot one bounded part before upload. SHA-1 remains native error detection only. */
  async uploadPart(
    upload: BoxUploadType,
    at: number,
    bytes: Uint8Array,
    options: { readonly subtle: Pick<SubtleCrypto, "digest">; readonly signal?: AbortSignal },
  ): Promise<BoxPartType> {
    const captured = this.#capture(upload),
      offset = integer(at, "part offset"),
      owned = this.#owned(bytes),
      subtle = options.subtle,
      signal = options.signal;
    if (
      offset % captured.partSize !== 0 || offset >= captured.size ||
      owned.length !== Math.min(captured.partSize, captured.size - offset)
    ) throw new TypeError("Box part does not match its required alignment/length.");
    signal?.throwIfAborted();
    const hashBytes = new Uint8Array(await subtle.digest("SHA-1", owned));
    signal?.throwIfAborted();
    if (hashBytes.length !== 20) throw new TypeError("SHA-1 capability returned an invalid digest length.");
    const expected = Array.from(hashBytes, (value) => value.toString(16).padStart(2, "0")).join("");
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      Digest: digest(expected),
      "Content-Range": `bytes ${offset}-${offset + owned.length - 1}/${captured.size}`,
    });
    return await this.#json(
      await this.#send(new URL(captured.endpoint), "PUT", headers, toRequestBytes(owned), signal, true),
      200,
      (value) => {
        const wire = z.object({ part: z.unknown() }).parse(value), data = this.#part(wire.part, captured);
        if (data.offset !== offset || data.size !== owned.length || data.sha1 !== expected) {
          throw new TypeError(
            "Box part receipt differs from the uploaded bytes.",
          );
        }
        return data;
      },
      true,
    );
  }
  /** One identity per nonoverlapping extent; complete commits require a gap-free source cover. */
  #validateParts(parts: readonly BoxPartType[], upload: BoxUploadType, complete: boolean): readonly BoxPartType[] {
    if (parts.length > this.#parts || parts.length > upload.totalParts) {
      throw new RangeError("Box parts exceed their budget.");
    }
    const ids = new Set<string>();
    const sorted = parts.map((part) =>
      this.#part({ part_id: part.id, offset: part.offset, size: part.size, sha1: part.sha1 }, upload)
    ).sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const part of sorted) {
      if (ids.has(part.id) || part.offset < end || complete && part.offset !== end) {
        throw new TypeError("Box parts overlap, repeat or leave a commit gap.");
      }
      ids.add(part.id);
      end = part.offset + part.size;
    }
    if (complete && (sorted.length !== upload.totalParts || end !== upload.size)) {
      throw new TypeError("Box commit requires a complete source cover.");
    }
    return sorted;
  }
  /** One explicit commit attempt. 202 advises a later caller-owned attempt; only 201 is a file receipt. */
  async commitUpload(
    upload: BoxUploadType,
    parts: readonly BoxPartType[],
    options: { readonly sha1: string; readonly signal?: AbortSignal },
  ): Promise<BoxCommitType> {
    const captured = this.#capture(upload), expected = sha1(options.sha1), signal = options.signal;
    const sorted = this.#validateParts(parts, captured, true);
    const body = JSON.stringify({
      parts: sorted.map((part) => ({ part_id: part.id, offset: part.offset, size: part.size, sha1: part.sha1 })),
    });
    if (body.length > 8 * 1024 * 1024) throw new RangeError("Box commit body exceeds its control budget.");
    const headers = new Headers({ "Content-Type": "application/json", Digest: digest(expected) });
    if (captured.target.kind === "replace" && captured.target.ifMatch !== undefined) {
      headers.set("If-Match", captured.target.ifMatch);
    }
    const response = await this.#send(new URL(`${captured.endpoint}/commit`), "POST", headers, body, signal, true);
    if (response.status === 202) {
      return await readResponse(response, () => {
        try {
          return { complete: false as const, retryAfterSeconds: retry(response) };
        } catch (reason) {
          throw new BoxPublicationError(reason);
        }
      });
    }
    return await this.#json(
      response,
      201,
      (value) => ({ complete: true, file: this.#receipt(value, captured.target, captured.size, expected) }),
      true,
    );
  }
  /** Explicit session cancellation does not delete a published file or reconcile an ambiguous commit. */
  async abortUpload(upload: BoxUploadType, signal?: AbortSignal): Promise<void> {
    const captured = this.#capture(upload);
    const response = await this.#send(new URL(captured.endpoint), "DELETE", new Headers(), undefined, signal, true);
    await readResponse(response, () => {
      if (response.status !== 204) {
        const failure = new BoxError(response.status);
        if (response.ok || response.status >= 500 || response.status >= 300 && response.status < 400) {
          throw new BoxPublicationError(failure);
        }
        throw failure;
      }
    });
  }
}
