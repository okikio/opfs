/** Bounded first-party compatibility with Netlify Blobs SDK 11.1.7 API routing. @module */
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { close } from "./close.ts";
import { isBytes, toView } from "./bytes.ts";
import type { FetchType } from "./request.ts";
export type { FetchType } from "./request.ts";

/** Observed SDK wire compatibility, not a stable provider REST specification. */
export const NETLIFY_PROFILE = "netlify-blobs-11.1.7-api-v1";
/** One explicit grant for a negotiated capability. The account bearer is never sent to this URL. */
export interface NetlifyDataType {
  /** The final data request method, never an account API negotiation. */
  readonly method: "GET" | "PUT";
  /** Qualified original provider key; no filesystem normalization is performed. */
  readonly key: string;
}
/** Constructor values and callbacks are captured without reading environment variables or making requests. */
export interface NetlifyOptionsType {
  /** Exact reviewed SDK-wire admission; broader SDK or stable REST compatibility is not implied. */
  readonly profile: typeof NETLIFY_PROFILE;
  /** Borrowed Fetch must honor AbortSignal and must not retry mutations internally. */
  readonly fetch: FetchType;
  /** Explicit authority only: no path other than /, query, userinfo or fragment. */
  readonly api: string;
  /** Explicit account site identifier in the admitted ASCII profile. */
  readonly site: string;
  /** Application store name. The client adds the SDK's literal site: prefix. */
  readonly store: string;
  /** Visible-ASCII account bearer, confined to this API authority. */
  readonly token: string;
  /** Return literal true to permit this exact canonical signed URL; asynchronous decisions are refused. */
  readonly authorizeDataURL: (url: string, request: Readonly<NetlifyDataType>) => boolean;
  /** Explicit fixture grant; applies to API and separately authorized data URLs. Default false. */
  readonly allowHttp?: boolean;
  /** Default 1 MiB for a copied PUT or complete GET. */
  readonly maxBytes?: number;
  /** Default 64 KiB per negotiation/list JSON response. */
  readonly maxJsonBytes?: number;
  /** Default 32 KiB of response header names and values. */
  readonly maxHeaderBytes?: number;
  /** Default 2 KiB of encoded metadata header name plus value. Writes are outside this profile. */
  readonly maxMetadataBytes?: number;
  /** Default 1,000 entries across blobs and directories in one page. */
  readonly maxEntries?: number;
  /** Default 2 MiB of aggregate response bytes across this operation's requests. */
  readonly maxResponseBytes?: number;
  /** Default two concrete Fetch calls; no retries or automatic capability refresh. */
  readonly maxRequests?: number;
  /** Default 65,536 body read attempts across the operation, including empty chunks and EOF. */
  readonly maxReadSteps?: number;
  /** Default 30 seconds; aborts and joins the borrowed transport rather than abandoning its promise. */
  readonly timeoutMs?: number;
}
/** Per-operation borrowed cancellation; it never transfers ownership of the caller's controller. */
export interface NetlifyOperationType {
  /** Aborts owned Fetch/body work, then awaits retirement before settlement. */
  readonly signal?: AbortSignal;
}
/** Cache validation and cancellation for one complete bounded GET. */
export interface NetlifyGetOptionsType extends NetlifyOperationType {
  /** Cache validation only, not a revision guard. Sent only to the final capability URL. */
  readonly etag?: string;
}
/** Native single-page query; cursors and prefixes are serialized once with URLSearchParams. */
export interface NetlifyListOptionsType extends NetlifyOperationType {
  /** Exact bounded Unicode prefix, not a normalized directory path. */
  readonly prefix?: string;
  /** Request the native directories=true projection; omission and false leave it absent. */
  readonly directories?: boolean;
  /** Native opaque continuation token. No local iterator state or invented page-size parameter. */
  readonly cursor?: string;
}
/** Mutually exclusive create-only or opaque ETag-match conditions on the final data PUT. */
export type NetlifyConditionType =
  | {
    /** Create only when absent by sending If-None-Match: *. */
    readonly kind: "new";
  }
  | {
    /** Replace only the object matching the supplied ETag observation. */
    readonly kind: "match";
    /** Nonempty opaque provider ETag, sent as If-Match. */
    readonly etag: string;
  };
/** No metadata-writing option is exposed until Unicode interoperability is qualified. */
export interface NetlifyPutOptionsType extends NetlifyOperationType {
  /** Omission performs an unconditional PUT; conditions do not imply automatic replay safety. */
  readonly condition?: NetlifyConditionType;
}
/** Detached actual transport work; this is not provider-internal work or heap accounting. */
export interface NetlifyWorkType {
  /** Concrete Fetch invocations, never retry-policy estimates. */
  readonly requests: number;
  /** Observed response bytes, including a refused oversized chunk. */
  readonly responseBytes: number;
  /** Body read attempts, including empty chunks, EOF and failed reads. */
  readonly readSteps: number;
}
/** Bounded provider metadata; ETags are opaque observations, not authentication evidence. */
export interface NetlifyObservationType {
  /** Optional opaque response ETag; missing is not replaced by an invented identity. */
  readonly etag?: string;
  /** Strict bounded JSON data, without executable extension or string-map interpretation. */
  readonly metadata: unknown;
}
/** Only HEAD 200/404 are admitted. Size and ETag can both remain absent. */
export type NetlifyHeadType =
  | {
    /** The account API returned 404 for this metadata request. */
    readonly state: "absent";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  }
  | (NetlifyObservationType & {
    /** The account API returned metadata with status 200. */
    readonly state: "present";
    /** Optional declared object size; HEAD does not download bytes to measure it. */
    readonly size?: number;
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  });
/** Absence, cache validation and owned full bytes are separate outcomes. */
export type NetlifyGetType =
  | {
    /** The final data request returned 404; negotiation failures reject instead. */
    readonly state: "absent";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  }
  | (NetlifyObservationType & {
    /** A GET with a supplied cache ETag returned 304; no object bytes are returned. */
    readonly state: "not-modified";
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  })
  | (NetlifyObservationType & {
    /** The final data request returned 200 and the complete body passed admission. */
    readonly state: "present";
    /** Owned exact-length snapshot; a later operation cannot overwrite these bytes. */
    readonly bytes: Uint8Array;
    /** Measured downloaded byte count, independent of optional HEAD observations. */
    readonly size: number;
    /** Requests and response reads completed by this operation. */
    readonly work: NetlifyWorkType;
  });
/** One native page; later pages remain caller-owned explicit operations. */
export interface NetlifyPageType {
  /** JSON 200 page or native 404 store absence. */
  readonly state: "page" | "absent";
  /** Listed native identities can exceed this initial client's actionable ASCII key subset. */
  readonly blobs: readonly {
    /** Original provider key, preserved without filesystem normalization. */
    readonly key: string;
    /** Optional opaque ETag observed in this listing. */
    readonly etag?: string;
  }[];
  /** Native directory projection strings, not filesystem directory handles. */
  readonly directories: readonly string[];
  /** Opaque next_cursor; no stable source or resumable-upload claim follows from it. */
  readonly cursor?: string;
  /** Completed operation work. */
  readonly work: NetlifyWorkType;
}
/** A final conditional response observation; modified:false never proves the entire history was unchanged. */
export interface NetlifyPutType {
  /** The acknowledged native operation. */
  readonly operation: "put";
  /** Exact qualified original key. */
  readonly key: string;
  /** Final successful or condition-refused response, not proof about previous attempts. */
  readonly modified: boolean;
  /** Native final response status. */
  readonly status: number;
  /** Known copied input length, also retained on a conditional refusal. */
  readonly size: number;
  /** Optional success response ETag; condition refusals do not become write receipts. */
  readonly etag?: string;
  /** Work through acknowledgement and response retirement. */
  readonly work: NetlifyWorkType;
}
/** An unconditional removal acknowledgement, not a deleted-revision receipt. */
export interface NetlifyDeleteType {
  /** The acknowledged native operation. */
  readonly operation: "delete";
  /** Exact qualified original key. */
  readonly key: string;
  /** Accepted unconditional removal/already-absent acknowledgement. */
  readonly status: 200 | 204 | 404;
  /** Work through acknowledgement and response retirement. */
  readonly work: NetlifyWorkType;
}
/** An admitted mutation observation that remains available if later cleanup fails. */
export type NetlifyReceiptType = NetlifyPutType | NetlifyDeleteType;
/** Library-owned messages exclude credentials, capability queries and response text. */
export class NetlifyError extends Error {
  /** Stable local policy, format, authorization or native HTTP failure category. */
  readonly code: "invalid-response" | "budget-exceeded" | "http" | "capability-refused";
  /** Account API or credential-free data capability phase. */
  readonly phase: "api" | "data";
  /** Native status when a response was received. */
  readonly status: number | undefined;
  /** Preserve structured observations without embedding sensitive response text or URLs. */
  constructor(code: NetlifyError["code"], phase: "api" | "data", status?: number) {
    super(`Netlify ${phase} request ${code}${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "NetlifyError";
    this.code = code;
    this.phase = phase;
    this.status = status;
  }
}
/** A dispatched mutation lacks an admitted completion. Reconcile before any caller-owned retry. */
export class NetlifyPublicationError extends Error {
  /** No rollback, absence or safe replay follows from this failure. */
  readonly outcome = "unknown";
  /** The dispatched mutation requiring caller reconciliation. */
  readonly operation: "put" | "delete";
  /** Original key to reconcile. */
  readonly key: string;
  /** Retain the original failure, including an undefined rejection reason. */
  constructor(operation: "put" | "delete", key: string, cause: unknown) {
    super("Netlify mutation outcome is unknown; reconcile the key before retrying.", { cause });
    this.name = "NetlifyPublicationError";
    this.operation = operation;
    this.key = key;
  }
}
/** Preserve an already-known acknowledgement beside a later parsing, abort or cleanup failure. */
export class NetlifyCompletionError extends Error {
  /** Known final observation, updated with work through the later failure. */
  readonly receipt: NetlifyReceiptType;
  /** A cleanup/admission failure does not revoke the already-known receipt. */
  constructor(receipt: NetlifyReceiptType, cause: unknown) {
    super("Netlify acknowledged the mutation before completion or cleanup failed.", { cause });
    this.name = "NetlifyCompletionError";
    this.receipt = receipt;
  }
}
/** Independent operation allowances; no byte limit substitutes for the request or read-step limit. */
interface PolicyType {
  bytes: number;
  json: number;
  headers: number;
  metadata: number;
  entries: number;
  response: number;
  requests: number;
  reads: number;
  timeout: number;
}
function fail(code: NetlifyError["code"], phase: "api" | "data", status?: number): never {
  throw new NetlifyError(code, phase, status);
}
/** Reject ill-formed UTF-16 instead of letting TextEncoder silently replace key/token identity. */
function text(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || new TextEncoder().encode(value).length > maximum) {
    throw new TypeError(`Netlify ${label} must be bounded well-formed text without controls.`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) throw new TypeError(`Netlify ${label} must not contain control characters.`);
  }
  return value;
}
/** Keep each actionable key inside the qualified URL-path subset; never rewrite a provider identity. */
function key(value: string): string {
  text(value, 600, "key");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value)) {
    throw new TypeError("Netlify key is outside the qualified ASCII segment profile.");
  }
  return value;
}
function etag(value: string): string {
  text(value, 4096, "ETag");
  if (value.length === 0) throw new TypeError("Netlify conditional ETag must not be empty.");
  return value;
}
/** Validate without reserializing: changing a signed URL's spelling can invalidate its capability. */
function address(value: string, allowHttp: boolean): string {
  if (typeof value !== "string" || value.length > 16384) throw new TypeError("Netlify URL must be a bounded string.");
  text(value, 16384, "URL");
  if (/\s/.test(value)) throw new TypeError("Netlify URL must not contain unescaped whitespace.");
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password || url.hash
  ) throw new TypeError("Netlify URL authority is not permitted.");
  return value;
}
/** Bound parsed JSON structure separately from its serialized-byte ceiling. */
function json(bytes: Uint8Array, phase: "api" | "data"): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    fail("invalid-response", phase);
  }
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 16) fail("budget-exceeded", phase);
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid-response", phase);
    if (Array.isArray(item)) { for (const child of item) inspect(child, depth + 1); }
    else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  return value;
}
function object(value: unknown, phase: "api" | "data"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid-response", phase);
  return value as Record<string, unknown>;
}

/** One operation owns its deadline, response bodies and finite request/byte ledger. */
class Operation {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #parent: AbortSignal | undefined;
  readonly #abort: () => void;
  readonly #policy: PolicyType;
  readonly #fetch: FetchType;
  #requests = 0;
  #bytes = 0;
  #reads = 0;
  /** Set at Fetch dispatch, when a missing reply can no longer establish that no mutation occurred. */
  mutation: { operation: "put" | "delete"; key: string } | undefined;
  /** An admitted final status survives later response admission, abort or retirement failures. */
  receipt: NetlifyReceiptType | undefined;
  constructor(fetch: FetchType, policy: PolicyType, signal?: AbortSignal) {
    this.#fetch = fetch;
    this.#policy = policy;
    this.#parent = signal;
    this.#abort = () => this.controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", this.#abort, { once: true });
    this.#timer = setTimeout(
      () => this.controller.abort(new DOMException("Netlify operation deadline exceeded.", "TimeoutError")),
      policy.timeout,
    );
  }
  work(): NetlifyWorkType {
    return { requests: this.#requests, responseBytes: this.#bytes, readSteps: this.#reads };
  }
  close(): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener("abort", this.#abort);
  }
  async send(
    url: string,
    method: string,
    headers: Headers,
    phase: "api" | "data",
    body?: Uint8Array<ArrayBuffer>,
    mutation?: { operation: "put" | "delete"; key: string },
  ): Promise<Response> {
    this.signal.throwIfAborted();
    if (this.#requests >= this.#policy.requests) fail("budget-exceeded", phase);
    this.#requests++;
    if (mutation) this.mutation = mutation;
    // The supplied Fetch is the dispatch boundary. Hidden retries violate its contract.
    return await this.#fetch(url, {
      method,
      headers,
      redirect: "error",
      credentials: "omit",
      signal: this.signal,
      ...(body === undefined ? {} : { body }),
    });
  }
  headers(response: Response, phase: "api" | "data"): void {
    if (response.redirected) fail("invalid-response", phase, response.status);
    let length = 0;
    for (const [name, value] of response.headers) {
      length += new TextEncoder().encode(name).length + new TextEncoder().encode(value).length;
      if (length > this.#policy.headers) fail("budget-exceeded", phase, response.status);
    }
  }
  /**
   * Copy one bounded body and retire its reader before returning or rejecting.
   *
   * Read attempts share the operation ledger, so tiny and empty chunks cannot evade work admission. Growth retains
   * one accumulator instead of one object per chunk. A terminal source error is already observed; cancel only when
   * retirement still owns an active read, then preserve independent cancellation/release failures beside the primary.
   */
  async read(response: Response, maximum: number, phase: "api" | "data"): Promise<Uint8Array<ArrayBuffer>> {
    if (response.body === null) {
      this.signal.throwIfAborted();
      return new Uint8Array();
    }
    const reader = response.body.getReader();
    let output: Uint8Array<ArrayBuffer> = new Uint8Array();
    let length = 0, done = false, terminal = false, canceled: Promise<void> | undefined;
    const cancel = (reason?: unknown): Promise<void> => {
      canceled ??= Promise.resolve().then(() => reader.cancel(reason));
      void canceled.catch(() => {});
      return canceled;
    };
    const abort = (): void => {
      void cancel(this.signal.reason);
    };
    this.signal.addEventListener("abort", abort, { once: true });
    const failures: unknown[] = [];
    try {
      let empty = 0;
      while (true) {
        this.signal.throwIfAborted();
        if (this.#reads >= this.#policy.reads) fail("budget-exceeded", phase);
        this.#reads++;
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await reader.read();
        } catch (error) {
          terminal = true;
          throw error;
        }
        this.signal.throwIfAborted();
        if (item.done) {
          done = true;
          break;
        }
        if (!isBytes(item.value)) fail("invalid-response", phase);
        const bytes = toView(item.value);
        if (bytes.length === 0 && ++empty > 16) fail("budget-exceeded", phase);
        if (bytes.length !== 0) empty = 0;
        const refused = bytes.length > maximum - length || bytes.length > this.#policy.response - this.#bytes;
        this.#bytes += bytes.length;
        if (refused) fail("budget-exceeded", phase);
        if (bytes.length === 0) continue;
        const needed = length + bytes.length;
        if (needed > output.length) {
          const doubled = output.length > maximum - output.length ? maximum : output.length * 2;
          const capacity = Math.min(maximum, Math.max(needed, doubled));
          const grown = new Uint8Array(capacity);
          grown.set(output);
          output = grown;
        }
        output.set(bytes, length);
        length = needed;
      }
    } catch (error) {
      failures.push(error);
    } finally {
      this.signal.removeEventListener("abort", abort);
      await close(
        [...(canceled || !done && !terminal ? [() => cancel(failures[0])] : []), () => reader.releaseLock()],
        failures,
      );
    }
    return length === output.length ? output : output.slice(0, length);
  }
  /** Retire an untouched body when status/header admission fails before read() can take ownership. */
  async response<T>(response: Response, action: () => Promise<T>): Promise<T> {
    const failures: unknown[] = [];
    try {
      return await action();
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      if (response.body !== null && !response.body.locked && !response.bodyUsed) {
        await close([() => response.body!.cancel(failures[0])], failures);
      }
    }
  }
}

/**
 * Read and mutate one explicit site store through the pinned SDK-wire profile.
 *
 * The account API negotiates data URLs, but the caller must authorize each exact URL before it is used. The account
 * bearer stays on the API authority. Each operation borrows Fetch, owns its response bodies and waits for retirement.
 * The client performs no retries, filesystem projection, remote ranges or resumable uploads.
 *
 * A dispatched mutation without an admitted final response throws NetlifyPublicationError with an unknown outcome.
 * A later failure after a known final observation throws NetlifyCompletionError and retains that receipt. The caller
 * owns reconciliation and any retry; an ETag observation is not authentication or proof of permanent retention.
 */
export class NetlifyClient {
  readonly #fetch: FetchType;
  readonly #api: string;
  readonly #site: string;
  readonly #store: string;
  readonly #token: string;
  readonly #authorize: NetlifyOptionsType["authorizeDataURL"];
  readonly #http: boolean;
  readonly #policy: PolicyType;
  /** Capture explicit application authority and policy without provider I/O or capability authorization. */
  constructor(options: NetlifyOptionsType) {
    const captured = { ...options };
    if (
      captured.profile !== NETLIFY_PROFILE || typeof captured.fetch !== "function" ||
      typeof captured.authorizeDataURL !== "function"
    ) throw new TypeError("Netlify requires its explicit compatibility profile, Fetch and data URL authorization.");
    if (captured.allowHttp !== undefined && typeof captured.allowHttp !== "boolean") {
      throw new TypeError("Netlify HTTP grant must be boolean.");
    }
    this.#http = captured.allowHttp ?? false;
    const api = new URL(address(captured.api, this.#http));
    if (api.pathname !== "/" || api.search) {
      throw new TypeError("Netlify API must name an authority without a path or query.");
    }
    this.#api = api.origin;
    this.#site = text(captured.site, 128, "site");
    this.#store = text(captured.store, 64, "store");
    if (!/^[A-Za-z0-9_-]+$/.test(this.#site) || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(this.#store)) {
      throw new TypeError("Netlify site/store is outside the qualified ASCII profile.");
    }
    this.#token = text(captured.token, 8192, "account token");
    if (!this.#token || /[^\x21-\x7e]/.test(this.#token)) {
      throw new TypeError("Netlify bearer must be nonempty visible ASCII.");
    }
    this.#fetch = captured.fetch;
    this.#authorize = captured.authorizeDataURL;
    this.#policy = {
      bytes: captured.maxBytes ?? 1048576,
      json: captured.maxJsonBytes ?? 65536,
      headers: captured.maxHeaderBytes ?? 32768,
      metadata: captured.maxMetadataBytes ?? 2048,
      entries: captured.maxEntries ?? 1000,
      response: captured.maxResponseBytes ?? 2097152,
      requests: captured.maxRequests ?? 2,
      reads: captured.maxReadSteps ?? 65536,
      timeout: captured.timeoutMs ?? 30000,
    };
    for (const [label, value] of Object.entries(this.#policy)) {
      if (!Number.isSafeInteger(value) || value < 0 || label === "timeout" && (value === 0 || value > 2147483647)) {
        throw new TypeError(`Netlify ${label} limit must be a finite admitted integer.`);
      }
    }
  }
  #url(key?: string, parameters?: URLSearchParams): string {
    const url = new URL(
      `/api/v1/blobs/${this.#site}/site:${this.#store}${key === undefined ? "" : `/${key}`}`,
      this.#api,
    );
    if (parameters) url.search = parameters.toString();
    return url.href;
  }
  #headers(): Headers {
    return new Headers({ authorization: `Bearer ${this.#token}` });
  }
  /** Classify failure by the latest admitted mutation state before retiring the operation's timer and listener. */
  async #run<T>(signal: AbortSignal | undefined, action: (operation: Operation) => Promise<T>): Promise<T> {
    const op = new Operation(this.#fetch, this.#policy, signal);
    try {
      return await action(op);
    } catch (error) {
      if (op.receipt !== undefined) throw new NetlifyCompletionError({ ...op.receipt, work: op.work() }, error);
      if (op.mutation !== undefined) throw new NetlifyPublicationError(op.mutation.operation, op.mutation.key, error);
      throw error;
    } finally {
      op.close();
    }
  }
  /** Negotiation grants no ambient authority: require the caller's literal true before dispatching data requests. */
  async #data(op: Operation, key: string, method: "GET" | "PUT"): Promise<string> {
    const headers = this.#headers();
    headers.set("accept", "application/json;type=signed-url");
    const response = await op.send(this.#url(key), method, headers, "api");
    return await op.response(response, async () => {
      op.headers(response, "api");
      if (response.status !== 200) fail("http", "api", response.status);
      const value = object(json(await op.read(response, this.#policy.json, "api"), "api"), "api");
      if (typeof value.url !== "string") fail("invalid-response", "api");
      let url: string;
      try {
        url = address(value.url, this.#http);
      } catch {
        fail("invalid-response", "api");
      }
      if (new URL(url).href !== url) fail("invalid-response", "api");
      if (this.#authorize(url, Object.freeze({ method, key })) !== true) fail("capability-refused", "data");
      return url;
    });
  }
  /** Decode the admitted metadata header as bounded data; never turn a missing ETag into a revision guarantee. */
  #observation(response: Response, phase: "api" | "data"): NetlifyObservationType {
    const etag = response.headers.get("etag") || undefined;
    const external = response.headers.get("netlify-blobs-metadata"), internal = response.headers.get("x-amz-meta-user");
    const header = external || internal;
    let metadata: unknown = {};
    if (header !== null && header !== "") {
      if (header.length + (external ? "netlify-blobs-metadata" : "x-amz-meta-user").length > this.#policy.metadata) {
        fail("budget-exceeded", phase);
      }
      if (header.startsWith("b64;")) {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(header.slice(4));
          if (encodeBase64(bytes) !== header.slice(4)) fail("invalid-response", phase);
        } catch {
          fail("invalid-response", phase);
        }
        metadata = json(bytes, phase);
      }
    }
    return { ...(etag === undefined ? {} : { etag }), metadata };
  }
  #size(response: Response, phase: "api" | "data"): number | undefined {
    const raw = response.headers.get("content-length");
    if (raw === null) return undefined;
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail("invalid-response", phase);
    return Number(raw);
  }
  /** Metadata remains optional observation; missing size/ETag never triggers a hidden GET. */
  head(value: string, supplied: NetlifyOperationType = {}): Promise<NetlifyHeadType> {
    const name = key(value), { signal } = supplied;
    return this.#run(signal, async (op) => {
      const response = await op.send(this.#url(name), "HEAD", this.#headers(), "api");
      return await op.response(response, async (): Promise<NetlifyHeadType> => {
        op.headers(response, "api");
        if (response.status === 404) {
          await op.read(response, this.#policy.json, "api");
          return { state: "absent", work: op.work() };
        }
        if (response.status !== 200) fail("http", "api", response.status);
        const observed = this.#observation(response, "api"), size = this.#size(response, "api");
        await op.read(response, this.#policy.json, "api");
        return { state: "present", ...observed, ...(size === undefined ? {} : { size }), work: op.work() };
      });
    });
  }
  /** Full bounded snapshot. Cache validation is not an If-Match revision guard or range request. */
  get(value: string, supplied: NetlifyGetOptionsType = {}): Promise<NetlifyGetType> {
    const name = key(value),
      { signal, etag: cached } = supplied,
      match = cached === undefined ? undefined : etag(cached);
    return this.#run(signal, async (op) => {
      const url = await this.#data(op, name, "GET"), headers = new Headers();
      if (match !== undefined) headers.set("if-none-match", match);
      const response = await op.send(url, "GET", headers, "data");
      return await op.response(response, async (): Promise<NetlifyGetType> => {
        op.headers(response, "data");
        if (response.status === 404) {
          await op.read(response, this.#policy.json, "data");
          return { state: "absent", work: op.work() };
        }
        if (response.status === 304 && match !== undefined) {
          const observed = this.#observation(response, "data");
          await op.read(response, 0, "data");
          return { state: "not-modified", ...observed, work: op.work() };
        }
        if (response.status !== 200) fail("http", "data", response.status);
        if (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity") {
          fail("invalid-response", "data");
        }
        const observed = this.#observation(response, "data"), declared = this.#size(response, "data");
        if (declared !== undefined && declared > this.#policy.bytes) fail("budget-exceeded", "data");
        const bytes = await op.read(response, this.#policy.bytes, "data");
        if (declared !== undefined && declared !== bytes.length) fail("invalid-response", "data");
        return { state: "present", ...observed, bytes, size: bytes.length, work: op.work() };
      });
    });
  }
  /** One opaque native page. No collected-store or synthetic pagination contract is created. */
  list(supplied: NetlifyListOptionsType = {}): Promise<NetlifyPageType> {
    const { signal, prefix, directories, cursor } = supplied, parameters = new URLSearchParams();
    if (prefix !== undefined) parameters.set("prefix", text(prefix, 600, "prefix"));
    if (cursor !== undefined) {
      text(cursor, 8192, "cursor");
      if (!cursor) throw new TypeError("Netlify cursor must not be empty.");
      parameters.set("cursor", cursor);
    }
    if (directories !== undefined && typeof directories !== "boolean") {
      throw new TypeError("Netlify directories flag must be boolean.");
    }
    if (directories) parameters.set("directories", "true");
    return this.#run(signal, async (op) => {
      const response = await op.send(this.#url(undefined, parameters), "GET", this.#headers(), "api");
      return await op.response(response, async (): Promise<NetlifyPageType> => {
        op.headers(response, "api");
        if (response.status === 404) {
          await op.read(response, this.#policy.json, "api");
          return { state: "absent", blobs: [], directories: [], work: op.work() };
        }
        if (response.status !== 200) fail("http", "api", response.status);
        const page = object(json(await op.read(response, this.#policy.json, "api"), "api"), "api");
        const blobs = page.blobs ?? [], directories = page.directories ?? [], next = page.next_cursor;
        if (!Array.isArray(blobs) || !Array.isArray(directories)) fail("invalid-response", "api");
        if (blobs.length + directories.length > this.#policy.entries) fail("budget-exceeded", "api");
        const entries = blobs.map((item: unknown) => {
          const record = object(item, "api");
          if (
            typeof record.key !== "string" || !record.key ||
            typeof record.etag !== "string" && record.etag !== undefined
          ) fail("invalid-response", "api");
          text(record.key, 600, "listed key");
          return {
            key: record.key,
            ...(record.etag === undefined ? {} : { etag: text(record.etag, 4096, "listed ETag") }),
          };
        });
        const names = directories.map((item: unknown) => {
          if (typeof item !== "string") fail("invalid-response", "api");
          return text(item, 600, "listed directory");
        });
        if (next !== undefined && next !== null && typeof next !== "string") fail("invalid-response", "api");
        return {
          state: "page",
          blobs: entries,
          directories: names,
          ...(typeof next === "string" && next !== "" ? { cursor: text(next, 8192, "next cursor") } : {}),
          work: op.work(),
        };
      });
    });
  }
  /** Snapshot bounded bytes before negotiation; metadata writing awaits independent Unicode qualification. */
  put(value: string, input: Uint8Array, supplied: NetlifyPutOptionsType = {}): Promise<NetlifyPutType> {
    const name = key(value);
    if (!isBytes(input)) throw new TypeError("Netlify PUT requires bytes.");
    const view = toView(input);
    if (view.length > this.#policy.bytes) fail("budget-exceeded", "data");
    const bytes = new Uint8Array(view), { signal, condition } = supplied;
    const headers = new Headers({ "cache-control": "max-age=0, stale-while-revalidate=60" });
    if (condition !== undefined) {
      const captured = { ...condition };
      if (captured.kind === "new") headers.set("if-none-match", "*");
      else if (captured.kind === "match") headers.set("if-match", etag(captured.etag));
      else throw new TypeError("Netlify PUT condition is not admitted.");
    }
    const conditional = condition !== undefined;
    return this.#run(signal, async (op) => {
      const url = await this.#data(op, name, "PUT");
      const response = await op.send(url, "PUT", headers, "data", bytes, { operation: "put", key: name });
      return await op.response(response, async () => {
        // A transport that followed a forbidden redirect did not establish an
        // acknowledgement from the admitted mutation target.
        if (response.redirected) fail("invalid-response", "data", response.status);
        const refused = conditional && (response.status === 409 || response.status === 412);
        if (!refused && !(conditional ? response.status >= 200 && response.status < 300 : response.status === 200)) {
          fail("http", "data", response.status);
        }
        const receipt: NetlifyPutType = {
          operation: "put",
          key: name,
          modified: !refused,
          status: response.status,
          size: bytes.length,
          work: op.work(),
        };
        op.receipt = receipt;
        op.headers(response, "data");
        const observed = response.headers.get("etag") || undefined;
        if (!refused && observed !== undefined) op.receipt = { ...receipt, etag: observed };
        await op.read(response, this.#policy.json, "data");
        return { ...op.receipt as NetlifyPutType, work: op.work() };
      });
    });
  }
  /** Unconditional native removal. No version guard, retry or deleted-object identity is inferred. */
  delete(value: string, supplied: NetlifyOperationType = {}): Promise<NetlifyDeleteType> {
    const name = key(value), { signal } = supplied;
    return this.#run(signal, async (op) => {
      const response = await op.send(this.#url(name), "DELETE", this.#headers(), "api", undefined, {
        operation: "delete",
        key: name,
      });
      return await op.response(response, async () => {
        if (response.redirected) fail("invalid-response", "api", response.status);
        const status = response.status;
        if (status !== 200 && status !== 204 && status !== 404) fail("http", "api", status);
        const receipt: NetlifyDeleteType = { operation: "delete", key: name, status, work: op.work() };
        op.receipt = receipt;
        op.headers(response, "api");
        await op.read(response, this.#policy.json, "api");
        return { ...receipt, work: op.work() };
      });
    });
  }
}

/** Construction is import-safe and performs no connection, discovery or authorization callback. */
export function createNetlifyClient(options: NetlifyOptionsType): NetlifyClient {
  return new NetlifyClient(options);
}
