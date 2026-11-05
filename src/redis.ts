/** Bounded Redis/Valkey RESP2 commands over an explicitly acquired byte channel. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";

/**
 * A newly connected, exclusive RESP2 channel with no pending commands, tracking
 * or Pub/Sub mode. Acquisition transfers ownership. The adapter owns routing,
 * TLS, certificates and peer authentication; this client does not discover sockets.
 * close must be idempotent and retire pending IO. Acquisition must honor abort
 * and retire partial or late connections rather than return them after cancellation.
 */
export interface RedisChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
const PersistSchema: z.ZodObject<{ kind: z.ZodLiteral<"persist"> }, z.core.$strict> = z.object({
  kind: z.literal("persist"),
}).strict();
const KeepSchema: z.ZodObject<{ kind: z.ZodLiteral<"keep"> }, z.core.$strict> = z.object({
  kind: z.literal("keep"),
}).strict();
const RelativeSchema: z.ZodObject<{
  kind: z.ZodLiteral<"relative">;
  milliseconds: z.ZodNumber;
}, z.core.$strict> = z.object({
  kind: z.literal("relative"),
  milliseconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const AbsoluteSchema: z.ZodObject<{
  kind: z.ZodLiteral<"absolute">;
  milliseconds: z.ZodNumber;
}, z.core.$strict> = z.object({
  kind: z.literal("absolute"),
  milliseconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
/**
 * persist deliberately clears an old TTL; keep sends KEEPTTL, which does not
 * create a TTL for a new key. Absolute milliseconds are caller-owned Unix time.
 * A past absolute expiry can acknowledge a write that has already expired.
 */
export const RedisExpirySchema: z.ZodUnion<[
  typeof PersistSchema,
  typeof KeepSchema,
  typeof RelativeSchema,
  typeof AbsoluteSchema,
]> = z.union([PersistSchema, KeepSchema, RelativeSchema, AbsoluteSchema]);
/** Expiry is not protection against eviction, administrative changes or persistence loss. */
export type RedisExpiryType = Readonly<z.infer<typeof RedisExpirySchema>>;
/** One operation adds cancellation to the connection lifetime and configured deadline. */
export interface RedisOperationType {
  readonly signal?: AbortSignal;
}
/** A native SET condition; every call explicitly chooses its TTL behavior. */
export interface RedisPutType extends RedisOperationType {
  readonly mode: "any" | "absent" | "present";
  readonly expiry: RedisExpiryType;
}
/** Native SET acknowledgement; not-stored is a failed NX/XX condition, not a transport failure. */
export interface RedisReceiptType {
  readonly state: "stored" | "not-stored";
}
/** One PTTL observation, with a lossless decimal millisecond count; it does not pin a value or guarantee survival. */
export type RedisTtlType =
  | { readonly state: "missing" }
  | { readonly state: "persistent" }
  | { readonly state: "remaining"; readonly milliseconds: string };
/** Explicit native AUTH bytes, copied before acquisition. Local limits are 4 KiB for password and 1 KiB for username. */
export interface RedisAuthType {
  /** Omitted selects password-only AUTH; supplied bytes are a literal native username. */
  readonly username?: Uint8Array;
  readonly password: Uint8Array;
}
/** Local policy limits do not change the provider's own key, value, memory or database configuration. */
export interface RedisOptionsType {
  readonly openChannel: (options: { readonly signal: AbortSignal }) => Promise<RedisChannelType>;
  readonly signal?: AbortSignal;
  readonly auth?: RedisAuthType;
  /** Explicit SELECT database index, 0 to 65535; omitted leaves the new connection's native database 0. */
  readonly database?: number;
  /** Maximum acquisition/initialization or command duration, default 30 seconds and maximum one day. */
  readonly timeoutMs?: number;
  /** Maximum adapter close wait, default five seconds and maximum one minute. */
  readonly cleanupMs?: number;
  /** Materialized value limit, default and maximum 1 MiB. Empty values are supported. */
  readonly maxBytes?: number;
  /** Binary key limit, default and maximum 1 KiB. The empty binary key is valid. */
  readonly maxKeyBytes?: number;
  /** Incoming chunk ceiling, default 64 KiB and maximum 1 MiB. */
  readonly maxChunkBytes?: number;
  /** Reply line ceiling excluding CRLF, default 1024 and maximum 8192 bytes. */
  readonly maxLineBytes?: number;
}
/** A framed native error reply; untrusted server reason text and credentials are not copied into the error. */
export class RedisError extends Error {
  readonly code: "ERR" | "NOAUTH" | "WRONGPASS" | "NOPERM" | "WRONGTYPE" | "OOM" | "READONLY" | "OTHER";
  constructor(code: RedisError["code"]) {
    super(`Redis/Valkey returned a native ${code} error.`);
    this.name = "RedisError";
    this.code = code;
  }
}
/** Invalid framing, unrelated replies or local connection-state refusal. */
export class RedisProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisProtocolError";
  }
}
/** A mutation was dispatched without an attributable terminal reply. Repeating it can change a different key state. */
export class RedisPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "put" | "remove";
  constructor(operation: RedisPublicationError["operation"], cause: unknown) {
    super("Redis/Valkey mutation outcome is unknown; reconcile before considering a new mutation.", { cause });
    this.name = "RedisPublicationError";
    this.operation = operation;
  }
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError("Invalid Redis/Valkey policy limit.");
  }
  return selected;
}
/** Copy before any asynchronous boundary or later structural getter can change the byte authority. */
function copy(value: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (!isBytes(value)) throw new TypeError("Redis/Valkey commands require byte views.");
  const bytes = toView(value);
  if (bytes.length > maximum) throw new RangeError("Redis/Valkey bytes exceed policy.");
  return new Uint8Array(bytes);
}
/** Decimal syntax and signed 64-bit limits are checked before any selective Number conversion. */
function integer(value: string): bigint {
  if (value.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u.test(value)) {
    throw new RedisProtocolError("Invalid RESP2 integer.");
  }
  const result = BigInt(value);
  if (result < -9223372036854775808n || result > 9223372036854775807n) {
    throw new RedisProtocolError("RESP2 integer exceeds signed 64-bit range.");
  }
  return result;
}
/** Only fixed native command arguments enter this function; caller data is always a length-prefixed bulk string. */
function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}
/** Bounded commands are one private packet, preserving framing even when keys or values contain CRLF and NUL. */
function packet(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const start = text(`*${parts.length}\r\n`), headers = parts.map((part) => text(`$${part.length}\r\n`));
  const size = start.length + parts.reduce((sum, part, index) => sum + headers[index]!.length + part.length + 2, 0);
  const result = new Uint8Array(size);
  result.set(start);
  let at = start.length;
  for (let index = 0; index < parts.length; index++) {
    const header = headers[index]!, part = parts[index]!;
    result.set(header, at);
    at += header.length;
    result.set(part, at);
    at += part.length;
    result.set([13, 10], at);
    at += 2;
  }
  return result;
}
/** The abort race observes late rejection. The acquired adapter still owns actually stopping its pending IO. */
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
interface MutationType {
  readonly operation: "put" | "remove";
  dispatched: boolean;
  acknowledged: boolean;
  refused: boolean;
}
type ReplyType =
  | { readonly kind: "simple"; readonly value: string }
  | { readonly kind: "integer"; readonly value: string }
  | { readonly kind: "bulk"; readonly value: Uint8Array<ArrayBuffer> | null };
/**
 * One outstanding command, without pipeline, transaction, reconnect or retry.
 * Invalid framing, cancellation and command failures retire the connection.
 * No filesystem projection, key enumeration, immutable source or durability is inferred.
 */
export class RedisClient implements AsyncDisposable {
  readonly #acquire: RedisOptionsType["openChannel"];
  readonly #signal: AbortSignal | undefined;
  readonly #initial: readonly Uint8Array[];
  readonly #timeout: number;
  readonly #cleanup: number;
  readonly #maximum: number;
  readonly #keyMaximum: number;
  readonly #chunk: number;
  readonly #lineMaximum: number;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #retire: (() => Promise<void>) | undefined;
  #pending = new Uint8Array(0);
  #position = 0;
  #busy = false;
  #opened = false;
  #closed = false;
  #active: AbortController | undefined;
  #closing: Promise<void> | undefined;
  /** Pure policy and AUTH/SELECT capture; openRedisClient performs acquisition. No runtime socket is discovered. */
  constructor(options: RedisOptionsType) {
    const acquire = options.openChannel;
    if (typeof acquire !== "function") throw new TypeError("Redis/Valkey requires an explicit channel capability.");
    this.#acquire = acquire.bind(options);
    this.#signal = options.signal;
    const auth = options.auth, initial: Uint8Array[] = [];
    if (auth !== undefined) {
      const password = copy(auth.password, 4096), suppliedUsername = auth.username;
      const username = suppliedUsername === undefined ? undefined : copy(suppliedUsername, 1024);
      initial.push(packet(username === undefined ? [text("AUTH"), password] : [text("AUTH"), username, password]));
    }
    const database = options.database;
    if (database !== undefined) {
      if (!Number.isSafeInteger(database) || database < 0 || database > 65535) {
        throw new RangeError("Redis/Valkey database index exceeds policy.");
      }
      initial.push(packet([text("SELECT"), text(String(database))]));
    }
    this.#initial = initial;
    this.#timeout = limit(options.timeoutMs, 30_000, 86_400_000);
    this.#cleanup = limit(options.cleanupMs, 5000, 60_000);
    this.#maximum = limit(options.maxBytes, 1_048_576, 1_048_576);
    this.#keyMaximum = limit(options.maxKeyBytes, 1024, 1024);
    this.#chunk = limit(options.maxChunkBytes, 65_536, 1_048_576);
    this.#lineMaximum = limit(options.maxLineBytes, 1024, 8192);
  }
  get closed(): boolean {
    return this.#closed;
  }
  /** Admission failures before this scope leave the connection alone; admitted command failures retire it. */
  async #run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    mutation?: MutationType,
    opening = false,
  ): Promise<T> {
    if (this.#closed) throw new RedisProtocolError("Redis/Valkey connection is closed.");
    if (this.#busy) throw new RedisProtocolError("Redis/Valkey connection is busy; commands are not queued.");
    if (!opening && !this.#opened) throw new RedisProtocolError("Redis/Valkey connection is not open.");
    const abort = new AbortController(), signals = [abort.signal, AbortSignal.timeout(this.#timeout)];
    if (signal) signals.push(signal);
    if (this.#signal) signals.push(this.#signal);
    const combined = AbortSignal.any(signals);
    combined.throwIfAborted();
    this.#busy = true;
    this.#active = abort;
    try {
      return await action(combined);
    } catch (reason) {
      const primary = mutation?.dispatched && !mutation.acknowledged && !mutation.refused
        ? new RedisPublicationError(mutation.operation, reason)
        : reason;
      await close([() => this.close()], [primary]);
      throw primary;
    } finally {
      this.#busy = false;
      this.#active = undefined;
    }
  }
  /** Ownership is captured before locking streams, so partial setup and AUTH/SELECT failure can retire the channel. */
  async open(): Promise<void> {
    if (this.#opened) throw new RedisProtocolError("Redis/Valkey connection was already opened.");
    await this.#run(
      async (signal) => {
        const channel = await wait(this.#acquire({ signal }), signal), retire = channel.close;
        if (typeof retire !== "function") throw new TypeError("Redis/Valkey channel has no close capability.");
        this.#retire = retire.bind(channel);
        signal.throwIfAborted();
        this.#reader = channel.readable.getReader();
        this.#writer = channel.writable.getWriter();
        for (const request of this.#initial) {
          await this.#send(request, signal);
          const reply = await this.#reply(signal);
          if (reply.kind !== "simple" || reply.value !== "OK") {
            throw new RedisProtocolError("Redis/Valkey initialization lacks its OK receipt.");
          }
          signal.throwIfAborted();
        }
        signal.throwIfAborted();
        this.#opened = true;
      },
      undefined,
      undefined,
      true,
    );
  }
  /** Declared lengths are checked before this bounded allocation; transport chunks are privately copied before another read. */
  async #take(length: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const result = new Uint8Array(length);
    let at = 0, empty = 0;
    while (at < length) {
      if (this.#position === this.#pending.length) {
        const next = await wait(this.#reader!.read(), signal);
        if (next.done) throw new RedisProtocolError("Redis/Valkey connection ended before its reply.");
        if (!isBytes(next.value)) throw new RedisProtocolError("Redis/Valkey channel returned non-byte data.");
        const view = toView(next.value);
        if (view.length > this.#chunk) throw new RedisProtocolError("Redis/Valkey chunk exceeds policy.");
        if (!view.length) {
          if (++empty > 16) throw new RedisProtocolError("Redis/Valkey channel made no byte progress.");
          continue;
        }
        empty = 0;
        this.#pending = new Uint8Array(view);
        this.#position = 0;
      }
      const count = Math.min(length - at, this.#pending.length - this.#position);
      result.set(this.#pending.subarray(this.#position, this.#position + count), at);
      at += count;
      this.#position += count;
    }
    return result;
  }
  /** Read a bounded line without decoding untrusted UTF-8; native error text is never returned. */
  async #line(signal: AbortSignal): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      const byte = (await this.#take(1, signal))[0]!;
      if (byte === 13) {
        if ((await this.#take(1, signal))[0] !== 10) throw new RedisProtocolError("RESP2 reply has invalid CRLF.");
        return String.fromCharCode(...bytes);
      }
      if (byte === 10) throw new RedisProtocolError("RESP2 reply has a bare LF.");
      if (bytes.length >= this.#lineMaximum) throw new RedisProtocolError("RESP2 reply line exceeds policy.");
      bytes.push(byte);
    }
  }
  /** Buffered trailing bytes cannot belong to another command on this exclusive, non-pipelined connection. */
  #finish(): void {
    if (this.#position !== this.#pending.length) {
      throw new RedisProtocolError("Unsolicited bytes follow the RESP2 reply.");
    }
    this.#pending = new Uint8Array(0);
    this.#position = 0;
  }
  /** Only the four RESP2 shapes used by this profile are admitted; arrays, RESP3 and pushes are not silently coerced. */
  async #reply(signal: AbortSignal, mutation?: MutationType): Promise<ReplyType> {
    const line = await this.#line(signal), prefix = line[0], value = line.slice(1);
    let result: ReplyType;
    if (prefix === "-") {
      this.#finish();
      if (mutation) mutation.refused = true;
      const code = value.split(" ", 1)[0];
      const known = ["ERR", "NOAUTH", "WRONGPASS", "NOPERM", "WRONGTYPE", "OOM", "READONLY"] as const;
      throw new RedisError(known.find((candidate) => candidate === code) ?? "OTHER");
    } else if (prefix === "+") {
      result = { kind: "simple", value };
    } else if (prefix === ":") {
      integer(value);
      result = { kind: "integer", value };
    } else if (prefix === "$") {
      const length = integer(value);
      if (length === -1n) result = { kind: "bulk", value: null };
      else {
        if (length < 0n || length > BigInt(this.#maximum)) {
          throw new RedisProtocolError("RESP2 bulk length exceeds policy.");
        }
        const bytes = await this.#take(Number(length), signal), end = await this.#take(2, signal);
        if (end[0] !== 13 || end[1] !== 10) throw new RedisProtocolError("RESP2 bulk lacks its exact CRLF terminator.");
        result = { kind: "bulk", value: bytes };
      }
    } else throw new RedisProtocolError("Unexpected RESP2 reply type.");
    this.#finish();
    return result;
  }
  async #send(request: Uint8Array, signal: AbortSignal, mutation?: MutationType): Promise<void> {
    signal.throwIfAborted();
    if (mutation) mutation.dispatched = true;
    await wait(this.#writer!.write(request), signal);
  }
  /** Native GET for one literal binary key. Missing differs from an existing empty value; returned bytes belong to the caller. */
  async get(key: Uint8Array, options: RedisOperationType = {}): Promise<Uint8Array<ArrayBuffer> | null> {
    const name = copy(key, this.#keyMaximum), signal = options.signal;
    signal?.throwIfAborted();
    const request = packet([text("GET"), name]);
    return await this.#run(async (combined) => {
      await this.#send(request, combined);
      const reply = await this.#reply(combined);
      if (reply.kind !== "bulk") throw new RedisProtocolError("GET lacks a bulk or null-bulk receipt.");
      combined.throwIfAborted();
      return reply.value;
    }, signal);
  }
  /** SET can replace another native data type. NX/XX protects existence only; the explicit expiry policy replaces or retains TTL. */
  async put(key: Uint8Array, bytes: Uint8Array, options: RedisPutType): Promise<RedisReceiptType> {
    const name = copy(key, this.#keyMaximum), value = copy(bytes, this.#maximum);
    const signal = options.signal, mode = options.mode, expiry = RedisExpirySchema.safeParse(options.expiry);
    signal?.throwIfAborted();
    if (!["any", "absent", "present"].includes(mode) || !expiry.success) {
      throw new TypeError("SET requires a native existence mode and explicit valid expiry policy.");
    }
    const parts = [text("SET"), name, value];
    if (mode !== "any") parts.push(text(mode === "absent" ? "NX" : "XX"));
    if (expiry.data.kind === "keep") parts.push(text("KEEPTTL"));
    else if (expiry.data.kind !== "persist") {
      parts.push(text(expiry.data.kind === "relative" ? "PX" : "PXAT"), text(String(expiry.data.milliseconds)));
    }
    const request = packet(parts),
      mutation: MutationType = {
        operation: "put",
        dispatched: false,
        acknowledged: false,
        refused: false,
      };
    return await this.#run(
      async (combined) => {
        await this.#send(request, combined, mutation);
        const reply = await this.#reply(combined, mutation);
        let state: RedisReceiptType["state"];
        if (reply.kind === "simple" && reply.value === "OK") state = "stored";
        else if (mode !== "any" && reply.kind === "bulk" && reply.value === null) state = "not-stored";
        else throw new RedisProtocolError("SET lacks its requested conditional acknowledgement.");
        mutation.acknowledged = true;
        combined.throwIfAborted();
        return Object.freeze({ state });
      },
      signal,
      mutation,
    );
  }
  /** PTTL observes one current key state. A later GET or SET can address a different state even on the same connection. */
  async ttl(key: Uint8Array, options: RedisOperationType = {}): Promise<RedisTtlType> {
    const name = copy(key, this.#keyMaximum), signal = options.signal;
    signal?.throwIfAborted();
    const request = packet([text("PTTL"), name]);
    return await this.#run(async (combined) => {
      await this.#send(request, combined);
      const reply = await this.#reply(combined);
      if (reply.kind !== "integer" || integer(reply.value) < -2n) {
        throw new RedisProtocolError("PTTL lacks a native TTL observation.");
      }
      combined.throwIfAborted();
      if (reply.value === "-2") return Object.freeze({ state: "missing" });
      if (reply.value === "-1") return Object.freeze({ state: "persistent" });
      return Object.freeze({ state: "remaining", milliseconds: reply.value });
    }, signal);
  }
  /** Native single-key unconditional DEL, without version protection, secure erasure or persistence promises. */
  async remove(key: Uint8Array, options: RedisOperationType = {}): Promise<boolean> {
    const name = copy(key, this.#keyMaximum), signal = options.signal;
    signal?.throwIfAborted();
    const request = packet([text("DEL"), name]),
      mutation: MutationType = {
        operation: "remove",
        dispatched: false,
        acknowledged: false,
        refused: false,
      };
    return await this.#run(
      async (combined) => {
        await this.#send(request, combined, mutation);
        const reply = await this.#reply(combined, mutation);
        if (reply.kind !== "integer" || reply.value !== "0" && reply.value !== "1") {
          throw new RedisProtocolError("Single-key DEL lacks its zero-or-one acknowledgement.");
        }
        mutation.acknowledged = true;
        combined.throwIfAborted();
        return reply.value === "1";
      },
      signal,
      mutation,
    );
  }
  /** Shared close retires the channel before releasing stream locks, even when adapter cleanup fails or reaches its deadline. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#active?.abort(new RedisProtocolError("Redis/Valkey connection was closed."));
    const retire = this.#retire, reader = this.#reader, writer = this.#writer;
    this.#closing = Promise.resolve().then(() =>
      close([
        async () => {
          if (retire) await wait(retire(), AbortSignal.timeout(this.#cleanup));
        },
        () => reader?.releaseLock(),
        () => writer?.releaseLock(),
      ])
    );
    return this.#closing;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/** Acquire and initialize one owned RESP2 connection. There is no ambient transport, credential or reconnection discovery. */
export async function openRedisClient(options: RedisOptionsType): Promise<RedisClient> {
  const client = new RedisClient(options);
  await client.open();
  return client;
}
