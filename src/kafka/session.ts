/** Exclusive portable Kafka channel ownership and classic request framing. No socket or credentials are discovered. */
import { isBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { frame, Reader, Writer } from "./wire.ts";

/**
 * A fresh exclusive channel already positioned at an authenticated Kafka request boundary.
 *
 * The opener owns TLS peer verification, any SASL handshake, abort-aware acquisition and retirement of partial or late
 * acquisitions when cancellation wins. Successful transfer grants this operation both streams and close capability.
 * close must be idempotent and retire pending reads/writes. No advertised endpoint grants authority to connect.
 */
export interface KafkaChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly security: "tls" | "plaintext";
  close(): Promise<void>;
}
/** One action owns one channel. Separate invocations share no session, discovery state or correlation counter. */
export interface KafkaSessionOptionsType {
  readonly openChannel: (options: { readonly signal: AbortSignal }) => Promise<KafkaChannelType>;
  readonly signal?: AbortSignal;
  /** Acquisition and complete action deadline, default 30 seconds; maximum one day. */
  readonly timeoutMs?: number;
  /** Independent channel retirement wait, default five seconds; maximum one minute. */
  readonly cleanupMs?: number;
  /** Explicit permission for an already authenticated plaintext fixture or trusted transport; default false. */
  readonly allowPlaintext?: boolean;
}
const FRAME_LIMIT = 4194304, IO_LIMIT = 8388608, CHUNK_LIMIT = 65536;
/** Keep implementation admission policy separate from provider protocol limits. */
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError("Invalid Kafka session deadline.");
  }
  return result;
}
/** Observe late promise settlement; the opener or transferred channel still owns actual foreign IO retirement. */
function wait<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) {
      pending.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
}
/**
 * A wrapper-owned sequence of at most five classic requests on one exclusive channel.
 *
 * exchange snapshots its body before yielding, serializes one request/response at a time and returns owned response
 * body bytes after correlation. No broker result interpretation or append-outcome wrapping happens at this layer.
 * The 4 MiB frame, 8 MiB whole-call IO and 64 KiB transport chunk ceilings are implementation safety limits.
 */
export class KafkaSession {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #signal: AbortSignal;
  #pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  #at = 0;
  #io = 0;
  #requests = 0;
  #empty = 0;
  #busy = false;
  #live = true;
  #poisoned = false;
  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    signal: AbortSignal,
  ) {
    this.#reader = reader;
    this.#writer = writer;
    this.#signal = signal;
  }
  /** Count complete borrowed chunks, not only selected bytes, so trailing unsolicited data cannot evade the IO cap. */
  #count(bytes: number): void {
    if (bytes > IO_LIMIT - this.#io) throw new RangeError("Kafka session exceeds whole-call IO policy.");
    this.#io += bytes;
  }
  /** Copy admitted transport storage before retaining it; read boundaries have no protocol meaning. */
  async #take(size: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isSafeInteger(size) || size < 0 || size > FRAME_LIMIT) {
      throw new RangeError("Kafka response exceeds frame allocation policy.");
    }
    const result = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      this.#signal.throwIfAborted();
      if (this.#at === this.#pending.length) {
        const next = await wait(this.#reader.read(), this.#signal);
        this.#signal.throwIfAborted();
        const done = next.done;
        this.#signal.throwIfAborted();
        if (done) throw new TypeError("Kafka response ended before its declared extent.");
        const supplied = next.value;
        this.#signal.throwIfAborted();
        if (!isBytes(supplied)) throw new TypeError("Kafka transport requires byte chunks.");
        const bytes = toView(supplied);
        this.#signal.throwIfAborted();
        if (bytes.length > CHUNK_LIMIT) throw new RangeError("Kafka transport chunk exceeds 64 KiB policy.");
        this.#count(bytes.length);
        if (!bytes.length) {
          if (++this.#empty > 16) throw new TypeError("Kafka transport made no byte progress.");
          continue;
        }
        this.#empty = 0;
        this.#pending = new Uint8Array(bytes);
        this.#at = 0;
      }
      const amount = Math.min(size - at, this.#pending.length - this.#at);
      result.set(this.#pending.subarray(this.#at, this.#at + amount), at);
      this.#at += amount;
      at += amount;
    }
    this.#signal.throwIfAborted();
    return result;
  }
  /**
   * Send a classic request and admit one matching classic response, with no retry or result-code interpretation.
   *
   * dispatch runs immediately before calling writer.write, including when the foreign writer throws synchronously.
   * The client uses that observation to distinguish an undispatched error from an unknown append outcome.
   */
  async exchange(
    key: number,
    version: number,
    body: Uint8Array,
    dispatch?: () => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    this.#signal.throwIfAborted();
    if (!this.#live || this.#poisoned || this.#busy || this.#requests >= 5) {
      throw new TypeError("Kafka session is retired, failed, busy or over its request budget.");
    }
    if (
      !Number.isInteger(key) || key < 0 || key > 32767 || !Number.isInteger(version) || version < 0 || version > 32767
    ) {
      throw new RangeError("Invalid Kafka classic API key/version.");
    }
    if (!isBytes(body)) throw new TypeError("Kafka request body requires bytes.");
    const view = toView(body);
    if (view.length > FRAME_LIMIT - 14) throw new RangeError("Kafka request exceeds frame policy.");
    this.#busy = true;
    try {
      const correlation = ++this.#requests;
      const request = frame(new Writer().short(key).short(version).int(correlation).text("opfs").raw(view).finish());
      this.#count(request.length);
      this.#signal.throwIfAborted();
      if (this.#at !== this.#pending.length) throw new TypeError("Kafka channel contains an unsolicited response.");
      dispatch?.();
      this.#signal.throwIfAborted();
      await wait(this.#writer.write(request), this.#signal);
      this.#signal.throwIfAborted();
      const prefix = new Reader(await this.#take(4)), size = prefix.int();
      prefix.done();
      if (size < 4 || size > FRAME_LIMIT || size > IO_LIMIT - this.#io + (this.#pending.length - this.#at)) {
        throw new RangeError("Kafka response exceeds frame or remaining IO policy.");
      }
      const response = new Reader(await this.#take(size));
      if (response.int() !== correlation) throw new TypeError("Kafka response correlation differs.");
      if (this.#at !== this.#pending.length) throw new TypeError("Kafka channel contains an unsolicited response.");
      const bytes = response.copy(response.remaining);
      response.done();
      this.#signal.throwIfAborted();
      return bytes;
    } catch (reason) {
      this.#poisoned = true;
      throw reason;
    } finally {
      this.#busy = false;
    }
  }
  /** Wrapper-only retirement closes further admission even if an action retained this object or abandoned an exchange. */
  retire(): boolean {
    const pending = this.#busy;
    this.#live = false;
    this.#pending = new Uint8Array();
    this.#at = 0;
    return pending;
  }
}
/**
 * Acquire one channel, run an awaited action and settle independent retirement before publishing its result.
 *
 * The action must await every exchange. The opener owns connections that resolve after acquisition cancellation;
 * after transfer this wrapper binds close before reading any other channel property. A complete client receipt should
 * be retained by the action's caller before it returns, so later cancellation/cleanup can preserve known outcomes.
 */
export async function withKafkaSession<T>(
  options: KafkaSessionOptionsType,
  action: (session: KafkaSession) => Promise<T>,
): Promise<T> {
  const timeout = limit(options.timeoutMs, 30000, 86400000), cleanup = limit(options.cleanupMs, 5000, 60000);
  const opener = options.openChannel, parent = options.signal, plaintext = options.allowPlaintext ?? false;
  if (typeof opener !== "function" || typeof action !== "function" || typeof plaintext !== "boolean") {
    throw new TypeError("Invalid Kafka session capabilities or policy.");
  }
  const lifetime = new AbortController(), signals = [AbortSignal.timeout(timeout), lifetime.signal];
  if (parent) signals.push(parent);
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  let retire: (() => Promise<void>) | undefined, session: KafkaSession | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let result: T | undefined, complete = false;
  const failures: unknown[] = [];
  try {
    const channel = await wait(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return opener({ signal });
        }),
        signal,
      ),
      closeMethod = channel.close;
    if (typeof closeMethod !== "function") throw new TypeError("Kafka channel requires a close capability.");
    retire = closeMethod.bind(channel);
    signal.throwIfAborted();
    const security = channel.security;
    signal.throwIfAborted();
    if (security !== "tls" && !(security === "plaintext" && plaintext)) {
      throw new TypeError("Kafka transport security was not permitted.");
    }
    const readable = channel.readable;
    signal.throwIfAborted();
    reader = readable.getReader();
    signal.throwIfAborted();
    const writable = channel.writable;
    signal.throwIfAborted();
    writer = writable.getWriter();
    signal.throwIfAborted();
    session = new KafkaSession(reader, writer, signal);
    result = await wait(
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return action(session!);
      }),
      signal,
    );
    complete = true;
    signal.throwIfAborted();
  } catch (reason) {
    failures.push(reason);
  }
  if (session?.retire() && complete) {
    failures.push(new TypeError("Kafka action returned before its exchange settled."));
  }
  lifetime.abort(new Error("Kafka session action ended."));
  await close([
    async () => {
      if (retire) await wait(Promise.resolve().then(retire), AbortSignal.timeout(cleanup));
    },
    () => reader?.releaseLock(),
    () => writer?.releaseLock(),
  ], failures);
  return result as T;
}
