/** Native unencrypted Seafile library files, with API tokens isolated from capability URLs. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestMetricsType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Finite copied-upload/materialization policy ceiling, separate from server quotas. */
export const SEAFILE_BUFFER_BYTES = 64 * 1024 * 1024;
/** One exact data origin and path subtree explicitly authorized by the application. */
export interface SeafileGrantType {
  readonly origin: string | URL;
  readonly prefix: string;
}
/** Native library metadata. An encrypted library can be inspected but data operations refuse it. */
export interface SeafileLibraryType {
  readonly id: string;
  readonly name: string;
  readonly encrypted: boolean;
  readonly permission: string;
  readonly head?: string;
}
/** Native file/directory identity; IDs are Seafile objects, not verified hashes of complete file bytes. */
export interface SeafileEntryType {
  readonly id: string;
  readonly name: string;
  readonly parent: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
}
/** One native upload acknowledgement. Collisions can rename the created file. */
export interface SeafileReceiptType {
  readonly id: string;
  readonly name: string;
  readonly parent: string;
  readonly size: number;
}
/** Caller-owned streaming response; no stable revision or full hash proof is inferred. */
export interface SeafileDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly evidence: "server-trusted";
}
export interface SeafileOperationType {
  readonly signal?: AbortSignal;
}
export interface SeafileReadType extends SeafileOperationType {
  readonly at?: number;
  readonly length?: number;
}
/** Explicit user authority. Library-token authentication uses different routes and is outside this profile. */
export interface SeafileClientOptionsType {
  readonly endpoint: string | URL;
  readonly library: string;
  readonly token: string | ((url: URL, signal?: AbortSignal) => string | Promise<string>);
  readonly downloadGrants?: readonly SeafileGrantType[];
  readonly uploadGrants?: readonly SeafileGrantType[];
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 8 MiB, at most SEAFILE_BUFFER_BYTES. Streaming downloads do not materialize whole objects. */
  readonly maxBytes?: number;
  /** Native directory listing has no cursor; refuse beyond this count, default10000/hard100000. */
  readonly maxEntries?: number;
  /** Credential-free download redirects only, default3/hard8; API and upload redirects always refuse. */
  readonly maxRedirects?: number;
}
/** Native HTTP failure without capability URLs or response text in library-owned messages. */
export class SeafileError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Seafile request failed with HTTP ${status}.`);
    this.name = "SeafileError";
    this.status = status;
  }
}
/** A dispatched upload lacks a complete receipt; no absence, rollback or safe replay is inferred. */
export class SeafilePublicationError extends Error {
  readonly outcome = "unknown";
  readonly library: string;
  readonly parent: string;
  constructor(library: string, parent: string, name: string, cause: unknown) {
    super("Seafile upload has no complete success acknowledgement.", { cause });
    this.name = "SeafilePublicationError";
    this.library = library;
    this.parent = parent;
    // Error.name identifies the error class; retain the requested file name separately.
    this.requestedName = name;
  }
  readonly requestedName: string;
}

const LibrarySchema = z.object({
  id: z.string(),
  name: z.string().max(4096),
  encrypted: z.boolean(),
  permission: z.string().max(256),
  head_commit_id: z.string().max(256).optional(),
});
const FileSchema = z.object({
  repo_id: z.string(),
  parent_dir: z.string(),
  obj_name: z.string(),
  obj_id: z.string(),
  size: z.number().int().nonnegative().safe(),
  type: z.literal("file"),
});
const EntrySchema = z.object({
  type: z.enum(["file", "dir"]),
  id: z.string(),
  name: z.string(),
  parent_dir: z.string(),
  size: z.number().int().nonnegative().safe().optional(),
});
const ReceiptSchema = z.object({ id: z.string(), name: z.string(), size: z.number().int().nonnegative().safe() });
function integer(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError("Seafile value exceeds its finite bound.");
  }
  return value;
}
/** This path profile is literal Unicode with no aliases, controls or malformed UTF-16. */
function text(value: string, max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max) {
    throw new TypeError("Invalid Seafile text field.");
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127) throw new TypeError("Invalid Seafile text control.");
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw new TypeError("Invalid Seafile text encoding.");
  }
  return value;
}
function filename(value: string): string {
  value = text(value, 255);
  if (value === "." || value === ".." || /[/\\]/u.test(value)) throw new TypeError("Invalid Seafile file name.");
  return value;
}
function path(value: string, directory = false): string {
  value = text(value);
  if (
    !value.startsWith("/") || value.includes("\\") ||
    (value !== "/" &&
      (value.endsWith("/") || value.split("/").slice(1).some((part) => !part || part === "." || part === "..")))
  ) throw new TypeError("Invalid Seafile literal path.");
  if (!directory && value === "/") throw new TypeError("A Seafile file path cannot name the root.");
  return value;
}
function parent(value: string): string {
  return value.slice(0, value.lastIndexOf("/")) || "/";
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError("Invalid Seafile native acknowledgement.");
  return result.data;
}
/** Bounded control JSON rejects duplicate/prototype keys and noncanonical numeric lexemes before Number conversion.
 * The finite profile admits only safe integers, depth32, 100000 tokens and 512 KiB lexical strings within 8 MiB text.
 * JSON.parse is restricted to bounded string tokens, so fractional rounding cannot create accepted byte authority.
 */
function json(text: string): unknown {
  if (text.length > 8 * 1024 * 1024) throw new RangeError("Seafile JSON exceeds its lexical budget.");
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget Seafile JSON.");
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
      if (at - start > 17) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (raw.length > 17) fail();
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    if (!/^-?(0|[1-9][0-9]{0,15})$/.test(raw) || raw === "-0") return fail();
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) return fail();
    return number;
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
            if (seen !== expected) throw new TypeError("Seafile body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Seafile body requires bytes.");
          const bytes = toView(next.value);
          if (bytes.length > expected - seen) throw new TypeError("Seafile body exceeds its declared extent.");
          seen += bytes.length;
          if (!bytes.length) { if (++empty > 16) throw new TypeError("Seafile body makes no progress."); }
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
    "Seafile",
    "download",
  );
}

/** One configured library; caller owns authentication, permissions and coordination of concurrent writers. */
export class SeafileClient {
  readonly #base: URL;
  readonly #library: string;
  readonly #token: SeafileClientOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #downloads: readonly Readonly<{ origin: string; prefix: string }>[];
  readonly #uploads: readonly Readonly<{ origin: string; prefix: string }>[];
  readonly #max: number;
  readonly #entries: number;
  readonly #redirects: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: SeafileClientOptionsType) {
    const base = new URL(options.endpoint);
    if (
      (base.protocol !== "https:" && !(base.protocol === "http:" && options.allowHttp === true)) || base.username ||
      base.password || base.search || base.hash
    ) throw new TypeError("Invalid Seafile API base URL.");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.#base = base;
    this.#library = text(options.library, 36);
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(this.#library)) {
      throw new TypeError("Seafile library must be a full lowercase UUID.");
    }
    this.#token = options.token;
    if (typeof this.#token !== "string" && typeof this.#token !== "function") {
      throw new TypeError("An explicit Seafile user token is required.");
    }
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const policy = options.policy;
    this.#policy = policy === undefined ? undefined : { ...policy };
    this.#max = integer(options.maxBytes ?? 8 * 1024 * 1024, SEAFILE_BUFFER_BYTES);
    this.#entries = integer(options.maxEntries ?? 10000, 100000);
    this.#redirects = integer(options.maxRedirects ?? 3, 8);
    const grants = (
      values: readonly SeafileGrantType[] | undefined,
    ): readonly Readonly<{ origin: string; prefix: string }>[] => {
      if (values === undefined) return Object.freeze([]);
      if (!Array.isArray(values) || values.length > 32) {
        throw new TypeError("Seafile data grants exceed their finite bound.");
      }
      return Object.freeze(values.map((value) => {
        const origin = new URL(value.origin), prefix = value.prefix;
        if (
          (origin.protocol !== "https:" && !(origin.protocol === "http:" && options.allowHttp === true)) ||
          origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
          typeof prefix !== "string" || prefix.length > 1024 || !/^\/(?:[A-Za-z0-9_-]+\/)+$/u.test(prefix)
        ) throw new TypeError("Invalid Seafile exact data grant.");
        return Object.freeze({ origin: origin.origin, prefix });
      }));
    };
    this.#downloads = grants(options.downloadGrants);
    this.#uploads = grants(options.uploadGrants);
  }
  getMetrics(): RequestMetricsType {
    return this.#metrics.snapshot();
  }
  #url(route: string, query: Readonly<Record<string, string>> = {}): URL {
    const url = new URL(route, this.#base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }
  /** Data capabilities are separate authorities, including when their origin equals the API origin. */
  #capability(value: string | URL, grants: readonly Readonly<{ origin: string; prefix: string }>[]): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError("Invalid Seafile data capability.");
    }
    if (
      url.username || url.password || url.hash || /%(?:2f|5c|2e)/iu.test(url.pathname) || url.pathname.includes("\\") ||
      !grants.some((grant) => url.origin === grant.origin && url.pathname.startsWith(grant.prefix))
    ) throw new TypeError("Seafile capability is outside the explicit data grants.");
    return url;
  }
  async #send(
    url: URL,
    method: string,
    api: boolean,
    signal?: AbortSignal,
    headers = new Headers(),
    body?: BodyInit,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      const admitted = new Headers(headers);
      admitted.set("accept-encoding", "identity");
      if (api) {
        const token = typeof this.#token === "function" ? await this.#token(new URL(url), attemptSignal) : this.#token;
        if (typeof token !== "string" || !token.length || token.length > 8192 || /[^\x21-\x7e]/u.test(token)) {
          throw new TypeError("Invalid Seafile user token.");
        }
        admitted.set("authorization", `Token ${token}`);
      }
      attemptSignal?.throwIfAborted();
      return {
        input: url,
        init: {
          method,
          headers: admitted,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(body === undefined ? {} : { body }),
        },
      };
    }, {
      fetch: async (input, init) => {
        dispatch?.();
        return await this.#fetch(input, init);
      },
      replayable: api && method === "GET",
      metrics: this.#metrics,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  async #json(response: Response): Promise<unknown> {
    return await readResponse(response, async (body) => {
      if (response.status !== 200) throw new SeafileError(response.status);
      return json(await body());
    });
  }
  async getLibrary(options: SeafileOperationType = {}): Promise<SeafileLibraryType> {
    const { signal } = options;
    const data = parse(
      LibrarySchema,
      await this.#json(await this.#send(this.#url(`api2/repos/${this.#library}/`), "GET", true, signal)),
    );
    if (data.id !== this.#library) throw new TypeError("Seafile returned a different library.");
    return Object.freeze({
      id: data.id,
      name: data.name,
      encrypted: data.encrypted,
      permission: data.permission,
      ...(data.head_commit_id === undefined ? {} : { head: data.head_commit_id }),
    });
  }
  /** Encrypted libraries require a separately reviewed password/key and server-session model. */
  async #admit(signal?: AbortSignal): Promise<void> {
    const library = await this.getLibrary(signal === undefined ? {} : { signal });
    if (library.encrypted) throw new TypeError("Encrypted Seafile libraries are outside this data profile.");
  }
  async stat(file: string, options: SeafileOperationType = {}): Promise<SeafileEntryType> {
    file = path(file);
    const { signal } = options;
    const url = this.#url(`api/v2.1/repos/${this.#library}/file/`, { p: file });
    await this.#admit(signal);
    const data = parse(FileSchema, await this.#json(await this.#send(url, "GET", true, signal)));
    if (
      data.repo_id !== this.#library || data.parent_dir !== parent(file) ||
      data.obj_name !== file.slice(file.lastIndexOf("/") + 1)
    ) throw new TypeError("Seafile returned different file metadata.");
    return Object.freeze({
      id: text(data.obj_id, 256),
      name: filename(data.obj_name),
      parent: path(data.parent_dir, true),
      kind: "file",
      size: data.size,
    });
  }
  async list(directory = "/", options: SeafileOperationType = {}): Promise<readonly SeafileEntryType[]> {
    directory = path(directory, true);
    const { signal } = options;
    const url = this.#url(`api/v2.1/repos/${this.#library}/dir/`, {
      p: directory,
      recursive: "0",
      with_thumbnail: "false",
    });
    await this.#admit(signal);
    const data = parse(
      z.object({ dirent_list: z.array(EntrySchema).max(this.#entries) }),
      await this.#json(await this.#send(url, "GET", true, signal)),
    );
    const seen = new Set<string>();
    return Object.freeze(data.dirent_list.map((value): SeafileEntryType => {
      const name = filename(value.name);
      if (value.parent_dir !== directory || seen.has(name) || (value.type === "file" && value.size === undefined)) {
        throw new TypeError("Ambiguous Seafile directory listing.");
      }
      seen.add(name);
      return Object.freeze({
        id: text(value.id, 256),
        name,
        parent: directory,
        kind: value.type === "file" ? "file" : "directory",
        ...(value.size === undefined ? {} : { size: value.size }),
      });
    }));
  }
  async download(file: string, options: SeafileReadType = {}): Promise<SeafileDownloadType> {
    file = path(file);
    const { signal, at, length } = options;
    const selected = range({
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (selected.empty) {
      return Object.freeze({
        bytes: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        size: 0,
        evidence: "server-trusted",
      });
    }
    const api = this.#url(`api2/repos/${this.#library}/file/`, { p: file, reuse: "0" });
    await this.#admit(signal);
    const link = await this.#json(await this.#send(api, "GET", true, signal));
    if (typeof link !== "string" || link.length > 16384) throw new TypeError("Invalid Seafile download link receipt.");
    let url = this.#capability(link, this.#downloads);
    const seen = new Set<string>();
    const headers = new Headers(selected.header === undefined ? {} : { range: selected.header });
    for (let redirects = 0;; redirects++) {
      if (seen.has(url.href)) throw new TypeError("Seafile download redirect loop.");
      seen.add(url.href);
      const response = await this.#send(url, "GET", false, signal, headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        url = await readResponse(response, () => {
          const location = response.headers.get("location");
          if (redirects >= this.#redirects || location === null) {
            throw new TypeError("Seafile redirect exceeds its grant or hop budget.");
          }
          let target: URL;
          try {
            target = new URL(location, url);
          } catch {
            throw new TypeError("Invalid Seafile redirect target.");
          }
          return this.#capability(target, this.#downloads);
        });
        continue;
      }
      if (response.status !== 200 && response.status !== 206) {
        await readResponse(response, () => {
          throw new SeafileError(response.status);
        });
      }
      await assertRangeResponse(response, selected);
      let size: number;
      try {
        const raw = response.headers.get("content-length");
        if (raw === null || !/^(0|[1-9][0-9]{0,15})$/u.test(raw)) {
          throw new TypeError("Seafile data requires safe Content-Length.");
        }
        size = integer(Number(raw));
        if (response.body === null && size !== 0) throw new TypeError("Seafile data response omitted bytes.");
      } catch (reason) {
        await close([() => response.body?.cancel(reason)], [reason]);
        throw reason;
      }
      const body = response.body ?? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return Object.freeze({ bytes: extent(body, size, signal), size, evidence: "server-trusted" });
    }
  }
  async read(file: string, options: SeafileReadType = {}): Promise<Uint8Array> {
    const { signal, at, length } = options;
    const result = await this.download(file, {
      ...(signal === undefined ? {} : { signal }),
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
    });
    if (result.size > this.#max) {
      const reason = new RangeError("Seafile read exceeds its materialization policy.");
      await close([() => result.bytes.cancel(reason)], [reason]);
      throw reason;
    }
    return await collectBytes(result.bytes, this.#max, signal, "read", "Seafile");
  }
  /** Native replace=false can choose a new name on collision; this is not atomic create-only. */
  async upload(
    directory: string,
    name: string,
    bytes: Uint8Array,
    options: SeafileOperationType & { readonly replace?: boolean } = {},
  ): Promise<SeafileReceiptType> {
    directory = path(directory, true);
    name = filename(name);
    const { signal, replace = false } = options;
    if (typeof replace !== "boolean") throw new TypeError("Seafile replace must be a boolean.");
    if (!isBytes(bytes)) throw new TypeError("Seafile upload requires native bytes.");
    const view = toView(bytes);
    integer(view.byteLength, this.#max);
    signal?.throwIfAborted();
    const body = toRequestBytes(view.slice());
    const api = this.#url(`api2/repos/${this.#library}/upload-link/`, { p: directory, replace: replace ? "1" : "0" });
    await this.#admit(signal);
    const link = await this.#json(await this.#send(api, "GET", true, signal));
    if (typeof link !== "string" || link.length > 16384) throw new TypeError("Invalid Seafile upload link receipt.");
    const url = this.#capability(link, this.#uploads);
    url.searchParams.set("ret-json", "1");
    const form = new FormData();
    form.set("parent_dir", directory);
    form.set("replace", replace ? "1" : "0");
    form.set("file", new Blob([body]), name);
    let dispatched = false;
    try {
      const data = parse(
        z.array(ReceiptSchema).length(1),
        await this.#json(
          await this.#send(url, "POST", false, signal, new Headers(), form, () => {
            dispatched = true;
          }),
        ),
      )[0]!;
      if (data.size !== body.length) throw new TypeError("Seafile upload receipt has a different size.");
      return Object.freeze({ id: text(data.id, 256), name: filename(data.name), parent: directory, size: data.size });
    } catch (reason) {
      if (dispatched) throw new SeafilePublicationError(this.#library, directory, name, reason);
      throw reason;
    }
  }
}
