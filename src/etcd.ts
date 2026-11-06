/** Bounded native etcd v3 JSON gateway operations. Byte keys and MVCC revisions are not filesystem paths. @module */
import { z } from "zod";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isBytes, toView } from "./bytes.ts";
import { sendRequest } from "./request.ts";
import type { FetchType, RequestPolicyType } from "./request.ts";
import { readResponse } from "./response.ts";

/** Implementation policies, independent of server request/quota limits. Values are materialized because the JSON gateway uses base64. */
export const ETCD_VALUE_BYTES = 1024 * 1024;
/** Ordinary byte keys are bounded before copying/base64 encoding. Native servers may impose lower limits. */
export const ETCD_KEY_BYTES = 4096;
/** Canonical bounded unsigned decimal admission does not convert revision authority through Number. */
function decimal(value: string, maximum: string, zero = true): boolean {
  return value.length <= maximum.length && /^(0|[1-9][0-9]*)$/u.test(value) &&
    (zero || value !== "0") && (value.length < maximum.length || value <= maximum);
}
function unsigned(positive = false): z.ZodString {
  return z.string().refine((value) => decimal(value, "18446744073709551615", !positive));
}
function revision(positive = false): z.ZodString {
  return z.string().refine((value) => decimal(value, "9223372036854775807", !positive));
}
const LeaseSchema = z.string().refine((value) =>
  value.startsWith("-")
    ? value !== "-0" && decimal(value.slice(1), "9223372036854775808", false)
    : decimal(value, "9223372036854775807")
);
/** Native header fields stay decimal strings, including cluster/member uint64 IDs larger than Number.MAX_SAFE_INTEGER. */
export const EtcdHeaderSchema: z.ZodObject<{
  cluster_id: z.ZodString;
  member_id: z.ZodString;
  revision: z.ZodString;
  raft_term: z.ZodString;
}> = z.object({
  cluster_id: unsigned(true),
  member_id: unsigned(true),
  revision: revision(true),
  raft_term: unsigned(true),
});
/** Native header evidence is server-trusted and does not identify immutable retained content. */
export type EtcdHeaderType = Readonly<z.infer<typeof EtcdHeaderSchema>>;
/** One page's restart position; revision history can be compacted, so this is not durable availability evidence. */
export const EtcdCursorSchema: z.ZodObject<{
  prefix: z.ZodString;
  start: z.ZodString;
  revision: z.ZodString;
  cluster_id: z.ZodString;
}, z.core.$strict> = z.object({
  prefix: z.string().max(5464),
  start: z.string().max(5464),
  revision: revision(true),
  cluster_id: unsigned(true),
}).strict().refine((data) => {
  try {
    const prefix = decode(data.prefix, ETCD_KEY_BYTES), start = decode(data.start, ETCD_KEY_BYTES + 1);
    return starts(start, prefix) && compare(start, prefix) > 0;
  } catch {
    return false;
  }
});
/** Cursor prefix/start are standard base64 byte keys, revalidated against the caller's prefix before every request. */
export type EtcdCursorType = Readonly<z.infer<typeof EtcdCursorSchema>>;
/** Byte arrays are caller-owned copies; changing them does not change the retained cursor or native revision strings. */
export interface EtcdEntryType {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
  readonly createRevision: string;
  readonly modRevision: string;
  readonly version: string;
  readonly lease: string;
}
/** A range at one selected revision. No implicit unbounded iteration, watch or lease lifetime is acquired. */
export interface EtcdPageType {
  readonly header: EtcdHeaderType;
  readonly revision: string;
  readonly entries: readonly EtcdEntryType[];
  readonly count: string;
  readonly next?: EtcdCursorType;
}
/** A single exact-key lookup distinguishes absence from an existing empty value. */
export interface EtcdGetType {
  readonly header: EtcdHeaderType;
  readonly entry: EtcdEntryType | null;
}
/** Condition failure is an acknowledged transaction outcome, not a transport failure or an automatic retry trigger. */
export interface EtcdReceiptType {
  readonly applied: boolean;
  readonly header: EtcdHeaderType;
}
/** Cancellation does not transfer ownership of injected transport or credentials. */
export interface EtcdOperationType {
  readonly signal?: AbortSignal;
}
/** Explicit historical selection can fail after native compaction. */
export interface EtcdReadType extends EtcdOperationType {
  readonly revision?: string;
}
/** Continuation pins the first page's revision; concurrent current writes do not silently change later pages. */
export interface EtcdListType extends EtcdOperationType {
  readonly limit?: number;
  readonly cursor?: EtcdCursorType;
}
/** Creation has no lease; replacement must explicitly preserve its current native lease or detach it. No lease is acquired/renewed. */
export type EtcdPutType =
  & EtcdOperationType
  & (
    | { readonly create: true; readonly modRevision?: never; readonly lease?: never }
    | { readonly modRevision: string; readonly lease: "preserve" | "none"; readonly create?: never }
  );
/** Delete exactly one key if its native modification revision still matches. */
export interface EtcdRemoveType extends EtcdOperationType {
  readonly modRevision: string;
}
/** One exact caller-owned gateway base; no cluster membership, username/password login or token discovery. */
export interface EtcdClientOptionsType {
  readonly endpoint: string | URL;
  readonly credentials?: (url: URL, signal?: AbortSignal) => string | undefined | Promise<string | undefined>;
  readonly fetch?: FetchType;
  readonly policy?: RequestPolicyType;
  readonly allowHttp?: boolean;
  /** Defaults to 1 MiB, capped by ETCD_VALUE_BYTES. Gateway JSON/control bodies are independently capped at8MiB. */
  readonly maxBytes?: number;
}
/** Native HTTP refusal without echoing foreign error bodies, keys, values or tokens. */
export class EtcdError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`etcd gateway request failed with HTTP ${status}.`);
    this.name = "EtcdError";
    this.status = status;
  }
}
/** Dispatched mutation has no complete native transaction receipt. Reconcile key/revision; do not blindly repeat. */
export class EtcdPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "put" | "remove";
  readonly key: string;
  constructor(operation: "put" | "remove", key: string, cause: unknown) {
    super("etcd mutation has no complete acknowledgement.", { cause });
    this.name = "EtcdPublicationError";
    this.operation = operation;
    this.key = key;
  }
}
function integer(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError("etcd value exceeds its finite policy.");
  }
  return value;
}
/** Sanitized boundary errors do not expose Zod diagnostics containing caller/provider data. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError("Invalid etcd gateway data.");
  return result.data;
}
function key(value: Uint8Array, maximum = ETCD_KEY_BYTES): Uint8Array<ArrayBuffer> {
  if (!isBytes(value)) throw new TypeError("etcd keys require bytes.");
  const view = toView(value);
  integer(view.length, maximum);
  if (!view.length) throw new RangeError("etcd key must be nonempty.");
  return new Uint8Array(view);
}
/** Canonical standard base64 and encoded length are checked before allocating decoded bytes. */
function decode(value: string, maximum: number, empty = false): Uint8Array<ArrayBuffer> {
  if (
    value.length > 4 * Math.ceil(maximum / 3) || (!empty && !value.length) || value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) throw new TypeError("Invalid etcd base64 field.");
  let result: Uint8Array<ArrayBuffer>;
  try {
    result = new Uint8Array(decodeBase64(value));
  } catch {
    throw new TypeError("Invalid etcd base64 field.");
  }
  if (result.length > maximum || encodeBase64(result) !== value || (!empty && !result.length)) {
    throw new TypeError("Invalid etcd base64 field.");
  }
  return result;
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
function starts(a: Uint8Array, prefix: Uint8Array): boolean {
  return a.length >= prefix.length && prefix.every((v, i) => v === a[i]);
}
/** Native prefix range upper bound; all-FF prefixes use the protocol's exclusive-unbounded end sentinel. */
function end(prefix: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(prefix);
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] !== 255) {
      bytes[i] = bytes[i]! + 1;
      return bytes.slice(0, i + 1);
    }
  }
  return new Uint8Array([0]);
}
const EntrySchema = z.object({
  key: z.string(),
  value: z.string().default(""),
  create_revision: revision(true),
  mod_revision: revision(true),
  version: revision(true),
  lease: LeaseSchema.default("0"),
});
const RangeSchema = z.object({
  header: EtcdHeaderSchema,
  kvs: z.array(EntrySchema).max(1000).default([]),
  count: revision().default("0"),
  more: z.boolean().default(false),
});
// Native nested KV receipts carry revision-only headers; only the outer header is populated with cluster/member/term.
const NestedHeaderSchema = z.object({
  revision: revision(true),
  cluster_id: unsigned().optional(),
  member_id: unsigned().optional(),
  raft_term: unsigned().optional(),
});
const TxnSchema = z.object({
  header: EtcdHeaderSchema,
  succeeded: z.boolean().default(false),
  responses: z.array(z.record(z.string(), z.unknown())).max(1).default([]),
});

/** Bounded control JSON rejects duplicate/prototype keys and noncanonical numeric lexemes before Number conversion.
 * The finite profile admits only safe integers, depth32, 100000 tokens and 2 MiB lexical strings within 8 MiB text.
 * JSON.parse is restricted to bounded string tokens, so fractional rounding cannot create accepted byte authority.
 */
function json(text: string): unknown {
  if (text.length > 8 * 1024 * 1024) throw new RangeError("etcd JSON exceeds its lexical budget.");
  let at = 0, tokens = 0;
  const fail = (): never => {
    throw new TypeError("Malformed or over-budget etcd JSON.");
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
      if (at - start > 2097152) fail();
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
/** A finite byte-KV client; import/construction does not contact a member or acquire an authentication session. */
export class EtcdClient {
  readonly #endpoint: URL;
  readonly #fetch: FetchType;
  readonly #credentials: EtcdClientOptionsType["credentials"];
  readonly #policy: RequestPolicyType | undefined;
  readonly #max: number;
  constructor(options: EtcdClientOptionsType) {
    const raw = String(options.endpoint);
    if (
      raw.length > 8192 || /[^\u0021-\u007e]/u.test(raw) || /\\|%(?:2e|2f|5c)/iu.test(raw) ||
      raw.split("/").some((p) => p === "." || p === "..")
    ) throw new TypeError("Invalid etcd endpoint.");
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      throw new TypeError("Invalid etcd endpoint.");
    }
    if (
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith("/") ||
      !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && options.allowHttp === true)
    ) throw new TypeError("etcd requires an explicit trailing-slash API base without URL credentials.");
    this.#endpoint = endpoint;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#credentials = options.credentials;
    this.#policy = options.policy === undefined ? undefined : { ...options.policy };
    this.#max = integer(options.maxBytes ?? ETCD_VALUE_BYTES, ETCD_VALUE_BYTES);
  }
  /** Serialize private captured data before credentials; remote metadata/redirects never select a credential target. */
  async #send(
    operation: "range" | "txn",
    data: unknown,
    signal?: AbortSignal,
    dispatch?: () => void,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const body = JSON.stringify(data);
    if (body.length > 2 * 1024 * 1024) throw new RangeError("etcd request exceeds its JSON policy.");
    const url = new URL(`v3/kv/${operation}`, this.#endpoint);
    return await sendRequest(async (attemptSignal) => {
      attemptSignal?.throwIfAborted();
      const token = await this.#credentials?.(new URL(url), attemptSignal);
      attemptSignal?.throwIfAborted();
      const headers = new Headers({
        "content-type": "application/json",
        "accept": "application/json",
        "accept-encoding": "identity",
      });
      if (token !== undefined) {
        if (typeof token !== "string" || !token.length || token.length > 8192 || /[^\u0021-\u007e]/u.test(token)) {
          throw new TypeError("Invalid etcd authorization token.");
        }
        headers.set("authorization", token);
      }
      return {
        input: url,
        init: {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          ...(attemptSignal === undefined ? {} : { signal: attemptSignal }),
        },
      };
    }, {
      fetch: async (input, init) => {
        dispatch?.();
        return await this.#fetch(input, init);
      },
      replayable: false,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#policy === undefined ? {} : { policy: this.#policy }),
    });
  }
  async #range(request: unknown, signal?: AbortSignal): Promise<z.infer<typeof RangeSchema>> {
    const response = await this.#send("range", request, signal);
    return await readResponse(response, async (body) => {
      if (response.status !== 200) throw new EtcdError(response.status);
      const data = parse(RangeSchema, json(await body()));
      signal?.throwIfAborted();
      return data;
    });
  }
  /** Decode only bounded values and verify native revision order before exposing caller-owned copies. */
  #entry(data: z.infer<typeof EntrySchema>, selected: string): EtcdEntryType {
    if (
      decimalCompare(data.create_revision, data.mod_revision) > 0 || decimalCompare(data.mod_revision, selected) > 0
    ) throw new TypeError("etcd entry revisions exceed the selected point.");
    return Object.freeze({
      key: decode(data.key, ETCD_KEY_BYTES),
      value: decode(data.value, this.#max, true),
      createRevision: data.create_revision,
      modRevision: data.mod_revision,
      version: data.version,
      lease: data.lease,
    });
  }
  /** Exact key only. Empty values remain present; selected historical revisions can be unavailable after compaction. */
  async get(input: Uint8Array, options: EtcdReadType = {}): Promise<EtcdGetType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const owned = key(input), raw = options.revision;
    const selected = raw === undefined ? undefined : parse(revision(true), raw);
    const data = await this.#range({
      key: encodeBase64(owned),
      serializable: false,
      ...(selected === undefined ? {} : { revision: selected }),
    }, signal);
    if (data.more || data.kvs.length > 1 || data.count !== String(data.kvs.length)) {
      throw new TypeError("etcd exact-key range returned inconsistent cardinality.");
    }
    if (selected !== undefined && decimalCompare(data.header.revision, selected) < 0) {
      throw new TypeError("etcd selected revision exceeds response evidence.");
    }
    const entry = data.kvs.length === 0 ? null : this.#entry(data.kvs[0]!, selected ?? data.header.revision);
    if (entry !== null && !same(entry.key, owned)) throw new TypeError("etcd response identifies a different key.");
    return Object.freeze({ header: Object.freeze(data.header), entry });
  }
  /** One sorted prefix page. Cursor pins cluster/revision and advances after the last exact key, without background traversal. */
  async list(input: Uint8Array, options: EtcdListType = {}): Promise<EtcdPageType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const prefix = key(input), limit = integer(options.limit ?? 100, 1000);
    if (limit === 0) throw new RangeError("etcd list limit must be positive.");
    const supplied = options.cursor, cursor = supplied === undefined ? undefined : parse(EtcdCursorSchema, supplied);
    let first = prefix;
    if (cursor !== undefined) {
      if (!same(decode(cursor.prefix, ETCD_KEY_BYTES), prefix)) {
        throw new TypeError("etcd cursor belongs to a different prefix.");
      }
      first = decode(cursor.start, ETCD_KEY_BYTES + 1);
      if (!starts(first, prefix) || compare(first, prefix) <= 0) {
        throw new TypeError("etcd cursor does not advance inside its prefix.");
      }
    }
    const data = await this.#range({
      key: encodeBase64(first),
      range_end: encodeBase64(end(prefix)),
      limit: String(limit),
      sort_order: "ASCEND",
      sort_target: "KEY",
      serializable: false,
      ...(cursor === undefined ? {} : { revision: cursor.revision }),
    }, signal);
    const selected = cursor?.revision ?? data.header.revision;
    if (
      cursor !== undefined && cursor.cluster_id !== data.header.cluster_id ||
      decimalCompare(data.header.revision, selected) < 0
    ) throw new TypeError("etcd cursor response has a different cluster/revision.");
    if (
      data.kvs.length > limit || decimalCompare(data.count, String(data.kvs.length)) < 0 ||
      !data.more && data.count !== String(data.kvs.length) ||
      data.more && (data.kvs.length === 0 || data.count === String(data.kvs.length))
    ) throw new TypeError("etcd prefix range returned inconsistent cardinality.");
    const entries: EtcdEntryType[] = [];
    let previous: Uint8Array | undefined, decoded = 0;
    for (const raw of data.kvs) {
      const entry = this.#entry(raw, selected);
      if (
        !starts(entry.key, prefix) || compare(entry.key, first) < 0 ||
        previous !== undefined && compare(entry.key, previous) <= 0
      ) throw new TypeError("etcd prefix response is outside its ordered range.");
      decoded += entry.key.length + entry.value.length;
      if (decoded > 8 * 1024 * 1024) throw new RangeError("etcd page exceeds its decoded policy.");
      entries.push(entry);
      previous = entry.key;
    }
    let next: EtcdCursorType | undefined;
    if (data.more) {
      const last = entries[entries.length - 1]!.key, start = new Uint8Array(last.length + 1);
      start.set(last);
      next = Object.freeze(
        parse(EtcdCursorSchema, {
          prefix: encodeBase64(prefix),
          start: encodeBase64(start),
          revision: selected,
          cluster_id: data.header.cluster_id,
        }),
      );
    }
    return Object.freeze({
      header: Object.freeze(data.header),
      revision: selected,
      entries: Object.freeze(entries),
      count: data.count,
      ...(next === undefined ? {} : { next }),
    });
  }
  /** A single-key native transaction has no caller-provided arbitrary request program or failure mutation branch. */
  async #mutate(
    operation: "put" | "remove",
    key: string,
    condition: Record<string, string>,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<EtcdReceiptType> {
    let dispatched = false, acknowledged = false, refused = false;
    try {
      const response = await this.#send(
        "txn",
        { compare: [{ key, result: "EQUAL", ...condition }], success: [request], failure: [] },
        signal,
        () => {
          dispatched = true;
        },
      );
      return await readResponse(response, async (body) => {
        if (response.status !== 200) {
          refused = response.status >= 400 && response.status < 500 && response.status !== 408;
          throw new EtcdError(response.status);
        }
        const data = parse(TxnSchema, json(await body()));
        if (data.succeeded) {
          if (data.responses.length !== 1) throw new TypeError("etcd applied transaction has no complete receipt.");
          const item = data.responses[0]!, expected = operation === "put" ? "response_put" : "response_delete_range";
          if (Object.keys(item).length !== 1 || !Object.hasOwn(item, expected)) {
            throw new TypeError("etcd transaction acknowledges another operation.");
          }
          const receipt = parse(
            z.object({ header: NestedHeaderSchema.optional(), deleted: revision().optional() }),
            item[expected],
          );
          if (operation === "remove" && receipt.deleted !== "1") {
            throw new TypeError("etcd transaction did not acknowledge one exact deletion.");
          }
          if (receipt.header !== undefined) {
            if (receipt.header.revision !== data.header.revision) {
              throw new TypeError("etcd nested receipt revision differs.");
            }
            for (const field of ["cluster_id", "member_id", "raft_term"] as const) {
              const nested = receipt.header[field];
              if (nested !== undefined && nested !== "0" && nested !== data.header[field]) {
                throw new TypeError("etcd nested receipt authority differs.");
              }
            }
          }
          if (
            condition.mod_revision !== undefined && decimalCompare(data.header.revision, condition.mod_revision) <= 0
          ) throw new TypeError("etcd applied receipt did not advance the modification revision.");
        } else if (data.responses.length !== 0) {
          throw new TypeError("etcd rejected condition has unexpected operations.");
        }
        acknowledged = true;
        signal?.throwIfAborted();
        return Object.freeze({ applied: data.succeeded, header: Object.freeze(data.header) });
      });
    } catch (cause) {
      if (!dispatched || acknowledged || refused) throw cause;
      throw new EtcdPublicationError(operation, key, cause);
    }
  }
  /** Create without lease or replace under a native modification revision with explicit lease preservation/detachment. */
  async put(input: Uint8Array, value: Uint8Array, options: EtcdPutType): Promise<EtcdReceiptType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const owned = key(input), create = options.create, raw = options.modRevision, lease = options.lease;
    if (
      (create === true) === (raw !== undefined) || create !== undefined && create !== true ||
      create === true && lease !== undefined || raw !== undefined && lease !== "none" && lease !== "preserve"
    ) throw new TypeError("etcd put requires one condition and an explicit replacement lease choice.");
    const mod = raw === undefined ? undefined : parse(revision(true), raw);
    if (!isBytes(value)) throw new TypeError("etcd values require bytes.");
    const view = toView(value);
    integer(view.length, this.#max);
    const encoded = encodeBase64(new Uint8Array(view)), encodedKey = encodeBase64(owned);
    return await this.#mutate(
      "put",
      encodedKey,
      mod === undefined ? { target: "CREATE", create_revision: "0" } : { target: "MOD", mod_revision: mod },
      {
        request_put: {
          key: encodedKey,
          value: encoded,
          ...(lease === "preserve" ? { ignore_lease: true } : { lease: "0" }),
        },
      },
      signal,
    );
  }
  /** Exactly one conditional key deletion. Prefix/range deletion and repository maintenance are not exposed. */
  async remove(input: Uint8Array, options: EtcdRemoveType): Promise<EtcdReceiptType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const owned = key(input), mod = parse(revision(true), options.modRevision), encoded = encodeBase64(owned);
    return await this.#mutate("remove", encoded, { target: "MOD", mod_revision: mod }, {
      request_delete_range: { key: encoded },
    }, signal);
  }
}
/** Compare nonnegative bounded decimal strings without converting native revision authority through floating point. */
function decimalCompare(a: string, b: string): number {
  return a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : a.length - b.length;
}
/** Explicit construction performs no I/O, token discovery or global configuration. */
export function createEtcdClient(options: EtcdClientOptionsType): EtcdClient {
  return new EtcdClient(options);
}
