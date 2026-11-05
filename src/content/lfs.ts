/** Bounded Git LFS pointers, Batch API and basic object transfer, without Git discovery. @module */
import { z } from "zod";
import { encodeHex } from "@std/encoding/hex";
import { isBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { readResponse } from "../response.ts";
import { RequestMetrics, sendRequest } from "../request.ts";
import type { FetchType, RequestPolicyType } from "../request.ts";
import { collectBytes, openBytes, withAbortSignal } from "../stream.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType } from "../source.ts";

/** Implementation ceiling for whole-object SHA-256 verification and copied uploads. */
export const LFS_BUFFER_BYTES = 64 * 1024 * 1024;
/** The version value is compared literally, never URL-normalized. */
export const LFS_POINTER_VERSION = "https://git-lfs.github.com/spec/v1";
/** Native object identity is a full lowercase SHA-256 hex digest plus exact safe-integer byte size. */
export interface LfsObjectType {
  readonly oid: string;
  readonly size: number;
}
/** Unknown pointer records remain inert; no extension subprocess or transformation is discovered. */
export interface LfsFieldType {
  readonly key: string;
  readonly value: string;
}
/** Empty files pass through LFS unchanged; they are distinct from a three-line zero-size pointer. */
export type LfsPointerType = { readonly kind: "empty" } | {
  readonly kind: "pointer";
  readonly oid: string;
  readonly size: number;
  readonly fields: readonly LfsFieldType[];
};
/** Action URLs and header values are secret capabilities. Expiry is advisory server-relative evidence. */
export interface LfsActionType {
  readonly href: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expires?: number;
}
/** HTTP 200 batch envelopes can still contain an error for an individual requested object. */
export type LfsResultType =
  & LfsObjectType
  & ({ readonly state: "error"; readonly code: number } | {
    readonly state: "ready";
    readonly authenticated?: boolean;
    readonly download?: LfsActionType;
    readonly upload?: LfsActionType;
    readonly verify?: LfsActionType;
  });
/** Explicit endpoint and origin grants replace ambient Git credential/remote discovery. */
export interface LfsOptionsType {
  readonly endpoint: string | URL;
  readonly fetch?: FetchType;
  readonly credentials?: (url: URL, signal?: AbortSignal) => HeadersInit | PromiseLike<HeadersInit>;
  /** Separate authority for action URLs; Batch credentials are never reused here. */
  readonly actionCredentials?: (
    url: URL,
    kind: "download" | "upload" | "verify",
    signal?: AbortSignal,
  ) => HeadersInit | PromiseLike<HeadersInit>;
  readonly downloadOrigins?: readonly string[];
  readonly uploadOrigins?: readonly string[];
  readonly verifyOrigins?: readonly string[];
  readonly allowHttp?: boolean;
  readonly request?: RequestPolicyType;
  /** Borrowed trusted Web Crypto capability, required for verified reads and uploads. */
  readonly subtle?: Pick<SubtleCrypto, "digest">;
  readonly now?: () => number;
  readonly maxBytes?: number;
  readonly maxBatch?: number;
}
/** The stream exposes bytes before full digest verification. Consume to EOF or cancel it. */
export interface LfsDownloadType extends LfsObjectType {
  readonly bytes: ReadableStream<Uint8Array>;
  readonly evidence: "server-trusted";
}
/** Native existence/transfer evidence does not publish a Git ref or prove continued retention. */
export type LfsUploadType = LfsObjectType & {
  readonly state: "already-present" | "uploaded" | "verified";
};
/** Sanitized HTTP or per-object status. Provider diagnostic bodies are not logged or echoed. */
export class LfsError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Git LFS request failed: status ${status}.`);
    this.name = "LfsError";
    this.status = status;
  }
}
/** A mutation was dispatched without a delivered acknowledgment; do not blindly retry. */
export class LfsPublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Git LFS mutation outcome is unknown; reconcile before retrying.", { cause });
    this.name = "LfsPublicationError";
  }
}
/** Upload was acknowledged, but optional verification did not deliver a success acknowledgment. */
export class LfsVerificationError extends Error {
  readonly upload: LfsUploadType;
  constructor(upload: LfsUploadType, cause: unknown) {
    super("Git LFS upload was acknowledged, but verification failed.", { cause });
    this.name = "LfsVerificationError";
    this.upload = Object.freeze({ ...upload });
  }
}
function integer(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`Invalid Git LFS ${label}.`);
  return value;
}
function object(value: LfsObjectType): LfsObjectType {
  const oid = value.oid, size = value.size;
  if (typeof oid !== "string" || !/^[a-f0-9]{64}$/.test(oid)) {
    throw new TypeError("Git LFS requires a complete SHA-256 object ID.");
  }
  return { oid, size: integer(size, Number.MAX_SAFE_INTEGER, "object size") };
}
/** Pure canonical pointer parser; historical aliases/noncanonical encodings are intentionally refused. */
export function decodeLfsPointer(bytes: Uint8Array): LfsPointerType {
  if (!isBytes(bytes)) throw new TypeError("Git LFS pointer requires bytes.");
  const view = toView(bytes);
  if (view.length >= 1024) throw new RangeError("Git LFS pointer must be smaller than 1024 bytes.");
  if (!view.length) return { kind: "empty" };
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(view);
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0")) {
    throw new TypeError("Git LFS pointer requires canonical LF lines.");
  }
  const lines = text.slice(0, -1).split("\n"), values = new Map<string, string>();
  let previous = "";
  for (let at = 0; at < lines.length; at++) {
    const match = /^([a-z0-9.-]+) (.*)$/.exec(lines[at]!);
    if (!match || values.has(match[1]!) || at === 0 && match[1] !== "version" || at > 1 && match[1]! <= previous) {
      throw new TypeError("Git LFS pointer keys are duplicated or out of order.");
    }
    values.set(match[1]!, match[2]!);
    if (at > 0) previous = match[1]!;
  }
  if (
    values.get("version") !== LFS_POINTER_VERSION || !/^sha256:[a-f0-9]{64}$/.test(values.get("oid") ?? "") ||
    !/^[1-9][0-9]*$/.test(values.get("size") ?? "")
  ) throw new TypeError("Unsupported or noncanonical Git LFS pointer.");
  const selected = object({ oid: values.get("oid")!.slice(7), size: Number(values.get("size")) });
  return {
    kind: "pointer",
    ...selected,
    fields: [...values].filter(([key]) => !["version", "oid", "size"].includes(key)).map(([key, value]) => ({
      key,
      value,
    })),
  };
}
/** Encode the canonical profile and preserve caller-supplied unknown records without executing them. */
export function encodeLfsPointer(value: LfsPointerType): Uint8Array<ArrayBuffer> {
  if (value.kind === "empty") return new Uint8Array();
  const selected = object(value);
  if (!selected.size) throw new TypeError("Canonical empty Git LFS files have empty pointer bytes.");
  if (value.fields.length > 32) throw new RangeError("Git LFS pointer field budget exceeded.");
  const fields = value.fields.map((field) => {
    const key = field.key, text = field.value;
    if (
      typeof key !== "string" || key.length > 1024 || !/^[a-z0-9.-]+$/.test(key) ||
      ["version", "oid", "size"].includes(key) || typeof text !== "string" || text.length > 1024 ||
      !text.isWellFormed() || /[\r\n\0]/.test(text)
    ) throw new TypeError("Invalid Git LFS pointer field.");
    return [key, text] as const;
  });
  fields.push(["oid", `sha256:${selected.oid}`], ["size", String(selected.size)]);
  fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const bytes = new TextEncoder().encode(
    `version ${LFS_POINTER_VERSION}\n${fields.map(([key, text]) => `${key} ${text}\n`).join("")}`,
  );
  decodeLfsPointer(bytes);
  return bytes;
}
/** No implicit extension transforms are applied when turning a pointer into a stored-object request. */
export function lfsPointerObject(value: LfsPointerType): LfsObjectType {
  if (value.kind === "empty") throw new TypeError("An empty pass-through file has no remote pointer request.");
  if (value.fields.length) throw new TypeError("Pointer extensions require explicit interpretation before retrieval.");
  return object(value);
}
function url(value: string | URL): URL {
  try {
    return new URL(value);
  } catch {
    throw new TypeError("Invalid Git LFS URL.");
  }
}
function admitted(value: string | URL, http: boolean): URL {
  if (typeof value === "string" && value.length > 65536) throw new RangeError("Git LFS URL exceeds its budget.");
  const target = url(value);
  if (
    (target.protocol !== "https:" && !(http && target.protocol === "http:")) || target.username || target.password ||
    target.hash
  ) throw new TypeError("Invalid Git LFS URL authority.");
  return target;
}
/** Do not allow server-selected control/transport headers to alter Fetch's URL, framing or ambient credentials. */
function headers(value: HeadersInit): Headers {
  // Headers normally joins case-insensitive duplicates, which would change a
  // signed action's authority. Refuse them while their original keys are visible.
  const names = new Set<string>();
  const pairs = Array.isArray(value) ? value : value instanceof Headers ? value : Object.entries(value);
  for (const [key] of pairs) {
    if (typeof key !== "string" || key.length > 256) throw new TypeError("Invalid Git LFS header name.");
    if (names.has(key.toLowerCase())) throw new TypeError("Git LFS headers repeat an authority field.");
    names.add(key.toLowerCase());
    if (names.size > 64) throw new RangeError("Git LFS header count exceeds its budget.");
  }
  let result: Headers;
  try {
    result = new Headers(value);
  } catch {
    throw new TypeError("Invalid Git LFS header syntax.");
  }
  let count = 0, bytes = 0;
  for (const [key, text] of result) {
    if (
      ++count > 64 || text.length > 8192 || (bytes += key.length + text.length) > 65536 ||
      [
        "host",
        "cookie",
        "cookie2",
        "set-cookie",
        "connection",
        "transfer-encoding",
        "content-length",
        "proxy-authorization",
        "proxy-authenticate",
        "upgrade",
        "te",
        "trailer",
        "range",
        "content-range",
        "accept-encoding",
        "referer",
      ].includes(key)
    ) throw new TypeError("Git LFS action header is forbidden or over budget.");
  }
  return result;
}
/** Native Accept values can include quality weights without changing action authority. */
function acceptsJson(value: string): boolean {
  return value.split(",").some((part) => {
    const match = /^\s*application\/vnd\.git-lfs\+json(?:\s*;\s*q=(0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?\s*$/i.exec(part);
    return match !== null && (match[1] === undefined || Number(match[1]) > 0);
  });
}
const RawActionSchema = z.object({
  href: z.string().max(65536),
  header: z.record(z.string().max(256), z.string().max(8192)).optional(),
  expires_in: z.number().int().min(-2147483647).max(2147483647).optional(),
  expires_at: z.string().max(64).optional(),
});
const BatchSchema = z.object({
  transfer: z.literal("basic").optional(),
  hash_algo: z.literal("sha256").optional(),
  objects: z.array(z.object({
    oid: z.string(),
    size: z.number(),
    authenticated: z.boolean().optional(),
    error: z.object({ code: z.number().int().min(100).max(599) }).optional(),
    actions: z.object({
      download: RawActionSchema.optional(),
      upload: RawActionSchema.optional(),
      verify: RawActionSchema.optional(),
    }).optional(),
  })),
});
/** Bounded duplicate-aware JSON preflight protects action URL/header authority from last-key-wins parsing. */
function json(text: string): unknown {
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget Git LFS JSON.");
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
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  }
  function value(depth: number): void {
    if (++tokens > 100000 || depth > 32) fail();
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
          const key = string();
          if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail();
          keys.add(key);
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
      if (at - start > 128) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (
      !["true", "false", "null"].includes(raw) &&
      (!/^-?(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
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
/** Actual EOF and exact size are required, but streaming bytes are exposed before any whole-object digest. */
function extent(body: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = openBytes(body);
  let left = size, terminal = false, empty = 0;
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
            if (left) throw new TypeError("Git LFS body is truncated.");
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Git LFS body requires bytes.");
          const bytes = toView(next.value);
          if (bytes.length > left) throw new TypeError("Git LFS body exceeds object size.");
          if (!bytes.length) { if (++empty > 16) throw new TypeError("Git LFS body makes no progress."); }
          else empty = 0;
          left -= bytes.length;
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
    "Git LFS content",
    "download",
  );
}
/** Native Basic transfer client. No Git repository, ref, lock or filesystem state is inferred. */
export class LfsClient {
  readonly #base: URL;
  readonly #http: boolean;
  readonly #fetch: FetchType;
  readonly #credentials: LfsOptionsType["credentials"];
  readonly #actionCredentials: LfsOptionsType["actionCredentials"];
  readonly #grants: Readonly<Record<"download" | "upload" | "verify", ReadonlySet<string>>>;
  readonly #request: RequestPolicyType | undefined;
  readonly #digest: ((algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer>) | undefined;
  readonly #now: () => number;
  readonly #bytes: number;
  readonly #batch: number;
  readonly #metrics = new RequestMetrics();
  constructor(options: LfsOptionsType) {
    this.#http = options.allowHttp === true;
    this.#base = admitted(options.endpoint, this.#http);
    if (this.#base.search || !this.#base.pathname.endsWith("/")) {
      throw new TypeError("Git LFS endpoint must end with '/' and have no query.");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credentials = options.credentials;
    this.#actionCredentials = options.actionCredentials;
    const origins = (values: readonly string[]): ReadonlySet<string> =>
      new Set(values.map((value) => {
        const target = admitted(value, this.#http);
        if (target.pathname !== "/" || target.search) {
          throw new TypeError("Git LFS action grants require exact origins.");
        }
        return target.origin;
      }));
    this.#grants = {
      download: origins(options.downloadOrigins ?? []),
      upload: origins(options.uploadOrigins ?? []),
      verify: origins(options.verifyOrigins ?? []),
    };
    this.#request = options.request === undefined ? undefined : { ...options.request };
    this.#digest = options.subtle?.digest.bind(options.subtle);
    this.#now = options.now ?? (() => Date.now());
    this.#bytes = integer(options.maxBytes ?? 8 * 1024 * 1024, LFS_BUFFER_BYTES, "byte budget");
    this.#batch = integer(options.maxBatch ?? 100, 1000, "batch budget");
  }
  #time(): number {
    const time = this.#now();
    if (!Number.isSafeInteger(time)) throw new TypeError("Git LFS clock must return safe-integer epoch milliseconds.");
    return time;
  }
  /** A request owns captured headers/body; no automatic credential challenge or retry occurs. */
  async #send<Value>(
    target: URL,
    method: string,
    selected: Headers,
    body: Uint8Array<ArrayBuffer> | string | undefined,
    signal: AbortSignal | undefined,
    mutation: boolean,
    consume: (response: Response, text: () => PromiseLike<string>) => Value | PromiseLike<Value>,
    transfer = false,
  ): Promise<Value> {
    let dispatched = false;
    signal?.throwIfAborted();
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
      if (transfer && response.status === 200) {
        try {
          return await consume(response, () => {
            throw new TypeError("Transferred Git LFS media cannot be parsed as control text.");
          });
        } catch (reason) {
          await close(response.body === null || response.body.locked ? [] : [() => response.body!.cancel(reason)], [
            reason,
          ]);
          throw reason;
        }
      }
      return await readResponse(response, async (text) => {
        if (response.status !== 200) throw new LfsError(response.status);
        return await consume(response, text);
      });
    } catch (reason) {
      if (mutation && dispatched) throw new LfsPublicationError(reason);
      throw reason;
    }
  }
  /** Action expiry is advisory; it cannot prove server acceptance or remaining availability. */
  #action(
    value: z.infer<typeof RawActionSchema>,
    kind: "download" | "upload" | "verify",
    received: number,
  ): LfsActionType {
    const target = admitted(value.href, this.#http);
    if (!this.#grants[kind].has(target.origin)) throw new TypeError("Git LFS action origin is not granted.");
    const selected = headers(value.header ?? {});
    let expires: number | undefined;
    if (value.expires_in !== undefined) expires = received + value.expires_in * 1000;
    else if (value.expires_at !== undefined) {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/.exec(value.expires_at);
      if (match === null) {
        throw new TypeError("Invalid Git LFS action expiry.");
      }
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const days = [
        31,
        year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
      ];
      if (
        month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(match[4]) > 23 ||
        Number(match[5]) > 59 || Number(match[6]) > 59 || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59
      ) throw new TypeError("Invalid Git LFS expiry calendar fields.");
      expires = Date.parse(value.expires_at);
    }
    if (expires !== undefined && !Number.isSafeInteger(expires)) throw new TypeError("Invalid Git LFS expiry epoch.");
    return { href: target.href, headers: Object.fromEntries(selected), ...(expires === undefined ? {} : { expires }) };
  }
  /** Bounded per-object results; missing/foreign/duplicate responses never become implicit success. */
  async batch(
    operation: "download" | "upload",
    objects: readonly LfsObjectType[],
    options: { readonly ref?: string; readonly signal?: AbortSignal } = {},
  ): Promise<readonly LfsResultType[]> {
    const signal = options.signal, ref = options.ref;
    if (
      !["download", "upload"].includes(operation) || !Array.isArray(objects) || !objects.length ||
      objects.length > this.#batch
    ) throw new RangeError("Invalid Git LFS batch admission.");
    const captured = objects.map(object), expected = new Map(captured.map((item) => [item.oid, item.size]));
    if (expected.size !== captured.length) throw new TypeError("Duplicate requested Git LFS objects.");
    if (
      ref !== undefined &&
      (typeof ref !== "string" || ref.length > 4096 || !ref.startsWith("refs/") || /[\r\n\0]/.test(ref))
    ) throw new TypeError("Invalid Git LFS ref context.");
    const target = new URL("objects/batch", this.#base),
      body = JSON.stringify({
        operation,
        transfers: ["basic"],
        hash_algo: "sha256",
        objects: captured,
        ...(ref === undefined ? {} : { ref: { name: ref } }),
      });
    signal?.throwIfAborted();
    const selected = headers(await this.#credentials?.(new URL(target), signal) ?? {});
    signal?.throwIfAborted();
    selected.set("Accept", "application/vnd.git-lfs+json");
    selected.set("Content-Type", "application/vnd.git-lfs+json");
    return await this.#send<readonly LfsResultType[]>(
      target,
      "POST",
      selected,
      body,
      signal,
      false,
      async (_response, text) => {
        const received = this.#time(), data = BatchSchema.parse(json(await text()));
        if (data.objects.length !== expected.size) throw new TypeError("Git LFS batch response count differs.");
        const seen = new Set<string>();
        return data.objects.map((raw): LfsResultType => {
          const item = object(raw);
          if (expected.get(item.oid) !== item.size || seen.has(item.oid)) {
            throw new TypeError("Git LFS batch object identity differs.");
          }
          seen.add(item.oid);
          if (raw.error !== undefined) {
            if (raw.actions !== undefined) throw new TypeError("Git LFS object combines actions and an error.");
            return { ...item, state: "error", code: raw.error.code };
          }
          if (
            operation === "download" && !raw.actions?.download ||
            operation === "upload" && raw.actions !== undefined && !raw.actions.upload
          ) throw new TypeError("Git LFS object omitted its required transfer action.");
          if (
            operation === "download" && (raw.actions?.upload || raw.actions?.verify) ||
            operation === "upload" && raw.actions?.download
          ) throw new TypeError("Git LFS object supplied actions for another operation.");
          return {
            ...item,
            state: "ready",
            ...(raw.authenticated === undefined ? {} : { authenticated: raw.authenticated }),
            ...(raw.actions?.download === undefined
              ? {}
              : { download: this.#action(raw.actions.download, "download", received) }),
            ...(raw.actions?.upload === undefined
              ? {}
              : { upload: this.#action(raw.actions.upload, "upload", received) }),
            ...(raw.actions?.verify === undefined
              ? {}
              : { verify: this.#action(raw.actions.verify, "verify", received) }),
          };
        });
      },
    );
  }
  /** Recheck an action grant/expiry before and after the separately authorized credential callback. */
  async #prepare(
    action: LfsActionType,
    kind: "download" | "upload" | "verify",
    signal?: AbortSignal,
  ): Promise<{ target: URL; headers: Headers }> {
    const target = admitted(action.href, this.#http), selected = headers(action.headers), expires = action.expires;
    if (!this.#grants[kind].has(target.origin)) throw new TypeError("Git LFS action origin is not granted.");
    if (expires !== undefined && (!Number.isSafeInteger(expires) || expires <= this.#time())) {
      throw new TypeError("Git LFS action has expired.");
    }
    signal?.throwIfAborted();
    const additional = headers(await this.#actionCredentials?.(new URL(target), kind, signal) ?? {});
    signal?.throwIfAborted();
    for (const [key, value] of additional) {
      if (selected.has(key) && selected.get(key) !== value) {
        throw new TypeError("Git LFS action credentials conflict with signed headers.");
      }
      selected.set(key, value);
    }
    if (expires !== undefined && expires <= this.#time()) {
      throw new TypeError("Git LFS action expired during credential acquisition.");
    }
    return { target, headers: selected };
  }
  /** Native whole-object basic stream. Hash verification is a separate bounded operation. */
  async download(
    value: LfsObjectType,
    options: { readonly ref?: string; readonly signal?: AbortSignal } = {},
  ): Promise<LfsDownloadType> {
    const selected = object(value), signal = options.signal, ref = options.ref;
    const [result] = await this.batch("download", [selected], {
      ...(ref === undefined ? {} : { ref }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result!.state === "error") throw new LfsError(result!.code);
    const action = await this.#prepare(result!.download!, "download", signal);
    action.headers.set("Accept-Encoding", "identity");
    return await this.#send<LfsDownloadType>(
      action.target,
      "GET",
      action.headers,
      undefined,
      signal,
      false,
      (response) => {
        const encoding = response.headers.get("content-encoding"), length = response.headers.get("content-length");
        if (
          encoding !== null && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity" ||
          length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== selected.size) ||
          response.body === null
        ) throw new TypeError("Git LFS download extent differs.");
        return { ...selected, bytes: extent(response.body!, selected.size, signal), evidence: "server-trusted" };
      },
      true,
    );
  }
  async #hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    if (this.#digest === undefined) {
      throw new TypeError("Git LFS verified operations require an injected SHA-256 capability.");
    }
    return encodeHex(new Uint8Array(await this.#digest("SHA-256", bytes)));
  }
  /** Verify exact complete bytes against the caller's expected SHA-256. This proves content, not publisher identity. */
  async readVerified(value: LfsObjectType, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return await this.#readVerified(value, signal);
  }
  /** Inherited immutable-source construction cannot accidentally bypass the actual digest proof via an override. */
  async #readVerified(value: LfsObjectType, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const selected = object(value);
    integer(selected.size, this.#bytes, "verified byte budget");
    if (this.#digest === undefined) throw new TypeError("Git LFS verification requires injected Web Crypto.");
    const response = await this.download(selected, { ...(signal === undefined ? {} : { signal }) });
    const bytes = new Uint8Array(
      await collectBytes(response.bytes, selected.size, signal, "Git LFS verification", "object"),
    );
    if (bytes.length !== selected.size || await this.#hash(bytes) !== selected.oid) {
      throw new TypeError("Git LFS object digest differs.");
    }
    signal?.throwIfAborted();
    return bytes;
  }
  /** Private fully verified bytes provide immutable exact reads; later caller mutations cannot change this source. */
  async openVerified(value: LfsObjectType, signal?: AbortSignal): Promise<ByteSourceType> {
    const selected = object(value), bytes = await this.#readVerified(selected, signal), size = bytes.length;
    return Object.freeze({
      size,
      identity: JSON.stringify(["git-lfs", "sha256", selected.oid, size]),
      stability: "immutable" as const,
      async read(
        offset: number,
        length: number,
        options: { readonly signal?: AbortSignal } = {},
      ): Promise<Uint8Array<ArrayBuffer>> {
        options.signal?.throwIfAborted();
        sourceRange(size, offset, length);
        return bytes.slice(offset, offset + length);
      },
    });
  }
  /** Hash copied bytes before acquiring upload authority. Optional verification failure retains the upload acknowledgment. */
  async upload(
    value: LfsObjectType,
    bytes: Uint8Array,
    options: { readonly ref?: string; readonly signal?: AbortSignal } = {},
  ): Promise<LfsUploadType> {
    const selected = object(value), signal = options.signal, ref = options.ref;
    signal?.throwIfAborted();
    if (!isBytes(bytes)) throw new TypeError("Git LFS upload requires bytes.");
    const view = toView(bytes);
    integer(view.length, this.#bytes, "upload byte budget");
    if (view.length !== selected.size) throw new TypeError("Git LFS upload size differs.");
    const copied = new Uint8Array(view);
    if (await this.#hash(copied) !== selected.oid) throw new TypeError("Git LFS upload digest differs.");
    signal?.throwIfAborted();
    const [result] = await this.batch("upload", [selected], {
      ...(ref === undefined ? {} : { ref }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result!.state === "error") throw new LfsError(result!.code);
    if (result!.upload === undefined) return { ...selected, state: "already-present" };
    const action = await this.#prepare(result!.upload, "upload", signal);
    if (!action.headers.has("Content-Type")) action.headers.set("Content-Type", "application/octet-stream");
    await this.#send(action.target, "PUT", action.headers, copied, signal, true, () => {});
    const receipt: LfsUploadType = { ...selected, state: "uploaded" };
    if (result!.verify === undefined) return receipt;
    try {
      const verify = await this.#prepare(result!.verify, "verify", signal);
      if (
        verify.headers.has("Accept") && !acceptsJson(verify.headers.get("Accept")!) ||
        verify.headers.has("Content-Type") &&
          !/^application\/vnd\.git-lfs\+json(?:;\s*charset=utf-8)?$/i.test(verify.headers.get("Content-Type")!)
      ) throw new TypeError("Git LFS verify headers conflict with its JSON protocol.");
      if (!verify.headers.has("Accept")) verify.headers.set("Accept", "application/vnd.git-lfs+json");
      if (!verify.headers.has("Content-Type")) verify.headers.set("Content-Type", "application/vnd.git-lfs+json");
      await this.#send(verify.target, "POST", verify.headers, JSON.stringify(selected), signal, true, () => {});
      return { ...selected, state: "verified" };
    } catch (reason) {
      throw new LfsVerificationError(receipt, reason);
    }
  }
}
