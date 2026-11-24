/** Bounded first-party compatibility with Netlify Blobs SDK 11.1.7 API routing. @module */
import { Operation } from "./operation.ts";
import { address, etag, fail, json, key, object, text } from "./parse.ts";
import { NetlifyCompletionError, NetlifyPublicationError } from "./error.ts";
import type {
  NetlifyDeleteType,
  NetlifyGetOptionsType,
  NetlifyGetType,
  NetlifyHeadType,
  NetlifyListOptionsType,
  NetlifyObservationType,
  NetlifyOperationType,
  NetlifyOptionsType,
  NetlifyPageType,
  NetlifyPutOptionsType,
  NetlifyPutType,
  PolicyType,
} from "./types.ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isBytes, toView } from "../../bytes.ts";
import type { FetchType } from "../../request.ts";
export type { FetchType } from "../../request.ts";

/** Observed SDK wire compatibility, not a stable provider REST specification. */
export const NETLIFY_PROFILE = "netlify-blobs-11.1.7-api-v1";

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

export type {
  NetlifyConditionType,
  NetlifyDataType,
  NetlifyDeleteType,
  NetlifyGetOptionsType,
  NetlifyGetType,
  NetlifyHeadType,
  NetlifyListOptionsType,
  NetlifyObservationType,
  NetlifyOperationType,
  NetlifyOptionsType,
  NetlifyPageType,
  NetlifyPutOptionsType,
  NetlifyPutType,
  NetlifyReceiptType,
  NetlifyWorkType,
} from "./types.ts";

export { NetlifyCompletionError, NetlifyError, NetlifyPublicationError } from "./error.ts";
