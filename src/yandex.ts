/** Native Yandex Disk REST paths, explicit content authority and asynchronous receipts. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Local buffer ceiling, independent of subscription-dependent provider file limits. */
export const YANDEX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Paths are mutable native addresses. These fields establish no immutable version or ID. */
export interface YandexResourceType {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly md5?: string;
  readonly mediaType?: string;
  readonly modified?: string;
}
/** One native offset page; concurrent directory changes can make pagination omit entries. */
export interface YandexPageType {
  readonly directory: YandexResourceType;
  readonly entries: readonly YandexResourceType[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}
/** Only the native operation route on the configured API authority may receive OAuth. */
export interface YandexOperationType {
  readonly id: string;
  readonly href: string;
}
/** Completion acknowledges the service's operation, not atomic tree or revision semantics. */
export type YandexMutationType =
  | {
    readonly state: "completed";
    readonly path: string;
    readonly from?: string;
    readonly acknowledgment: "http-201" | "http-204";
  }
  | {
    readonly state: "pending";
    readonly path: string;
    readonly from?: string;
    readonly operation: YandexOperationType;
    readonly acknowledgment: "http-202";
  };
/** Upload202 has no documented operation link, so it must not be promoted to completed. */
export type YandexUploadType =
  | { readonly state: "created"; readonly path: string; readonly size: number; readonly acknowledgment: "http-201" }
  | { readonly state: "pending"; readonly path: string; readonly size: number; readonly acknowledgment: "http-202" };
/** Token issuance/account identity belong to the caller; construction does no discovery. */
export interface YandexOptionsType {
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly fetch?: FetchType;
  readonly endpoint?: string | URL;
  readonly request?: RequestPolicyType;
  /** Exact origins for all download hops; defaults to none. */
  readonly downloadOrigins?: readonly string[];
  /** Separate exact grant for OAuth on the INITIAL download hop only. Defaults to none. */
  readonly downloadAuthOrigins?: readonly string[];
  /** Exact signed PUT origins, with no OAuth and no redirect forwarding. Defaults to none. */
  readonly uploadOrigins?: readonly string[];
  readonly allowHttp?: boolean;
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxEntries?: number;
}
/** Extent validation is separate from provider-verified immutable source identity. */
export interface YandexReadOptionsType {
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Caller owns this stream and must consume or cancel it. */
export interface YandexDownloadType {
  readonly resource: YandexResourceType;
  readonly bytes: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly evidence: "server-trusted";
}
/** Sanitized service failure; arbitrary injected capability errors retain caller-owned context. */
export class YandexError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Yandex Disk request failed.");
    this.name = "YandexError";
    this.status = status;
  }
}
/** Dispatch occurred without a delivered trustworthy receipt. Reconcile before another mutation. */
export class YandexPublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Yandex Disk mutation outcome is unknown; reconcile before retrying.", { cause });
    this.name = "YandexPublicationError";
  }
}
const ResourceSchema = z.object({
  path: z.string(),
  name: z.string().max(255),
  type: z.enum(["file", "dir"]),
  size: z.number().optional(),
  md5: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  mime_type: z.string().max(1024).optional(),
  modified: z.string().max(128).optional(),
});
const LinkSchema = z.object({
  href: z.string().min(1).max(65536),
  method: z.enum(["GET", "PUT"]),
  templated: z.literal(false),
});
/** Finite local bounds precede allocations, arithmetic and borrowed capability acquisition. */
function integer(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Invalid Yandex Disk ${label}.`);
  }
  return value;
}
/** No decoding/normalization: a literal '%' in a name is encoded once by URLSearchParams. */
function path(value: string, mutation = false): string {
  if (typeof value !== "string" || value.length > 32760 || !value.startsWith("disk:/") || !value.isWellFormed()) {
    throw new TypeError("Yandex Disk requires a bounded canonical disk:/ path.");
  }
  if (new TextEncoder().encode(value).length > 32768) {
    throw new RangeError("Yandex Disk path exceeds the local UTF-8 budget.");
  }
  if (
    value !== "disk:/" &&
    value.slice(6).split("/").some((part) =>
      !part || part === "." || part === ".." || part.length > 255 || part.includes("\\") || part.includes("\0")
    )
  ) throw new TypeError("Invalid Yandex Disk path component.");
  if (mutation && value === "disk:/") throw new TypeError("Yandex Disk root mutations are not admitted.");
  return value;
}
/** Native URL parsing errors can include signed input, so they must not cross this boundary. */
function url(value: string | URL, base?: URL): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new TypeError("Invalid Yandex Disk URL.");
  }
}
function separators(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 32 || code === 127 || code === 92) return true;
  }
  return false;
}
function endpoint(value: string | URL, http: boolean): URL {
  const result = url(value);
  if (
    (result.protocol !== "https:" && !(http && result.protocol === "http:")) || result.username || result.password ||
    result.search || result.hash || !result.pathname.endsWith("/")
  ) throw new TypeError("Invalid Yandex Disk API endpoint.");
  return result;
}
function origins(values: readonly string[], http: boolean): ReadonlySet<string> {
  return new Set(values.map((value) => {
    const result = endpoint(value.endsWith("/") ? value : value + "/", http);
    if (result.pathname !== "/") throw new TypeError("Yandex Disk grants require exact origins.");
    return result.origin;
  }));
}
/**
 * Duplicate-aware preflight protects link/path authority before JSON.parse can
 * overwrite it. The selected response profile contains only safe integer numeric
 * fields; fractions/exponents are refused before rounding. Depth32, 1M tokens,
 * 196608-character lexical strings and 128-character scalar tokens cap work.
 */
function json(text: string): unknown {
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget Yandex Disk JSON.");
  };
  const count = (): void => {
    if (++tokens > 1000000) fail();
  };
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (at - start > 196608) fail();
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, at));
          if (typeof parsed !== "string") return fail();
          return parsed;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(depth: number): void {
    count();
    if (depth > 32) fail();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (true) {
        count();
        space();
        if (text[at] !== '"') fail();
        const key = string();
        if (["__proto__", "constructor", "prototype"].includes(key) || keys.has(key)) fail();
        keys.add(key);
        space();
        if (text[at++] !== ":") fail();
        value(depth + 1);
        space();
        const end = text[at++];
        if (end === "}") return;
        if (end !== ",") fail();
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (true) {
        value(depth + 1);
        space();
        const end = text[at++];
        if (end === "]") return;
        if (end !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start >= 128) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (["true", "false", "null"].includes(raw)) return;
    if (!/^-?(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail();
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
/** Native paths and selected kind must agree; metadata is server evidence, not a revision receipt. */
function resource(value: unknown, expected?: string): YandexResourceType {
  const data = ResourceSchema.parse(value), selected = path(data.path);
  if (
    expected !== undefined && selected !== expected ||
    selected !== "disk:/" && selected.slice(selected.lastIndexOf("/") + 1) !== data.name
  ) throw new TypeError("Yandex Disk resource path/name differs.");
  const size = data.type === "file" ? integer(data.size!, Number.MAX_SAFE_INTEGER, "file size") : undefined;
  return {
    path: selected,
    name: data.name,
    kind: data.type === "file" ? "file" : "directory",
    ...(size === undefined ? {} : { size }),
    ...(data.md5 === undefined ? {} : { md5: data.md5 }),
    ...(data.mime_type === undefined ? {} : { mediaType: data.mime_type }),
    ...(data.modified === undefined ? {} : { modified: data.modified }),
  };
}
/** Exact extent publication waits for true EOF, retaining primary failure when cancellation fails. */
function extent(source: ReadableStream<Uint8Array>, length: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(source);
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
            if (left !== 0) throw new TypeError("Yandex Disk body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Yandex Disk body requires bytes.");
          const chunk = toView(next.value);
          if (chunk.length > left) throw new TypeError("Yandex Disk body exceeds the selected extent.");
          if (!chunk.length) { if (++empty > 16) throw new TypeError("Yandex Disk body makes no progress."); }
          else empty = 0;
          left -= chunk.length;
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
    "Yandex Disk content",
    "download",
  );
}
const fields = "path,name,type,size,md5,mime_type,modified";
/** Native REST client; none of its methods promises canonical filesystem or immutable source semantics. */
export class YandexClient {
  readonly #api: URL;
  readonly #token: YandexOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #downloads: ReadonlySet<string>;
  readonly #downloadAuth: ReadonlySet<string>;
  readonly #uploads: ReadonlySet<string>;
  readonly #bytes: number;
  readonly #pages: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: YandexOptionsType) {
    const http = options.allowHttp === true;
    this.#api = endpoint(options.endpoint ?? "https://cloud-api.yandex.net/v1/disk/", http);
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request === undefined ? undefined : { ...options.request };
    this.#downloads = origins(options.downloadOrigins ?? [], http);
    this.#downloadAuth = origins(options.downloadAuthOrigins ?? [], http);
    this.#uploads = origins(options.uploadOrigins ?? [], http);
    for (const origin of this.#downloadAuth) {
      if (!this.#downloads.has(origin)) {
        throw new TypeError("Yandex Disk download credential grant needs the same content-origin grant.");
      }
    }
    this.#bytes = integer(options.maxBytes ?? 8 * 1024 * 1024, YANDEX_BUFFER_BYTES, "byte budget");
    this.#pages = integer(options.maxPages ?? 1000, 100000, "page budget");
    this.#entries = integer(options.maxEntries ?? 100000, 1000000, "entry budget");
  }
  #url(route: string, params: Record<string, string> = {}): URL {
    const result = new URL(route, this.#api);
    for (const [key, value] of Object.entries(params)) result.searchParams.set(key, value);
    return result;
  }
  async #credential(target: URL, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const token = await this.#token(new URL(target), signal);
    signal?.throwIfAborted();
    if (typeof token !== "string" || !token.length || token.length > 32768 || separators(token)) {
      throw new TypeError("Invalid Yandex Disk OAuth token.");
    }
    return token;
  }
  /** Only a private operation token can cross its explicitly admitted initial download boundary. */
  async #send(
    target: URL,
    method: string,
    signal?: AbortSignal,
    token?: string,
    body?: Uint8Array<ArrayBuffer>,
    rangeHeader?: string,
    mutation = false,
    jsonHeaders = true,
  ): Promise<Response> {
    const headers = new Headers();
    if (token !== undefined) headers.set("Authorization", `OAuth ${token}`);
    if (jsonHeaders) {
      headers.set("Accept", "application/json");
      headers.set("Content-Type", "application/json");
    }
    if (body !== undefined) headers.set("Content-Type", "application/octet-stream");
    if (rangeHeader !== undefined) headers.set("Range", rangeHeader);
    let dispatched = false;
    try {
      return await sendRequest(
        async (signal) => ({
          input: target,
          init: {
            method,
            headers,
            credentials: "omit",
            redirect: "manual",
            referrerPolicy: "no-referrer",
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
      if (mutation && dispatched) throw new YandexPublicationError(reason);
      throw reason;
    }
  }
  /** Metadata parsing happens inside response ownership; mutation delivery failures remain unknown. */
  async #json<Value>(
    response: Response,
    parse: (value: unknown) => Value,
    mutation = false,
    expected = 200,
  ): Promise<Value> {
    try {
      return await readResponse(response, async (text) => {
        if (response.status !== expected) throw new YandexError(response.status);
        return parse(json(await text()));
      });
    } catch (reason) {
      if (mutation) throw new YandexPublicationError(reason);
      throw reason;
    }
  }
  async #stat(selected: string, token: string, signal?: AbortSignal): Promise<YandexResourceType> {
    return await this.#json(
      await this.#send(this.#url("resources", { path: selected, fields }), "GET", signal, token),
      (value) => resource(value, selected),
    );
  }
  /** Get selected native metadata without treating modified time or MD5 as a revision condition. */
  async stat(value: string, signal?: AbortSignal): Promise<YandexResourceType> {
    const selected = path(value), target = this.#url("resources", { path: selected });
    const token = await this.#credential(target, signal);
    return await this.#stat(selected, token, signal);
  }
  /** Native offset pagination is finite but cannot be made snapshot-consistent by the client. */
  async listPage(
    value: string,
    options: { readonly offset?: number; readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<YandexPageType> {
    const selected = path(value),
      offset = integer(options.offset ?? 0, Number.MAX_SAFE_INTEGER, "offset"),
      limit = integer(options.limit ?? 100, 1000, "page limit"),
      signal = options.signal;
    if (limit === 0) throw new RangeError("Yandex Disk list pages need a positive limit.");
    const target = this.#url("resources", {
      path: selected,
      offset: String(offset),
      limit: String(limit),
      sort: "name",
      fields: `${fields},_embedded.items.${
        fields.split(",").join(",_embedded.items.")
      },_embedded.offset,_embedded.limit,_embedded.total,_embedded.path`,
    });
    return await this.#json(
      await this.#send(target, "GET", signal, await this.#credential(target, signal)),
      (value) => {
        const directory = resource(value, selected);
        if (directory.kind !== "directory") throw new TypeError("Yandex Disk list target is not a directory.");
        const data = z.object({
          _embedded: z.object({
            items: z.array(z.unknown()).max(Math.min(limit, this.#entries)),
            offset: z.number(),
            limit: z.number(),
            total: z.number(),
            path: z.string(),
          }),
        }).parse(value)._embedded;
        const total = integer(data.total, Number.MAX_SAFE_INTEGER, "total");
        if (
          data.offset !== offset || data.limit !== limit || path(data.path) !== selected ||
          data.items.length > Math.max(0, total - offset)
        ) throw new TypeError("Yandex Disk page differs from requested bounds.");
        const prefix = selected.endsWith("/") ? selected : selected + "/", seen = new Set<string>();
        const entries = data.items.map((value) => {
          const item = resource(value), suffix = item.path.slice(prefix.length);
          if (
            !item.path.startsWith(prefix) || !suffix || suffix.includes("/") || seen.has(item.path)
          ) throw new TypeError("Yandex Disk list returned duplicate or non-child paths.");
          seen.add(item.path);
          return item;
        });
        if (offset < total && entries.length === 0) throw new TypeError("Yandex Disk page makes no progress.");
        return { directory, entries, offset, limit, total };
      },
    );
  }
  /** Collect bounded offset pages; changes during listing may still omit resources. */
  async list(value: string, signal?: AbortSignal): Promise<readonly YandexResourceType[]> {
    const selected = path(value), entries: YandexResourceType[] = [], seen = new Set<string>();
    let offset = 0;
    for (let page = 0; page < this.#pages; page++) {
      const data = await this.listPage(selected, { offset, limit: 100, ...(signal === undefined ? {} : { signal }) });
      for (const entry of data.entries) {
        if (entries.length >= this.#entries) throw new RangeError("Yandex Disk listing exceeds its entry budget.");
        if (seen.has(entry.path)) throw new TypeError("Yandex Disk offset pages repeat a resource.");
        seen.add(entry.path);
        entries.push(entry);
      }
      if (data.entries.length >= data.total - offset) return entries;
      offset = integer(offset + data.entries.length, Number.MAX_SAFE_INTEGER, "next offset");
    }
    throw new RangeError("Yandex Disk listing exceeds its page budget.");
  }
  /** Link evidence never expands content or credential grants. Template expansion is not supported. */
  #content(value: unknown, method: "GET" | "PUT", allowed: ReadonlySet<string>): URL {
    const data = LinkSchema.parse(value);
    if (data.method !== method || separators(data.href)) throw new TypeError("Invalid Yandex Disk content link.");
    const target = url(data.href);
    if (target.username || target.password || target.hash || !allowed.has(target.origin)) {
      throw new TypeError("Yandex Disk content origin is not explicitly granted.");
    }
    return target;
  }
  async #downloadLink(selected: string, token: string, signal?: AbortSignal): Promise<URL> {
    return await this.#json(
      await this.#send(this.#url("resources/download", { path: selected }), "GET", signal, token),
      (value) => this.#content(value, "GET", this.#downloads),
    );
  }
  /** Low-level secret link; this method never returns the operation token. */
  async getDownloadLink(value: string, signal?: AbortSignal): Promise<string> {
    const selected = path(value), target = this.#url("resources/download", { path: selected });
    return (await this.#downloadLink(selected, await this.#credential(target, signal), signal)).href;
  }
  /** Borrow one token for metadata/link/INITIAL granted download; all redirect hops permanently strip it. */
  async #download(value: string, options: YandexReadOptionsType, maximum?: number): Promise<YandexDownloadType> {
    const selectedPath = path(value), selected = range(options), signal = selected.signal;
    if (selected.empty) throw new RangeError("Use read() for an empty local Yandex Disk read.");
    const token = await this.#credential(this.#url("resources/download", { path: selectedPath }), signal);
    const stored = await this.#stat(selectedPath, token, signal);
    if (stored.kind !== "file" || stored.size === undefined) {
      throw new TypeError("Yandex Disk download requires a stored file.");
    }
    if (selected.header !== undefined && selected.start >= stored.size) {
      throw new RangeError("Yandex Disk range starts beyond EOF.");
    }
    const length = selected.header === undefined
      ? stored.size
      : Math.min(selected.end ?? stored.size - 1, stored.size - 1) - selected.start + 1;
    if (maximum !== undefined && length > maximum) throw new RangeError("Yandex Disk read exceeds its byte budget.");
    let target = await this.#downloadLink(selectedPath, token, signal);
    if (!this.#downloadAuth.has(target.origin)) {
      throw new TypeError("Yandex Disk initial download OAuth origin is not explicitly granted.");
    }
    const visited = new Set<string>();
    for (let hop = 0; hop <= 3; hop++) {
      if (
        !this.#downloads.has(target.origin) || target.username || target.password || target.hash ||
        visited.has(target.href)
      ) throw new TypeError("Invalid or repeated Yandex Disk download hop.");
      visited.add(target.href);
      const response = await this.#send(
        target,
        "GET",
        signal,
        hop === 0 ? token : undefined,
        undefined,
        selected.header,
        false,
        false,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await close(response.body === null ? [] : [() => response.body!.cancel()]);
        if (location === null || location.length > 65536 || separators(location)) {
          throw new TypeError("Invalid Yandex Disk redirect.");
        }
        target = url(location, target);
        continue;
      }
      await assertRangeResponse(response, selected);
      try {
        const declared = response.headers.get("content-length");
        if (
          declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== length) ||
          selected.header !== undefined && Number(response.headers.get("content-range")?.split("/")[1]) !== stored.size
        ) throw new TypeError("Yandex Disk content size differs from metadata.");
        if (response.body === null && length !== 0) throw new TypeError("Yandex Disk content body is missing.");
        return {
          resource: stored,
          length,
          evidence: "server-trusted",
          bytes: extent(
            response.body ?? new ReadableStream<Uint8Array>({
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
    throw new TypeError("Yandex Disk redirect budget exhausted.");
  }
  /** Stream bytes with exact extent validation, without immutable revision evidence. */
  async download(value: string, options: YandexReadOptionsType = {}): Promise<YandexDownloadType> {
    return await this.#download(value, options);
  }
  /** Bounded materialization preflights metadata before opening content; empty reads are local. */
  async read(value: string, options: YandexReadOptionsType = {}): Promise<Uint8Array> {
    const selected = range(options), selectedPath = path(value);
    if (selected.empty) return new Uint8Array();
    const captured = {
      ...(selected.header === undefined
        ? {}
        : { at: selected.start, ...(selected.end === undefined ? {} : { length: selected.end - selected.start + 1 }) }),
      ...(selected.signal === undefined ? {} : { signal: selected.signal }),
    };
    const data = await this.#download(selectedPath, captured, this.#bytes);
    return await collectBytes(data.bytes, this.#bytes, selected.signal, selectedPath, "Yandex Disk content");
  }
  /** Validate signed uploader authority inside the client, without virtual public-method overrides. */
  async #uploadLink(selected: string, overwrite: boolean, signal?: AbortSignal): Promise<URL> {
    const target = this.#url("resources/upload", { path: selected, overwrite: String(overwrite) });
    return await this.#json(
      await this.#send(target, "GET", signal, await this.#credential(target, signal)),
      (value) => this.#content(value, "PUT", this.#uploads),
    );
  }
  /** Upload links expire if unused for 30 minutes per native docs. This does not create a resume session. */
  async getUploadLink(
    value: string,
    options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  ): Promise<string> {
    const selected = path(value, true), overwrite = options.overwrite, signal = options.signal;
    if (typeof overwrite !== "boolean") throw new TypeError("Choose native Yandex Disk overwrite behavior.");
    return (await this.#uploadLink(selected, overwrite, signal)).href;
  }
  /** One copied PUT, no OAuth, redirects or retry. 201/202 are different native acknowledgments. */
  async upload(
    value: string,
    bytes: Uint8Array,
    options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  ): Promise<YandexUploadType> {
    const selected = path(value, true), overwrite = options.overwrite, signal = options.signal;
    signal?.throwIfAborted();
    if (typeof overwrite !== "boolean" || !isBytes(bytes)) {
      throw new TypeError("Yandex Disk upload needs bytes and explicit overwrite behavior.");
    }
    const view = toView(bytes);
    if (view.length > this.#bytes) throw new RangeError("Yandex Disk upload exceeds its byte budget.");
    const owned = new Uint8Array(view);
    const target = await this.#uploadLink(selected, overwrite, signal);
    const response = await this.#send(target, "PUT", signal, undefined, owned, undefined, true, false);
    try {
      return await readResponse<YandexUploadType>(response, async (text) => {
        if (response.status !== 201 && response.status !== 202) throw new YandexError(response.status);
        await text();
        return response.status === 201
          ? { state: "created", path: selected, size: owned.length, acknowledgment: "http-201" }
          : { state: "pending", path: selected, size: owned.length, acknowledgment: "http-202" };
      });
    } catch (reason) {
      throw new YandexPublicationError(reason);
    }
  }
  /** Returned operation URLs may use native path-ID or sole id-query spelling, never arbitrary API routes. */
  #operation(value: unknown): YandexOperationType {
    const data = LinkSchema.parse(value);
    if (data.method !== "GET" || separators(data.href)) throw new TypeError("Invalid Yandex Disk operation link.");
    const target = url(data.href), base = this.#url("operations");
    let id: string | undefined;
    if (target.origin !== base.origin || target.username || target.password || target.hash) {
      throw new TypeError("Yandex Disk operation authority differs.");
    }
    if (
      target.pathname === base.pathname && [...target.searchParams.keys()].length === 1 && target.searchParams.has("id")
    ) id = target.searchParams.get("id")!;
    else if (target.pathname.startsWith(base.pathname + "/") && !target.search) {
      id = target.pathname.slice(base.pathname.length + 1);
    }
    if (id === undefined || !/^[A-Za-z0-9_-]{1,512}$/.test(id)) {
      throw new TypeError("Invalid Yandex Disk operation identity.");
    }
    return { id, href: target.href };
  }
  /** Completed-resource links must describe exactly the requested native target, not a redirect or a new grant. */
  #resourceLink(value: unknown, selected: string): void {
    const data = LinkSchema.parse(value);
    if (separators(data.href)) throw new TypeError("Invalid Yandex Disk metadata link.");
    const target = url(data.href), base = this.#url("resources");
    if (
      data.method !== "GET" || target.origin !== base.origin || target.pathname !== base.pathname || target.username ||
      target.password || target.hash || [...target.searchParams.keys()].length !== 1 ||
      target.searchParams.get("path") !== selected
    ) throw new TypeError("Yandex Disk metadata link differs from requested target.");
  }
  /** Poll once; failed does not prove rollback and no mutation is replayed automatically. */
  async statusOperation(
    operation: YandexOperationType,
    signal?: AbortSignal,
  ): Promise<"in-progress" | "success" | "failed"> {
    const captured = this.#operation({ href: operation.href, method: "GET", templated: false });
    if (captured.id !== operation.id) throw new TypeError("Yandex Disk operation ID differs from its URL.");
    const target = url(captured.href);
    return await this.#json(
      await this.#send(target, "GET", signal, await this.#credential(target, signal)),
      (value) => z.object({ status: z.enum(["in-progress", "success", "failed"]) }).parse(value).status,
    );
  }
  /** 201 is native completed acknowledgment;202 requires explicit operation polling. */
  async #mutation(
    target: URL,
    method: string,
    selected: string,
    signal?: AbortSignal,
    options: { readonly deletion?: boolean; readonly from?: string; readonly pending?: boolean } = {},
  ): Promise<YandexMutationType> {
    const deletion = options.deletion === true, from = options.from, pending = options.pending !== false;
    const context = from === undefined ? {} : { from };
    const response = await this.#send(
      target,
      method,
      signal,
      await this.#credential(target, signal),
      undefined,
      undefined,
      true,
    );
    try {
      return await readResponse<YandexMutationType>(response, async (text) => {
        if (deletion && response.status === 204) {
          return { state: "completed", path: selected, ...context, acknowledgment: "http-204" };
        }
        if (!deletion && response.status === 201) {
          this.#resourceLink(json(await text()), selected);
          return { state: "completed", path: selected, ...context, acknowledgment: "http-201" };
        }
        if (response.status === 202 && pending) {
          return {
            state: "pending",
            path: selected,
            ...context,
            operation: this.#operation(json(await text())),
            acknowledgment: "http-202",
          };
        }
        throw new YandexError(response.status);
      });
    } catch (reason) {
      throw new YandexPublicationError(reason);
    }
  }
  /** Create one native path. Parent creation and exclusive publication are not inferred. */
  async createFolder(value: string, signal?: AbortSignal): Promise<YandexMutationType> {
    const selected = path(value, true);
    return await this.#mutation(this.#url("resources", { path: selected }), "PUT", selected, signal, {
      pending: false,
    });
  }
  /** Native copy may recurse and overwrite; it is not a version-bound or atomic tree copy. */
  async copy(
    from: string,
    to: string,
    options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  ): Promise<YandexMutationType> {
    const source = path(from, true), target = path(to, true), overwrite = options.overwrite, signal = options.signal;
    if (typeof overwrite !== "boolean") throw new TypeError("Choose native Yandex Disk overwrite behavior.");
    return await this.#mutation(
      this.#url("resources/copy", { from: source, path: target, overwrite: String(overwrite) }),
      "POST",
      target,
      signal,
      { from: source },
    );
  }
  /** Native move acknowledgment says nothing about concurrent source/destination replacement. */
  async move(
    from: string,
    to: string,
    options: { readonly overwrite: boolean; readonly signal?: AbortSignal },
  ): Promise<YandexMutationType> {
    const source = path(from, true), target = path(to, true), overwrite = options.overwrite, signal = options.signal;
    if (typeof overwrite !== "boolean") throw new TypeError("Choose native Yandex Disk overwrite behavior.");
    return await this.#mutation(
      this.#url("resources/move", { from: source, path: target, overwrite: String(overwrite) }),
      "POST",
      target,
      signal,
      { from: source },
    );
  }
  /** Explicit current-path recursive deletion. A file-to-directory race never becomes a one-entry guarantee. */
  async deleteResource(
    value: string,
    options: { readonly recursive: true; readonly permanently: boolean; readonly signal?: AbortSignal },
  ): Promise<YandexMutationType> {
    const selected = path(value, true),
      recursive = options.recursive,
      permanently = options.permanently,
      signal = options.signal;
    if (recursive !== true || typeof permanently !== "boolean") {
      throw new TypeError("Yandex Disk deletion requires explicit recursive and permanent/trash choices.");
    }
    return await this.#mutation(
      this.#url("resources", { path: selected, permanently: String(permanently) }),
      "DELETE",
      selected,
      signal,
      { deletion: true },
    );
  }
}
