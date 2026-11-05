/** Explicit fixed-length uploads using draft-ietf-httpbis-resumable-upload-15, interop10. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import type { FetchType } from "./request.ts";
import { readDictionary, readField } from "./transfer/fields.ts";

const maximum = 999999999999999;
/** A draft integer is narrower than JavaScript's safe-integer range. */
function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be a nonnegative RFC9651 integer.`);
  }
}
function finite(value: number | undefined, fallback: number, hard: number, label: string): number {
  const n = value ?? fallback;
  integer(n, label);
  if (n > hard) throw new RangeError(`${label} exceeds the implementation ceiling.`);
  return n;
}
function signal(...values: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const distinct = [...new Set(values.filter((value): value is AbortSignal => value !== undefined))];
  return distinct.length === 0 ? undefined : distinct.length === 1 ? distinct[0] : AbortSignal.any(distinct);
}
function url(value: string | URL): URL {
  const text = String(value);
  if (text.length > 8192) throw new RangeError("Upload URL exceeds 8 KiB.");
  const out = new URL(text);
  if (!["http:", "https:"].includes(out.protocol) || out.username || out.password || out.hash) {
    throw new TypeError("Upload URL must be HTTP(S) without userinfo or fragment.");
  }
  return out;
}
function serializedUrl(value: string): boolean {
  try {
    return url(value).href === value;
  } catch {
    return false;
  }
}

/** Server advice, not format maxima, local policy or a clock-derived expiry guarantee. */
export const UploadLimitsSchema: z.ZodObject<{
  maxSize: z.ZodOptional<z.ZodNumber>;
  minSize: z.ZodOptional<z.ZodNumber>;
  maxAppendBytes: z.ZodOptional<z.ZodNumber>;
  minAppendBytes: z.ZodOptional<z.ZodNumber>;
  maxAgeSeconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict> = z.strictObject({
  maxSize: z.number().int().positive().max(maximum).optional(),
  minSize: z.number().int().nonnegative().max(maximum).optional(),
  maxAppendBytes: z.number().int().positive().max(maximum).optional(),
  minAppendBytes: z.number().int().nonnegative().max(maximum).optional(),
  maxAgeSeconds: z.number().int().nonnegative().max(maximum).optional(),
}).refine(
  (v) =>
    (v.minSize ?? 0) <= (v.maxSize ?? maximum) &&
    (v.minAppendBytes ?? 0) <= Math.min(v.maxAppendBytes ?? maximum, v.maxSize ?? maximum),
  "Inconsistent upload limits.",
);
/** Validated recognized limits. Unknown dictionary members and parameters remain inert. */
export type UploadLimitsType = z.infer<typeof UploadLimitsSchema>;
/** Persist atomically after creation. Upload URLs can carry bearer authority; do not log this descriptor. */
export const UploadSessionSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  draft: z.ZodLiteral<15>;
  interop: z.ZodLiteral<10>;
  target: z.ZodString;
  url: z.ZodString;
  method: z.ZodEnum<{ POST: "POST"; PUT: "PUT" }>;
  size: z.ZodNumber;
  type: z.ZodOptional<z.ZodString>;
  limits: z.ZodOptional<typeof UploadLimitsSchema>;
}, z.core.$strict> = z.strictObject({
  version: z.literal(1),
  draft: z.literal(15),
  interop: z.literal(10),
  target: z.string().max(8192).refine(serializedUrl, "Invalid canonical target URL."),
  url: z.string().max(8192).refine(serializedUrl, "Invalid canonical upload URL."),
  method: z.enum(["POST", "PUT"]),
  size: z.number().int().nonnegative().max(maximum),
  type: z.string().max(1024).optional(),
  limits: UploadLimitsSchema.optional(),
});
/** The descriptor identifies a resource, not its source bytes, authentication or confirmed publication. */
export type UploadSessionType = z.infer<typeof UploadSessionSchema>;
/** Per-operation cancellation composes with every ancestor owner. */
export interface UploadRequestOptionsType {
  readonly signal?: AbortSignal;
}
/** Construction acquires only explicit transport capabilities; importing the module performs no I/O. */
export interface UploadClientOptionsType extends UploadRequestOptionsType {
  readonly profile: "draft-15";
  /** Exact initial target, retained to reject a substituted saved target before authentication. */ readonly target:
    | string
    | URL;
  readonly fetch?: FetchType;
  readonly headers?: HeadersInit | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  readonly credentials?: RequestCredentials;
  /** Default is the initial target's origin. The callback sees a detached URL and cannot rewrite the admitted request. */ readonly allowUploadURL?:
    (url: URL) => boolean;
  /** Per-request copied body: default 8 MiB, hard 64 MiB. */ readonly maxChunkBytes?: number;
  /** Buffered target/error receipt: default 64 KiB, hard 1 MiB. */ readonly maxResponseBytes?: number;
  /** Response read results, including empty chunks: default 4096, hard 65536. */ readonly maxResponseChunks?: number;
  /** Lifetime requests, including failed attempts: default 4096, hard 1,000,000. */ readonly maxRequests?: number;
}
/** Known representation metadata belongs to the initial target request, never to append requests. */
export interface UploadCreateOptionsType extends UploadRequestOptionsType {
  readonly method: "POST" | "PUT";
  readonly size: number;
  readonly type?: string;
}
/** Parsed HEAD state. Missing optional fields are not invented from the local descriptor. */
export interface UploadStatusType {
  readonly offset: number;
  readonly length?: number;
  readonly terminal?: boolean;
  readonly limits?: UploadLimitsType;
}
/** The target answered; this is neither a success flag nor a storage publication proof. Body bytes are caller-owned. */
export interface UploadReceiptType {
  readonly terminal: true;
  readonly status: number;
  readonly target: string;
  readonly upload?: string;
  /** Fetch-normalized header pairs, not the original wire field-line layout. */ readonly headers:
    readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}
/** An initial target may answer immediately instead of offering an upload resource. */
export type UploadCreateType = { readonly kind: "created"; readonly session: UploadSessionType } | {
  readonly kind: "terminal";
  readonly receipt: UploadReceiptType;
};
/** An incomplete 2xx acknowledges the entire chunk; an early target response is a different outcome. */
export type UploadAppendType = { readonly kind: "ack"; readonly offset: number } | {
  readonly kind: "terminal";
  readonly receipt: UploadReceiptType;
};
/** Existing local acknowledgement is an assertion from the caller's durable checkpoint, not a content digest. */
export interface UploadOpenOptionsType extends UploadRequestOptionsType {
  readonly acknowledgedOffset?: number;
}
/** Borrowed session owner; one operation at a time. Reopening does not fence another process. */
export interface UploadResourceType {
  readonly session: UploadSessionType;
  readonly limits: UploadLimitsType;
  status(options?: UploadRequestOptionsType): Promise<UploadStatusType>;
  append(offset: number, bytes: Uint8Array, options?: UploadRequestOptionsType): Promise<UploadAppendType>;
  /** Requires an acknowledged EOF in this wrapper. A reopened wrapper first needs status(). */ finish(
    options?: UploadRequestOptionsType,
  ): Promise<UploadReceiptType>;
  /** A successful DELETE is a cancellation-request acknowledgement, not proof of byte deletion or target removal. */ cancel(
    options?: UploadRequestOptionsType,
  ): Promise<{ readonly requested: true; readonly status: number }>;
}
/** Protocol/policy failure. A known terminal header remains visible even if its body cannot be retained. */
export class UploadError extends Error {
  readonly code: "protocol" | "limit" | "state" | "http";
  readonly status: number | undefined;
  readonly terminal: boolean | undefined;
  constructor(
    code: UploadError["code"],
    message: string,
    options: { readonly status?: number; readonly terminal?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, Object.hasOwn(options, "cause") ? { cause: options.cause } : {});
    this.name = "UploadError";
    this.code = code;
    this.status = options.status;
    this.terminal = options.terminal;
  }
}
/** Invalid optional item fields are ignored as RFC9651 requires; policy overrun still fails explicitly. */
function optionalInteger(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  let item;
  try {
    item = readField(value);
  } catch (reason) {
    if (reason instanceof SyntaxError) return undefined;
    throw reason;
  }
  return item.kind === "integer" && item.value >= 0 ? item.value : undefined;
}
function optionalBoolean(headers: Headers, name: string): boolean | undefined {
  const value = headers.get(name);
  if (value === null) return undefined;
  let item;
  try {
    item = readField(value);
  } catch (reason) {
    if (reason instanceof SyntaxError) return undefined;
    throw reason;
  }
  return item.kind === "boolean" ? item.value : undefined;
}
/** A malformed Upload-Limit rejects this selected message rather than guessing one surviving bound. */
function limitsOf(headers: Headers): UploadLimitsType | undefined {
  const raw = headers.get("Upload-Limit");
  if (raw === null) return undefined;
  const fields = readDictionary(raw);
  if (fields.size === 0) return undefined;
  const result: Record<string, number> = {};
  for (
    const [wire, key] of [["max-size", "maxSize"], ["min-size", "minSize"], ["max-append-size", "maxAppendBytes"], [
      "min-append-size",
      "minAppendBytes",
    ], ["max-age", "maxAgeSeconds"]] as const
  ) {
    const item = fields.get(wire);
    if (item !== undefined) {
      if (item.kind !== "integer") {
        throw new UploadError("protocol", "Upload-Limit contains a non-integer known member.");
      }
      result[key] = item.value;
    }
  }
  const parsed = UploadLimitsSchema.safeParse(result);
  if (!parsed.success) throw new UploadError("protocol", "Upload-Limit contains invalid or inconsistent bounds.");
  return Object.freeze(parsed.data);
}
/** Bound normalized headers before retaining receipt copies. Fetch's earlier internal allocation is opaque. */
function headerPairs(headers: Headers): readonly (readonly [string, string])[] {
  let bytes = 0, count = 0;
  const pairs: Array<readonly [string, string]> = [];
  headers.forEach((value, key) => {
    bytes += key.length + value.length;
    count++;
    if (bytes > 8192 || count > 128) throw new UploadError("limit", "Upload response headers exceed 8 KiB/128 fields.");
    pairs.push(Object.freeze([key, value] as const));
  });
  return Object.freeze(pairs);
}
interface ReplyType {
  readonly status: number;
  readonly headers: Headers;
  readonly pairs: readonly (readonly [string, string])[];
  readonly terminal: boolean | undefined;
  body(): Promise<Uint8Array>;
}
/** Own each response exactly once. Reader errors are already terminal and must not be cancelled a second time. */
async function reply<Value>(
  response: Response,
  owner: AbortSignal | undefined,
  maxBytes: number,
  maxChunks: number,
  accept: (reply: ReplyType) => Value | Promise<Value>,
): Promise<Value> {
  const status = response.status, responseBody = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, ended = false;
  let bodyStarted = false;
  let terminal: boolean | undefined;
  let outcome: { ok: true; value: Value } | { ok: false; reason: unknown };
  try {
    owner?.throwIfAborted();
    const pairs = headerPairs(response.headers);
    const headers = new Headers();
    for (const [key, value] of pairs) headers.append(key, value);
    terminal = optionalBoolean(headers, "Upload-Complete");
    const version = optionalInteger(headers, "Upload-Draft-Interop-Version");
    if (headers.has("Upload-Draft-Interop-Version") && version !== 10) {
      throw new UploadError("protocol", "Response contradicts requested draft interop10.", {
        status: status,
        ...(terminal === undefined ? {} : { terminal }),
      });
    }
    const body = async (): Promise<Uint8Array> => {
      if (bodyStarted) throw new TypeError("Upload response body was already consumed.");
      bodyStarted = true;
      owner?.throwIfAborted();
      const coding = headers.get("Content-Encoding");
      if (coding !== null && coding.toLowerCase() !== "identity") {
        throw new UploadError("protocol", "Encoded upload receipts are outside this bounded profile.");
      }
      const rawLength = headers.get("Content-Length");
      let expected: number | undefined;
      if (rawLength !== null) {
        if (!/^[0-9]+$/.test(rawLength)) throw new UploadError("protocol", "Invalid response Content-Length.");
        expected = Number(rawLength);
        if (!Number.isSafeInteger(expected) || expected > maxBytes) {
          throw new UploadError("limit", "Upload response exceeds configured receipt bytes.");
        }
      }
      if (responseBody === null) {
        if (expected !== undefined && expected !== 0) {
          throw new UploadError("protocol", "Upload response body is shorter than its declared length.");
        }
        ended = true;
        return new Uint8Array();
      }
      reader = responseBody.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0, reads = 0;
      while (true) {
        owner?.throwIfAborted();
        if (++reads > maxChunks) throw new UploadError("limit", "Upload response exceeds configured chunk count.");
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (reason) {
          ended = true;
          throw reason;
        }
        owner?.throwIfAborted();
        if (next.done) {
          ended = true;
          break;
        }
        if (!isBytes(next.value)) throw new TypeError("Upload response chunk must be native bytes.");
        const bytes = toView(next.value);
        if (bytes.byteLength > maxBytes - total) {
          throw new UploadError("limit", "Upload response exceeds configured receipt bytes.");
        }
        total += bytes.byteLength;
        chunks.push(new Uint8Array(bytes));
      }
      if (expected !== undefined && total !== expected) {
        throw new UploadError("protocol", "Upload response length does not match its declared length.");
      }
      const output = new Uint8Array(total);
      let at = 0;
      for (const bytes of chunks) {
        output.set(bytes, at);
        at += bytes.byteLength;
      }
      owner?.throwIfAborted();
      return output;
    };
    outcome = {
      ok: true,
      value: await accept({ status: status, headers, pairs, terminal, body }),
    };
  } catch (reason) {
    outcome = { ok: false, reason };
  }
  const releases: Array<() => void | PromiseLike<unknown>> = [];
  if (reader !== undefined) {
    const owned = reader;
    if (!ended) releases.push(() => owned.cancel());
    releases.push(() => owned.releaseLock());
  } else if (responseBody !== null && !ended) releases.push(() => responseBody!.cancel());
  try {
    await close(releases, outcome.ok ? [] : [outcome.reason]);
  } catch (reason) {
    if (terminal === true) {
      throw new UploadError("protocol", "Target response was terminal, but its body or owned cleanup failed.", {
        status: status,
        terminal: true,
        cause: reason,
      });
    }
    throw reason;
  }
  if (!outcome.ok) throw outcome.reason;
  owner?.throwIfAborted();
  return outcome.value;
}

/** Explicit chunked profile; this client neither observes 104 interim responses nor transparently upgrades ordinary requests. */
export class UploadClient {
  readonly #target: string;
  readonly #origin: string;
  readonly #fetch: FetchType;
  readonly #headers: Headers | ((url: URL) => HeadersInit | Promise<HeadersInit>);
  readonly #allow: (url: URL) => boolean;
  readonly #credentials: RequestCredentials;
  readonly #signal: AbortSignal | undefined;
  readonly #chunk: number;
  readonly #response: number;
  readonly #chunks: number;
  readonly #maximumRequests: number;
  #requests = 0;
  #limits: UploadLimitsType = Object.freeze({});
  constructor(input: UploadClientOptionsType) {
    const options = { ...input };
    if (options.profile !== "draft-15") throw new TypeError("Select the draft-15 upload profile explicitly.");
    const target = url(options.target);
    this.#target = target.href;
    this.#origin = target.origin;
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.#headers = typeof options.headers === "function" ? options.headers : new Headers(options.headers);
    this.#allow = options.allowUploadURL ?? ((value) => value.origin === this.#origin);
    this.#credentials = options.credentials ?? "omit";
    if (!["omit", "same-origin", "include"].includes(this.#credentials)) {
      throw new TypeError("Invalid upload credential policy.");
    }
    this.#signal = options.signal;
    this.#chunk = finite(options.maxChunkBytes, 8 * 1024 * 1024, 64 * 1024 * 1024, "Upload chunk bytes");
    this.#response = finite(options.maxResponseBytes, 65536, 1024 * 1024, "Upload receipt bytes");
    this.#chunks = finite(options.maxResponseChunks, 4096, 65536, "Upload response chunks");
    this.#maximumRequests = finite(options.maxRequests, 4096, 1000000, "Upload requests");
  }
  #url(value: string): URL {
    const next = url(value);
    if (this.#allow(new URL(next)) !== true) {
      throw new TypeError("Upload resource URL is outside the explicit target policy.");
    }
    return next;
  }
  async #request<Value>(
    target: URL,
    method: string,
    fields: HeadersInit,
    owner: AbortSignal | undefined,
    accept: (reply: ReplyType) => Value | Promise<Value>,
    copyBody?: () => Uint8Array<ArrayBuffer>,
  ): Promise<Value> {
    owner?.throwIfAborted();
    if (this.#requests >= this.#maximumRequests) {
      throw new UploadError("limit", "Upload client lifetime request allowance is exhausted.");
    }
    this.#requests++;
    const body = copyBody?.();
    const requestURL = target.href;
    const auth = this.#headers;
    const headers = new Headers(typeof auth === "function" ? await auth(new URL(requestURL)) : auth);
    owner?.throwIfAborted();
    for (
      const key of [
        "Upload-Offset",
        "Upload-Length",
        "Upload-Complete",
        "Upload-Incomplete",
        "Upload-Draft-Interop-Version",
        "Upload-Limit",
        "Tus-Resumable",
        "Content-Length",
        "Content-Type",
        "Content-Encoding",
        "Transfer-Encoding",
        "Range",
        "Content-Range",
        "Host",
      ]
    ) headers.delete(key);
    new Headers(fields).forEach((value, key) => headers.set(key, value));
    headers.set("Upload-Draft-Interop-Version", "10");
    headers.set("Accept-Encoding", "identity");
    headerPairs(headers);
    owner?.throwIfAborted();
    const response = await this.#fetch(requestURL, {
      method,
      headers,
      credentials: this.#credentials,
      redirect: "manual",
      ...(owner ? { signal: owner } : {}),
      ...(body === undefined ? {} : { body }),
    });
    return await reply(response, owner, this.#response, this.#chunks, accept);
  }
  /** Explicit OPTIONS discovery. Missing/empty Upload-Limit is not an affirmative support advertisement. */
  async options(input: UploadRequestOptionsType = {}): Promise<UploadLimitsType> {
    const owner = signal(this.#signal, { ...input }.signal);
    return await this.#request(new URL(this.#target), "OPTIONS", {}, owner, (answer) => {
      if (answer.status < 200 || answer.status >= 300) {
        throw new UploadError("http", "Upload OPTIONS failed.", { status: answer.status });
      }
      const limits = limitsOf(answer.headers);
      if (limits === undefined) {
        throw new UploadError("protocol", "Endpoint did not advertise resumable-upload limits.");
      }
      this.#limits = limits;
      return limits;
    });
  }
  /** Empty known-size creation sent once. A lost Location cannot be recovered by silently issuing another creation. */
  async create(input: UploadCreateOptionsType): Promise<UploadCreateType> {
    const options = { ...input };
    integer(options.size, "Upload size");
    if (options.method !== "POST" && options.method !== "PUT") {
      throw new TypeError("Upload creation method must be POST or PUT.");
    }
    if (options.type !== undefined && (options.type.length > 1024 || /[\r\n\0]/.test(options.type))) {
      throw new TypeError("Invalid upload representation media type.");
    }
    this.#size(options.size, this.#limits);
    const owner = signal(this.#signal, options.signal);
    const fields = new Headers({ "Upload-Complete": "?0", "Upload-Length": String(options.size) });
    if (options.type !== undefined) fields.set("Content-Type", options.type);
    return await this.#request(new URL(this.#target), options.method, fields, owner, async (answer) => {
      if (answer.terminal === true) return { kind: "terminal", receipt: await this.#receipt(answer) };
      if (answer.status < 200 || answer.status >= 300) {
        throw new UploadError(
          "http",
          "Upload creation was not acknowledged; do not recreate an unknown attempt automatically.",
          { status: answer.status, ...(answer.terminal === undefined ? {} : { terminal: answer.terminal }) },
        );
      }
      const location = answer.headers.get("Location");
      if (location === null) {
        throw new UploadError(
          "protocol",
          "Creation omitted its upload Location; the remote effect may already exist.",
          { status: answer.status },
        );
      }
      const resource = this.#url(new URL(location, this.#target).href);
      const offset = optionalInteger(answer.headers, "Upload-Offset");
      if (offset !== undefined && offset !== 0) {
        throw new UploadError("protocol", "Empty creation returned a nonzero offset.");
      }
      this.#length(answer.headers, options.size);
      const limits = limitsOf(answer.headers);
      if (limits) this.#size(options.size, limits);
      const session = UploadSessionSchema.parse({
        version: 1,
        draft: 15,
        interop: 10,
        target: this.#target,
        url: resource.href,
        method: options.method,
        size: options.size,
        ...(options.type === undefined ? {} : { type: options.type }),
        ...(limits === undefined ? {} : { limits }),
      });
      return {
        kind: "created",
        session: Object.freeze({
          ...session,
          ...(session.limits === undefined ? {} : { limits: Object.freeze(session.limits) }),
        }),
      };
    }, () => new Uint8Array());
  }
  #size(size: number, limits: UploadLimitsType): void {
    if (size < (limits.minSize ?? 0) || size > (limits.maxSize ?? maximum)) {
      throw new UploadError("limit", "Upload representation violates announced size limits.");
    }
  }
  #length(headers: Headers, size: number): number | undefined {
    const length = optionalInteger(headers, "Upload-Length");
    if (length !== undefined && length !== size) {
      throw new UploadError("protocol", "Server representation length conflicts with the saved session.");
    }
    return length;
  }
  async #receipt(answer: ReplyType, upload?: string): Promise<UploadReceiptType> {
    return Object.freeze({
      terminal: true,
      status: answer.status,
      target: this.#target,
      ...(upload === undefined ? {} : { upload }),
      headers: answer.pairs,
      body: await answer.body(),
    });
  }
  /** Open a captured descriptor. The caller owns unchanged source identity and exclusive ownership across processes. */
  open(input: UploadSessionType, inputOptions: UploadOpenOptionsType = {}): UploadResourceType {
    const parsed = UploadSessionSchema.parse(input), options = { ...inputOptions };
    if (parsed.target !== this.#target) throw new TypeError("Saved upload target differs from this client's target.");
    const target = this.#url(parsed.url);
    const session = Object.freeze({
      ...parsed,
      ...(parsed.limits === undefined ? {} : { limits: Object.freeze({ ...parsed.limits }) }),
    });
    let offset = options.acknowledgedOffset ?? 0;
    integer(offset, "Acknowledged upload offset");
    if (offset > session.size) throw new RangeError("Acknowledged offset exceeds session size.");
    let limits: UploadLimitsType = session.limits ?? Object.freeze({}),
      busy = false,
      synced = false,
      stopped = false,
      remoteTerminal = false;
    const ancestor = signal(this.#signal, options.signal);
    const lock = async <Value>(
      call: UploadRequestOptionsType,
      action: (owner: AbortSignal | undefined) => Promise<Value>,
    ): Promise<Value> => {
      const owner = signal(ancestor, { ...call }.signal);
      owner?.throwIfAborted();
      if (busy) throw new UploadError("state", "An upload resource operation is already active.");
      busy = true;
      try {
        return await action(owner);
      } finally {
        busy = false;
      }
    };
    const update = (answer: ReplyType): void => {
      this.#length(answer.headers, session.size);
      const next = limitsOf(answer.headers);
      if (next !== undefined) limits = next;
    };
    return Object.freeze({
      session,
      get limits() {
        return limits;
      },
      status: (call: UploadRequestOptionsType = {}) =>
        lock(call, async (owner) => {
          synced = false;
          return await this.#request(target, "HEAD", {}, owner, (answer) => {
            if (answer.status < 200 || answer.status >= 300) {
              throw new UploadError("http", "Upload offset retrieval failed; publication may remain unknown.", {
                status: answer.status,
              });
            }
            update(answer);
            const remote = optionalInteger(answer.headers, "Upload-Offset");
            if (remote === undefined || remote < offset || remote > session.size) {
              throw new UploadError(
                "protocol",
                "Upload offset is missing, outside the source or behind its acknowledged checkpoint.",
              );
            }
            offset = remote;
            remoteTerminal ||= answer.terminal === true;
            synced = true;
            const length = this.#length(answer.headers, session.size);
            const advertised = limitsOf(answer.headers);
            return Object.freeze({
              offset: remote,
              ...(length === undefined ? {} : { length }),
              ...(answer.terminal === undefined ? {} : { terminal: answer.terminal }),
              ...(advertised === undefined ? {} : { limits: advertised }),
            });
          });
        }),
      append: (at: number, input: Uint8Array, call: UploadRequestOptionsType = {}) =>
        lock(call, async (owner) => {
          integer(at, "Upload offset");
          if (stopped || remoteTerminal || !synced || at !== offset) {
            throw new UploadError("state", "Reconcile this resource before appending at its acknowledged offset.");
          }
          if (!isBytes(input)) {
            throw new TypeError("Upload chunk must be native Uint8Array bytes.");
          }
          const bytes = toView(input);
          if (bytes.byteLength > this.#chunk || bytes.byteLength > session.size - at) {
            throw new UploadError("limit", "Upload chunk exceeds local policy or the declared representation.");
          }
          this.#size(session.size, limits);
          if (
            bytes.byteLength > (limits.maxAppendBytes ?? maximum) || bytes.byteLength < (limits.minAppendBytes ?? 0)
          ) throw new UploadError("limit", "Upload chunk violates announced append bounds.");
          owner?.throwIfAborted();
          const next = at + bytes.byteLength;
          synced = false;
          return await this.#request<UploadAppendType>(
            target,
            "PATCH",
            { "Upload-Complete": "?0", "Upload-Offset": String(at), "Content-Type": "application/partial-upload" },
            owner,
            async (answer) => {
              if (answer.terminal === true) {
                stopped = true;
                return { kind: "terminal", receipt: await this.#receipt(answer, target.href) };
              }
              update(answer);
              if (answer.status < 200 || answer.status >= 300 || answer.terminal !== false) {
                throw new UploadError(
                  "http",
                  "Append was not fully acknowledged; retrieve the offset before sending more data.",
                  { status: answer.status, ...(answer.terminal === undefined ? {} : { terminal: answer.terminal }) },
                );
              }
              const ack = optionalInteger(answer.headers, "Upload-Offset");
              if (ack !== undefined && ack !== next) {
                throw new UploadError("protocol", "Append offset contradicts its complete-request acknowledgement.");
              }
              offset = next;
              synced = true;
              return { kind: "ack", offset: next };
            },
            () => new Uint8Array(bytes),
          );
        }),
      finish: (call: UploadRequestOptionsType = {}) =>
        lock(call, async (owner) => {
          if (stopped || !synced || offset !== session.size) {
            throw new UploadError(
              "state",
              "Finish requires a reconciled acknowledged EOF; terminal uploads cannot be repeated in this wrapper.",
            );
          }
          this.#size(session.size, limits);
          synced = false;
          return await this.#request(
            target,
            "PATCH",
            { "Upload-Complete": "?1", "Upload-Offset": String(offset), "Content-Type": "application/partial-upload" },
            owner,
            async (answer) => {
              if (answer.terminal !== true) {
                throw new UploadError(
                  "http",
                  "Completing request has no attributable terminal target response; publication remains unknown.",
                  { status: answer.status, ...(answer.terminal === undefined ? {} : { terminal: answer.terminal }) },
                );
              }
              stopped = true;
              return await this.#receipt(answer, target.href);
            },
            () => new Uint8Array(),
          );
        }),
      cancel: (call: UploadRequestOptionsType = {}) =>
        lock(call, async (owner) => {
          synced = false;
          return await this.#request(target, "DELETE", {}, owner, (answer) => {
            if (answer.status < 200 || answer.status >= 300) {
              throw new UploadError("http", "Upload cancellation request was not acknowledged.", {
                status: answer.status,
              });
            }
            stopped = true;
            return Object.freeze({ requested: true as const, status: answer.status });
          });
        }),
    });
  }
}
/** Constructing the client acquires native Fetch only if the caller omitted an explicit capability. */
export function createUploadClient(options: UploadClientOptionsType): UploadClient {
  return new UploadClient(options);
}
