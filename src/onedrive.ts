/** Microsoft Graph drive/item IDs and native upload sessions; no filesystem namespace. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";

/** Nonfinal upload fragments follow the native 320 KiB protocol alignment. */
export const ONEDRIVE_CHUNK_BYTES = 320 * 1024;
const selection = "id,name,size,file,folder,package,remoteItem,deleted,eTag,cTag,parentReference";
const FacetSchema = z.object({}).passthrough();
const ItemSchema = z.object({
  id: z.string().min(1).max(1024),
  name: z.string(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  file: FacetSchema.optional(),
  folder: FacetSchema.optional(),
  package: FacetSchema.optional(),
  remoteItem: FacetSchema.optional(),
  deleted: FacetSchema.optional(),
  eTag: z.string().optional(),
  cTag: z.string().optional(),
  parentReference: z.object({ driveId: z.string().optional(), id: z.string().optional() }).optional(),
});
/** Names do not identify paths; IDs are scoped to the explicitly selected drive. */
export interface OnedriveItemType {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly kind: "file" | "folder" | "package" | "remote" | "other";
  readonly deleted: boolean;
  /** Informational tags. They do not pin separate download capability requests. */
  readonly etag?: string;
  readonly ctag?: string;
  readonly driveId?: string;
  readonly parentId?: string;
}
/** Graph OAuth and preauthenticated file/session authorities are deliberately separate. */
export interface OnedriveOptionsType {
  readonly driveId: string;
  /** Called only for admitted Graph URLs, never download/upload capabilities. */
  readonly token: (url: URL, signal?: AbortSignal) => string | Promise<string>;
  readonly endpoint?: string | URL;
  readonly fetch?: FetchType;
  readonly request?: RequestPolicyType;
  /** Exact origins only; no wildcard suffix or automatic Graph-origin admission. */
  readonly downloadOrigins?: readonly string[];
  readonly uploadOrigins?: readonly string[];
  /** Optional additional path boundary for admitted upload origins. Each prefix begins and ends with '/'. */
  readonly uploadPrefixes?: readonly string[];
  /** Explicit private fixture policy. HTTPS is required by default for every endpoint/capability. */
  readonly allowHttp?: boolean;
  readonly maxPages?: number;
  readonly maxEntries?: number;
}
/** Creating by parent/name and updating an existing ID are distinct native operations. */
export type OnedriveTargetType =
  | Readonly<{ kind: "create"; parentId: string; name: string; conflict?: "fail" | "replace" | "rename" }>
  | Readonly<{ kind: "update"; itemId: string }>;
/** Sensitive capability and fixed-size source contract retained for explicit recovery. */
export interface OnedriveUploadType {
  readonly url: string;
  readonly driveId: string;
  readonly size: number;
  readonly target: OnedriveTargetType;
  readonly expires: string;
}
/** Inclusive missing extent. An absent end means through the end of the fixed source. */
export interface OnedriveMissingType {
  readonly start: number;
  readonly end?: number;
}
/** Missing ranges can be partial evidence; they are not a committed contiguous offset. */
export type OnedriveUploadStatusType =
  | Readonly<{ complete: false; missing: readonly OnedriveMissingType[]; expires: string }>
  | Readonly<{ complete: true; item: OnedriveItemType }>;
/** One page preserves item identity and opaque continuation authority. */
export interface OnedrivePageType {
  readonly items: readonly OnedriveItemType[];
  readonly next?: string;
}
/** Native failure excludes provider URLs, tokens and response bodies from the message. */
export class OnedriveError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Microsoft Graph drive request failed with HTTP ${status}.`);
    this.name = "OnedriveError";
    this.status = status;
  }
}
/** A dispatched mutation lacks a validated acknowledgement. Later metadata cannot attribute that write. */
export class OnedrivePublicationError extends Error {
  constructor(cause: unknown) {
    super("OneDrive mutation has no validated acknowledgement; reconcile without blind replay.", { cause });
    this.name = "OnedrivePublicationError";
  }
}
/** Safe arithmetic and bounded native fragments are admitted before credentials or allocation. */
function integer(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid OneDrive ${label}.`);
  return value;
}
/** Control code units have no ID/name route interpretation, including embedded NUL. */
function controls(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
/** Encode opaque IDs once as route segments. Never accept path/query syntax as an ID. */
function id(value: string): string {
  if (
    typeof value !== "string" || !value || value.length > 1024 || /[\/\\?#\s]/u.test(value) || controls(value) ||
    value === "." || value === ".."
  ) throw new TypeError("Invalid OneDrive ID.");
  return encodeURIComponent(value);
}
/** Snapshot target fields once. Name addressing is confined to the create-session route. */
function target(value: OnedriveTargetType): OnedriveTargetType {
  if (value.kind === "update") {
    const itemId = value.itemId;
    id(itemId);
    if (itemId === "root") throw new TypeError("OneDrive root cannot receive file content.");
    return { kind: "update", itemId };
  }
  if (value.kind !== "create") throw new TypeError("Invalid OneDrive upload target.");
  const { parentId, name, conflict = "fail" } = value;
  id(parentId);
  if (
    typeof name !== "string" || !name || name.length > 255 || /[<>:"/\\|?*]/u.test(name) || controls(name) ||
    name === "." || name === ".." || /[. ]$/.test(name)
  ) throw new TypeError("Invalid OneDrive file name.");
  if (!["fail", "replace", "rename"].includes(conflict)) throw new TypeError("Invalid OneDrive conflict policy.");
  return { kind: "create", parentId, name, conflict };
}
/** Timestamps remain provider evidence, not client timers or expiry-based publication proof. */
function expires(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Invalid OneDrive session expiry.");
  }
  return value;
}
/** Keep exact optional fields omitted and refuse another drive's returned identity. */
function item(value: unknown, driveId: string, expected?: string): OnedriveItemType {
  const data = ItemSchema.parse(value);
  id(data.id);
  if (
    (expected !== undefined && data.id !== expected) ||
    (data.parentReference?.driveId !== undefined && data.parentReference.driveId !== driveId)
  ) throw new TypeError("OneDrive receipt has another item or drive identity.");
  const kinds = [data.file, data.folder, data.package].filter((facet) => facet !== undefined).length;
  const kind = data.remoteItem !== undefined
    ? "remote"
    : kinds > 1
    ? "other"
    : data.file !== undefined
    ? "file"
    : data.folder !== undefined
    ? "folder"
    : data.package !== undefined
    ? "package"
    : "other";
  return {
    id: data.id,
    name: data.name,
    size: data.size,
    kind,
    deleted: data.deleted !== undefined,
    ...(data.eTag === undefined ? {} : { etag: data.eTag }),
    ...(data.cTag === undefined ? {} : { ctag: data.cTag }),
    ...(data.parentReference?.driveId === undefined ? {} : { driveId: data.parentReference.driveId }),
    ...(data.parentReference?.id === undefined ? {} : { parentId: data.parentReference.id }),
  };
}

/** Owns one drive and injected transports, without ambient credentials or filesystem projection. */
export class OnedriveClient {
  readonly #api: URL;
  readonly #drive: string;
  readonly #token: OnedriveOptionsType["token"];
  readonly #fetch: FetchType;
  readonly #policy: RequestPolicyType | undefined;
  readonly #download: ReadonlySet<string>;
  readonly #upload: ReadonlySet<string>;
  readonly #prefixes: readonly string[];
  readonly #http: boolean;
  readonly #pages: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: OnedriveOptionsType) {
    this.#http = options.allowHttp ?? false;
    this.#api = this.#url(options.endpoint ?? "https://graph.microsoft.com/v1.0/");
    if (!this.#api.pathname.endsWith("/") || this.#api.search) {
      throw new TypeError("Graph endpoint needs a trailing slash and no query.");
    }
    id(options.driveId);
    this.#drive = options.driveId;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = options.request;
    const origins = (values: readonly string[]) =>
      new Set(values.map((value) => {
        const url = this.#url(value);
        if (url.pathname !== "/" || url.search) throw new TypeError("OneDrive allowlists contain exact origins only.");
        return url.origin;
      }));
    this.#download = origins(options.downloadOrigins ?? []);
    this.#upload = origins(options.uploadOrigins ?? []);
    this.#prefixes = [...options.uploadPrefixes ?? []];
    for (const prefix of this.#prefixes) {
      if (
        !prefix.startsWith("/") || !prefix.endsWith("/") || /[?#\\%]/.test(prefix) ||
        prefix.split("/").some((part) => part === "." || part === "..")
      ) throw new TypeError("Invalid OneDrive upload path prefix.");
    }
    this.#pages = integer(options.maxPages ?? 1000, "page budget");
    this.#entries = integer(options.maxEntries ?? 100000, "entry budget");
  }
  /** Every capability is admitted before network access; its opaque query is secret authority. */
  #url(value: string | URL): URL {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && !(this.#http && url.protocol === "http:")) || url.username || url.password ||
      url.hash || url.href.length > 65536
    ) throw new TypeError("Invalid OneDrive URL authority.");
    return url;
  }
  #capability(value: string, role: "download" | "upload"): URL {
    const url = this.#url(value);
    if (!(role === "download" ? this.#download : this.#upload).has(url.origin)) {
      throw new TypeError("OneDrive capability origin is not explicitly allowed.");
    }
    if (
      role === "upload" && this.#prefixes.length > 0 &&
      (/%(?:2f|5c|25)/i.test(url.pathname) || !this.#prefixes.some((prefix) => url.pathname.startsWith(prefix)))
    ) throw new TypeError("OneDrive upload capability is outside the configured path prefixes.");
    return url;
  }
  #route(itemId: string, operation = ""): URL {
    const address = itemId === "root" ? "root" : `items/${id(itemId)}`;
    return new URL(`drives/${id(this.#drive)}/${address}${operation}`, this.#api);
  }
  /** Graph and capability requests share cleanup/retry mechanics, never credential acquisition. */
  async #send(
    url: URL,
    method: string,
    graph: boolean,
    headers = new Headers(),
    body?: BodyInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    signal?.throwIfAborted();
    if (graph) {
      const token = await this.#token(new URL(url), signal);
      signal?.throwIfAborted();
      if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
        throw new TypeError("Invalid Graph bearer token.");
      }
      headers.set("Authorization", `Bearer ${token}`);
    }
    let dispatched = false;
    try {
      return await sendRequest(
        async (signal) => ({
          input: url,
          init: {
            method,
            headers,
            credentials: "omit",
            redirect: "manual",
            ...(signal === undefined ? {} : { signal }),
            ...(body === undefined ? {} : { body }),
          },
        }),
        {
          fetch: (input, init) => {
            dispatched = true;
            return this.#fetch(input, init);
          },
          replayable: method === "GET",
          metrics: this.#metrics,
          ...(this.#policy === undefined ? {} : { policy: this.#policy }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (cause) {
      if (dispatched && method !== "GET") throw new OnedrivePublicationError(cause);
      throw cause;
    }
  }
  /** Parsing owns the bounded control response, including failed-response release. */
  async #json(response: Response): Promise<unknown> {
    return await readResponse(response, async (text) => {
      if (!response.ok) throw new OnedriveError(response.status);
      return JSON.parse(await text());
    });
  }
  /** Metadata tags are informational; no immutable read identity is synthesized. */
  async stat(itemId: string, signal?: AbortSignal): Promise<OnedriveItemType> {
    const url = this.#route(itemId);
    url.searchParams.set("$select", selection);
    return item(
      await this.#json(await this.#send(url, "GET", true, new Headers(), undefined, signal)),
      this.#drive,
      itemId === "root" ? undefined : itemId,
    );
  }
  /** Admit a server continuation only inside the exact selected folder route. */
  #page(value: string, expected: URL): URL {
    const url = this.#url(value);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      throw new TypeError("OneDrive continuation changed the selected folder route.");
    }
    const names = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (names.has(key) || !["$select", "$top", "$skiptoken", "$skipToken", "$orderby"].includes(key)) {
        throw new TypeError("Unsupported OneDrive continuation query.");
      }
      names.add(key);
    }
    return url;
  }
  /** Preserve returned names and IDs; listing is not a consistent snapshot or name resolver. */
  async listPage(
    parentId: string,
    options: { readonly next?: string; readonly pageSize?: number; readonly signal?: AbortSignal } = {},
  ): Promise<OnedrivePageType> {
    const { next, signal } = options;
    const pageSize = integer(options.pageSize ?? 200, "page size", 1000);
    if (pageSize === 0) throw new RangeError("OneDrive page size must be positive.");
    const route = this.#route(parentId, "/children");
    const url = next === undefined ? route : this.#page(next, route);
    if (next === undefined) {
      url.searchParams.set("$select", selection);
      url.searchParams.set("$top", String(pageSize));
    }
    const data = z.object({ value: z.array(z.unknown()), "@odata.nextLink": z.string().optional() }).parse(
      await this.#json(await this.#send(url, "GET", true, new Headers(), undefined, signal)),
    );
    if (data.value.length > 1000) throw new RangeError("OneDrive page exceeds the implementation entry ceiling.");
    const continuation = data["@odata.nextLink"];
    if (continuation !== undefined) this.#page(continuation, route);
    return {
      items: data.value.map((value) => item(value, this.#drive)),
      ...(continuation === undefined ? {} : { next: continuation }),
    };
  }
  /** Bounded lazy iteration releases every control response before yielding a page. */
  async *list(
    parentId: string,
    options: { readonly pageSize?: number; readonly signal?: AbortSignal } = {},
  ): AsyncGenerator<OnedriveItemType> {
    const selected = { ...options };
    const selectedParent = parentId;
    let next: string | undefined;
    let entries = 0;
    const seen = new Set<string>();
    for (let page = 0; page < this.#pages; page++) {
      const result = await this.listPage(selectedParent, { ...selected, ...(next === undefined ? {} : { next }) });
      entries += result.items.length;
      if (entries > this.#entries) throw new RangeError("OneDrive listing exceeds the entry budget.");
      yield* result.items;
      if (result.next === undefined) return;
      if (seen.has(result.next)) throw new TypeError("OneDrive continuation repeated.");
      seen.add(result.next);
      next = result.next;
    }
    throw new RangeError("OneDrive listing exceeds the page budget.");
  }
  /** Fresh preauthenticated media URL; Range is sent there without Graph OAuth or cookies. */
  async download(
    itemId: string,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const selected = range(options);
    const route = this.#route(itemId);
    if (selected.empty) {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    route.searchParams.set("$select", `${selection},@microsoft.graph.downloadUrl`);
    const data: unknown = await this.#json(
      await this.#send(route, "GET", true, new Headers(), undefined, selected.signal),
    );
    const metadata = item(data, this.#drive, itemId === "root" ? undefined : itemId);
    if (metadata.kind !== "file" || metadata.deleted) {
      throw new TypeError("OneDrive download requires a local regular file facet.");
    }
    const address =
      z.object({ "@microsoft.graph.downloadUrl": z.string() }).parse(data)["@microsoft.graph.downloadUrl"];
    const url = this.#capability(address, "download");
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (selected.header !== undefined) headers.set("Range", selected.header);
    const response = await this.#send(url, "GET", false, headers, undefined, selected.signal);
    if (!response.ok) await this.#json(response);
    await assertRangeResponse(response, selected);
    if (response.body === null) throw new TypeError("OneDrive media response has no body.");
    return response.body;
  }
  /** Native DELETE recycles the item, including folder descendants; it is not permanent deletion. */
  async trash(
    itemId: string,
    options: { readonly ifMatch?: string; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const { ifMatch, signal } = options;
    const url = this.#route(itemId);
    const headers = new Headers();
    if (ifMatch !== undefined) {
      if (!ifMatch || /[\r\n]/.test(ifMatch)) throw new TypeError("Invalid OneDrive item condition.");
      headers.set("If-Match", ifMatch);
    }
    const response = await this.#send(url, "DELETE", true, headers, undefined, signal);
    try {
      await readResponse(response, () => {
        if (response.status !== 204) throw new OnedriveError(response.status);
      });
    } catch (cause) {
      if (cause instanceof OnedriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new OnedrivePublicationError(cause);
    }
  }
  /** Restored upload authority is independently admitted and detached before awaited work. */
  #session(value: OnedriveUploadType): OnedriveUploadType {
    const { url, driveId, size, target: destination, expires: expiration } = value;
    if (driveId !== this.#drive) throw new TypeError("OneDrive session belongs to another drive.");
    if (integer(size, "upload size") === 0) {
      throw new RangeError("This OneDrive resumable profile requires a positive size.");
    }
    return {
      url: this.#capability(url, "upload").href,
      driveId,
      size,
      target: target(destination),
      expires: expires(expiration),
    };
  }
  /** Fixed-size positive-length session. Caller owns immutable source bytes and exclusive sequential use. */
  async createUpload(
    options: { readonly size: number; readonly target: OnedriveTargetType; readonly signal?: AbortSignal },
  ): Promise<OnedriveUploadType> {
    const { size, signal } = options;
    const destination = target(options.target);
    if (integer(size, "upload size") === 0) {
      throw new RangeError("This OneDrive resumable profile requires a positive size.");
    }
    const url = destination.kind === "update"
      ? this.#route(destination.itemId, "/createUploadSession")
      : this.#route(destination.parentId, `:/${encodeURIComponent(destination.name)}:/createUploadSession`);
    const body = JSON.stringify({
      item: destination.kind === "create"
        ? { name: destination.name, "@microsoft.graph.conflictBehavior": destination.conflict }
        : {},
      deferCommit: false,
    });
    const response = await this.#send(
      url,
      "POST",
      true,
      new Headers({ "Content-Type": "application/json" }),
      body,
      signal,
    );
    try {
      const data = z.object({ uploadUrl: z.string(), expirationDateTime: z.string() }).parse(
        await this.#json(response),
      );
      return this.#session({
        url: data.uploadUrl,
        driveId: this.#drive,
        size,
        target: destination,
        expires: data.expirationDateTime,
      });
    } catch (cause) {
      if (cause instanceof OnedriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new OnedrivePublicationError(cause);
    }
  }
  /** Preserve partial native missing-range evidence; never infer completion from an empty list. */
  #missing(value: unknown, size: number): Extract<OnedriveUploadStatusType, { complete: false }> {
    const data = z.object({ expirationDateTime: z.string(), nextExpectedRanges: z.array(z.string()).max(1024) }).parse(
      value,
    );
    const missing = data.nextExpectedRanges.map((value): OnedriveMissingType => {
      const match = /^(\d+)-(\d*)$/.exec(value);
      if (match === null) throw new TypeError("Malformed OneDrive missing range.");
      const start = integer(Number(match[1]), "missing range start", size - 1);
      if (match[2] === "") return { start };
      const end = integer(Number(match[2]), "missing range end", size - 1);
      if (end < start) throw new TypeError("Reversed OneDrive missing range.");
      return { start, end };
    });
    return { complete: false, missing, expires: expires(data.expirationDateTime) };
  }
  /** HTTP 200 here reports a live session, not a completed driveItem receipt. */
  async queryUpload(value: OnedriveUploadType, signal?: AbortSignal): Promise<OnedriveUploadStatusType> {
    const upload = this.#session(value);
    return this.#missing(
      await this.#json(await this.#send(new URL(upload.url), "GET", false, new Headers(), undefined, signal)),
      upload.size,
    );
  }
  /** Copy native bytes before awaits; response 202 records staging, only a final item validates publication. */
  async writeUpload(
    value: OnedriveUploadType,
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<OnedriveUploadStatusType> {
    const upload = this.#session(value);
    integer(offset, "upload offset", upload.size);
    if (!isBytes(bytes)) throw new TypeError("OneDrive upload requires a Uint8Array.");
    const view = toView(bytes);
    const length = view.byteLength;
    if (
      length === 0 || length > 8 * 1024 * 1024 || length > upload.size - offset ||
      (offset + length !== upload.size && length % ONEDRIVE_CHUNK_BYTES !== 0)
    ) throw new RangeError("Invalid OneDrive upload extent (8 MiB implementation ceiling).");
    const body = toRequestBytes(new Uint8Array(view));
    const response = await this.#send(
      new URL(upload.url),
      "PUT",
      false,
      new Headers({
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${offset}-${offset + length - 1}/${upload.size}`,
      }),
      body,
      signal,
    );
    try {
      if (response.status === 202) return this.#missing(await this.#json(response), upload.size);
      const parsed = await this.#json(response);
      if (response.status !== 200 && response.status !== 201) {
        throw new TypeError("OneDrive final upload receipt requires HTTP 200 or 201.");
      }
      const receipt = item(parsed, this.#drive, upload.target.kind === "update" ? upload.target.itemId : undefined);
      if (
        receipt.kind !== "file" || receipt.deleted || receipt.size !== upload.size || offset + length !== upload.size
      ) throw new TypeError("OneDrive final upload receipt has a different file extent or kind.");
      if (
        upload.target.kind === "create" &&
        ((receipt.parentId !== undefined && upload.target.parentId !== "root" &&
          receipt.parentId !== upload.target.parentId) ||
          (upload.target.conflict !== "rename" && receipt.name !== upload.target.name))
      ) throw new TypeError("OneDrive created receipt has a different parent or name.");
      return { complete: true, item: receipt };
    } catch (cause) {
      if (cause instanceof OnedriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new OnedrivePublicationError(cause);
    }
  }
  /** Delete only temporary upload state. A lost response does not prove cleanup or published-item deletion. */
  async cancelUpload(value: OnedriveUploadType, signal?: AbortSignal): Promise<void> {
    const upload = this.#session(value);
    const response = await this.#send(new URL(upload.url), "DELETE", false, new Headers(), undefined, signal);
    try {
      await readResponse(response, () => {
        if (response.status !== 204) throw new OnedriveError(response.status);
      });
    } catch (cause) {
      if (cause instanceof OnedriveError && cause.status >= 400 && cause.status < 500) throw cause;
      throw new OnedrivePublicationError(cause);
    }
  }
}
