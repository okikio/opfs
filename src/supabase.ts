/** Native Supabase Storage files-bucket REST operations, separate from S3, Auth and tus. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import type { RangeType } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Implementation ceiling for a copied upload or whole materialized read; streaming downloads are separate. */
export const SUPABASE_BUFFER_BYTES = 64 * 1024 * 1024;
/** Caller-owned authentication. A JWT is supplied without a Bearer prefix; apiKey is separate gateway context. */
export interface SupabaseCredentialsType {
  readonly accessToken?: string;
  readonly apiKey?: string;
}
/** Explicit Storage API root and files bucket. No account, credentials, schema or backend are discovered. */
export interface SupabaseOptionsType {
  readonly endpoint: string | URL;
  readonly bucket: string;
  readonly credentials?: (
    url: URL,
    signal?: AbortSignal,
  ) => SupabaseCredentialsType | PromiseLike<SupabaseCredentialsType>;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Exact origins allowed for signed downloads, even when the signed target is the API origin. */
  readonly signedOrigins?: readonly string[];
  readonly maxBytes?: number;
}
/** Native metadata evidence. Internal UUID/version values are not a content hash or an immutable-source contract. */
export interface SupabaseInfoType {
  readonly bucket: string;
  readonly key: string;
  readonly id: string;
  readonly version?: string;
  readonly size: number;
  readonly etag?: string;
  readonly mediaType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
/** Native list-v1 prefixes are placeholders, not zero-byte objects. Names are relative direct-child names. */
export type SupabaseEntryType = { readonly kind: "prefix"; readonly name: string } | {
  readonly kind: "object";
  readonly name: string;
  readonly id: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};
/** Native offset page evidence. A full page does not establish that another page exists. */
export interface SupabasePageType {
  readonly offset: number;
  readonly limit: number;
  readonly items: readonly SupabaseEntryType[];
}
/** Matched native upload acknowledgement; no independent stored-byte proof or immutable revision is inferred. */
export interface SupabaseUploadType {
  readonly bucket: string;
  readonly key: string;
  readonly id?: string;
  readonly state: "acknowledged";
}
/** Acknowledged removed identity only. Requested but omitted keys remain unresolved, not implicitly absent/deleted. */
export interface SupabaseDeletedType {
  readonly key: string;
  readonly id: string;
  readonly version?: string;
}
/** Explicit native route. Public reads never acquire API credentials; signed reads use a separate method. */
export interface SupabaseReadOptionsType {
  readonly access: "authenticated" | "public";
  readonly at?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Consume to EOF or await cancellation. Size is response-extent evidence, never a persistent snapshot declaration. */
export interface SupabaseDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size?: number;
  readonly evidence: "server-trusted";
}
/** Sanitized native HTTP failure. Server diagnostics and capability URLs are not echoed. */
export class SupabaseError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Supabase Storage request failed: status ${status}.`);
    this.name = "SupabaseError";
    this.status = status;
  }
}
/** A dispatched object mutation did not deliver a valid acknowledgement. Reconcile before retrying. */
export class SupabasePublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Supabase Storage mutation outcome is unknown; reconcile before retrying.", { cause });
    this.name = "SupabasePublicationError";
  }
}
function integer(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError("Invalid Supabase Storage budget or extent.");
  }
  return value;
}
/** Segment admission precedes URL encoding, avoiding dot/separator aliases without normalizing the caller's key. */
function component(value: string): string {
  if (
    typeof value !== "string" || !value || value.length > 1024 || !value.isWellFormed() || value === "." ||
    value === ".." || value.includes("/") || value.includes("\\")
  ) throw new TypeError("Invalid Supabase Storage path segment.");
  for (const char of value) {
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) {
      throw new TypeError("Invalid Supabase Storage path segment.");
    }
  }
  return value;
}
function key(value: string): string {
  if (typeof value !== "string" || value.length > 8192) {
    throw new RangeError("Supabase Storage key exceeds its budget.");
  }
  for (const part of value.split("/")) component(part);
  return value;
}
function encodeKey(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
function token(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /[^\x21-\x7e]/.test(value)) {
    throw new TypeError("Invalid Supabase Storage token.");
  }
  return value;
}
function header(value: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[^\x20-\x7e]/.test(value)) {
    throw new TypeError("Invalid Supabase Storage media header.");
  }
  return value;
}
function url(value: string | URL, http: boolean): URL {
  if (typeof value === "string" && value.length > 65536) {
    throw new RangeError("Supabase Storage URL exceeds its budget.");
  }
  if (typeof value === "string") {
    const wire = value.split(/[?#]/, 1)[0]!;
    if (wire.includes("\\") || /(?:^|\/)(?:\.|%2e){1,2}(?=\/|$)/i.test(wire) || /%2f|%5c/i.test(wire)) {
      throw new TypeError("Supabase Storage URL contains a path alias.");
    }
  }
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new TypeError("Invalid Supabase Storage URL.");
  }
  if (
    target.protocol !== "https:" && !(http && target.protocol === "http:") || target.username || target.password ||
    target.hash
  ) throw new TypeError("Invalid Supabase Storage URL authority.");
  return target;
}
/** Duplicate-aware finite JSON admission protects paths, headers and native identity from last-key-wins parsing. */
function json(text: string): unknown {
  let at = 0, values = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget Supabase Storage JSON.");
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
    if (++values > 100000 || depth > 32) fail();
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
          const name = string();
          if (keys.has(name) || ["__proto__", "constructor", "prototype"].includes(name)) fail();
          keys.add(name);
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
      if (at - start >= 128) fail();
      at++;
    }
    const raw = text.slice(start, at), number = Number(raw);
    if (
      !["true", "false", "null"].includes(raw) &&
      (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw) || !Number.isFinite(number) ||
        Number.isInteger(number) && !Number.isSafeInteger(number))
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
const InfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  bucket_id: z.string(),
  version: z.string().nullish(),
  size: z.number(),
  etag: z.string().nullish(),
  content_type: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
const EntrySchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
const DeletedSchema = z.object({
  id: z.string(),
  name: z.string(),
  bucket_id: z.string(),
  version: z.string().nullish(),
});
/** The wrapper owns one reader until real EOF/cancellation. Native terminal errors are not re-cancelled and duplicated. */
function extent(
  body: ReadableStream<Uint8Array>,
  expected: number | undefined,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
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
            if (expected !== undefined && seen !== expected) throw new TypeError("Supabase Storage body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Supabase Storage body requires bytes.");
          const bytes = toView(next.value);
          if (
            bytes.length > Number.MAX_SAFE_INTEGER - seen || expected !== undefined && bytes.length > expected - seen
          ) throw new TypeError("Supabase Storage body exceeds its extent.");
          seen += bytes.length;
          if (!bytes.length) { if (++empty > 16) throw new TypeError("Supabase Storage body makes no progress."); }
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
    "Supabase Storage",
    "download",
  );
}
/** Native files-bucket client. RLS/retention and authentication lifecycle belong to the application and server. */
export class SupabaseClient {
  readonly #base: URL;
  readonly #bucket: string;
  readonly #http: boolean;
  readonly #credentials: SupabaseOptionsType["credentials"];
  readonly #fetch: FetchType;
  readonly #request: RequestPolicyType | undefined;
  readonly #max: number;
  readonly #origins: ReadonlySet<string>;
  readonly #metrics = new RequestMetrics();
  constructor(options: SupabaseOptionsType) {
    this.#http = options.allowHttp === true;
    this.#base = url(options.endpoint, this.#http);
    if (this.#base.search || !this.#base.pathname.endsWith("/")) {
      throw new TypeError("Supabase Storage API root requires a final slash and no query.");
    }
    this.#bucket = component(options.bucket);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#request = options.request === undefined ? undefined : { ...options.request };
    this.#max = integer(options.maxBytes ?? 8 * 1024 * 1024, SUPABASE_BUFFER_BYTES);
    const origins = options.signedOrigins ?? [];
    if (!Array.isArray(origins) || origins.length > 64) {
      throw new RangeError("Supabase signed origin grants exceed their budget.");
    }
    this.#origins = new Set(origins.map((origin) => {
      const target = url(origin, this.#http);
      if (target.pathname !== "/" || target.search) {
        throw new TypeError("Supabase signed grants require exact origins.");
      }
      return target.origin;
    }));
  }
  #url(path: string): URL {
    return new URL(path, this.#base);
  }
  #object(route: string, selected: string): URL {
    return this.#url(`object/${route}${encodeURIComponent(this.#bucket)}/${encodeKey(selected)}`);
  }
  async #headers(target: URL, signal?: AbortSignal): Promise<Headers> {
    signal?.throwIfAborted();
    const credentials = await this.#credentials?.(new URL(target), signal);
    signal?.throwIfAborted();
    const accessToken = credentials?.accessToken, apiKey = credentials?.apiKey, headers = new Headers();
    if (accessToken !== undefined) headers.set("Authorization", `Bearer ${token(accessToken)}`);
    if (apiKey !== undefined) headers.set("apikey", token(apiKey));
    return headers;
  }
  /** Each request captures target/body/headers and refuses redirects. Mutations are never automatically retried. */
  async #response(
    target: URL,
    method: string,
    headers: Headers,
    body: string | Uint8Array<ArrayBuffer> | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    return await sendRequest(
      async (signal) => ({
        input: target,
        init: {
          method,
          headers,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          redirect: "manual",
          ...(body === undefined ? {} : { body }),
          ...(signal === undefined ? {} : { signal }),
        },
      }),
      {
        fetch: this.#fetch,
        replayable: false,
        metrics: this.#metrics,
        ...(this.#request === undefined ? {} : { policy: this.#request }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  }
  /** API authority never flows onto public or signed media requests. Dispatched mutation receipts remain conservative. */
  async #control<Value>(
    target: URL,
    method: string,
    body: string | Uint8Array<ArrayBuffer> | undefined,
    signal: AbortSignal | undefined,
    mutation: boolean,
    consume: (value: unknown) => Value,
    media?: { type: string; cache: string; upsert: boolean },
  ): Promise<Value> {
    const selected = await this.#headers(target, signal);
    selected.set("Accept", "application/json");
    if (media !== undefined) {
      selected.set("Content-Type", media.type);
      selected.set("Cache-Control", media.cache);
      selected.set("x-upsert", String(media.upsert));
    } else if (body !== undefined) selected.set("Content-Type", "application/json");
    let dispatched = false;
    try {
      const response = await sendRequest(
        async (signal) => ({
          input: target,
          init: {
            method,
            headers: selected,
            credentials: "omit",
            referrerPolicy: "no-referrer",
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
          ...(this.#request === undefined ? {} : { policy: this.#request }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return await readResponse(response, async (text) => {
        if (response.status !== 200) throw new SupabaseError(response.status);
        return consume(json(await text()));
      });
    } catch (reason) {
      if (mutation && dispatched) throw new SupabasePublicationError(reason);
      throw reason;
    }
  }
  /** Read native metadata without promoting internal version/ETag evidence into a persistent snapshot. */
  async info(value: string, signal?: AbortSignal): Promise<SupabaseInfoType> {
    const selected = key(value);
    return await this.#control(this.#object("info/", selected), "GET", undefined, signal, false, (value) => {
      const data = InfoSchema.parse(value);
      if (data.name !== selected || data.bucket_id !== this.#bucket || !data.id || data.id.length > 1024) {
        throw new TypeError("Supabase Storage metadata identity differs.");
      }
      return {
        bucket: this.#bucket,
        key: selected,
        id: data.id,
        size: integer(data.size),
        ...(data.version == null ? {} : { version: data.version }),
        ...(data.etag == null ? {} : { etag: data.etag }),
        ...(data.content_type == null ? {} : { mediaType: data.content_type }),
        ...(data.metadata == null ? {} : { metadata: data.metadata }),
      };
    });
  }
  /** One bounded native list-v1 page. Prefix placeholders and offset evidence are not directory/snapshot guarantees. */
  async listPage(
    prefix: string,
    options: { readonly offset?: number; readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<SupabasePageType> {
    if (typeof prefix !== "string") throw new TypeError("Supabase Storage prefix requires a string.");
    if (prefix) key(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    const captured = prefix,
      offset = integer(options.offset ?? 0, 1_000_000),
      limit = integer(options.limit ?? 100, 500),
      signal = options.signal;
    if (!limit) throw new RangeError("Supabase Storage page limit must be positive.");
    return await this.#control(
      this.#url(`object/list/${encodeURIComponent(this.#bucket)}`),
      "POST",
      JSON.stringify({ prefix: captured, offset, limit, sortBy: { column: "name", order: "asc" } }),
      signal,
      false,
      (value) => {
        const entries = z.array(EntrySchema).max(limit).parse(value), seen = new Set<string>();
        const items = entries.map((entry): SupabaseEntryType => {
          const name = component(entry.name);
          if (seen.has(name)) throw new TypeError("Supabase Storage list repeats a name.");
          seen.add(name);
          if (entry.id === null) {
            if (entry.metadata != null) throw new TypeError("Supabase Storage prefix contains object metadata.");
            return { kind: "prefix", name };
          }
          if (!entry.id || entry.id.length > 1024) throw new TypeError("Invalid Supabase Storage object ID.");
          return {
            kind: "object",
            name,
            id: entry.id,
            ...(entry.metadata == null ? {} : { metadata: entry.metadata }),
          };
        });
        return { offset, limit, items };
      },
    );
  }
  /** Copy bounded bytes before credentials. Create conflict and explicit upsert are native permissions, never revision CAS. */
  async upload(
    value: string,
    bytes: Uint8Array,
    options: {
      readonly mode: "create" | "upsert";
      readonly mediaType?: string;
      readonly cacheControl?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<SupabaseUploadType> {
    const selected = key(value),
      mode = options.mode,
      signal = options.signal,
      type = header(options.mediaType ?? "application/octet-stream"),
      cache = header(options.cacheControl ?? "max-age=3600");
    signal?.throwIfAborted();
    if (mode !== "create" && mode !== "upsert") {
      throw new TypeError("Supabase Storage upload requires an explicit native mode.");
    }
    if (!isBytes(bytes)) throw new TypeError("Supabase Storage upload requires bytes.");
    const view = toView(bytes);
    integer(view.length, this.#max);
    const copied = new Uint8Array(view);
    return await this.#control(this.#object("", selected), "POST", copied, signal, true, (value) => {
      const data = z.object({ Key: z.string(), Id: z.string().optional() }).parse(value);
      if (data.Key !== `${this.#bucket}/${selected}` || data.Id !== undefined && (!data.Id || data.Id.length > 1024)) {
        throw new TypeError("Supabase Storage upload receipt differs.");
      }
      return {
        bucket: this.#bucket,
        key: selected,
        state: "acknowledged",
        ...(data.Id === undefined ? {} : { id: data.Id }),
      };
    }, { type, cache, upsert: mode === "upsert" });
  }
  /** Remove exact requested keys, not prefix descendants. Only returned identities are acknowledged; RLS can omit others. */
  async remove(values: readonly string[], signal?: AbortSignal): Promise<readonly SupabaseDeletedType[]> {
    if (!Array.isArray(values) || !values.length || values.length > 100) {
      throw new RangeError("Invalid Supabase Storage deletion count.");
    }
    const captured = values.map(key), expected = new Set(captured);
    if (expected.size !== captured.length) throw new TypeError("Supabase Storage removal repeats keys.");
    return await this.#control(
      this.#url(`object/${encodeURIComponent(this.#bucket)}`),
      "DELETE",
      JSON.stringify({ prefixes: captured }),
      signal,
      true,
      (value) => {
        const entries = z.array(DeletedSchema).max(captured.length).parse(value), seen = new Set<string>();
        return entries.map((entry) => {
          if (
            !expected.has(entry.name) || seen.has(entry.name) || entry.bucket_id !== this.#bucket || !entry.id ||
            entry.id.length > 1024
          ) throw new TypeError("Supabase Storage deletion receipt differs.");
          seen.add(entry.name);
          return { key: entry.name, id: entry.id, ...(entry.version == null ? {} : { version: entry.version }) };
        });
      },
    );
  }
  /** Native signed URLs are relative to the Storage API root, not the project origin. Preserve that routing boundary. */
  async createSignedUrl(
    value: string,
    options: { readonly expiresIn: number; readonly signal?: AbortSignal },
  ): Promise<string> {
    const selected = key(value), expiresIn = integer(options.expiresIn, 86400), signal = options.signal;
    if (!expiresIn) throw new RangeError("Supabase signed expiry must be positive seconds.");
    return await this.#control(
      this.#object("sign/", selected),
      "POST",
      JSON.stringify({ expiresIn }),
      signal,
      false,
      (value) => {
        const data = z.object({ signedURL: z.string().max(65536) }).parse(value);
        const expectedPath = `/object/sign/${encodeURIComponent(this.#bucket)}/${encodeKey(selected)}`;
        if (data.signedURL.split("?", 1)[0] !== expectedPath) {
          throw new TypeError(
            "Supabase signed receipt has an unsupported route.",
          );
        }
        const target = this.#url(data.signedURL.slice(1));
        return this.#signed(selected, target, false).href;
      },
    );
  }
  /** Capability authority is an exact origin plus one canonical expected route; API credentials are never consulted. */
  #signed(selected: string, value: string | URL, grant: boolean): URL {
    const target = url(value, this.#http), expected = this.#object("sign/", selected);
    if (
      (grant ? !this.#origins.has(target.origin) : target.origin !== this.#base.origin) ||
      target.pathname !== expected.pathname || target.searchParams.getAll("token").length !== 1 ||
      [...target.searchParams.keys()].some((name) => name !== "token")
    ) throw new TypeError("Supabase signed target does not match the granted object route.");
    token(target.searchParams.get("token")!);
    return target;
  }
  /** The media owner retires rejected responses and enforces actual EOF without claiming immutable revision identity. */
  async #download(target: URL, selected: RangeType, authenticated: boolean): Promise<SupabaseDownloadType> {
    if (selected.empty) {
      return {
        bytes: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        size: 0,
        evidence: "server-trusted",
      };
    }
    const headers = authenticated ? await this.#headers(target, selected.signal) : new Headers();
    headers.set("Accept-Encoding", "identity");
    if (selected.header !== undefined) headers.set("Range", selected.header);
    const response = await this.#response(target, "GET", headers, undefined, selected.signal);
    if (response.status !== 200 && response.status !== 206) {
      const reason = new SupabaseError(response.status);
      await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
      throw reason;
    }
    await assertRangeResponse(response, selected);
    try {
      const raw = response.headers.get("content-length");
      let size: number | undefined;
      if (raw !== null) {
        if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError("Invalid Supabase Storage response length.");
        size = integer(Number(raw));
      }
      if (selected.header !== undefined) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range")!);
        size = Number(match![2]) - Number(match![1]) + 1;
      }
      if (response.body === null) throw new TypeError("Supabase Storage download lacks a body.");
      return {
        bytes: extent(response.body, size, selected.signal),
        ...(size === undefined ? {} : { size }),
        evidence: "server-trusted",
      };
    } catch (reason) {
      await close(response.body === null || response.body.locked ? [] : [() => response.body!.cancel(reason)], [
        reason,
      ]);
      throw reason;
    }
  }
  /** Explicit authenticated/public route. Public requests never acquire or forward API credentials. */
  async download(value: string, options: SupabaseReadOptionsType): Promise<SupabaseDownloadType> {
    const selected = key(value), access = options.access, requested = range(options);
    if (access !== "authenticated" && access !== "public") {
      throw new TypeError("Supabase download requires an explicit access route.");
    }
    return await this.#download(
      this.#object(access === "public" ? "public/" : "authenticated/", selected),
      requested,
      access === "authenticated",
    );
  }
  /** Signed capability downloads require an exact origin grant and never receive API credentials, even at the API origin. */
  async downloadSigned(
    value: string,
    capability: string | URL,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<SupabaseDownloadType> {
    const selected = key(value), target = this.#signed(selected, capability, true), requested = range(options);
    return await this.#download(target, requested, false);
  }
  /** A response extent can clamp at EOF; budget admission here owns cancellation before collecting oversized bytes. */
  async #read(response: SupabaseDownloadType, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    if (response.size !== undefined && response.size > this.#max) {
      const reason = new RangeError("Supabase Storage materialized read exceeds its byte budget.");
      await close([() => response.bytes.cancel(reason)], [reason]);
    }
    return new Uint8Array(await collectBytes(response.bytes, this.#max, signal, "Supabase Storage", "object"));
  }
  /** Bounded whole/selected read, with server-trusted bytes and no content hash or snapshot promise. */
  async read(value: string, options: SupabaseReadOptionsType): Promise<Uint8Array<ArrayBuffer>> {
    const access = options.access, signal = options.signal, at = options.at, length = options.length;
    const captured: SupabaseReadOptionsType = {
      access,
      ...(signal === undefined ? {} : { signal }),
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
    };
    return await this.#read(await this.download(value, captured), signal);
  }
  /** Bounded signed-capability read. The URL is a secret, not immutable content identity. */
  async readSigned(
    value: string,
    capability: string | URL,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    const signal = options.signal, at = options.at, length = options.length;
    const captured = {
      ...(signal === undefined ? {} : { signal }),
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
    };
    return await this.#read(await this.downloadSigned(value, capability, captured), signal);
  }
}
