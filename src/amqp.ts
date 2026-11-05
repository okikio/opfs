/** Bounded AMQP 0-9-1 publication confirms and explicitly destructive queue reads. @module */
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";

/**
 * Acquisition transfers a fresh, exclusive AMQP transport positioned before
 * its protocol header. The adapter owns socket/TLS authentication, abort-aware
 * acquisition, and cleanup of late or partially acquired resources. close must
 * be idempotent and retire pending reads/writes. No socket is discovered here.
 */
export interface AmqpChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly security: "tls" | "plaintext";
  close(): Promise<void>;
}
/** Credentials are privately captured; PLAIN authenticates only inside the selected transport. */
export interface AmqpOptionsType {
  readonly openChannel: (options: { readonly signal: AbortSignal }) => Promise<AmqpChannelType>;
  readonly auth: { readonly user: string; readonly password: string };
  readonly vhost: string;
  /** Explicit permission for an unencrypted transport; default false. */
  readonly allowPlaintext?: boolean;
  readonly signal?: AbortSignal;
  /** Acquisition through terminal receipt and graceful close; default 30 seconds, maximum one day. */
  readonly timeoutMs?: number;
  /** Physical retirement wait, independent of operation abort; default five seconds, maximum one minute. */
  readonly cleanupMs?: number;
  /** Local materialized body policy, default and maximum 1 MiB. */
  readonly maxBytes?: number;
  /** Positive heartbeat proposal in seconds; default 60, maximum 3600. Native negotiation may lower it. */
  readonly heartbeat?: number;
}
/** A complete native message. Property bytes include flags and values, validated but left inert. */
export interface AmqpMessageType {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly properties: Uint8Array<ArrayBuffer>;
  /** Channel-scoped uint64 decimal text; this auto-ack profile cannot acknowledge it later. */
  readonly deliveryTag: string;
  readonly redelivered: boolean;
  readonly exchange: string;
  readonly routingKey: string;
  /** Point-in-time server declaration, not a backlog-completeness guarantee. */
  readonly remaining: number;
}
/** Mandatory return and publisher confirmation are independent native observations. */
export interface AmqpReceiptType {
  readonly confirmation: "ack" | "nack";
  /** Native nack requeue bit is retained as data; it does not establish whether routing had partial effects. */
  readonly requeue: boolean;
  readonly returned?: {
    readonly code: number;
    readonly exchange: string;
    readonly routingKey: string;
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly properties: Uint8Array<ArrayBuffer>;
  };
}
/** Native refusal metadata without potentially private reply text. */
export class AmqpError extends Error {
  readonly code: number;
  readonly classId: number;
  readonly methodId: number;
  constructor(code: number, classId: number, methodId: number) {
    super("AMQP peer refused the connection or channel.");
    this.name = "AmqpError";
    this.code = code;
    this.classId = classId;
    this.methodId = methodId;
  }
}
/** A mutating method was admitted to the transport without a complete selected receipt. Never blindly retry. */
export class AmqpOutcomeError extends Error {
  readonly outcome = "unknown";
  readonly operation: "publish" | "take";
  /** A complete mandatory return observed before the terminal confirmation was lost. It is not a confirmation. */
  readonly returned: AmqpReceiptType["returned"];
  constructor(operation: "publish" | "take", cause: unknown, returned?: AmqpReceiptType["returned"]) {
    super("AMQP operation outcome is unknown; publication or dequeue may already have occurred.", { cause });
    this.name = "AmqpOutcomeError";
    this.operation = operation;
    this.returned = returned;
  }
}
/** Complete result retained when later cancellation, graceful close, or physical retirement fails. */
export class AmqpCompletionError extends Error {
  readonly receipt: AmqpReceiptType | AmqpMessageType | null;
  constructor(receipt: AmqpReceiptType | AmqpMessageType | null, cause: unknown) {
    super("AMQP produced a complete result, but terminal cleanup failed.", { cause });
    this.name = "AmqpCompletionError";
    this.receipt = receipt;
  }
}
/** All malformed peer errors are fixed text; wire values and credentials are never interpolated. */
function invalid(): never {
  throw new TypeError("AMQP peer data is outside the supported bounded protocol profile.");
}
function bound(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError("Invalid AMQP policy.");
  }
  return selected;
}
/** Refuse lone surrogates before UTF-8 encoding can silently replace caller authority. */
function text(value: string, maximum: number, empty = true): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > maximum || !empty && !value.length || /\p{Surrogate}/u.test(value)) {
    throw new TypeError("Invalid AMQP text extent.");
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > maximum || bytes.includes(0)) throw new TypeError("Invalid AMQP UTF-8 text.");
  return bytes;
}
function name(value: string, empty = false): Uint8Array<ArrayBuffer> {
  const bytes = text(value, 127, empty);
  if (!/^[A-Za-z0-9_.:-]*$/.test(value)) throw new TypeError("AMQP name is outside the selected ASCII profile.");
  return bytes;
}
function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid();
  }
}
function join(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
function number(value: number | bigint, size: 1 | 2 | 4 | 8): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(size), view = new DataView(result.buffer);
  if (size === 8) view.setBigUint64(0, BigInt(value));
  else if (size === 4) view.setUint32(0, Number(value));
  else if (size === 2) view.setUint16(0, Number(value));
  else view.setUint8(0, Number(value));
  return result;
}
const short = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => join(number(bytes.length, 1), bytes);
const long = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => join(number(bytes.length, 4), bytes);
function frame(type: number, channel: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  return join(number(type, 1), number(channel, 2), number(body.length, 4), body, number(206, 1));
}
function method(
  channel: number,
  classId: number,
  methodId: number,
  ...args: readonly Uint8Array[]
): Uint8Array<ArrayBuffer> {
  return frame(1, channel, join(number(classId, 2), number(methodId, 2), ...args));
}
/** Packet bounds dominate every subreader; no numeric value is silently narrowed from uint64. */
class Reader {
  #at = 0;
  readonly bytes: Uint8Array<ArrayBuffer>;
  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.bytes = bytes;
  }
  get left(): number {
    return this.bytes.length - this.#at;
  }
  take(size: number): Uint8Array<ArrayBuffer> {
    if (size < 0 || size > this.left) return invalid();
    const result = this.bytes.subarray(this.#at, this.#at + size);
    this.#at += size;
    return result;
  }
  uint(size: 1 | 2 | 4): number {
    const bytes = this.take(size), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return size === 1 ? view.getUint8(0) : size === 2 ? view.getUint16(0) : view.getUint32(0);
  }
  uint64(): bigint {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
  }
  short(): string {
    const bytes = this.take(this.uint(1));
    if (bytes.includes(0)) return invalid();
    return utf8(bytes);
  }
  long(): Uint8Array<ArrayBuffer> {
    return this.take(this.uint(4));
  }
  end(): void {
    if (this.left) invalid();
  }
}
/**
 * Validate the RabbitMQ field-value grammar without converting its integers,
 * decimals, timestamps, floats or arbitrary long-string bytes to JS numbers.
 * Duplicate table names are refused rather than overwritten. Nested work shares
 * one entry counter and each declared container must end exactly at its extent.
 */
function fields(reader: Reader, table: boolean, quota: { entries: number }, depth = 0): void {
  if (depth > 16) throw new RangeError("AMQP field nesting exceeds policy.");
  const bytes = reader.long();
  if (bytes.length > 65536) throw new RangeError("AMQP field container exceeds policy.");
  const nested = new Reader(bytes), keys = new Set<string>();
  while (nested.left) {
    if (++quota.entries > 1024) throw new RangeError("AMQP field entry budget exceeded.");
    if (table) {
      const key = nested.short();
      // Field names exclude C0 controls and DEL, including inside valid UTF-8.
      for (let index = 0; index < key.length; index++) {
        const code = key.charCodeAt(index);
        if (code <= 31 || code === 127) return invalid();
      }
      if (!key.length || keys.has(key)) return invalid();
      keys.add(key);
    }
    const kind = nested.uint(1);
    if (kind === 116) { if (nested.uint(1) > 1) return invalid(); }
    else if (kind === 98 || kind === 66) nested.take(1);
    else if (kind === 85 || kind === 117 || kind === 115) nested.take(2);
    else if (kind === 73 || kind === 105 || kind === 102) nested.take(4);
    else if (kind === 76 || kind === 108 || kind === 100 || kind === 84) nested.take(8);
    else if (kind === 68) nested.take(5);
    else if (kind === 83 || kind === 120) nested.long();
    else if (kind === 65 || kind === 70) fields(nested, kind === 70, quota, depth + 1);
    else if (kind !== 86) return invalid();
  }
}
/** Basic has fourteen properties and one flag word; continuation/reserved bits are unsupported, never ignored. */
function properties(reader: Reader): Uint8Array<ArrayBuffer> {
  const raw = reader.take(reader.left), values = new Reader(raw), flags = values.uint(2);
  if (flags & 3) return invalid();
  for (let index = 0; index < 14; index++) {
    if (!(flags & (1 << (15 - index)))) continue;
    if (index === 2) fields(values, true, { entries: 0 });
    else if (index === 3) {
      const mode = values.uint(1);
      if (mode !== 1 && mode !== 2) return invalid();
    } else if (index === 4) values.uint(1);
    else if (index === 9) values.uint64();
    else values.short();
  }
  values.end();
  return new Uint8Array(raw);
}
/** Race only owned waits; the late promise remains observed. Adapters still own actual IO retirement. */
function wait<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(
      () => {},
    );
  });
}
interface FrameType {
  readonly type: number;
  readonly channel: number;
  readonly body: Uint8Array<ArrayBuffer>;
}
/** One reader and one serialized writer own the connection, including heartbeat traffic. */
class Session {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #signal: AbortSignal;
  #pending: Uint8Array<ArrayBuffer> = new Uint8Array();
  #at = 0;
  #frames = 0;
  #controls = 0;
  #lastWrite = 0;
  #interval = 0;
  frameMax = 4096;
  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    signal: AbortSignal,
  ) {
    this.#reader = reader;
    this.#writer = writer;
    this.#signal = signal;
  }
  async send(bytes: Uint8Array, dispatch?: () => void): Promise<void> {
    this.#signal.throwIfAborted();
    dispatch?.();
    await wait(this.#writer.write(bytes), this.#signal);
    this.#signal.throwIfAborted();
    this.#lastWrite = Date.now();
  }
  /** A timer never starts another read: every heartbeat races the same retained read until it settles. */
  async #read(): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
    this.#signal.throwIfAborted();
    if (this.#interval && Date.now() >= this.#lastWrite + this.#interval) {
      if (++this.#controls > 128) throw new RangeError("AMQP heartbeat/control budget exceeded.");
      await this.send(frame(8, 0, new Uint8Array()));
    }
    this.#signal.throwIfAborted();
    const pending = this.#reader.read();
    if (!this.#interval) return await wait(pending, this.#signal);
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tick = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(0, this.#lastWrite + this.#interval - Date.now()));
        });
        const result = await wait(Promise.race([pending, tick]), this.#signal);
        this.#signal.throwIfAborted();
        if (result !== null) return result;
        if (++this.#controls > 128) throw new RangeError("AMQP heartbeat/control budget exceeded.");
        await this.send(frame(8, 0, new Uint8Array()));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }
  async take(size: number): Promise<Uint8Array<ArrayBuffer>> {
    this.#signal.throwIfAborted();
    const result = new Uint8Array(size);
    let at = 0, empty = 0;
    while (at < size) {
      this.#signal.throwIfAborted();
      if (this.#at === this.#pending.length) {
        const next = await this.#read();
        this.#signal.throwIfAborted();
        const done = next.done;
        this.#signal.throwIfAborted();
        if (done) return invalid();
        const supplied = next.value;
        this.#signal.throwIfAborted();
        if (!isBytes(supplied)) return invalid();
        const bytes = toView(supplied);
        if (bytes.length > 65536) throw new RangeError("AMQP transport chunk exceeds 64 KiB policy.");
        if (!bytes.length) {
          if (++empty > 16) return invalid();
          continue;
        }
        empty = 0;
        this.#pending = new Uint8Array(bytes);
        this.#at = 0;
      }
      const count = Math.min(size - at, this.#pending.length - this.#at);
      result.set(this.#pending.subarray(this.#at, this.#at + count), at);
      this.#at += count;
      at += count;
    }
    this.#signal.throwIfAborted();
    return result;
  }
  async next(): Promise<FrameType> {
    while (true) {
      if (++this.#frames > 2048) throw new RangeError("AMQP frame budget exceeded.");
      const header = new Reader(await this.take(7)),
        type = header.uint(1),
        channel = header.uint(2),
        size = header.uint(4);
      if (size > this.frameMax - 8 || channel > 1) return invalid();
      const body = await this.take(size);
      if ((await this.take(1))[0] !== 206) return invalid();
      if (type === 8) {
        if (channel || size || ++this.#controls > 128) return invalid();
        continue;
      }
      if (type !== 1 && type !== 2 && type !== 3) return invalid();
      if (type === 1) {
        const method = new Reader(body), classId = method.uint(2), methodId = method.uint(2);
        if ((classId === 10 && methodId === 50) || (classId === 20 && methodId === 40)) {
          if (channel !== (classId === 10 ? 0 : 1)) return invalid();
          const code = method.uint(2);
          method.short();
          const selectedClass = method.uint(2), selectedMethod = method.uint(2);
          method.end();
          throw new AmqpError(code, selectedClass, selectedMethod);
        }
      }
      return { type, channel, body };
    }
  }
  async expect(channel: number, classId: number, methodId: number): Promise<Reader> {
    const next = await this.next(), value = new Reader(next.body);
    if (next.type !== 1 || next.channel !== channel || value.uint(2) !== classId || value.uint(2) !== methodId) {
      return invalid();
    }
    return value;
  }
  async initialize(auth: Uint8Array, vhost: Uint8Array, heartbeat: number): Promise<void> {
    await this.send(new Uint8Array([65, 77, 81, 80, 0, 0, 9, 1]));
    const start = await this.expect(0, 10, 10);
    if (start.uint(1) !== 0 || start.uint(1) !== 9) return invalid();
    fields(start, true, { entries: 0 });
    const mechanisms = utf8(start.long()).split(" "), locales = utf8(start.long()).split(" ");
    start.end();
    if (!mechanisms.includes("PLAIN") || !locales.includes("en_US")) return invalid();
    // RabbitMQ otherwise may silently close on bad PLAIN credentials. This
    // capability advertises the connection.close notification we implement.
    const capabilities = long(
      join(
        short(text("capabilities", 255)),
        number(70, 1),
        long(join(short(text("authentication_failure_close", 255)), number(116, 1), number(1, 1))),
      ),
    );
    await this.send(method(0, 10, 11, capabilities, short(text("PLAIN", 5)), long(auth), short(text("en_US", 5))));
    const tune = await this.expect(0, 10, 30);
    tune.uint(2);
    const maximum = tune.uint(4), remoteHeartbeat = tune.uint(2);
    tune.end();
    if (maximum && maximum < 4096) return invalid();
    this.frameMax = maximum ? Math.min(65536, maximum) : 65536;
    const negotiated = remoteHeartbeat ? Math.min(heartbeat, remoteHeartbeat) : heartbeat;
    await this.send(method(0, 10, 31, number(1, 2), number(this.frameMax, 4), number(negotiated, 2)));
    this.#interval = negotiated * 500;
    await this.send(method(0, 10, 40, short(vhost), number(0, 1), number(0, 1)));
    const connection = await this.expect(0, 10, 41);
    if (connection.short() !== "") return invalid();
    connection.end();
    await this.send(method(1, 20, 10, number(0, 1)));
    const opened = await this.expect(1, 20, 11);
    if (opened.long().length) return invalid();
    opened.end();
  }
  async content(maximum: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; properties: Uint8Array<ArrayBuffer> }> {
    const next = await this.next();
    if (next.type !== 2 || next.channel !== 1) return invalid();
    const header = new Reader(next.body);
    if (header.uint(2) !== 60 || header.uint(2) !== 0) return invalid();
    const length = header.uint64();
    if (length > BigInt(maximum)) throw new RangeError("AMQP body exceeds materialization policy.");
    const inert = properties(header), bytes = new Uint8Array(Number(length));
    let at = 0;
    while (at < bytes.length) {
      const part = await this.next();
      if (part.type !== 3 || part.channel !== 1 || part.body.length > bytes.length - at) return invalid();
      bytes.set(part.body, at);
      at += part.body.length;
    }
    return { bytes, properties: inert };
  }
  async finish(): Promise<void> {
    await this.send(method(0, 10, 50, number(200, 2), number(0, 1), number(0, 2), number(0, 2)));
    (await this.expect(0, 10, 51)).end();
  }
}
/**
 * Pure policy capture. One operation at a time per client, no queue, reconnect,
 * background retry or retained idle connection. Each operation transfers and
 * retires one adapter channel, even after malformed data or cancellation.
 */
export class AmqpClient {
  #open: AmqpOptionsType["openChannel"];
  #auth: Uint8Array<ArrayBuffer>;
  #vhost: Uint8Array<ArrayBuffer>;
  #plaintext: boolean;
  #timeout: number;
  #cleanup: number;
  #maximum: number;
  #heartbeat: number;
  #signal: AbortSignal | undefined;
  #busy = false;
  constructor(options: AmqpOptionsType) {
    const open = options.openChannel, auth = options.auth, user = auth.user, password = auth.password;
    if (typeof open !== "function") throw new TypeError("AMQP requires an explicit transport factory.");
    this.#open = open;
    this.#auth = join(number(0, 1), text(user, 4096), number(0, 1), text(password, 4096));
    if (this.#auth.length > 2048) throw new RangeError("AMQP PLAIN response exceeds 2 KiB policy.");
    this.#vhost = text(options.vhost, 127, false);
    this.#plaintext = options.allowPlaintext === true;
    this.#timeout = bound(options.timeoutMs, 30000, 86400000);
    this.#cleanup = bound(options.cleanupMs, 5000, 60000);
    this.#maximum = bound(options.maxBytes, 1048576, 1048576);
    this.#heartbeat = bound(options.heartbeat, 60, 3600);
    this.#signal = options.signal;
  }
  async #request<T extends AmqpReceiptType | AmqpMessageType | null>(
    operation: "publish" | "take",
    signal: AbortSignal | undefined,
    run: (
      session: Session,
      dispatch: () => void,
      observeReturn: (value: NonNullable<AmqpReceiptType["returned"]>) => void,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.#busy) throw new TypeError("AMQP client already owns an active operation.");
    const signals = [AbortSignal.timeout(this.#timeout)];
    if (signal) signals.push(signal);
    if (this.#signal) signals.push(this.#signal);
    const combined = AbortSignal.any(signals);
    combined.throwIfAborted();
    this.#busy = true;
    let retire: (() => Promise<void>) | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
      dispatched = false,
      complete = false,
      receipt: T | undefined;
    let returned: AmqpReceiptType["returned"];
    const failures: unknown[] = [];
    try {
      const channel = await wait(this.#open({ signal: combined }), combined), closeMethod = channel.close;
      if (typeof closeMethod !== "function") throw new TypeError("AMQP channel requires close capability.");
      retire = closeMethod.bind(channel);
      combined.throwIfAborted();
      const security = channel.security;
      if (security !== "tls" && !(security === "plaintext" && this.#plaintext)) {
        throw new TypeError("AMQP transport security was not permitted.");
      }
      reader = channel.readable.getReader();
      writer = channel.writable.getWriter();
      combined.throwIfAborted();
      const session = new Session(reader, writer, combined);
      await session.initialize(this.#auth, this.#vhost, this.#heartbeat);
      receipt = await run(session, () => {
        dispatched = true;
      }, (value) => {
        returned = value;
      });
      complete = true;
      combined.throwIfAborted();
      await session.finish();
    } catch (reason) {
      failures.push(dispatched && !complete ? new AmqpOutcomeError(operation, reason, returned) : reason);
    }
    try {
      await close([
        async () => {
          if (retire) await wait(Promise.resolve().then(retire), AbortSignal.timeout(this.#cleanup));
        },
        () => reader?.releaseLock(),
        () => writer?.releaseLock(),
      ], failures);
    } catch (reason) {
      if (complete) throw new AmqpCompletionError(receipt!, reason);
      throw reason;
    } finally {
      this.#busy = false;
    }
    return receipt!;
  }
  /**
   * Publishes one materialized message with mandatory routing and confirms.
   * A nack can follow partial routing; an ack is scoped to native queue policy,
   * not end-to-end consumer delivery or guaranteed disk persistence.
   */
  publish(
    exchange: string,
    routingKey: string,
    bytes: Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AmqpReceiptType> {
    const selectedExchange = name(exchange, true), selectedRouting = text(routingKey, 255);
    if (!isBytes(bytes)) throw new TypeError("AMQP publication requires bytes.");
    const view = toView(bytes);
    if (view.length > this.#maximum) throw new RangeError("AMQP body exceeds materialization policy.");
    const body = new Uint8Array(view), signal = options.signal;
    return this.#request("publish", signal, async (session, dispatch, observeReturn) => {
      await session.send(method(1, 85, 10, number(0, 1)));
      (await session.expect(1, 85, 11)).end();
      await session.send(
        method(1, 60, 40, number(0, 2), short(selectedExchange), short(selectedRouting), number(1, 1)),
        dispatch,
      );
      await session.send(frame(2, 1, join(number(60, 2), number(0, 2), number(body.length, 8), number(0, 2))));
      for (let at = 0; at < body.length; at += session.frameMax - 8) {
        await session.send(frame(3, 1, body.slice(at, at + session.frameMax - 8)));
      }
      let returned: AmqpReceiptType["returned"];
      while (true) {
        const next = await session.next(), value = new Reader(next.body);
        if (next.type !== 1 || next.channel !== 1 || value.uint(2) !== 60) return invalid();
        const id = value.uint(2);
        if (id === 50) {
          if (returned) return invalid();
          const code = value.uint(2);
          value.short();
          const returnedExchange = value.short(), returnedRouting = value.short();
          value.end();
          if (returnedExchange !== exchange || returnedRouting !== routingKey) return invalid();
          const message = await session.content(this.#maximum);
          if (message.bytes.length !== body.length || message.bytes.some((byte, index) => byte !== body[index])) {
            return invalid();
          }
          returned = { code, exchange: returnedExchange, routingKey: returnedRouting, ...message };
          observeReturn(returned);
        } else if (id === 80 || id === 120) {
          const tag = value.uint64(), bits = value.uint(1);
          value.end();
          if (bits > (id === 80 ? 1 : 3) || tag !== 1n && !(tag === 0n && (bits & 1))) return invalid();
          return {
            confirmation: id === 80 ? "ack" : "nack",
            requeue: Boolean(bits & 2),
            ...(returned ? { returned } : {}),
          };
        } else return invalid();
      }
    });
  }
  /**
   * Explicit destructive read. Native auto-ack can remove a message before its
   * complete body arrives here; abort or partial transport failure must not be
   * retried as a harmless read. null is one observed empty queue response.
   */
  take(
    queue: string,
    options: { readonly autoAck: true; readonly signal?: AbortSignal },
  ): Promise<AmqpMessageType | null> {
    const selected = name(queue), autoAck = options.autoAck, signal = options.signal;
    if (autoAck !== true) throw new TypeError("AMQP take requires explicit autoAck:true permission.");
    return this.#request("take", signal, async (session, dispatch) => {
      await session.send(method(1, 60, 70, number(0, 2), short(selected), number(1, 1)), dispatch);
      const next = await session.next(), value = new Reader(next.body);
      if (next.type !== 1 || next.channel !== 1 || value.uint(2) !== 60) return invalid();
      const id = value.uint(2);
      if (id === 72) {
        value.short();
        value.end();
        return null;
      }
      if (id !== 71) return invalid();
      const tag = value.uint64(),
        redelivered = value.uint(1),
        exchange = value.short(),
        routingKey = value.short(),
        remaining = value.uint(4);
      value.end();
      if (tag === 0n || redelivered > 1) return invalid();
      const message = await session.content(this.#maximum);
      return {
        deliveryTag: tag.toString(),
        redelivered: Boolean(redelivered),
        exchange,
        routingKey,
        remaining,
        ...message,
      };
    });
  }
}
