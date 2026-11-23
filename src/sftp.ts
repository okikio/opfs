/** SFTP v3 packets over an explicitly acquired SSH subsystem byte channel. @module */
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";

/**
 * A clean, exclusive binary subsystem channel, not an SSH session or raw TCP.
 * The application owns SSH host-key validation, authentication, cryptography,
 * window management and stderr/exit handling. close retires pending channel IO
 * without closing an independently borrowed parent SSH session.
 */
export interface SftpChannelType {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** Native v3 attributes are metadata, never immutable revision evidence. */
export interface SftpAttributesType {
  readonly kind: "file" | "directory" | "symlink" | "other" | "unknown";
  readonly size?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly permissions?: number;
  readonly accessed?: number;
  readonly modified?: number;
  readonly extended?: readonly { readonly name: Uint8Array; readonly data: Uint8Array }[];
}
/** A native filename and structured attributes; longname is never parsed. */
export interface SftpEntryType {
  readonly name: string;
  readonly attributes: SftpAttributesType;
}
/** EOF is true only after an explicit server EOF status, not a short DATA reply. */
export interface SftpReadType {
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}
/** Each successful WRITE was acknowledged; this does not imply fsync or atomic publication. */
export interface SftpReceiptType {
  readonly at: number;
  readonly bytes: number;
}
/** Operation signals add to the client lifetime signal and operation deadline. */
export interface SftpOperationType {
  readonly signal?: AbortSignal;
}
/** Owned opaque server handle; callers cannot edit, forge or export its wire bytes. */
export interface SftpFileType extends AsyncDisposable {
  readonly closed: boolean;
  stat(options?: SftpOperationType): Promise<SftpAttributesType>;
  read(at: number, length: number, options?: SftpOperationType): Promise<SftpReadType>;
  write(at: number, bytes: Uint8Array, options?: SftpOperationType): Promise<SftpReceiptType>;
  close(options?: SftpOperationType): Promise<void>;
}
/** Policy limits are implementation bounds, not negotiated server capabilities. */
export interface SftpOptionsType {
  /** Successful acquisition transfers ownership. Honor abort and dispose late/partial channels. */
  readonly openChannel: (
    options: { readonly subsystem: "sftp"; readonly signal: AbortSignal },
  ) => Promise<SftpChannelType>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cleanupMs?: number;
  readonly maxPacketBytes?: number;
  readonly maxChunkBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxListBytes?: number;
  readonly maxEntries?: number;
  readonly maxOpenFiles?: number;
  readonly maxRequests?: number;
}

/** A known server status. Nonzero status can follow partial effects of earlier writes. */
export class SftpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`SFTP server returned status ${status}.`);
    this.name = "SftpError";
    this.status = status;
  }
}
/** The channel failed to carry a valid, attributable v3 response. */
export class SftpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SftpProtocolError";
  }
}
/** A mutating OPEN/WRITE was dispatched without an attributable completion. */
export class SftpPublicationError extends Error {
  constructor(options?: ErrorOptions) {
    super("SFTP mutation outcome is unknown; inspect remote state before deciding whether to retry.", options);
    this.name = "SftpPublicationError";
  }
}

interface LifetimeType {
  readonly signal: AbortSignal;
  readonly abort: AbortController;
}
interface HandleType {
  readonly bytes: Uint8Array;
  readonly key: string;
  readonly writable: boolean;
  dirty: boolean;
  closed: boolean;
}

/** Server integer/string lengths are checked against remaining bytes before allocation. */
class Cursor {
  readonly bytes: Uint8Array;
  #at = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get remaining(): number {
    return this.bytes.length - this.#at;
  }
  take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) {
      throw new SftpProtocolError("Truncated SFTP packet field.");
    }
    const value = this.bytes.subarray(this.#at, this.#at + size);
    this.#at += size;
    return value;
  }
  byte(): number {
    return this.take(1)[0]!;
  }
  uint(): number {
    const value = this.take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0);
  }
  size(): number {
    const value = BigInt(this.uint()) << 32n | BigInt(this.uint());
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new SftpProtocolError("SFTP uint64 exceeds safe integer precision.");
    }
    return Number(value);
  }
  string(maximum: number): Uint8Array {
    const size = this.uint();
    if (size > maximum) throw new SftpProtocolError("SFTP string exceeds its budget.");
    return this.take(size);
  }
  text(maximum: number): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.string(maximum));
    } catch (reason) {
      if (reason instanceof SftpProtocolError) throw reason;
      throw new SftpProtocolError("Invalid UTF-8 in SFTP text profile.");
    }
  }
  end(): void {
    if (this.remaining !== 0) throw new SftpProtocolError("Unexpected trailing SFTP packet bytes.");
  }
}

function uint(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function size(value: number): Uint8Array {
  const integer = BigInt(value);
  return join(uint(Number(integer >> 32n)), uint(Number(integer & 0xffffffffn)));
}
function join(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
function string(bytes: Uint8Array): Uint8Array {
  return join(uint(bytes.length), bytes);
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new RangeError("Invalid SFTP policy limit.");
  }
  return result;
}
function extent(at: number, length: number): void {
  if (
    !Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(length) || length < 0 ||
    !Number.isSafeInteger(at + length)
  ) {
    throw new RangeError("SFTP extent must use safe nonnegative integers.");
  }
}
/** Explicit UTF-8 pathname profile, without shell interpretation or virtual normalization. */
function path(value: string, maximum: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Invalid SFTP pathname.");
  }
  if (value.length > maximum) throw new RangeError("SFTP pathname exceeds budget.");
  if (value.includes("\0")) throw new TypeError("Invalid SFTP pathname.");
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError("SFTP pathname contains an unpaired surrogate.");
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > maximum) throw new RangeError("SFTP pathname exceeds budget.");
  return bytes;
}
/** A bounded abort race observes the borrowed promise's eventual rejection. */
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
/** Attribute flags select exact fields; longname cannot invent missing type/size. */
function attributes(cursor: Cursor): SftpAttributesType {
  const flags = cursor.uint();
  if ((flags & ~0x8000000f) !== 0) throw new SftpProtocolError("Unsupported SFTP attribute flags.");
  const result: {
    kind: SftpAttributesType["kind"];
    size?: number;
    uid?: number;
    gid?: number;
    permissions?: number;
    accessed?: number;
    modified?: number;
    extended?: { name: Uint8Array; data: Uint8Array }[];
  } = { kind: "unknown" };
  if (flags & 1) result.size = cursor.size();
  if (flags & 2) {
    result.uid = cursor.uint();
    result.gid = cursor.uint();
  }
  if (flags & 4) {
    result.permissions = cursor.uint();
    const type = result.permissions & 0xf000;
    result.kind = type === 0x8000
      ? "file"
      : type === 0x4000
      ? "directory"
      : type === 0xa000
      ? "symlink"
      : type === 0
      ? "unknown"
      : "other";
  }
  if (flags & 8) {
    result.accessed = cursor.uint();
    result.modified = cursor.uint();
  }
  if (flags & 0x80000000) {
    const count = cursor.uint();
    if (count > 128 || count > Math.floor(cursor.remaining / 8)) {
      throw new SftpProtocolError("SFTP extended attributes exceed budget.");
    }
    result.extended = [];
    for (let index = 0; index < count; index++) {
      result.extended.push({
        name: new Uint8Array(cursor.string(8192)),
        data: new Uint8Array(cursor.string(cursor.remaining)),
      });
    }
  }
  return result;
}

/**
 * Native v3 client, not an SSH implementation or filesystem adapter. One operation
 * is active at a time; server response IDs must match exactly. Handle metadata
 * does not prevent concurrent remote mutation or authorize immutable replay.
 */
export class SftpClient implements AsyncDisposable {
  readonly #options: SftpOptionsType;
  readonly #timeout: number;
  readonly #cleanup: number;
  readonly #packet: number;
  readonly #chunk: number;
  readonly #read: number;
  readonly #write: number;
  readonly #path: number;
  readonly #list: number;
  readonly #entries: number;
  readonly #open: number;
  readonly #requests: number;
  #channel: SftpChannelType | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #pending = new Uint8Array(0);
  #position = 0;
  #id = 0;
  #busy = false;
  #closed = false;
  #active: LifetimeType | undefined;
  #closing: Promise<void> | undefined;
  readonly #handles = new Map<string, HandleType>();
  #extensions: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.create(null));

  /** Validates local policy; use openSftpClient to acquire and negotiate the channel. */
  constructor(options: SftpOptionsType) {
    if (typeof options.openChannel !== "function") {
      throw new TypeError("An explicit SFTP subsystem capability is required.");
    }
    this.#options = { ...options, openChannel: options.openChannel.bind(options) };
    this.#timeout = limit(options.timeoutMs, 30_000, 86_400_000);
    this.#cleanup = limit(options.cleanupMs, 5000, 60_000);
    this.#packet = limit(options.maxPacketBytes, 262_144, 8_388_608);
    if (this.#packet < 1024) throw new RangeError("SFTP packet policy must admit at least 1024 bytes.");
    this.#chunk = limit(options.maxChunkBytes, 65_536, 8_388_608);
    this.#read = limit(options.maxReadBytes, 8_388_608, 67_108_864);
    this.#write = limit(options.maxWriteBytes, 8_388_608, 67_108_864);
    this.#path = limit(options.maxPathBytes, 8192, 1_048_576);
    this.#list = limit(options.maxListBytes, 8_388_608, 67_108_864);
    this.#entries = limit(options.maxEntries, 100_000, 1_000_000);
    this.#open = limit(options.maxOpenFiles, 16, 1024);
    this.#requests = limit(options.maxRequests, 1_000_000, 0xffffffff);
  }
  /** Advertised version strings are descriptive; unsupported extensions are never invoked. */
  get extensions(): Readonly<Record<string, readonly string[]>> {
    return this.#extensions;
  }
  get closed(): boolean {
    return this.#closed;
  }

  async #run<T>(action: (life: LifetimeType) => Promise<T>, signal?: AbortSignal, opening = false): Promise<T> {
    if (this.#closed) throw new SftpProtocolError("SFTP channel is closed.");
    if (this.#busy) throw new SftpProtocolError("SFTP channel is busy; operations are not queued.");
    if (!opening && !this.#channel) throw new SftpProtocolError("SFTP channel has not been opened.");
    const abort = new AbortController();
    const signals = [abort.signal, AbortSignal.timeout(this.#timeout)];
    if (signal) signals.push(signal);
    if (this.#options.signal) signals.push(this.#options.signal);
    const life = { abort, signal: AbortSignal.any(signals) };
    life.signal.throwIfAborted();
    this.#busy = true;
    this.#active = life;
    try {
      return await action(life);
    } catch (reason) {
      if (reason instanceof SftpError) throw reason;
      await close([() => this.close()], [reason]);
      throw reason;
    } finally {
      this.#busy = false;
      this.#active = undefined;
    }
  }
  /** No input packet length allocates memory before policy and minimum framing checks. */
  async #take(size: number, signal: AbortSignal): Promise<Uint8Array> {
    const result = new Uint8Array(size);
    let at = 0;
    let empty = 0;
    while (at < size) {
      if (this.#position === this.#pending.length) {
        const chunk = await wait(this.#reader!.read(), signal);
        if (chunk.done) throw new SftpProtocolError("SFTP channel ended before its packet.");
        if (!isBytes(chunk.value)) throw new SftpProtocolError("SFTP channel returned non-byte data.");
        const view = toView(chunk.value);
        if (view.length > this.#chunk) throw new SftpProtocolError("SFTP transport chunk exceeds budget.");
        if (view.length === 0) {
          if (++empty > 16) throw new SftpProtocolError("SFTP channel made no byte progress.");
          continue;
        }
        empty = 0;
        this.#pending = new Uint8Array(view);
        this.#position = 0;
      }
      const count = Math.min(size - at, this.#pending.length - this.#position);
      result.set(this.#pending.subarray(this.#position, this.#position + count), at);
      this.#position += count;
      at += count;
    }
    return result;
  }
  async #receive(signal: AbortSignal): Promise<Cursor> {
    const header = await this.#take(4, signal);
    const length = new DataView(header.buffer).getUint32(0);
    if (length < 5 || length > this.#packet) throw new SftpProtocolError("SFTP packet length exceeds profile bounds.");
    const packet = await this.#take(length, signal);
    if (this.#position !== this.#pending.length) {
      throw new SftpProtocolError("Unsolicited bytes follow the only outstanding SFTP reply.");
    }
    return new Cursor(packet);
  }
  async #send(packet: Uint8Array, signal: AbortSignal, dispatch?: () => void): Promise<void> {
    if (packet.length > this.#packet) throw new RangeError("SFTP request packet exceeds local budget.");
    signal.throwIfAborted();
    dispatch?.();
    await wait(this.#writer!.write(join(uint(packet.length), packet)), signal);
  }
  /** Initializes only v3; other versions need distinct schemas rather than guessed decoding. */
  async open(): Promise<void> {
    if (this.#channel) throw new SftpProtocolError("SFTP channel was already opened.");
    await this.#run(
      async (life) => {
        this.#channel = await wait(this.#options.openChannel({ subsystem: "sftp", signal: life.signal }), life.signal);
        this.#reader = this.#channel.readable.getReader();
        this.#writer = this.#channel.writable.getWriter();
        await this.#send(join(new Uint8Array([1]), uint(3)), life.signal);
        const reply = await this.#receive(life.signal);
        if (reply.byte() !== 2 || reply.uint() !== 3) throw new SftpProtocolError("Only SFTP version 3 is supported.");
        const extensions: Record<string, string[]> = Object.create(null);
        let count = 0;
        while (reply.remaining) {
          if (++count > 128) throw new SftpProtocolError("SFTP extension declarations exceed budget.");
          const name = reply.text(8192);
          const version = reply.text(8192);
          if (!name || !version) throw new SftpProtocolError("Empty SFTP extension declaration.");
          (extensions[name] ??= []).push(version);
        }
        this.#extensions = Object.freeze(
          Object.fromEntries(Object.entries(extensions).map(([name, values]) => [name, Object.freeze(values)])),
        );
      },
      undefined,
      true,
    );
  }
  /** One attributable response per request; no ID wrap, hidden retries or pipelining. */
  async #request(
    type: number,
    bytes: Uint8Array,
    expected: number,
    life: LifetimeType,
    dispatch?: () => void,
  ): Promise<Cursor> {
    if (this.#id >= this.#requests) throw new RangeError("SFTP session request budget exhausted; open a new channel.");
    const id = ++this.#id;
    await this.#send(join(new Uint8Array([type]), uint(id), bytes), life.signal, dispatch);
    const reply = await this.#receive(life.signal);
    const kind = reply.byte();
    if (reply.uint() !== id) throw new SftpProtocolError("SFTP response request ID does not match.");
    if (kind === 101) {
      const status = reply.uint();
      reply.text(this.#packet); // Server text is untrusted and deliberately omitted from errors/logs.
      reply.string(this.#packet);
      reply.end();
      if (status !== 0) throw new SftpError(status);
      if (expected !== 101) throw new SftpProtocolError("SFTP OK status cannot replace the expected data response.");
      return new Cursor(new Uint8Array(0));
    }
    if (kind !== expected) throw new SftpProtocolError("Unexpected SFTP response packet type.");
    return reply;
  }
  #admit(): void {
    if (this.#handles.size >= this.#open) throw new RangeError("SFTP open-handle budget exhausted.");
  }
  #handle(reply: Cursor, writable: boolean): HandleType {
    const bytes = new Uint8Array(reply.string(256));
    reply.end();
    const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (this.#handles.has(key)) throw new SftpProtocolError("Server reused an active SFTP handle.");
    const handle = { bytes, key, writable, dirty: false, closed: false };
    this.#handles.set(key, handle);
    return handle;
  }
  #check(handle: HandleType): void {
    if (handle.closed || this.#closed) throw new SftpProtocolError("SFTP file is closed.");
  }
  async #release(handle: HandleType, life: LifetimeType): Promise<void> {
    let dispatched = false;
    try {
      await this.#request(4, string(handle.bytes), 101, life, () => {
        dispatched = true;
      });
    } catch (reason) {
      if (dispatched && handle.dirty && !(reason instanceof SftpError)) {
        throw new SftpPublicationError({ cause: reason });
      }
      throw reason;
    }
    handle.closed = true;
    this.#handles.delete(handle.key);
  }
  /** stat follows symbolic links; lstat describes the link itself. */
  async stat(
    pathname: string,
    options: SftpOperationType & { readonly follow?: boolean } = {},
  ): Promise<SftpAttributesType> {
    const bytes = path(pathname, this.#path);
    const type = options.follow === false ? 7 : 17;
    return this.#run(async (life) => {
      const reply = await this.#request(type, string(bytes), 105, life);
      const value = attributes(reply);
      reply.end();
      return value;
    }, options.signal);
  }
  /** Bounded native listing. A closed directory handle is required before success. */
  async list(pathname: string, options: SftpOperationType = {}): Promise<readonly SftpEntryType[]> {
    const bytes = path(pathname, this.#path);
    this.#admit();
    return this.#run(async (life) => {
      const handle = this.#handle(await this.#request(11, string(bytes), 102, life), false);
      const entries: SftpEntryType[] = [];
      let total = 0;
      let seen = 0;
      try {
        for (;;) {
          let reply: Cursor;
          try {
            reply = await this.#request(12, string(handle.bytes), 104, life);
          } catch (reason) {
            if (reason instanceof SftpError && reason.status === 1) break;
            throw reason;
          }
          total += reply.bytes.length;
          if (total > this.#list) throw new RangeError("SFTP listing exceeds byte budget.");
          const count = reply.uint();
          if (count === 0 || count > this.#entries - seen || count > Math.floor(reply.remaining / 12)) {
            throw new SftpProtocolError("SFTP NAME count exceeds budget or makes no progress.");
          }
          seen += count;
          for (let index = 0; index < count; index++) {
            const name = reply.text(this.#path);
            path(name, this.#path);
            if (name.includes("/")) throw new SftpProtocolError("SFTP READDIR filename contains path components.");
            reply.string(this.#packet); // longname is presentation text, never an attribute source.
            const value = attributes(reply);
            if (name !== "." && name !== "..") entries.push({ name, attributes: value });
          }
          reply.end();
        }
      } catch (reason) {
        if (reason instanceof SftpError) await close([() => this.#release(handle, life)], [reason]);
        throw reason;
      }
      try {
        await this.#release(handle, life);
      } catch (reason) {
        await close([() => this.close()], [reason]);
        throw reason;
      }
      return entries;
    }, options.signal);
  }
  /**
   * read: existing file; write: existing file without truncation; create: exclusive
   * new file; replace: create or truncate. None is a conditional revision write.
   */
  async openFile(
    pathname: string,
    options: SftpOperationType & { readonly mode?: "read" | "write" | "create" | "replace" } = {},
  ): Promise<SftpFileType> {
    const bytes = path(pathname, this.#path);
    const mode = options.mode ?? "read";
    if (!["read", "write", "create", "replace"].includes(mode)) throw new TypeError("Unsupported SFTP open mode.");
    this.#admit();
    const flags = mode === "read" ? 1 : mode === "write" ? 2 : mode === "create" ? 2 | 8 | 32 : 2 | 8 | 16;
    return this.#run(async (life) => {
      let handle: HandleType;
      let dispatched = false;
      try {
        handle = this.#handle(
          await this.#request(3, join(string(bytes), uint(flags), uint(0)), 102, life, () => {
            dispatched = true;
          }),
          mode !== "read",
        );
      } catch (reason) {
        if (dispatched && mode !== "read" && !(reason instanceof SftpError)) {
          throw new SftpPublicationError({ cause: reason });
        }
        throw reason;
      }
      handle.dirty = mode === "create" || mode === "replace";
      const isClosed = () => handle.closed || this.closed;
      let closing: Promise<void> | undefined;
      const closeFile = (options: SftpOperationType = {}) => {
        if (closing) return closing;
        if (isClosed()) return Promise.resolve();
        let admitted = false;
        const action = this.#run((life) => {
          admitted = true;
          return this.#release(handle, life);
        }, options.signal);
        closing = action;
        // A local busy/pre-abort refusal did not acquire disposal authority.
        action.catch(() => {
          if (!admitted && closing === action) closing = undefined;
        });
        return action;
      };
      return {
        get closed() {
          return isClosed();
        },
        stat: async (options: SftpOperationType = {}) => {
          this.#check(handle);
          return this.#run(async (life) => {
            const reply = await this.#request(8, string(handle.bytes), 105, life);
            const result = attributes(reply);
            reply.end();
            return result;
          }, options.signal);
        },
        read: async (at: number, length: number, options: SftpOperationType = {}) => {
          this.#check(handle);
          extent(at, length);
          if (length > this.#read) throw new RangeError("SFTP read exceeds materialization budget.");
          return this.#run(async (life) => {
            const result = new Uint8Array(length);
            let received = 0;
            let eof = false;
            while (received < length) {
              const count = Math.min(length - received, 32768, this.#packet - 9);
              let reply: Cursor;
              try {
                reply = await this.#request(
                  5,
                  join(string(handle.bytes), size(at + received), uint(count)),
                  103,
                  life,
                );
              } catch (reason) {
                if (reason instanceof SftpError && reason.status === 1) {
                  eof = true;
                  break;
                }
                throw reason;
              }
              const data = reply.string(count);
              reply.end();
              if (data.length === 0) throw new SftpProtocolError("SFTP DATA made no byte progress.");
              result.set(data, received);
              received += data.length;
            }
            return { bytes: result.slice(0, received), eof };
          }, options.signal);
        },
        write: async (at: number, content: Uint8Array, options: SftpOperationType = {}) => {
          this.#check(handle);
          if (!handle.writable) throw new TypeError("SFTP file was opened for reading only.");
          if (!isBytes(content)) throw new TypeError("SFTP write requires native Uint8Array bytes.");
          const view = toView(content);
          extent(at, view.length);
          if (view.length > this.#write) throw new RangeError("SFTP write exceeds materialization budget.");
          const bytes = new Uint8Array(view);
          return this.#run(async (life) => {
            for (let written = 0; written < bytes.length;) {
              const count = Math.min(bytes.length - written, 32768, this.#packet - 21 - handle.bytes.length);
              let dispatched = false;
              try {
                await this.#request(
                  6,
                  join(string(handle.bytes), size(at + written), string(bytes.subarray(written, written + count))),
                  101,
                  life,
                  () => {
                    dispatched = true;
                    handle.dirty = true;
                  },
                );
              } catch (reason) {
                if (dispatched && !(reason instanceof SftpError)) throw new SftpPublicationError({ cause: reason });
                throw reason;
              }
              written += count;
            }
            return { at, bytes: bytes.length };
          }, options.signal);
        },
        close: closeFile,
        [Symbol.asyncDispose]: () => closeFile(),
      };
    }, options.signal);
  }
  /** Retires the owned channel and every handle; it never closes the application's SSH session. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const channel = this.#channel;
    const reader = this.#reader;
    const writer = this.#writer;
    this.#channel = undefined;
    for (const handle of this.#handles.values()) handle.closed = true;
    this.#handles.clear();
    this.#closing = Promise.resolve().then(async () => {
      this.#active?.abort.abort(new SftpProtocolError("SFTP channel was closed."));
      await close([
        async () => {
          if (channel) await wait(channel.close(), AbortSignal.timeout(this.#cleanup));
        },
        () => reader?.releaseLock(),
        () => writer?.releaseLock(),
      ]);
    });
    return this.#closing;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** Acquires one authenticated subsystem channel and negotiates only the deployed v3 profile. */
export async function openSftpClient(options: SftpOptionsType): Promise<SftpClient> {
  const client = new SftpClient(options);
  await client.open();
  return client;
}
