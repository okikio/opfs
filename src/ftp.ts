/** FTP and explicit FTPS over caller-owned TCP/TLS capabilities. @module */
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";

/** An acquired connection. close must retire pending reads/writes and be idempotent. */
export interface FtpSocketType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Concrete connected network address, not a hostname to resolve again. */
  readonly peerAddress: string;
  close(): Promise<void>;
}

/** A verified TLS connection and adapter-private resumption/binding context. */
export interface FtpSecureSocketType {
  readonly socket: FtpSocketType;
  readonly context: unknown;
}

/**
 * Explicit runtime capability. No runtime modules or credentials are discovered.
 * connect and secure must honor abort, including disposing late connections or
 * protected sockets produced after cancellation. secure owns certificate/hostname
 * validation and data-channel binding to controlSecurity.
 * Successful secure transfers socket ownership; failure leaves it with caller.
 */
export interface FtpTransportType {
  connect(
    options: { readonly host: string; readonly port: number; readonly signal: AbortSignal },
  ): Promise<FtpSocketType>;
  secure?(
    socket: FtpSocketType,
    options: {
      readonly serverName: string;
      readonly role: "control" | "data";
      readonly controlSecurity?: unknown;
      readonly signal: AbortSignal;
    },
  ): Promise<FtpSecureSocketType>;
}

/** Safety policy is local, not a promise made by the FTP server. */
export interface FtpOptionsType {
  readonly host: string;
  readonly port?: number;
  readonly mode: "plain" | "explicit-tls";
  readonly username: string;
  readonly password: string;
  readonly transport: FtpTransportType;
  /** Entire operation, including idle download consumers. Default 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum wait for each owned socket close. Default 5 seconds. */
  readonly cleanupMs?: number;
  readonly maxReplyBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxChunkBytes?: number;
  readonly maxUploadBytes?: number;
  readonly maxListBytes?: number;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
}

/** Standard MLSx facts; names are literal server names, never virtual paths. */
export interface FtpEntryType {
  readonly name: string;
  readonly type: string;
  readonly size?: number;
  readonly modify?: string;
  readonly unique?: string;
  readonly facts: Readonly<Record<string, string>>;
}

/** A server completion receipt, without content identity or durability claims. */
export interface FtpReceiptType {
  readonly bytes: number;
  readonly code: 226 | 250;
}

/** A suffix download; early cancellation retires its entire control session. */
export interface FtpReadType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly done: Promise<FtpReceiptType>;
  cancel(reason?: unknown): Promise<void>;
}

/** Protocol refusal or malformed response. Replies intentionally omit credentials. */
export class FtpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "FtpError";
    this.code = code;
  }
}

/** STOR was dispatched but its completion could not be established. Do not retry blindly. */
export class FtpPublicationError extends Error {
  constructor(options?: ErrorOptions) {
    super("FTP upload publication is unknown; inspect remote state before deciding how to recover.", options);
    this.name = "FtpPublicationError";
  }
}

/** Captured operation lifetime. The whole transfer includes time waiting on its consumer. */
interface LifetimeType {
  readonly signal: AbortSignal;
  readonly abort: AbortController;
  finish(): void;
}
interface ReplyType {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Races borrowed asynchronous work without leaving its later rejection unobserved. */
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

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError("Invalid FTP safety limit.");
  }
  return result;
}

/** Only encoding rules authorize command bytes; path spaces are not trimmed. */
function argument(value: string, utf8: boolean): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("FTP arguments must be nonempty strings.");
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point < 32 || point === 127 || point >= 0xd800 && point <= 0xdfff || !utf8 && point > 126) {
      throw new TypeError("FTP argument contains unsupported command bytes.");
    }
  }
  if (new TextEncoder().encode(value).length > 8192) throw new RangeError("FTP command argument is too long.");
  return value;
}

/** One reader owns control bytes. No read-ahead survives a TLS upgrade. */
class Control {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = new Uint8Array(0);
  readonly #lineLimit: number;
  readonly #replyLimit: number;
  readonly #chunkLimit: number;
  constructor(socket: FtpSocketType, line: number, reply: number, chunk: number) {
    this.#reader = socket.readable.getReader();
    this.#lineLimit = line;
    this.#replyLimit = reply;
    this.#chunkLimit = chunk;
  }
  /** AUTH's plaintext reader must not consume any bytes from the new TLS layer. */
  upgrade(): void {
    if (this.#buffer.length !== 0) throw new FtpError("Unexpected buffered plaintext at TLS upgrade.");
    this.#reader.releaseLock();
  }
  release(): void {
    this.#reader.releaseLock();
  }
  async #line(signal: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      const end = this.#buffer.indexOf(10);
      if (end !== -1) {
        if (end === 0 || this.#buffer[end - 1] !== 13) throw new FtpError("FTP reply requires CRLF.");
        const line = this.#buffer.slice(0, end - 1);
        this.#buffer = this.#buffer.slice(end + 1);
        if (
          line.length > this.#lineLimit || line.some((byte) => byte < 32 && byte !== 9 || byte === 127 || byte === 255)
        ) {
          throw new FtpError("Invalid FTP reply line.");
        }
        return line;
      }
      if (this.#buffer.length > this.#lineLimit + 1) throw new FtpError("FTP reply line exceeds budget.");
      const result = await wait(this.#reader.read(), signal);
      if (result.done) throw new FtpError("FTP control connection ended before its reply.");
      if (!isBytes(result.value)) throw new TypeError("FTP transport returned a non-byte chunk.");
      const bytes = toView(result.value);
      if (bytes.length > this.#chunkLimit) throw new FtpError("FTP control chunk exceeds budget.");
      const next = new Uint8Array(this.#buffer.length + bytes.length);
      next.set(this.#buffer);
      next.set(bytes, this.#buffer.length);
      this.#buffer = next;
    }
  }
  async read(signal: AbortSignal): Promise<ReplyType> {
    const decode = new TextDecoder("utf-8", { fatal: true });
    const first = await this.#line(signal);
    const text = decode.decode(first);
    if (!/^[1-5][0-9]{2}[ -]/.test(text)) throw new FtpError("Malformed FTP reply.");
    const code = Number(text.slice(0, 3));
    const lines = [text];
    let size = first.length + 2;
    if (size > this.#replyLimit) throw new FtpError("FTP reply exceeds budget.");
    if (text[3] === "-") {
      for (;;) {
        const bytes = await this.#line(signal);
        size += bytes.length + 2;
        if (size > this.#replyLimit) throw new FtpError("FTP reply exceeds budget.");
        const line = decode.decode(bytes);
        lines.push(line);
        if (line.startsWith(`${code} `)) break;
      }
    }
    return { code, lines };
  }
}

/** Parses MLSx without trimming away meaningful spaces in the pathname. */
function entry(line: string): FtpEntryType {
  const space = line.indexOf(" ");
  if (space < 1 || space === line.length - 1) throw new FtpError("Malformed MLSx record.");
  const facts: Record<string, string> = Object.create(null);
  const prefix = line.slice(0, space);
  if (!prefix.endsWith(";")) throw new FtpError("Malformed MLSx facts.");
  for (const fact of prefix.slice(0, -1).split(";")) {
    const equal = fact.indexOf("=");
    const key = fact.slice(0, equal).toLowerCase();
    const value = fact.slice(equal + 1);
    if (equal < 1 || !/^[a-z0-9.]+$/.test(key) || !/^[\x21-\x3a\x3c-\x7e]*$/.test(value) || Object.hasOwn(facts, key)) {
      throw new FtpError("Malformed or repeated MLSx fact.");
    }
    facts[key] = value;
  }
  if (!facts.type) throw new FtpError("MLSx record omits its type.");
  const size = facts.size === undefined ? undefined : Number(facts.size);
  if (facts.size !== undefined && (!/^[0-9]+$/.test(facts.size) || !Number.isSafeInteger(size) || size! < 0)) {
    throw new FtpError("Invalid MLSx size.");
  }
  const name = line.slice(space + 1);
  argument(name, true);
  return {
    name,
    type: facts.type.toLowerCase(),
    ...(size === undefined ? {} : { size }),
    ...(facts.modify === undefined ? {} : { modify: facts.modify }),
    ...(facts.unique === undefined ? {} : { unique: facts.unique }),
    facts: Object.freeze(facts),
  };
}

/**
 * Exclusive native session. Never equates FTP metadata with immutable content.
 * Use openFtpClient; a failed operation retires the connection to avoid reply
 * desynchronization. Successful operations may reuse it sequentially.
 */
export class FtpClient implements AsyncDisposable {
  readonly #options: FtpOptionsType;
  readonly #timeout: number;
  readonly #cleanup: number;
  readonly #line: number;
  readonly #reply: number;
  readonly #chunk: number;
  readonly #upload: number;
  readonly #list: number;
  readonly #entries: number;
  #socket: FtpSocketType | undefined;
  #data: FtpSocketType | undefined;
  #control: Control | undefined;
  #security: unknown;
  #utf8 = false;
  #mlst = false;
  #restart = false;
  #busy = false;
  #closed = false;
  #active: LifetimeType | undefined;
  #closing: Promise<void> | undefined;

  /** Construction validates policy only; openFtpClient performs the login. */
  constructor(options: FtpOptionsType) {
    argument(options.host, false);
    argument(options.username, false);
    argument(options.password, false);
    if (options.mode !== "plain" && options.mode !== "explicit-tls") throw new TypeError("Choose explicit FTP mode.");
    if (options.mode === "explicit-tls" && !options.transport.secure) {
      throw new TypeError("FTPS requires a TLS capability.");
    }
    this.#timeout = limit(options.timeoutMs, 30_000, 86_400_000);
    this.#cleanup = limit(options.cleanupMs, 5000, 60_000);
    this.#line = limit(options.maxLineBytes, 8192, 1_048_576);
    this.#reply = limit(options.maxReplyBytes, 65_536, 8_388_608);
    this.#chunk = limit(options.maxChunkBytes, 65_536, 8_388_608);
    this.#upload = limit(options.maxUploadBytes, 8_388_608, 1_073_741_824);
    this.#list = limit(options.maxListBytes, 8_388_608, 67_108_864);
    this.#entries = limit(options.maxEntries, 100_000, 1_000_000);
    const port = limit(options.port, 21, 65_535);
    this.#options = {
      ...options,
      port,
      transport: Object.freeze({
        connect: options.transport.connect.bind(options.transport),
        ...(options.transport.secure ? { secure: options.transport.secure.bind(options.transport) } : {}),
      }),
    };
  }

  #start(signal?: AbortSignal, opening = false): LifetimeType {
    if (this.#closed) throw new FtpError("FTP session is closed.");
    if (this.#busy) throw new FtpError("FTP session is busy; finish or cancel the active transfer first.");
    if (!opening && !this.#socket) throw new FtpError("FTP session has not been opened.");
    const abort = new AbortController();
    const sources = [abort.signal, AbortSignal.timeout(this.#timeout)];
    if (signal) sources.push(signal);
    if (this.#options.signal) sources.push(this.#options.signal);
    const joined = AbortSignal.any(sources);
    joined.throwIfAborted();
    this.#busy = true;
    const lifetime: LifetimeType = {
      signal: joined,
      abort,
      finish: () => {
        this.#busy = false;
        this.#active = undefined;
      },
    };
    this.#active = lifetime;
    return lifetime;
  }
  async #command(command: string, codes: readonly number[], signal: AbortSignal): Promise<ReplyType> {
    signal.throwIfAborted();
    const writer = this.#socket!.writable.getWriter();
    try {
      await wait(writer.write(new TextEncoder().encode(`${command}\r\n`)), signal);
    } finally {
      writer.releaseLock();
    }
    const reply = await this.#control!.read(signal);
    if (!codes.includes(reply.code)) {
      throw new FtpError("FTP command was refused or returned an unexpected reply.", reply.code);
    }
    return reply;
  }
  /** Initializes once; openFtpClient owns partial-construction cleanup. */
  async open(): Promise<void> {
    if (this.#socket) throw new FtpError("FTP session was already opened.");
    const life = this.#start(undefined, true);
    try {
      this.#socket = await wait(
        this.#options.transport.connect({ host: this.#options.host, port: this.#options.port!, signal: life.signal }),
        life.signal,
      );
      argument(this.#socket.peerAddress, false);
      this.#control = new Control(this.#socket, this.#line, this.#reply, this.#chunk);
      const greeting = await this.#control.read(life.signal);
      if (greeting.code !== 220) throw new FtpError("FTP server was not ready.", greeting.code);
      if (this.#options.mode === "explicit-tls") {
        await this.#command("AUTH TLS", [234], life.signal);
        this.#control.upgrade();
        const tls = await wait(
          this.#options.transport.secure!(this.#socket, {
            serverName: this.#options.host,
            role: "control",
            signal: life.signal,
          }),
          life.signal,
        );
        this.#socket = tls.socket;
        this.#security = tls.context;
        this.#control = new Control(this.#socket, this.#line, this.#reply, this.#chunk);
        await this.#command("PBSZ 0", [200], life.signal);
        await this.#command("PROT P", [200], life.signal);
      }
      const user = await this.#command(`USER ${this.#options.username}`, [230, 331], life.signal);
      if (user.code === 331) await this.#command(`PASS ${this.#options.password}`, [230], life.signal);
      await this.#command("TYPE I", [200], life.signal);
      await this.#command("MODE S", [200], life.signal);
      await this.#command("STRU F", [200], life.signal);
      const features = await this.#command("FEAT", [211, 500, 502], life.signal);
      const lines = features.lines.slice(1, -1).map((line) => line.trim().toUpperCase());
      this.#utf8 = lines.includes("UTF8");
      this.#mlst = lines.some((line) => line === "MLST" || line.startsWith("MLST "));
      this.#restart = lines.includes("REST STREAM");
    } catch (reason) {
      await this.#fail(reason);
    } finally {
      life.finish();
    }
  }
  async #fail(reason: unknown): Promise<never> {
    await close([() => this.close()], [reason]);
    throw reason;
  }
  /** Disposal aborts active work, then attempts every acquired socket close once. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const sockets = [this.#data, this.#socket].filter((value): value is FtpSocketType => value !== undefined);
    const control = this.#control;
    this.#data = undefined;
    this.#socket = undefined;
    // Publish the disposal promise before abort callbacks can reenter close().
    this.#closing = Promise.resolve().then(async () => {
      this.#active?.abort.abort(new FtpError("FTP session was closed."));
      await close([
        ...[...new Set(sockets)].map((socket) => () => wait(socket.close(), AbortSignal.timeout(this.#cleanup))),
        () => control?.release(),
      ]);
    });
    return this.#closing;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** Metadata is descriptive and cannot authorize replay or a conditional write. */
  async stat(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<FtpEntryType> {
    const name = argument(path, this.#utf8);
    const life = this.#start(options.signal);
    try {
      if (!this.#mlst) throw new FtpError("FTP server does not advertise MLST.");
      const reply = await this.#command(`MLST ${name}`, [250], life.signal);
      const records = reply.lines.slice(1, -1).filter((line) => line.startsWith(" "));
      if (records.length !== 1) throw new FtpError("MLST must contain one fact record.");
      return entry(records[0]!.slice(1));
    } catch (reason) {
      return await this.#fail(reason);
    } finally {
      life.finish();
    }
  }

  /** EPSV never supplies a host. Only the actual control peer may receive data. */
  async #passive(
    command: string,
    life: LifetimeType,
    offset = 0,
    dispatch?: () => void,
  ): Promise<{ readonly terminal: Promise<ReplyType> }> {
    const reply = await this.#command("EPSV", [229], life.signal);
    const text = reply.lines.at(-1)!;
    const match = /\(([!-~])\1\1([0-9]+)\1\)/.exec(text);
    if (!match) throw new FtpError("Malformed EPSV endpoint.");
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new FtpError("Invalid EPSV port.");
    this.#data = await wait(
      this.#options.transport.connect({ host: this.#socket!.peerAddress, port, signal: life.signal }),
      life.signal,
    );
    if (this.#data.peerAddress !== this.#socket!.peerAddress) {
      throw new FtpError("FTP data peer differs from control peer.");
    }
    if (offset > 0) await this.#command(`REST ${offset}`, [350], life.signal);
    dispatch?.();
    await this.#command(command, [125, 150], life.signal);
    const terminal = this.#control!.read(life.signal).then((value) => {
      if (value.code !== 226 && value.code !== 250) {
        throw new FtpError("FTP transfer did not complete successfully.", value.code);
      }
      return value;
    });
    // Observe refusal concurrently with TLS negotiation and data consumption.
    terminal.catch((reason) => {
      life.abort.abort(reason);
    });
    if (this.#options.mode === "explicit-tls") {
      const tls = await wait(
        this.#options.transport.secure!(this.#data, {
          serverName: this.#options.host,
          role: "data",
          controlSecurity: this.#security,
          signal: life.signal,
        }),
        life.signal,
      );
      this.#data = tls.socket;
    }
    return { terminal };
  }

  /**
   * Downloads an unversioned suffix. REST supplies an offset, not a finite range.
   * Early cancellation retires the session; no ABOR/reply-reuse guess is made.
   */
  async openRead(
    path: string,
    options: { readonly offset?: number; readonly signal?: AbortSignal } = {},
  ): Promise<FtpReadType> {
    const name = argument(path, this.#utf8);
    return await this.#read(`RETR ${name}`, options.offset ?? 0, options.signal);
  }
  async #read(command: string, offset: number, signal?: AbortSignal): Promise<FtpReadType> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("FTP offset must be a safe nonnegative integer.");
    }
    const life = this.#start(signal);
    let terminal: Promise<ReplyType>;
    try {
      if (offset > 0 && !this.#restart) throw new FtpError("FTP server does not advertise REST STREAM.");
      // Returning a promise inside an object avoids async promise assimilation.
      const setup = await this.#passive(command, life, offset);
      terminal = setup.terminal;
    } catch (reason) {
      life.finish();
      return await this.#fail(reason);
    }
    const socket = this.#data!;
    const reader = socket.readable.getReader();
    let bytes = 0;
    let ended = false;
    let resolve!: (receipt: FtpReceiptType) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<FtpReceiptType>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    done.catch(() => {});
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fail = async (reason: unknown): Promise<void> => {
      if (ended) return;
      ended = true;
      life.signal.removeEventListener("abort", abort);
      let failure = reason;
      try {
        await close([() => this.close(), () => reader.releaseLock()], [reason]);
      } catch (value) {
        failure = value;
      }
      life.finish();
      reject(failure);
      controller?.error(failure);
    };
    const abort = () => {
      void fail(life.signal.reason);
    };
    life.signal.addEventListener("abort", abort, { once: true });
    terminal.catch((reason) => {
      void fail(reason);
    });
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull: async (value) => {
        try {
          const chunk = await wait(reader.read(), life.signal);
          if (ended) return;
          if (!chunk.done) {
            if (!isBytes(chunk.value)) throw new TypeError("FTP data must contain native bytes.");
            const view = toView(chunk.value);
            if (view.length > this.#chunk || bytes + view.length > Number.MAX_SAFE_INTEGER) {
              throw new RangeError("FTP data chunk exceeds budget.");
            }
            bytes += view.length;
            value.enqueue(new Uint8Array(view));
            return;
          }
          const receipt = await terminal;
          await wait(socket.close(), AbortSignal.timeout(this.#cleanup));
          this.#data = undefined;
          reader.releaseLock();
          ended = true;
          life.signal.removeEventListener("abort", abort);
          life.finish();
          resolve({ bytes, code: receipt.code as 226 | 250 });
          value.close();
        } catch (reason) {
          await fail(reason);
        }
      },
      cancel: (reason) => fail(reason ?? new FtpError("FTP download was cancelled.")),
    }, { highWaterMark: 0 });
    if (life.signal.aborted) abort();
    return { stream, done, cancel: (reason) => fail(reason ?? new FtpError("FTP download was cancelled.")) };
  }
  /** Bounded MLSD materialization, with no locale-dependent LIST fallback. */
  async list(path: string, options: { readonly signal?: AbortSignal } = {}): Promise<readonly FtpEntryType[]> {
    const name = argument(path, this.#utf8);
    if (!this.#mlst) throw new FtpError("FTP server does not advertise MLSD.");
    const transfer = await this.#read(`MLSD ${name}`, 0, options.signal);
    const reader = transfer.stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const entries: FtpEntryType[] = [];
    let pending = "";
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > this.#list) throw new RangeError("MLSD listing exceeds byte budget.");
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = pending.indexOf("\r\n");
          if (end < 0) break;
          const line = pending.slice(0, end);
          if (new TextEncoder().encode(line).length > this.#line || line.includes("\n") || line.includes("\r")) {
            throw new FtpError("Malformed MLSD line.");
          }
          pending = pending.slice(end + 2);
          const record = entry(line);
          if (record.type !== "cdir" && record.type !== "pdir") {
            if (entries.length >= this.#entries) throw new RangeError("MLSD listing exceeds entry budget.");
            entries.push(record);
          }
        }
        if (new TextEncoder().encode(pending).length > this.#line + 1) {
          throw new RangeError("MLSD line exceeds budget.");
        }
      }
      pending += decoder.decode();
      if (pending.length !== 0) throw new FtpError("MLSD listing ended without CRLF.");
      await transfer.done;
      return entries;
    } catch (reason) {
      await close([() => reader.cancel(reason), () => this.close()], [reason]);
      throw reason;
    } finally {
      reader.releaseLock();
    }
  }

  /** Bounded STOR replacement; success is a protocol receipt, never a CAS write. */
  async put(
    path: string,
    content: Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<FtpReceiptType> {
    const name = argument(path, this.#utf8);
    if (!isBytes(content)) throw new TypeError("FTP upload requires native Uint8Array bytes.");
    const view = toView(content);
    if (view.length > this.#upload) throw new RangeError("FTP upload exceeds materialization budget.");
    const bytes = new Uint8Array(view);
    const life = this.#start(options.signal);
    let dispatched = false;
    try {
      const { terminal } = await this.#passive(`STOR ${name}`, life, 0, () => {
        dispatched = true;
      });
      life.signal.throwIfAborted();
      const socket = this.#data!;
      const writer = socket.writable.getWriter();
      try {
        for (let at = 0; at < bytes.length; at += this.#chunk) {
          await wait(writer.write(bytes.subarray(at, at + this.#chunk)), life.signal);
        }
        await wait(writer.close(), life.signal);
      } finally {
        writer.releaseLock();
      }
      const reader = socket.readable.getReader();
      try {
        for (;;) {
          const chunk = await wait(reader.read(), life.signal);
          if (chunk.done) break;
          if (!isBytes(chunk.value) || toView(chunk.value).length !== 0) {
            throw new FtpError("Unexpected data during STOR.");
          }
        }
      } finally {
        reader.releaseLock();
      }
      const reply = await terminal;
      await wait(socket.close(), AbortSignal.timeout(this.#cleanup));
      this.#data = undefined;
      return { bytes: bytes.length, code: reply.code as 226 | 250 };
    } catch (reason) {
      const failure = dispatched && !(reason instanceof FtpError && reason.code !== undefined && reason.code >= 400)
        ? new FtpPublicationError({ cause: reason })
        : reason;
      return await this.#fail(failure);
    } finally {
      life.finish();
    }
  }
}

/** Validates, connects and logs in, closing partial acquisitions on failure. */
export async function openFtpClient(options: FtpOptionsType): Promise<FtpClient> {
  const client = new FtpClient(options);
  await client.open();
  return client;
}
