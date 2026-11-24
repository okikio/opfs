/** Native lakeFS repository/ref operations; staged uploads and commits have separate receipts. @module */
import { toInteger } from "../../check.ts";
import { exactLength } from "../../body.ts";
import { type JsonLimitsType, parseJson } from "../../json.ts";
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";
import { assertRangeResponse, resolveRange } from "../../range.ts";
import { RequestMetrics, sendRequest } from "../../request.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import { readResponse } from "../../response.ts";
import { collectBytes } from "../../stream/mod.ts";

/** Finite copied-upload/materialization ceiling, independent of repository quotas. */
export const LAKEFS_BUFFER_BYTES = 64 * 1024 * 1024;
/** Server metadata, not proof of an object's digest or underlying storage immutability. */
export interface LakefsStatType {
  readonly path: string;
  readonly kind: "object" | "common_prefix";
  readonly size?: number;
  readonly checksum?: string;
  /** Unix epoch milliseconds, converted from native integer seconds. */
  readonly modified?: number;
  readonly mediaType?: string;
}
/** Native ref name and its reported committed head; a branch may also contain staged changes. */
export interface LakefsRefType {
  readonly id: string;
  readonly commit: string;
}
/** Native committed repository state. Commit IDs are opaque, not payload hashes verified by this client. */
export interface LakefsCommitType {
  readonly id: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly committer: string;
  /** Unix epoch milliseconds, converted from native integer seconds. */
  readonly created: number;
}
/** One bounded native page; the caller owns traversal and mutable-branch consistency. */
export interface LakefsPageType {
  readonly objects: readonly LakefsStatType[];
  readonly cursor?: string;
}
/** The caller consumes or cancels exact response bytes; no complete checksum proof is implied. */
export interface LakefsDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly evidence: "server-trusted";
}
/** Shared cancellation; no resource ownership is transferred by a signal. */
export interface LakefsOperationType {
  readonly signal?: AbortSignal;
}
/** Native reads accept one byte interval, with normal EOF clamping. */
export interface LakefsReadType extends LakefsOperationType {
  readonly at?: number;
  readonly length?: number;
}
/** Native conditions are provider values; they do not turn staging into a repository commit. */
export interface LakefsPutType extends LakefsOperationType {
  /** The pinned native server does not implement ETag replacement conditions. */
  readonly ifMatch?: never;
  readonly ifNoneMatch?: "*";
  readonly mediaType?: string;
}
/** Caller-supplied authority scoped to one repository and API base. */
export interface LakefsClientOptionsType {
  /** Service base URL, optionally below a reverse-proxy prefix; /api/v1/ is appended. */
  readonly endpoint: string | URL;
  readonly repository: string;
  /** Complete Authorization value; no token/account discovery is performed. */
  readonly credentials?: (url: URL, signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 8 MiB and cannot exceed LAKEFS_BUFFER_BYTES. */
  readonly maxBytes?: number;
}
/** Library-owned errors omit response text, physical addresses and credential-bearing URLs. */
export class LakefsError extends Error {
  readonly status: number;
  /**
   * Creates the error.
   * @param status HTTP status the service returned.
   */
  constructor(status: number) {
    super(`lakeFS request failed with HTTP ${status}.`);
    this.name = "LakefsError";
    this.status = status;
  }
}
/** A dispatched mutation has no validated success receipt. Do not blindly retry it. */
export class LakefsPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: string;
  readonly repository: string;
  readonly ref: string;
  readonly path: string | undefined;
  /**
   * Creates the error.
   * @param operation Operation that failed.
   * @param path Path the operation used.
   * @param cause Failure that caused this error.
   */
  constructor(operation: string, repository: string, ref: string, path: string | undefined, cause: unknown) {
    super("lakeFS mutation has no complete success acknowledgement.", { cause });
    this.name = "LakefsPublicationError";
    this.operation = operation;
    this.repository = repository;
    this.ref = ref;
    this.path = path;
  }
}

const StatSchema = z.object({
  path: z.string().max(4096),
  path_type: z.enum(["object", "common_prefix"]),
  size_bytes: z.number().int().nonnegative().safe().optional(),
  checksum: z.string().max(4096).optional(),
  mtime: z.number().int().nonnegative().safe().optional(),
  content_type: z.string().max(4096).optional(),
});
const RefSchema = z.object({ id: z.string().min(1).max(4096), commit_id: z.string().min(1).max(4096) });
const CommitSchema = z.object({
  id: z.string().min(1).max(4096),
  parents: z.array(z.string().min(1).max(4096)).max(64),
  message: z.string().max(65536),
  committer: z.string().max(4096),
  creation_date: z.number().int().nonnegative().safe(),
});

/** Reject malformed UTF-16 before URLSearchParams or TextEncoder silently replaces it. */
function text(value: string, maximum = 4096, empty = false): string {
  if (
    typeof value !== "string" || value.length > maximum || (!empty && !value.length) ||
    // deno-lint-ignore no-control-regex -- native text cannot inject protocol controls.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Invalid lakeFS native text field.");
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw new TypeError("Invalid lakeFS text encoding.");
  }
  return value;
}
/** Encoded route segments cannot become URL dot-navigation aliases. */
function segment(value: string): string {
  value = text(value);
  if (value === "." || value === "..") throw new TypeError("Invalid lakeFS route segment.");
  return encodeURIComponent(value);
}
/** Never expose Zod's foreign input diagnostics through a provider-owned error. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError("Invalid lakeFS acknowledgement.");
  return result.data;
}
function stat(value: unknown, expected?: string): LakefsStatType {
  const data = parse(StatSchema, value);
  if (expected !== undefined && (data.path !== expected || data.path_type !== "object")) {
    throw new TypeError("lakeFS acknowledgement names a different object.");
  }
  if (data.path_type === "object" && (data.size_bytes === undefined || data.checksum === undefined)) {
    throw new TypeError("lakeFS object metadata omits size or checksum.");
  }
  return Object.freeze({
    path: data.path,
    kind: data.path_type,
    ...(data.size_bytes === undefined ? {} : { size: data.size_bytes }),
    ...(data.checksum === undefined ? {} : { checksum: data.checksum }),
    ...(data.mtime === undefined ? {} : { modified: toInteger(data.mtime * 1000, "lakeFS size") }),
    ...(data.content_type === undefined ? {} : { mediaType: data.content_type }),
  });
}
function commit(value: unknown): LakefsCommitType {
  const data = parse(CommitSchema, value);
  return Object.freeze({
    id: data.id,
    parents: Object.freeze(data.parents),
    message: data.message,
    committer: data.committer,
    created: toInteger(data.creation_date * 1000, "lakeFS size"),
  });
}
/** Limits for this service's JSON responses; see `parseJson`. */
const jsonLimits: JsonLimitsType = {
  label: "lakeFS",
  maxLength: 8 * 1024 * 1024,
  maxTokens: 100_000,
  maxString: 524_288,
  maxScalar: 17,
};

/** No background work, implicit commits or canonical filesystem projection. */
export class LakefsClient {
  readonly #base: URL;
  readonly #repository: string;
  readonly #fetch: FetchType;
  readonly #credentials: LakefsClientOptionsType["credentials"];
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  readonly #metrics = new RequestMetrics();
  /**
   * Creates the client from `options`.
   * @param options Options that configure the client.
   */
  constructor(options: LakefsClientOptionsType) {
    const base = new URL(options.endpoint);
    if (
      (base.protocol !== "https:" && !(base.protocol === "http:" && options.allowHttp === true)) ||
      base.username || base.password || base.search || base.hash
    ) throw new TypeError("Invalid lakeFS service base URL.");
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    this.#base = new URL("api/v1/", base);
    this.#repository = text(options.repository, 63);
    segment(this.#repository);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#credentials = options.credentials;
    const policy = options.policy;
    this.#policy = policy === undefined ? undefined : { ...policy };
    this.#max = toInteger(options.maxBytes ?? 8 * 1024 * 1024, "lakeFS size", LAKEFS_BUFFER_BYTES);
  }
  /** Returns counts of requests, retries, failures and responses so far. */
  getMetrics(): import("../../request.ts").RequestMetricsType {
    return this.#metrics.snapshot();
  }
  /** Only constructed API routes can acquire the borrowed authorization header. */
  #url(route: string, query: Readonly<Record<string, string>> = {}): URL {
    const url = new URL(`repositories/${segment(this.#repository)}/${route}`, this.#base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }
  async #send(
    url: URL,
    method: string,
    signal?: AbortSignal,
    headers = new Headers(),
    body?: Uint8Array<ArrayBuffer>,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      const auth = await this.#credentials?.(new URL(url), attemptSignal);
      attemptSignal?.throwIfAborted();
      const admitted = new Headers(headers);
      admitted.set("accept-encoding", "identity");
      if (auth !== undefined) {
        if (typeof auth !== "string" || !auth.length || auth.length > 8192 || /[^\x20-\x7e]/u.test(auth)) {
          throw new TypeError("Invalid lakeFS Authorization header.");
        }
        admitted.set("authorization", auth);
      }
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
      metrics: this.#metrics,
      replayable: method === "GET",
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  async #json(response: Response, status = 200, plain = false): Promise<unknown> {
    return await readResponse(response, async (body) => {
      if (response.status !== status) throw new LakefsError(response.status);
      // Branch creation acknowledges a plain reference string, unlike JSON metadata endpoints.
      if (plain) return await body();
      const raw = await body();
      try {
        return parseJson(raw, jsonLimits);
      } catch {
        throw new TypeError("Invalid lakeFS JSON response.");
      }
    });
  }
  /** Known native refusals stay HTTP errors; transport/receipt/cleanup uncertainty retains operation context. */
  async #mutate<T>(
    url: URL,
    operation: string,
    ref: string,
    path: string | undefined,
    body: Uint8Array<ArrayBuffer>,
    headers: Headers,
    signal: AbortSignal | undefined,
    decode: (value: unknown) => T,
    plain = false,
  ): Promise<T> {
    let dispatched = false;
    try {
      return decode(
        await this.#json(
          await this.#send(url, "POST", signal, headers, body, () => {
            dispatched = true;
          }),
          201,
          plain,
        ),
      );
    } catch (reason) {
      if (
        dispatched && !(reason instanceof LakefsError && [400, 401, 403, 404, 409, 412, 429].includes(reason.status))
      ) {
        throw new LakefsPublicationError(operation, this.#repository, ref, path, reason);
      }
      throw reason;
    }
  }
  /**
   * Reads a branch and the commit it points to.
   * @param branch Branch name.
   * @param options Cancellation for the request.
   */
  async getBranch(branch: string, options: LakefsOperationType = {}): Promise<LakefsRefType> {
    const { signal } = options;
    const data = parse(
      RefSchema,
      await this.#json(await this.#send(this.#url(`branches/${segment(branch)}`), "GET", signal)),
    );
    if (data.id !== branch) throw new TypeError("lakeFS returned a different branch.");
    return Object.freeze({ id: data.id, commit: data.commit_id });
  }
  /**
   * Reads one commit.
   * @param id Commit ID.
   * @param options Cancellation for the request.
   */
  async getCommit(id: string, options: LakefsOperationType = {}): Promise<LakefsCommitType> {
    const { signal } = options;
    const result = commit(await this.#json(await this.#send(this.#url(`commits/${segment(id)}`), "GET", signal)));
    if (result.id !== id) throw new TypeError("lakeFS returned a different commit.");
    return result;
  }
  /**
   * Reads the metadata of one object at a ref.
   * @param ref Branch, tag or commit.
   * @param path Object path in the repository.
   * @param options Cancellation for the request.
   */
  async stat(ref: string, path: string, options: LakefsOperationType = {}): Promise<LakefsStatType> {
    const { signal } = options;
    const url = this.#url(`refs/${segment(ref)}/objects/stat`, { path: text(path), presign: "false" });
    return stat(await this.#json(await this.#send(url, "GET", signal)), path);
  }
  /** Lists one page of objects at a ref. */
  async listPage(
    ref: string,
    options: LakefsOperationType & { readonly prefix?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<LakefsPageType> {
    const { signal, prefix = "", cursor, limit = 1000 } = options;
    if (!toInteger(limit, "lakeFS size", 1000)) throw new RangeError("lakeFS page limit must be positive.");
    const url = this.#url(`refs/${segment(ref)}/objects/ls`, {
      prefix: text(prefix, 4096, true),
      amount: String(limit),
      delimiter: "",
      presign: "false",
      ...(cursor === undefined ? {} : { after: text(cursor) }),
    });
    const data = parse(
      z.object({
        results: z.array(StatSchema).max(limit),
        pagination: z.object({ has_more: z.boolean(), next_offset: z.string().max(4096) }),
      }),
      await this.#json(await this.#send(url, "GET", signal)),
    );
    if (data.pagination.has_more && (!data.pagination.next_offset || data.pagination.next_offset === cursor)) {
      throw new TypeError("lakeFS pagination makes no progress.");
    }
    const objects = data.results.map((value) => stat(value));
    const seen = new Set<string>();
    for (const object of objects) {
      if (!object.path.startsWith(prefix) || seen.has(object.path)) {
        throw new TypeError("Ambiguous lakeFS listing path.");
      }
      seen.add(object.path);
    }
    return Object.freeze({
      objects: Object.freeze(objects),
      ...(data.pagination.has_more ? { cursor: data.pagination.next_offset } : {}),
    });
  }
  /**
   * Downloads one object at a ref as a stream with its metadata.
   * @param ref Branch, tag or commit.
   * @param path Object path in the repository.
   * @param options Range, limits and cancellation.
   */
  async download(ref: string, path: string, options: LakefsReadType = {}): Promise<LakefsDownloadType> {
    const { signal, at, length } = options;
    const selected = resolveRange({ ...(at === undefined ? {} : { at }), ...(length === undefined ? {} : { length }) });
    const url = this.#url(`refs/${segment(ref)}/objects`, { path: text(path), presign: "false" });
    signal?.throwIfAborted();
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
    const response = await this.#send(
      url,
      "GET",
      signal,
      new Headers(selected.header === undefined ? {} : { range: selected.header }),
    );
    if (response.status !== 200 && response.status !== 206) {
      await readResponse(response, () => {
        throw new LakefsError(response.status);
      });
    }
    await assertRangeResponse(response, selected);
    let size: number;
    try {
      const raw = response.headers.get("content-length");
      if (raw === null || !/^(0|[1-9][0-9]{0,15})$/u.test(raw)) {
        throw new TypeError("lakeFS requires a finite Content-Length.");
      }
      size = toInteger(Number(raw), "lakeFS size");
      if (response.body === null && size !== 0) throw new TypeError("lakeFS response omitted bytes.");
    } catch (reason) {
      await close([() => response.body?.cancel(reason)], [reason]);
      throw reason;
    }
    const body = response.body ?? new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return Object.freeze({
      bytes: exactLength(body, size, { label: "lakeFS body", resource: "lakeFS", signal: signal }),
      size,
      evidence: "server-trusted",
    });
  }
  /**
   * Reads one object at a ref into memory.
   * @param ref Branch, tag or commit.
   * @param path Object path in the repository.
   * @param options Range, limits and cancellation.
   */
  async read(ref: string, path: string, options: LakefsReadType = {}): Promise<Uint8Array> {
    const { signal, at, length } = options;
    const result = await this.download(ref, path, {
      ...(signal === undefined ? {} : { signal }),
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
    });
    if (result.size > this.#max) {
      const reason = new RangeError("lakeFS read exceeds the materialization policy.");
      await close([() => result.bytes.cancel(reason)], [reason]);
      throw reason;
    }
    return await collectBytes(result.bytes, this.#max, signal, "read", "lakeFS");
  }
  /**
   * Writes one object on a branch. The write is uncommitted until the branch is committed.
   * @param branch Branch to write on.
   * @param path Object path in the repository.
   * @param bytes The object's bytes.
   * @param options Preconditions and cancellation.
   */
  async put(branch: string, path: string, bytes: Uint8Array, options: LakefsPutType = {}): Promise<LakefsStatType> {
    const { signal, ifMatch, ifNoneMatch, mediaType = "application/octet-stream" } = options;
    const url = this.#url(`branches/${segment(branch)}/objects`, { path: text(path) });
    if (ifMatch !== undefined) {
      throw new TypeError("lakeFS If-Match replacement is outside this native profile.");
    }
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
      throw new TypeError("lakeFS create-only condition must be '*'.");
    }
    const headers = new Headers({ "content-type": text(mediaType) });
    if (ifNoneMatch !== undefined) headers.set("if-none-match", ifNoneMatch);
    if (!isBytes(bytes)) throw new TypeError("lakeFS uploads require native bytes.");
    const admitted = toView(bytes);
    toInteger(admitted.byteLength, "lakeFS size", this.#max);
    signal?.throwIfAborted();
    const body = toRequestBytes(admitted.slice());
    return await this.#mutate(url, "stage", branch, path, body, headers, signal, (value) => {
      const receipt = stat(value, path);
      if (receipt.size !== body.length) throw new TypeError("lakeFS upload receipt has a different size.");
      return receipt;
    });
  }
  /**
   * Creates a branch from another ref and returns the new branch's commit ID.
   * @param name Name of the new branch.
   * @param source Branch, tag or commit to start from.
   * @param options Cancellation for the request.
   */
  async createBranch(name: string, source: string, options: LakefsOperationType = {}): Promise<string> {
    const { signal } = options;
    segment(name);
    segment(source);
    const body = new TextEncoder().encode(JSON.stringify({ name, source }));
    return await this.#mutate(
      this.#url("branches"),
      "create-branch",
      name,
      undefined,
      body,
      new Headers({ "content-type": "application/json" }),
      signal,
      (value) => text(typeof value === "string" ? value : ""),
      true,
    );
  }
  /** Commits every staged change on this branch; the caller must coordinate all writers. */
  async commit(branch: string, message: string, options: LakefsOperationType = {}): Promise<LakefsCommitType> {
    const { signal } = options;
    const url = this.#url(`branches/${segment(branch)}/commits`);
    const body = new TextEncoder().encode(JSON.stringify({ message: text(message, 65536) }));
    return await this.#mutate(
      url,
      "commit",
      branch,
      undefined,
      body,
      new Headers({ "content-type": "application/json" }),
      signal,
      commit,
    );
  }
}
