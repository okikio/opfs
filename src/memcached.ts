/** Bounded classic Memcached ASCII commands over an explicitly owned byte channel. @module */
import { z } from "zod";
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";

/**
 * One clean exclusive connection. Successful acquisition transfers ownership.
 * The adapter owns routing, TLS/certificate policy and any external security;
 * this client implements neither SASL nor text authentication. close must be
 * idempotent and retire pending IO. Acquisition must honor abort and retire
 * partial or late connections itself; it must not transfer a live channel after cancellation.
 */
export interface MemcachedChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
const RelativeSchema: z.ZodObject<{
  kind: z.ZodLiteral<"relative">;
  seconds: z.ZodNumber;
}, z.core.$strict> = z.object({
  kind: z.literal("relative"),
  seconds: z.number().int().min(0).max(2_592_000),
}).strict();
const AbsoluteSchema: z.ZodObject<{
  kind: z.ZodLiteral<"absolute">;
  seconds: z.ZodNumber;
}, z.core.$strict> = z.object({
  kind: z.literal("absolute"),
  seconds: z.number().int().min(2_592_001).max(0x7fffffff),
}).strict();
/** Seconds are either a relative duration up to 30 days (zero disables expiry), or a caller-owned signed 32-bit Unix timestamp. */
export const MemcachedExpirySchema: z.ZodUnion<[typeof RelativeSchema, typeof AbsoluteSchema]> = z.union([
  RelativeSchema,
  AbsoluteSchema,
]);
/** Expiry does not prevent eviction; no application or server clock is acquired by the client. */
export type MemcachedExpiryType = Readonly<z.infer<typeof MemcachedExpirySchema>>;
/** Returned bytes are caller-owned copies. CAS identifies a native item state, not an immutable content version. */
export interface MemcachedEntryType {
  readonly key: string;
  readonly flags: number;
  readonly cas: string;
  readonly bytes: Uint8Array;
}
/** One native acknowledgement, without cache durability or publisher identity. */
export interface MemcachedReceiptType {
  readonly state: "stored" | "not-stored" | "exists" | "missing";
}
/** Operation cancellation adds to the connection lifetime signal and configured deadline. */
export interface MemcachedOperationType {
  readonly signal?: AbortSignal;
}
/** Every write replaces flags and expiry. Classic CAS has no expiry-preservation option. */
export type MemcachedPutType =
  & MemcachedOperationType
  & { readonly flags: number; readonly expiry: MemcachedExpiryType }
  & (
    | { readonly mode: "set" | "add"; readonly cas?: never }
    | { readonly mode: "cas"; readonly cas: string }
  );
/** All limits are local safety policies, independent of native item/connection/memory configuration. */
export interface MemcachedOptionsType {
  readonly openChannel: (options: { readonly signal: AbortSignal }) => Promise<MemcachedChannelType>;
  readonly signal?: AbortSignal;
  /** Maximum acquisition or command duration, default 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum wait for the adapter's close, default five seconds. */
  readonly cleanupMs?: number;
  /** Materialized value ceiling, default and maximum 1 MiB. Server item overhead may lower its own limit. */
  readonly maxBytes?: number;
  /** Maximum individual incoming transport chunk, default 64 KiB and maximum 1 MiB. */
  readonly maxChunkBytes?: number;
  /** Maximum ASCII reply line, excluding CRLF, default 1024 and maximum 8192 bytes. */
  readonly maxLineBytes?: number;
}
/** An attributable native error reply; untrusted reason text is deliberately omitted. Effects can still have occurred. */
export class MemcachedError extends Error {
  readonly kind: "error" | "client" | "server";
  constructor(kind: MemcachedError["kind"]) {
    super(`Memcached returned a native ${kind} error.`);
    this.name = "MemcachedError";
    this.kind = kind;
  }
}
/** Invalid framing, unrelated replies or local connection-state refusal. */
export class MemcachedProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemcachedProtocolError";
  }
}
/** A mutating command was dispatched without an attributable terminal reply. No automatic retry is safe. */
export class MemcachedPublicationError extends Error {
  readonly outcome = "unknown";
  readonly operation: "put" | "remove";
  readonly key: string;
  constructor(operation: "put" | "remove", key: string, cause: unknown) {
    super("Memcached mutation outcome is unknown; reconcile before deciding whether to retry.", { cause });
    this.name = "MemcachedPublicationError";
    this.operation = operation;
    this.key = key;
  }
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError("Invalid Memcached policy limit.");
  }
  return selected;
}
/** The selected key profile admits printable single-byte ASCII, without command delimiters or transformations. */
function key(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 250 || /[^\u0021-\u007e]/u.test(value)) {
    throw new TypeError("Memcached key requires 1 to 250 visible ASCII bytes without whitespace.");
  }
  return value;
}
/** Canonical uint64 decimal admission never routes a CAS token through Number. */
function cas(value: string): string {
  if (
    typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]*$/u.test(value) ||
    value.length === 20 && value > "18446744073709551615"
  ) {
    throw new TypeError("Invalid Memcached CAS token.");
  }
  return value;
}
function integer(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError("Memcached integer exceeds its policy.");
  }
  return value;
}
/** Wire lengths and flags are canonical bounded decimals before allocation or Number conversion. */
function number(value: string, maximum: number): number {
  if (value.length > 10 || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new MemcachedProtocolError("Invalid Memcached reply integer.");
  }
  const selected = Number(value);
  if (selected > maximum) throw new MemcachedProtocolError("Memcached reply integer exceeds policy.");
  return selected;
}
/** The abort race observes eventual rejection; borrowed adapters must still honor cancellation and retire late acquisitions. */
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
  readonly key: string;
  dispatched: boolean;
  acknowledged: boolean;
}
/**
 * One operation at a time, without a hidden queue, pipeline or retry. Ambiguous
 * framing/cancellation retires the entire acquired connection. This is a cache
 * client, with no filesystem projection, key enumeration or durable byte source.
 */
export class MemcachedClient implements AsyncDisposable {
  readonly #acquire: MemcachedOptionsType["openChannel"];
  readonly #signal: AbortSignal | undefined;
  readonly #timeout: number;
  readonly #cleanup: number;
  readonly #maximum: number;
  readonly #chunk: number;
  readonly #lineMaximum: number;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #retire: (() => Promise<void>) | undefined;
  #pending = new Uint8Array(0);
  #position = 0;
  #busy = false;
  #closed = false;
  #opened = false;
  #active: AbortController | undefined;
  #closing: Promise<void> | undefined;
  /** Pure local policy admission; use openMemcachedClient to acquire the owned connection. */
  constructor(options: MemcachedOptionsType) {
    const acquire = options.openChannel;
    if (typeof acquire !== "function") throw new TypeError("Memcached requires an explicit byte-channel capability.");
    this.#acquire = acquire.bind(options);
    this.#signal = options.signal;
    this.#timeout = limit(options.timeoutMs, 30_000, 86_400_000);
    this.#cleanup = limit(options.cleanupMs, 5000, 60_000);
    this.#maximum = limit(options.maxBytes, 1_048_576, 1_048_576);
    this.#chunk = limit(options.maxChunkBytes, 65_536, 1_048_576);
    this.#lineMaximum = limit(options.maxLineBytes, 1024, 8192);
  }
  get closed(): boolean {
    return this.#closed;
  }
  /** Admission precedes dispatch; malformed protocol, abort or transport failure cannot leave a reusable ambiguous stream. */
  async #run<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    mutation?: MutationType,
    opening = false,
  ): Promise<T> {
    if (this.#closed) throw new MemcachedProtocolError("Memcached connection is closed.");
    if (this.#busy) throw new MemcachedProtocolError("Memcached connection is busy; commands are not queued.");
    if (!opening && !this.#opened) throw new MemcachedProtocolError("Memcached connection is not open.");
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
      const primary = mutation?.dispatched && !mutation.acknowledged && !(reason instanceof MemcachedError)
        ? new MemcachedPublicationError(mutation.operation, mutation.key, reason)
        : reason;
      await close([() => this.close()], [primary]);
      throw primary;
    } finally {
      this.#busy = false;
      this.#active = undefined;
    }
  }
  /** Successful acquisition transfers ownership before reader/writer locking, so partial setup can still close it. */
  async open(): Promise<void> {
    if (this.#opened) throw new MemcachedProtocolError("Memcached connection was already opened.");
    await this.#run(
      async (signal) => {
        const channel = await wait(this.#acquire({ signal }), signal);
        const retire = channel.close;
        if (typeof retire !== "function") throw new TypeError("Memcached channel has no close capability.");
        this.#retire = retire.bind(channel);
        signal.throwIfAborted();
        this.#reader = channel.readable.getReader();
        this.#writer = channel.writable.getWriter();
        this.#opened = true;
      },
      undefined,
      undefined,
      true,
    );
  }
  /** Policy is checked before allocating a declared value. Incoming chunks are privately copied before later reads. */
  async #take(length: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const result = new Uint8Array(length);
    let at = 0, empty = 0;
    while (at < length) {
      if (this.#position === this.#pending.length) {
        const next = await wait(this.#reader!.read(), signal);
        if (next.done) throw new MemcachedProtocolError("Memcached connection ended before its reply.");
        const bytes = next.value;
        if (!isBytes(bytes)) throw new MemcachedProtocolError("Memcached transport returned non-byte data.");
        const view = toView(bytes);
        if (view.length > this.#chunk) throw new MemcachedProtocolError("Memcached transport chunk exceeds policy.");
        if (!view.length) {
          if (++empty > 16) throw new MemcachedProtocolError("Memcached transport made no byte progress.");
          continue;
        }
        empty = 0;
        this.#pending = new Uint8Array(view);
        this.#position = 0;
      }
      const size = Math.min(length - at, this.#pending.length - this.#position);
      result.set(this.#pending.subarray(this.#position, this.#position + size), at);
      this.#position += size;
      at += size;
    }
    return result;
  }
  /** CRLF framing is independent of value payloads, which can contain every byte including CR and LF. */
  async #line(signal: AbortSignal): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      const byte = (await this.#take(1, signal))[0]!;
      if (byte === 13) {
        if ((await this.#take(1, signal))[0] !== 10) {
          throw new MemcachedProtocolError("Memcached reply has invalid CRLF.");
        }
        return String.fromCharCode(...bytes);
      }
      if (byte < 32 || byte > 126) throw new MemcachedProtocolError("Memcached reply line is not printable ASCII.");
      if (bytes.length >= this.#lineMaximum) throw new MemcachedProtocolError("Memcached reply line exceeds policy.");
      bytes.push(byte);
    }
  }
  /** With one outstanding command, already-buffered trailing bytes cannot belong to another legitimate reply. */
  #finish(): void {
    if (this.#position !== this.#pending.length) {
      throw new MemcachedProtocolError("Unsolicited bytes follow the Memcached reply.");
    }
    this.#pending = new Uint8Array(0);
    this.#position = 0;
  }
  #error(line: string): void {
    const kind = line === "ERROR"
      ? "error"
      : line.startsWith("CLIENT_ERROR ")
      ? "client"
      : line.startsWith("SERVER_ERROR ")
      ? "server"
      : undefined;
    if (kind !== undefined) {
      this.#finish();
      throw new MemcachedError(kind);
    }
  }
  async #send(bytes: Uint8Array, signal: AbortSignal, mutation?: MutationType): Promise<void> {
    signal.throwIfAborted();
    if (mutation) mutation.dispatched = true;
    await wait(this.#writer!.write(bytes), signal);
  }
  /** Fetch exactly one native item, including a uint64 CAS string; empty bytes differ from a missing item. */
  async get(input: string, options: MemcachedOperationType = {}): Promise<MemcachedEntryType | null> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const name = key(input), request = new TextEncoder().encode(`gets ${name}\r\n`);
    return await this.#run(async (combined) => {
      await this.#send(request, combined);
      const line = await this.#line(combined);
      this.#error(line);
      if (line === "END") {
        this.#finish();
        combined.throwIfAborted();
        return null;
      }
      const parts = line.split(" ");
      if (parts.length !== 5 || parts[0] !== "VALUE" || parts[1] !== name) {
        throw new MemcachedProtocolError("Memcached reply identifies another item or grammar.");
      }
      const flags = number(parts[2]!, 0xffffffff), length = number(parts[3]!, this.#maximum);
      let token: string;
      try {
        token = cas(parts[4]!);
      } catch {
        throw new MemcachedProtocolError("Memcached reply has an invalid CAS token.");
      }
      const bytes = await this.#take(length, combined), end = await this.#take(2, combined);
      if (end[0] !== 13 || end[1] !== 10 || await this.#line(combined) !== "END") {
        throw new MemcachedProtocolError("Memcached value lacks its exact terminator.");
      }
      this.#finish();
      combined.throwIfAborted();
      return Object.freeze({ key: name, flags, cas: token, bytes });
    }, signal);
  }
  /** Explicit native set/add/CAS, replacing expiry and flags; caller bytes/options are captured before any asynchronous write. */
  async put(input: string, bytes: Uint8Array, options: MemcachedPutType): Promise<MemcachedReceiptType> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const name = key(input), mode = options.mode, suppliedCas = options.cas, flags = integer(options.flags, 0xffffffff);
    if (!["set", "add", "cas"].includes(mode) || (mode === "cas") !== (suppliedCas !== undefined)) {
      throw new TypeError("Memcached write needs one native mode and matching CAS token.");
    }
    const token = suppliedCas === undefined ? undefined : cas(suppliedCas);
    const expiry = MemcachedExpirySchema.safeParse(options.expiry);
    if (!expiry.success) throw new TypeError("Invalid Memcached expiry policy.");
    if (!isBytes(bytes)) throw new TypeError("Memcached values require bytes.");
    const view = toView(bytes);
    integer(view.length, this.#maximum);
    const header = new TextEncoder().encode(
      `${mode} ${name} ${flags} ${expiry.data.seconds} ${view.length}${token === undefined ? "" : ` ${token}`}\r\n`,
    );
    const packet = new Uint8Array(header.length + view.length + 2);
    packet.set(header);
    packet.set(view, header.length);
    packet.set([13, 10], packet.length - 2);
    const mutation: MutationType = { operation: "put", key: name, dispatched: false, acknowledged: false };
    return await this.#run(
      async (combined) => {
        await this.#send(packet, combined, mutation);
        const line = await this.#line(combined);
        this.#error(line);
        let state: MemcachedReceiptType["state"];
        if (line === "STORED") state = "stored";
        else if (line === "NOT_STORED") state = "not-stored";
        else if (line === "EXISTS" && mode === "cas") state = "exists";
        else if (line === "NOT_FOUND" && mode === "cas") state = "missing";
        else throw new MemcachedProtocolError("Memcached reply does not acknowledge the requested storage command.");
        this.#finish();
        mutation.acknowledged = true;
        combined.throwIfAborted();
        return Object.freeze({ state });
      },
      signal,
      mutation,
    );
  }
  /** Native unconditional delete, without CAS protection, range deletion, history erasure or durability promises. */
  async remove(input: string, options: MemcachedOperationType = {}): Promise<boolean> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const name = key(input), request = new TextEncoder().encode(`delete ${name}\r\n`);
    const mutation: MutationType = { operation: "remove", key: name, dispatched: false, acknowledged: false };
    return await this.#run(
      async (combined) => {
        await this.#send(request, combined, mutation);
        const line = await this.#line(combined);
        this.#error(line);
        if (line !== "DELETED" && line !== "NOT_FOUND") {
          throw new MemcachedProtocolError(
            "Memcached reply does not acknowledge deletion.",
          );
        }
        this.#finish();
        mutation.acknowledged = true;
        combined.throwIfAborted();
        return line === "DELETED";
      },
      signal,
      mutation,
    );
  }
  /** Shared idempotent close retires pending IO, then releases locks even if adapter cleanup fails or times out. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#active?.abort(new MemcachedProtocolError("Memcached connection was closed."));
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
/** Acquire a clean connection from an explicit caller capability; no runtime socket or authentication discovery. */
export async function openMemcachedClient(options: MemcachedOptionsType): Promise<MemcachedClient> {
  const client = new MemcachedClient(options);
  await client.open();
  return client;
}
