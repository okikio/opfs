/** Bounded public-store compatibility with Vercel Blob SDK 2.8.2 API13 wire behavior. @module */
import { close } from "./close.ts";
import { isBytes, toView } from "./bytes.ts";
import type { FetchType } from "./request.ts";
export type { FetchType } from "./request.ts";

/** Fixed compatibility admission; it does not describe a stable public REST standard. */
export const VERCEL_PROFILE = "vercel-blob-2.8.2-public-api13-v1";
/** Explicit borrowed authority and per-operation work allowances; construction performs no I/O. */
export interface VercelOptionsType {
  readonly profile: typeof VERCEL_PROFILE;
  /** Must honor AbortSignal, settle after abort and avoid hidden retries. */
  readonly fetch: FetchType;
  /** Exact account API endpoint, including /api/blob, without query or fragment. */
  readonly api: string;
  /** Explicit store identity; the token does not supply it implicitly. */
  readonly store: string;
  /** Visible-ASCII account bearer; sent only to this account API endpoint and its /delete child. */
  readonly token: string;
  /** Literal synchronous true permits this exact canonical public GET URL. Never grants bearer transmission. */
  readonly authorizeContentURL: (url: string) => boolean;
  /** Explicit local-fixture allowance; content approval is still required. Default false. */
  readonly allowHttp?: boolean;
  /** Default 1 MiB of PUT bytes or a complete GET snapshot. */
  readonly maxBytes?: number;
  /** Default 64 KiB of one control response. */
  readonly maxJsonBytes?: number;
  /** Default 32 KiB of response header names and values. */
  readonly maxHeaderBytes?: number;
  /** Default 64 KiB per response chunk, independently of total bytes. */
  readonly maxChunkBytes?: number;
  /** Default 1,000 blobs in one expanded list page. */
  readonly maxEntries?: number;
  /** Default 2 MiB of cumulative observed response bytes per operation. */
  readonly maxResponseBytes?: number;
  /** Default one actual Fetch invocation per operation. No retry occurs. */
  readonly maxRequests?: number;
  /** Default 65,536 read attempts, including empty chunks and EOF. */
  readonly maxReadSteps?: number;
  /** Default 30 seconds. Retirement is joined, so a noncooperative transport can exceed this deadline. */
  readonly timeoutMs?: number;
}
/** Each invocation borrows cancellation and owns its acquired response until retirement settles. */
export interface VercelOperationType { readonly signal?: AbortSignal }
/** Cache validation does not establish a revision guard or permit partial responses. */
export interface VercelGetOptionsType extends VercelOperationType { readonly etag?: string }
/** Native overwrite intent; absence means create-only in this profile. */
export type VercelConditionType = { readonly kind: "new" } | { readonly kind: "match"; readonly etag: string };
/** Metadata upload, random suffixes and implicit overwrite are outside this profile. */
export interface VercelPutOptionsType extends VercelOperationType {
  readonly contentType: string;
  readonly condition?: VercelConditionType;
}
/** One native expanded page; cursor remains opaque and no further page is fetched automatically. */
export interface VercelListOptionsType extends VercelOperationType {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}
/** Actual observed transport work, not provider-internal work or heap accounting. */
export interface VercelWorkType { readonly requests: number; readonly responseBytes: number; readonly readSteps: number }
/** Detached provider observations. PUT does not report size; head/list can report it separately. */
export interface VercelBlobType {
  readonly pathname: string;
  readonly url: string;
  readonly downloadUrl: string;
  readonly etag?: string;
  readonly size?: number;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly uploadedAt?: string;
}
/** A final admitted API status survives a subsequent malformed body, cancellation or retirement failure. */
export interface VercelReceiptType {
  readonly operation: "put" | "delete";
  readonly pathname: string;
  readonly status: 200;
  readonly work: VercelWorkType;
}
/** PUT returns native identity observations after the response has retired. */
export interface VercelPutType extends VercelReceiptType { readonly operation: "put"; readonly blob: VercelBlobType }
/** Deletion acknowledgement does not prove lasting absence or name a deleted revision. */
export interface VercelDeleteType extends VercelReceiptType { readonly operation: "delete" }
export type VercelHeadType = { readonly state: "absent"; readonly work: VercelWorkType } |
  { readonly state: "present"; readonly blob: VercelBlobType; readonly work: VercelWorkType };
export type VercelGetType = { readonly state: "absent" | "not-modified"; readonly work: VercelWorkType } |
  { readonly state: "present"; readonly bytes: Uint8Array; readonly etag?: string; readonly contentType?: string; readonly work: VercelWorkType };
export interface VercelListType {
  readonly blobs: readonly VercelBlobType[];
  readonly hasMore: boolean;
  readonly cursor?: string;
  readonly work: VercelWorkType;
}
/** Redacted admission failure; response bodies, bearer values and capability queries are never included. */
export class VercelError extends Error {
  readonly code: "http" | "invalid-response" | "budget-exceeded" | "capability-refused";
  readonly phase: "api" | "data";
  readonly status: number | undefined;
  constructor(code: VercelError["code"], phase: "api" | "data", status?: number) {
    super(`Vercel ${phase} request failed (${code}).`);
    this.name = "VercelError"; this.code = code; this.phase = phase; this.status = status;
  }
}
/** Dispatch without an admitted completion is uncertain even for a returned HTTP error. Reconcile before retrying. */
export class VercelPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "put" | "delete";
  readonly pathname: string;
  constructor(operation: "put" | "delete", pathname: string, cause: unknown) {
    super("Vercel mutation outcome is unknown; reconcile the pathname before retrying.", { cause });
    this.name = "VercelPublicationError"; this.operation = operation; this.pathname = pathname;
  }
}
/** A later failure does not revoke the already observed successful mutation status. */
export class VercelCompletionError extends Error {
  readonly receipt: VercelReceiptType;
  constructor(receipt: VercelReceiptType, cause: unknown) {
    super("Vercel acknowledged the mutation before response completion or retirement failed.", { cause });
    this.name = "VercelCompletionError"; this.receipt = receipt;
  }
}
interface PolicyType {
  bytes: number; json: number; headers: number; chunk: number; entries: number;
  response: number; requests: number; reads: number; timeout: number;
}
function fail(code: VercelError["code"], phase: "api" | "data", status?: number): never { throw new VercelError(code, phase, status); }
/** Frozen ASCII identity avoids implicit normalization and ambiguous URL-path interpretation. */
function pathname(value: string): string {
  if (typeof value !== "string" || value.length > 950 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value)) {
    throw new TypeError("Vercel pathname is outside the qualified ASCII segment profile.");
  }
  return value;
}
function text(value: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError("Vercel text must be bounded well-formed text without controls.");
  }
  return value;
}
function etag(value: string): string {
  text(value, 4096); if (!value) throw new TypeError("Vercel ETag must not be empty."); return value;
}
/** Canonical spelling is required before approval; never silently change an approved URL's meaning. */
function address(value: string, allowHttp: boolean): string {
  text(value, 16384); const url = new URL(value);
  if (url.href !== value || /\s/.test(value) || url.username || url.password || url.hash ||
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))) throw new TypeError("Vercel URL is not admitted.");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid-response", "api");
  return value as Record<string, unknown>;
}
/** Strict UTF-8 and bounded structural work supplement the serialized JSON byte ceiling. */
function json(bytes: Uint8Array): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(bytes)); }
  catch { fail("invalid-response", "api"); }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 16) fail("budget-exceeded", "api");
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid-response", "api");
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else if (item !== null && typeof item === "object") for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value,0); return value;
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
  mutation: { operation: "put" | "delete"; pathname: string } | undefined;
  /** An admitted final status survives later response admission, abort or retirement failures. */
  receipt: VercelReceiptType | undefined;
  constructor(fetch: FetchType, policy: PolicyType, signal?: AbortSignal) {
    this.#fetch = fetch;
    this.#policy = policy;
    this.#parent = signal;
    this.#abort = () => this.controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", this.#abort, { once: true });
    this.#timer = setTimeout(
      () => this.controller.abort(new DOMException("Vercel operation deadline exceeded.", "TimeoutError")),
      policy.timeout,
    );
  }
  work(): VercelWorkType {
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
    mutation?: { operation: "put" | "delete"; pathname: string },
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
