/** Opaque restic REST repository objects, without backup decryption, locking or restore semantics. @module */
import { z } from "zod";
import { isBytes, toRequestBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { assertRangeResponse, range } from "./range.ts";
import { RequestMetrics, sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";
import { collectBytes, openBytes, withAbortSignal } from "./stream.ts";

/** Local per-operation ceiling, independent of the server's repository quota or pack-size policy. */
export const RESTIC_BUFFER_BYTES = 64 * 1024 * 1024;
/** Native named object classes. Config is a separate unhashed locator. */
export const ResticKindSchema: z.ZodEnum<
  { data: "data"; keys: "keys"; locks: "locks"; snapshots: "snapshots"; index: "index" }
> = z.enum(["data", "keys", "locks", "snapshots", "index"]);
/** Named repository object class selected by the native kind schema. */
export type ResticKindType = z.infer<typeof ResticKindSchema>;
/** Runtime grammar for one opaque repository object; abbreviated IDs are outside this wire profile. */
export const ResticObjectSchema: z.ZodUnion<
  readonly [
    z.ZodObject<{ kind: z.ZodLiteral<"config"> }, z.core.$strict>,
    z.ZodObject<{ kind: typeof ResticKindSchema; id: z.ZodString }, z.core.$strict>,
  ]
> = z.union([
  z.object({ kind: z.literal("config") }).strict(),
  z.object({ kind: ResticKindSchema, id: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
]);
/** Validated config or complete hash-addressed native locator; no snapshot path is inferred. */
export type ResticObjectType = Readonly<z.infer<typeof ResticObjectSchema>>;
/** Safe native metadata is evidence from this server, not an immutable revision. */
export interface ResticStatType {
  readonly size: number;
}
/** V2 listing entries are complete native object names, not paths inside a snapshot. */
export interface ResticEntryType {
  readonly id: string;
  readonly size: number;
}
/** The caller consumes or cancels the returned stream. A partial extent carries no complete-object hash proof. */
export interface ResticDownloadType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly evidence: "server-trusted";
}
/** Exact repository scope and borrowed network/hash capabilities, acquired only when the client is constructed. */
export interface ResticClientOptionsType {
  readonly endpoint: string | URL;
  readonly credentials?: (url: URL, signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
  readonly fetch?: FetchType;
  readonly subtle?: Pick<SubtleCrypto, "digest">;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 8 MiB; applies to copied saves and materialized reads, not streaming downloads. */
  readonly maxBytes?: number;
  /** Defaults to 10000; native listing has no continuation protocol. */
  readonly maxEntries?: number;
}
/** Native response status, without credential-bearing request or response text in its message. */
export class ResticError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Restic REST request failed with HTTP ${status}.`);
    this.name = "ResticError";
    this.status = status;
  }
}
/** A lost or refused dispatched acknowledgement cannot prove absence of effects; do not blindly retry. */
export class ResticPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: string;
  readonly object: ResticObjectType | undefined;
  constructor(operation: string, object: ResticObjectType | undefined, cause: unknown) {
    super(`Restic REST ${operation} has no complete success acknowledgement.`, { cause });
    this.name = "ResticPublicationError";
    this.operation = operation;
    this.object = object === undefined ? undefined : Object.freeze({ ...object });
  }
}

/** Reject unsafe lengths before allocation and before arithmetic can lose integer precision. */
function integer(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError("Restic REST size exceeds its finite bound.");
  }
  return value;
}
/** Sanitize schema diagnostics so foreign locator input is never echoed by a library-owned error. */
function locator(value: unknown): ResticObjectType {
  const parsed = ResticObjectSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid restic REST object locator.");
  return Object.freeze(parsed.data);
}
/** Native Content-Length, required by this selected exact-byte profile. */
function length(response: Response): number {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]{0,15})$/u.test(raw)) {
    throw new TypeError("Restic REST requires a safe Content-Length.");
  }
  return integer(Number(raw));
}
/** A narrow V2 grammar rejects duplicate keys and oversized numeric lexemes before conversion, without a general JSON tree. */
function listing(text: string, maximum: number): readonly ResticEntryType[] {
  let at = 0;
  const space = /[ \t\r\n]*/y, key = /"(name|size)"/y, name = /"([0-9a-f]{64})"/y, size = /(?:0|[1-9][0-9]{0,15})/y;
  const entries: ResticEntryType[] = [], seen = new Set<string>();
  function whitespace(): void {
    space.lastIndex = at;
    space.exec(text);
    at = space.lastIndex;
  }
  function character(value: string): void {
    whitespace();
    if (text[at++] !== value) throw new TypeError("Invalid restic REST V2 listing.");
  }
  function token(expression: RegExp): RegExpExecArray {
    whitespace();
    expression.lastIndex = at;
    const result = expression.exec(text);
    if (result === null) throw new TypeError("Unsupported restic REST V2 listing field.");
    at = expression.lastIndex;
    return result;
  }
  character("[");
  whitespace();
  if (text[at] !== "]") {
    while (true) {
      if (entries.length >= maximum) throw new RangeError("Restic REST listing exceeds its entry budget.");
      character("{");
      const keys = new Set<string>();
      let id: string | undefined, bytes: number | undefined;
      for (let field = 0; field < 2; field++) {
        const selected = token(key)[1]!;
        if (keys.has(selected)) throw new TypeError("Duplicate restic REST listing field.");
        keys.add(selected);
        character(":");
        if (selected === "name") id = token(name)[1]!;
        else bytes = integer(Number(token(size)[0]));
        if (field === 0) character(",");
      }
      character("}");
      if (id === undefined || bytes === undefined || seen.has(id)) {
        throw new TypeError("Ambiguous restic REST listing entry.");
      }
      seen.add(id);
      entries.push(Object.freeze({ id, size: bytes }));
      whitespace();
      if (text[at] !== ",") break;
      at++;
    }
  }
  character("]");
  whitespace();
  if (at !== text.length) throw new TypeError("Trailing restic REST listing data.");
  return Object.freeze(entries);
}
/** One reader owns exact actual EOF and cancellation; a native read rejection is terminal and is not re-cancelled. */
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
            if (seen !== expected) throw new TypeError("Restic REST body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Restic REST body requires bytes.");
          const bytes = toView(next.value);
          if (bytes.length > expected - seen) throw new TypeError("Restic REST body exceeds its extent.");
          seen += bytes.length;
          if (!bytes.length) { if (++empty > 16) throw new TypeError("Restic REST body makes no progress."); }
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
    "Restic REST",
    "download",
  );
}

/** Native opaque object storage. The caller owns repository initialization, maintenance locks and deletion policy. */
export class ResticClient {
  readonly #endpoint: URL;
  readonly #fetch: FetchType;
  readonly #credentials: ResticClientOptionsType["credentials"];
  /** Capture one bound authority before network awaits; mutating the borrowed object's method cannot replace it later. */
  readonly #digest: SubtleCrypto["digest"] | undefined;
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  readonly #entries: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: ResticClientOptionsType) {
    const raw = String(options.endpoint);
    if (raw.length > 8192 || /[^\u0021-\u007e]/u.test(raw) || raw.includes("\\") || /%(?:2e|2f|5c)/iu.test(raw)) {
      throw new TypeError("Invalid restic REST endpoint.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new TypeError("Invalid restic REST endpoint.");
    }
    if (
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/") ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && options.allowHttp === true) ||
      raw.split("/").some((part) => part === "." || part === "..") ||
      endpoint.pathname.split("/").some((part) =>
        ["data", "keys", "locks", "snapshots", "index", "config"].includes(decodeURIComponent(part))
      )
    ) {
      throw new TypeError(
        "Restic REST endpoint must name one explicit repository without URL credentials or reserved components.",
      );
    }
    this.#endpoint = endpoint;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credentials = options.credentials;
    const subtle = options.subtle, digest = subtle?.digest;
    if (digest !== undefined && typeof digest !== "function") {
      throw new TypeError("Invalid restic REST digest capability.");
    }
    this.#digest = digest === undefined ? undefined : digest.bind(subtle);
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
    this.#max = integer(options.maxBytes ?? 8 * 1024 * 1024, RESTIC_BUFFER_BYTES);
    this.#entries = integer(options.maxEntries ?? 10000, 100000);
  }
  /** Construct only native typed routes; no remote action URL or redirect is admitted. */
  #url(object: ResticObjectType): URL {
    return new URL(object.kind === "config" ? "config" : `${object.kind}/${object.id}`, this.#endpoint);
  }
  /** API authentication is borrowed per operation and never rediscovered from the endpoint. */
  async #send(
    target: URL,
    method: string,
    signal?: AbortSignal,
    headers = new Headers(),
    body?: Uint8Array,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    return await sendRequest(async (attemptSignal) => {
      attemptSignal?.throwIfAborted();
      const authorization = await this.#credentials?.(new URL(target), attemptSignal);
      attemptSignal?.throwIfAborted();
      const admitted = new Headers(headers);
      admitted.set("accept", "application/vnd.x.restic.rest.v2");
      admitted.set("accept-encoding", "identity");
      if (authorization !== undefined) {
        if (
          typeof authorization !== "string" || authorization.length === 0 || authorization.length > 8192 ||
          /[^\u0020-\u007e]/u.test(authorization)
        ) throw new TypeError("Invalid restic REST Authorization header.");
        admitted.set("authorization", authorization);
      }
      return {
        input: target,
        init: {
          method,
          headers: admitted,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
          ...(body === undefined ? {} : { body: toRequestBytes(body) }),
        },
      };
    }, {
      fetch: (input, init) => {
        dispatch?.();
        return this.#fetch(input, init);
      },
      metrics: this.#metrics,
      replayable: false,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  /** Conservatively retain uncertain dispatched writes, including a failed body release after an accepted status. */
  async #mutate(
    target: URL,
    method: string,
    operation: string,
    object: ResticObjectType | undefined,
    signal?: AbortSignal,
    body?: Uint8Array,
  ): Promise<void> {
    let dispatched = false;
    try {
      const response = await this.#send(
        target,
        method,
        signal,
        new Headers({ "content-type": "application/octet-stream" }),
        body,
        () => {
          dispatched = true;
        },
      );
      await readResponse(response, () => {
        if (response.status !== 200) throw new ResticError(response.status);
      });
    } catch (cause) {
      if (dispatched) throw new ResticPublicationError(operation, object, cause);
      throw cause;
    }
  }
  /** Creates the server's repository directories. It does not create encrypted config, keys or a usable initialized backup repository. */
  async createRepository(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal, target = new URL(this.#endpoint);
    target.search = "?create=true";
    await this.#mutate(target, "POST", "create repository structure", undefined, signal);
  }
  /** Native stat does not verify bytes or protect a later read against a writer or deletion. */
  async stat(value: ResticObjectType, options: { readonly signal?: AbortSignal } = {}): Promise<ResticStatType | null> {
    const object = locator(value),
      signal = options.signal,
      response = await this.#send(this.#url(object), "HEAD", signal);
    return await readResponse(response, () => {
      if (response.status === 404) return null;
      if (response.status !== 200) throw new ResticError(response.status);
      const encoding = response.headers.get("content-encoding");
      if (encoding !== null && encoding.toLowerCase().trim() !== "identity") {
        throw new TypeError("Encoded restic REST metadata cannot establish size.");
      }
      return { size: length(response) };
    });
  }
  /** One complete, bounded V2 native listing, in server order; no cursor, decrypted entries or frozen inventory. */
  async list(
    value: ResticKindType,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly ResticEntryType[]> {
    const parsed = ResticKindSchema.safeParse(value), signal = options.signal;
    if (!parsed.success) throw new TypeError("Invalid restic REST object kind.");
    const response = await this.#send(new URL(`${parsed.data}/`, this.#endpoint), "GET", signal);
    return await readResponse(response, async (text) => {
      if (response.status !== 200) throw new ResticError(response.status);
      if (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/vnd.x.restic.rest.v2"
      ) throw new TypeError("Restic REST listing requires actual V2 response evidence.");
      return listing(await text(), this.#entries);
    });
  }
  /** Server-trusted whole/partial streamed bytes. A digest-shaped object name does not verify an arbitrary range. */
  async download(
    value: ResticObjectType,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ResticDownloadType> {
    const object = locator(value), selected = range(options);
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
    const headers = new Headers();
    if (selected.header !== undefined) headers.set("range", selected.header);
    const response = await this.#send(this.#url(object), "GET", selected.signal, headers);
    if (response.status !== 200 && response.status !== 206) {
      await readResponse(response, () => {
        throw new ResticError(response.status);
      });
    }
    await assertRangeResponse(response, selected);
    try {
      const size = length(response);
      if (response.body === null) {
        if (size !== 0) throw new TypeError("Restic REST download lacks its body.");
        return {
          bytes: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          size,
          evidence: "server-trusted",
        };
      }
      return { bytes: extent(response.body, size, selected.signal), size, evidence: "server-trusted" };
    } catch (reason) {
      await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
      throw reason;
    }
  }
  /** Materialized server-trusted bytes; use readVerified for complete named-object SHA256 proof. */
  async read(
    value: ResticObjectType,
    options: { readonly at?: number; readonly length?: number; readonly signal?: AbortSignal } = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    const object = locator(value), signal = options.signal, at = options.at, size = options.length;
    const response = await this.download(object, {
      ...(signal === undefined ? {} : { signal }),
      ...(at === undefined ? {} : { at }),
      ...(size === undefined ? {} : { length: size }),
    });
    if (response.size > this.#max) {
      const reason = new RangeError("Restic REST materialized read exceeds its byte budget.");
      await close([() => response.bytes.cancel(reason)], [reason]);
    }
    return new Uint8Array(await collectBytes(response.bytes, this.#max, signal, "Restic REST", "object"));
  }
  /** Explicit injected digest capability; hashing checks content identity, not publisher authenticity or restic encryption. */
  async #hash(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.#digest === undefined) {
      throw new TypeError("Restic REST hashing requires an explicitly injected SubtleCrypto digest capability.");
    }
    const result = new Uint8Array(await this.#digest("SHA-256", bytes));
    signal?.throwIfAborted();
    if (result.length !== 32) throw new TypeError("Restic REST digest capability returned an invalid SHA256 extent.");
    return Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  /** Complete bounded named-object hash check before returning owned bytes. Config has no storage-ID hash name. */
  async readVerified(
    value: ResticObjectType,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Uint8Array<ArrayBuffer>> {
    const object = locator(value), signal = options.signal;
    if (object.kind === "config") throw new TypeError("Restic config is not addressed by a storage-ID hash.");
    if (this.#digest === undefined) {
      throw new TypeError("Restic REST verification requires an injected digest capability.");
    }
    const bytes = await this.read(object, signal === undefined ? {} : { signal });
    if (await this.#hash(bytes, signal) !== object.id) {
      throw new TypeError("Restic REST object SHA256 differs from its storage ID.");
    }
    return bytes;
  }
  /** Saves copied opaque bytes under their computed SHA256 ID. A 200 acknowledges storage, not a backup commit or remote read-back. */
  async save(
    value: ResticKindType,
    bytes: Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ResticEntryType> {
    const parsed = ResticKindSchema.safeParse(value), signal = options.signal;
    signal?.throwIfAborted();
    if (!parsed.success) throw new TypeError("Invalid restic REST object kind.");
    if (!isBytes(bytes)) throw new TypeError("Restic REST save requires a Uint8Array.");
    const view = toView(bytes);
    integer(view.length, this.#max);
    const owned = new Uint8Array(view), id = await this.#hash(owned, signal);
    const object = locator({ kind: parsed.data, id });
    await this.#mutate(this.#url(object), "POST", "save object", object, signal, owned);
    return Object.freeze({ id, size: owned.length });
  }
  /** Deletes only one explicit named object. Caller owns repository maintenance/locks; removal may make a live backup unrestorable. */
  async remove(value: ResticObjectType, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const object = locator(value), signal = options.signal;
    if (object.kind === "config") throw new TypeError("Config deletion is outside this native REST profile.");
    await this.#mutate(this.#url(object), "DELETE", "remove object", object, signal);
  }
}
