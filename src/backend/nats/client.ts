/** Bounded native NATS request/reply for JetStream publication and sequence reads. @module */
import { raceAbort } from "../../abort.ts";
import { encodeText } from "../../bytes.ts";
import { resolveLimit } from "../../check.ts";
import { type JsonLimitsType, parseJson } from "../../json.ts";
import { z } from "zod";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";

/**
 * A fresh exclusive NATS channel, initially positioned at the server INFO.
 * Acquisition transfers ownership. The adapter owns TCP/TLS negotiation,
 * certificate and peer authentication, abort-aware acquisition and late cleanup.
 * A negotiated TLS adapter must preserve the initial INFO for this client.
 * close is idempotent and retires pending IO. No runtime socket is discovered.
 */
export interface NatsChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly security: "plaintext" | "tls";
  close(): Promise<void>;
}
/** Native CONNECT credentials, privately captured before asynchronous acquisition. No JWT/NKey signing is inferred. */
export type NatsAuthType =
  | { readonly token: string }
  | { readonly user: string; readonly password: string };
/** One operation owns one channel; there is no pooled subscription, reconnect or hidden retry. */
export interface NatsOptionsType {
  readonly openChannel: (options: { readonly signal: AbortSignal }) => Promise<NatsChannelType>;
  readonly auth?: NatsAuthType;
  readonly signal?: AbortSignal;
  /** Whole acquisition, authentication and request deadline; default 30 seconds, maximum one day. */
  readonly timeoutMs?: number;
  /** Adapter retirement wait; default five seconds, maximum one minute. */
  readonly cleanupMs?: number;
  /** Materialized message limit; default and maximum 1 MiB. Headers have a separate 64 KiB cap. */
  readonly maxBytes?: number;
}
/**
 * Supply an exact unique reply subject under an inbox namespace your account
 * may subscribe to. Never reuse an inbox for another in-flight request. Subject
 * secrecy is not authentication: account permissions and the transport own trust.
 */
export interface NatsRequestType {
  readonly inbox: string;
  readonly signal?: AbortSignal;
}
/** Native deduplication is limited by the stream's configured window, not eternal exactly-once publication. */
export interface NatsPublishType extends NatsRequestType {
  readonly messageId?: string;
}
/** An attributed JetStream publish acknowledgement; sequence is canonical uint64 decimal text. */
export interface NatsReceiptType {
  readonly stream: string;
  readonly sequence: string;
  readonly duplicate: boolean;
}
/** A selected stored message; headers and payload are private inert byte copies, not an immutable storage revision. */
export interface NatsMessageType {
  readonly stream: string;
  readonly sequence: string;
  readonly subject: string;
  /** Raw server timestamp declaration with RFC3339 shape; no calendar validation or Date conversion. */
  readonly time: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly headers: Uint8Array<ArrayBuffer>;
}
/** A complete native refusal; server descriptions and credential text are not echoed. */
export class NatsError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("NATS/JetStream refused the operation.");
    this.name = "NatsError";
    this.code = code;
  }
}
/** A dispatched publication has no admitted attributable terminal acknowledgement. Never blindly retry it. */
export class NatsPublicationError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("JetStream publication outcome is unknown; reconcile before a new publication.", { cause });
    this.name = "NatsPublicationError";
  }
}
/** A complete result was admitted before cancellation or independent cleanup failed. Preserve it for recovery. */
export class NatsCompletionError extends Error {
  readonly receipt: NatsReceiptType | NatsMessageType;
  constructor(receipt: NatsReceiptType | NatsMessageType, cause: unknown) {
    super("NATS/JetStream completed, but cancellation or channel cleanup failed.", { cause });
    this.name = "NatsCompletionError";
    this.receipt = receipt;
  }
}
function fail(): never {
  throw new TypeError("Malformed or unsupported NATS/JetStream response.");
}
/** Grammar is admitted before encoding so large or structural strings cannot cause unbounded temporary allocation. */
function subject(value: string, stream = false): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 1024 ||
    !/^[!-~]+$/.test(value) || /[*>\\]/.test(value) || value.split(".").some((part) => !part) ||
    (stream && /[.\/]/.test(value))
  ) throw new TypeError("Invalid selected NATS subject or stream name.");
  return value;
}
function secret(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[ -~]*$/.test(value)) {
    throw new TypeError("Invalid selected NATS credential or message ID.");
  }
  return value;
}
function sequence(value: string): string {
  if (
    typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  ) throw new TypeError("Invalid JetStream uint64 sequence.");
  return value;
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail();
  }
}
function copy(bytes: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (!isBytes(bytes)) throw new TypeError("NATS payload must be a byte view.");
  const view = toView(bytes);
  if (view.length > maximum) throw new RangeError("NATS bytes exceed policy.");
  return new Uint8Array(view);
}
/** Canonical padded RFC4648 base64 prevents permissive decoding from silently changing native byte authority. */
function base64(value: string | undefined, maximum: number): Uint8Array<ArrayBuffer> {
  if (value === undefined) return new Uint8Array();
  if (
    value.length > 4 * Math.ceil(maximum / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return fail();
  const bytes = new Uint8Array(decodeBase64(value));
  if (bytes.length > maximum || encodeBase64(bytes) !== value) return fail();
  return bytes;
}

/** Limits for this service's JSON responses; see `parseJson`. */
const jsonLimits: JsonLimitsType = {
  label: "NATS",
  maxLength: 2 * 1024 * 1024,
  maxTokens: 10_000,
  maxString: 2_097_152,
  maxScalar: 21,
  number: (raw) => /^-?(0|[1-9][0-9]{0,19})$/.test(raw) && raw !== "-0" ? BigInt(raw) : undefined,
};

// External envelopes intentionally admit unknown fields for forward compatibility;
// selected authority fields remain schema-checked and contradictory errors refused.
const InfoSchema = z.object({
  max_payload: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)),
  headers: z.literal(true),
  tls_required: z.boolean().optional(),
});
const RefusalSchema = z.object({
  error: z.object({
    code: z.bigint().positive().max(999999n),
    err_code: z.bigint().nonnegative().max(9999999999n).optional(),
  }),
});
const SequenceSchema = z.bigint().positive().max(18446744073709551615n);
const ReceiptSchema = z.object({
  stream: z.string().min(1).max(1024),
  seq: SequenceSchema,
  duplicate: z.boolean().optional(),
});
const MessageSchema = z.object({
  type: z.literal("io.nats.jetstream.api.v1.stream_msg_get_response"),
  message: z.object({
    subject: z.string().min(1).max(1024),
    seq: SequenceSchema,
    time: z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/),
    data: z.string().optional(),
    hdrs: z.string().optional(),
  }),
});
/** One request's parser owns copied chunks and bounded frame/line allocations until its channel retires. */
class Session {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #signal: AbortSignal;
  #pending = new Uint8Array(0);
  #at = 0;
  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    signal: AbortSignal,
  ) {
    this.#reader = reader;
    this.#writer = writer;
    this.#signal = signal;
  }
  async take(size: number): Promise<Uint8Array<ArrayBuffer>> {
    this.#signal.throwIfAborted();
    const result = new Uint8Array(size);
    let at = 0, empty = 0;
    while (at < size) {
      this.#signal.throwIfAborted();
      if (this.#at === this.#pending.length) {
        const next = await raceAbort(this.#reader.read(), this.#signal);
        this.#signal.throwIfAborted();
        const done = next.done;
        this.#signal.throwIfAborted();
        if (done) return fail();
        const supplied = next.value;
        this.#signal.throwIfAborted();
        if (!isBytes(supplied)) return fail();
        const bytes = toView(supplied);
        if (bytes.length > 65536) throw new RangeError("NATS transport chunk exceeds 64 KiB policy.");
        if (!bytes.length) {
          if (++empty > 16) return fail();
          continue;
        }
        empty = 0;
        this.#pending = new Uint8Array(bytes);
        this.#at = 0;
      }
      const count = Math.min(size - at, this.#pending.length - this.#at);
      result.set(this.#pending.subarray(this.#at, this.#at + count), at);
      at += count;
      this.#at += count;
    }
    this.#signal.throwIfAborted();
    return result;
  }
  async line(): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      const byte = (await this.take(1))[0]!;
      if (byte === 13) {
        if ((await this.take(1))[0] !== 10) return fail();
        return decode(new Uint8Array(bytes));
      }
      if (byte === 10 || bytes.length >= 8192 || byte < 32 || byte === 127) return fail();
      bytes.push(byte);
    }
  }
  async send(bytes: Uint8Array, dispatch?: () => void): Promise<void> {
    this.#signal.throwIfAborted();
    dispatch?.();
    await raceAbort(this.#writer.write(bytes), this.#signal);
    this.#signal.throwIfAborted();
  }
  /** Only bounded unsolicited controls are serviced; discovery URLs are inert data. */
  async control(line: string): Promise<boolean> {
    if (line === "PING") {
      await this.send(encodeText("PONG\r\n"));
      return true;
    }
    if (line.startsWith("INFO ")) {
      InfoSchema.parse(parseJson(line.slice(5), jsonLimits));
      return true;
    }
    if (line.startsWith("-ERR '") && line.endsWith("'")) throw new NatsError("protocol-refusal");
    return false;
  }
  async initialize(connect: Uint8Array, security: NatsChannelType["security"]): Promise<number> {
    const first = await this.line();
    if (!first.startsWith("INFO ")) return fail();
    const info = InfoSchema.parse(parseJson(first.slice(5), jsonLimits)), maximum = Number(info.max_payload);
    if (!Number.isSafeInteger(maximum) || maximum < 1) return fail();
    if (info.tls_required && security !== "tls") throw new NatsError("tls-required");
    await this.send(connect);
    for (let count = 0; count < 32; count++) {
      const line = await this.line();
      if (line === "PONG") return maximum;
      if (!await this.control(line)) return fail();
    }
    throw new RangeError("NATS initialization control budget exceeded.");
  }
  /** SIDs and inboxes are request authority. Lengths are admitted before allocating an entire frame. */
  async response(inbox: string): Promise<Uint8Array<ArrayBuffer>> {
    for (let count = 0; count < 128; count++) {
      const line = await this.line();
      if (await this.control(line)) continue;
      const parts = line.split(" "), header = parts[0] === "HMSG";
      if (
        !(header || parts[0] === "MSG") || parts[1] !== inbox || parts[2] !== "1" ||
        (parts.length !== (header ? 5 : 4) && parts.length !== (header ? 6 : 5))
      ) return fail();
      const length = parts.at(-1)!;
      if (!/^(?:0|[1-9][0-9]{0,6})$/.test(length)) return fail();
      const size = Number(length);
      if (size > 2 * 1024 * 1024) throw new RangeError("NATS response frame exceeds 2 MiB policy.");
      let headerSize = 0;
      if (header) {
        const raw = parts.at(-2)!;
        if (!/^[1-9][0-9]{0,4}$/.test(raw)) return fail();
        headerSize = Number(raw);
        if (headerSize > 65536 || headerSize > size) return fail();
      }
      const frame = await this.take(size);
      if ((await this.take(2)).some((byte, index) => byte !== (index ? 10 : 13))) return fail();
      if (header) {
        const raw = decode(frame.subarray(0, headerSize));
        if (raw.length > 65536 || !raw.endsWith("\r\n\r\n") || raw.split("\r\n").length > 130) return fail();
        const lines = raw.slice(0, -4).split("\r\n"), first = lines.shift()!;
        if (!/^[\t -~]*$/.test(raw.replaceAll("\r\n", ""))) return fail();
        const status = /^NATS\/1\.0(?: ([1-5][0-9]{2})(?: [ -~]*)?)?$/.exec(first);
        if (!status || lines.some((value) => !/^[!-9;-~]+:[\t -~]*$/.test(value))) return fail();
        if (status[1] !== undefined) {
          if (status[1] === "503" && size === headerSize) throw new NatsError("503");
          return fail();
        }
      }
      return frame.slice(headerSize);
    }
    throw new RangeError("NATS response control budget exceeded.");
  }
}
/** Pure policy and credential capture. Each method acquires and closes its own exclusive channel. */
export class NatsClient {
  readonly #acquire: NatsOptionsType["openChannel"];
  readonly #connect: (security: NatsChannelType["security"]) => Uint8Array<ArrayBuffer>;
  readonly #signal: AbortSignal | undefined;
  readonly #timeout: number;
  readonly #cleanup: number;
  readonly #maximum: number;
  constructor(options: NatsOptionsType) {
    const acquire = options.openChannel;
    if (typeof acquire !== "function") throw new TypeError("NATS requires an explicit channel capability.");
    this.#acquire = acquire.bind(options);
    const auth = options.auth;
    let credentials: { auth_token: string } | { user: string; pass: string } | undefined;
    if (auth !== undefined) {
      if ("token" in auth) credentials = { auth_token: secret(auth.token) };
      else {
        const user = secret(auth.user), password = secret(auth.password);
        credentials = { user, pass: password };
      }
    }
    const identity = {
      verbose: false,
      pedantic: true,
      protocol: 1,
      headers: true,
      no_responders: true,
      lang: "typescript",
      version: "opfs-nats/1",
      ...credentials,
    };
    this.#connect = (security) =>
      encodeText(`CONNECT ${JSON.stringify({ ...identity, tls_required: security === "tls" })}\r\nPING\r\n`);
    this.#signal = options.signal;
    this.#timeout = resolveLimit(options.timeoutMs, 30000, 86400000, "NATS policy limit", 1);
    this.#cleanup = resolveLimit(options.cleanupMs, 5000, 60000, "NATS policy limit", 1);
    this.#maximum = resolveLimit(options.maxBytes, 1048576, 1048576, "NATS policy limit", 1);
  }
  /** Failure and cleanup keep separate evidence; an admitted receipt is never relabeled as an unknown publication. */
  async #request<T extends NatsReceiptType | NatsMessageType>(
    inbox: string,
    target: string,
    body: Uint8Array,
    headers: Uint8Array | undefined,
    signal: AbortSignal | undefined,
    publish: boolean,
    admit: (value: unknown) => T,
  ): Promise<T> {
    if (inbox === target) throw new TypeError("NATS reply inbox must differ from the request subject.");
    const signals = [AbortSignal.timeout(this.#timeout)];
    if (signal) signals.push(signal);
    if (this.#signal) signals.push(this.#signal);
    const combined = AbortSignal.any(signals);
    combined.throwIfAborted();
    let retire: (() => Promise<void>) | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined,
      dispatched = false,
      refused = false,
      receipt: T | undefined;
    const failures: unknown[] = [];
    try {
      const channel = await raceAbort(this.#acquire({ signal: combined }), combined), closeMethod = channel.close;
      if (typeof closeMethod !== "function") throw new TypeError("NATS channel requires a close capability.");
      retire = closeMethod.bind(channel);
      combined.throwIfAborted();
      const security = channel.security;
      if (security !== "plaintext" && security !== "tls") {
        throw new TypeError("NATS transport security must be explicit.");
      }
      reader = channel.readable.getReader();
      writer = channel.writable.getWriter();
      combined.throwIfAborted();
      const session = new Session(reader, writer, combined),
        maximum = await session.initialize(this.#connect(security), security);
      const payloadSize = body.length + (headers?.length ?? 0);
      if (payloadSize > maximum) throw new RangeError("NATS request exceeds advertised max_payload.");
      const prefix = encodeText(
        headers
          ? `HPUB ${target} ${inbox} ${headers.length} ${payloadSize}\r\n`
          : `PUB ${target} ${inbox} ${payloadSize}\r\n`,
      );
      const packet = new Uint8Array(prefix.length + payloadSize + 2);
      packet.set(prefix);
      if (headers) packet.set(headers, prefix.length);
      packet.set(body, prefix.length + (headers?.length ?? 0));
      packet.set([13, 10], packet.length - 2);
      await session.send(encodeText(`SUB ${inbox} 1\r\nUNSUB 1 1\r\n`));
      await session.send(packet, () => {
        dispatched = true;
      });
      const value = parseJson(decode(await session.response(inbox)), jsonLimits),
        refusal = RefusalSchema.safeParse(value);
      if (refusal.success) {
        const object = value as Record<string, unknown>;
        // Native publish refusals may include stream and seq:0. A positive
        // acknowledgement or stored message alongside an error is contradictory.
        if (
          Object.hasOwn(object, "message") || object.seq !== undefined && object.seq !== 0n ||
          object.duplicate !== undefined && object.duplicate !== false
        ) return fail();
        refused = true;
        throw new NatsError(String(refusal.data.error.err_code ?? refusal.data.error.code));
      }
      if (typeof value === "object" && value !== null && Object.hasOwn(value, "error")) return fail();
      receipt = admit(value);
      combined.throwIfAborted();
    } catch (reason) {
      // A protocol -ERR can describe the earlier SUB while a later PUB still
      // stores data. Only an attributed no-responders or API reply is refusal.
      if (reason instanceof NatsError && reason.code === "503") refused = true;
      failures.push(
        publish && dispatched && !refused && receipt === undefined ? new NatsPublicationError(reason) : reason,
      );
    }
    try {
      await close([
        async () => {
          if (retire) await raceAbort(Promise.resolve().then(retire), AbortSignal.timeout(this.#cleanup));
        },
        () => reader?.releaseLock(),
        () => writer?.releaseLock(),
      ], failures);
    } catch (reason) {
      if (receipt !== undefined) throw new NatsCompletionError(receipt, reason);
      throw reason;
    }
    return receipt!;
  }
  /** Reads one native sequence; retention, deletion or stream recreation can change its availability. No consumer is advanced. */
  get(stream: string, sequenceValue: string, options: NatsRequestType): Promise<NatsMessageType> {
    const selected = subject(stream, true),
      seq = sequence(sequenceValue),
      inbox = subject(options.inbox),
      signal = options.signal;
    return this.#request(
      inbox,
      `$JS.API.STREAM.MSG.GET.${selected}`,
      encodeText(`{"seq":${seq}}`),
      undefined,
      signal,
      false,
      (value) => {
        const result = MessageSchema.parse(value).message;
        if (result.seq.toString() !== seq) return fail();
        return {
          stream: selected,
          sequence: seq,
          subject: subject(result.subject),
          time: result.time,
          bytes: base64(result.data, this.#maximum),
          headers: base64(result.hdrs, 65536),
        };
      },
    );
  }
  /** Publishes with native expected-stream admission. The server still owns retention, dedup window and durability policy. */
  publish(stream: string, target: string, bytes: Uint8Array, options: NatsPublishType): Promise<NatsReceiptType> {
    const selected = subject(stream, true), destination = subject(target), body = copy(bytes, this.#maximum);
    const inbox = subject(options.inbox), suppliedId = options.messageId, signal = options.signal;
    const id = suppliedId === undefined ? undefined : secret(suppliedId);
    if (id !== undefined && !id.length) throw new TypeError("NATS message ID must not be empty.");
    const headers = encodeText(
      `NATS/1.0\r\nNats-Expected-Stream: ${selected}\r\n${id === undefined ? "" : `Nats-Msg-Id: ${id}\r\n`}\r\n`,
    );
    return this.#request(inbox, destination, body, headers, signal, true, (value) => {
      const result = ReceiptSchema.parse(value);
      if (result.stream !== selected) return fail();
      return { stream: selected, sequence: result.seq.toString(), duplicate: result.duplicate ?? false };
    });
  }
}
