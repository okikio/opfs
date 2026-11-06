/** Checked classic Kafka fields. Flexible versions and tagged fields are outside this profile. @module */
import { isBytes, toView } from "../bytes.ts";

/** Local body ceiling, independent of advertised broker fetch/request policy. */
export const MAX_FRAME = 4 * 1024 * 1024;
/** Signed int64 bounds remain bigint for offsets, timestamps and protocol values. */
export const MIN_LONG = -(1n << 63n);
/** Largest representable signed int64 protocol value. */
export const MAX_LONG = (1n << 63n) - 1n;

/** Validates a protocol integer without truncation or coercion. */
function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("Kafka integer is outside its admitted range.");
  }
  return value;
}
/** Checks int64 arithmetic before a value reaches DataView or a returned cursor. */
export function long(value: bigint): bigint {
  if (typeof value !== "bigint" || value < MIN_LONG || value > MAX_LONG) {
    throw new RangeError("Kafka int64 is outside its admitted range.");
  }
  return value;
}
/** UTF8 conversion refuses replacement of lone surrogates and preserves a literal BOM. */
function utf8(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") throw new TypeError("Kafka text must be a string.");
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value) {
    throw new TypeError("Kafka text is not a lossless UTF8 string.");
  }
  return bytes;
}

/**
 * A bounded cursor over borrowed bytes. take() is for nested synchronous parsing;
 * use copy() for returned fields so a result neither aliases a mutable channel
 * chunk nor retains its entire backing frame. Every extent is checked before the
 * cursor advances. Call done() at each schema boundary to refuse tagged tails.
 */
export class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #at = 0;
  constructor(bytes: Uint8Array) {
    if (!isBytes(bytes)) throw new TypeError("Kafka input must be bytes.");
    this.#bytes = toView(bytes);
    if (this.#bytes.byteLength > MAX_FRAME + 4) throw new RangeError("Kafka input exceeds the frame ceiling.");
    this.#view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
  }
  /** Unconsumed bytes, used to admit counts before allocating or iterating. */
  get remaining(): number {
    return this.#bytes.byteLength - this.#at;
  }
  /** Borrowed checked range; its lifetime must not escape the synchronous parser. */
  take(count: number): Uint8Array {
    integer(count, 0, this.remaining);
    const bytes = this.#bytes.subarray(this.#at, this.#at + count);
    this.#at += count;
    return bytes;
  }
  /** Separately owned bytes for retained key/value/header fields. */
  copy(count: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.take(count));
  }
  /** Unsigned byte; callers separately refuse unsupported record attribute bits. */
  byte(): number {
    return this.take(1)[0]!;
  }
  /** Signed network-order int16. */
  short(): number {
    const at = this.#at;
    this.take(2);
    return this.#view.getInt16(at);
  }
  /** Signed network-order int32. */
  int(): number {
    const at = this.#at;
    this.take(4);
    return this.#view.getInt32(at);
  }
  /** Unsigned network-order CRC field. */
  uint(): number {
    const at = this.#at;
    this.take(4);
    return this.#view.getUint32(at);
  }
  /** Signed network-order int64 without a lossy Number conversion. */
  long(): bigint {
    const at = this.#at;
    this.take(8);
    return this.#view.getBigInt64(at);
  }
  /** Classic int16 byte-length text; -1 is admitted only for explicitly nullable fields. */
  text(nullable?: false): string;
  text(nullable: true): string | null;
  text(nullable = false): string | null {
    const count = this.short();
    if (count === -1 && nullable) return null;
    integer(count, 0, 32767);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(count));
  }
  /**
   * Classic array count. minimumBytes is the schema's smallest encoded element,
   * preventing a tiny input from allocating an attacker-selected result array.
   */
  arrayLength(minimumBytes: number, nullable?: false, maximum?: number): number;
  arrayLength(minimumBytes: number, nullable: true, maximum?: number): number | null;
  arrayLength(minimumBytes: number, nullable = false, maximum = 1024): number | null {
    integer(minimumBytes, 1, MAX_FRAME);
    integer(maximum, 0, MAX_FRAME);
    const count = this.int();
    if (count === -1 && nullable) return null;
    return integer(count, 0, Math.min(maximum, Math.floor(this.remaining / minimumBytes)));
  }
  /** Minimal signed zigzag int32, limited to five bytes and its exact final nibble. */
  varint(): number {
    return Number(this.#var(32));
  }
  /** Minimal signed zigzag int64, limited to ten bytes and its exact final bit. */
  varlong(): bigint {
    return this.#var(64);
  }
  #var(bits: 32 | 64): bigint {
    const maximum = bits === 32 ? 5 : 10;
    let encoded = 0n;
    for (let index = 0; index < maximum; index++) {
      const byte = this.byte();
      const payload = byte & 127;
      if (index === maximum - 1 && payload > (bits === 32 ? 15 : 1)) {
        throw new RangeError("Kafka varint overflows its signed width.");
      }
      encoded |= BigInt(payload) << BigInt(index * 7);
      if ((byte & 128) === 0) {
        if (index > 0 && payload === 0) throw new Error("Nonminimal Kafka varint is outside this profile.");
        return (encoded >> 1n) ^ -(encoded & 1n);
      }
    }
    throw new Error("Kafka varint exceeds its byte ceiling.");
  }
  /** Refuses any unparsed bytes, including an incomplete final field. */
  done(): void {
    if (this.remaining !== 0) throw new Error("Kafka schema has trailing bytes.");
  }
}

/**
 * Synchronous bounded serialization. raw() borrows its input until finish(); the
 * caller must keep it unchanged over that interval. finish() always returns a
 * new owned array. The constructor ceiling is checked before retaining chunks.
 */
export class Writer {
  readonly #maximum: number;
  readonly #chunks: Uint8Array[] = [];
  #length = 0;
  constructor(maximum = MAX_FRAME) {
    this.#maximum = integer(maximum, 0, MAX_FRAME);
  }
  /** Encoded bytes currently retained, including scalar and length fields. */
  get length(): number {
    return this.#length;
  }
  /** Appends a borrowed synchronous byte range without introducing a length prefix. */
  raw(bytes: Uint8Array): this {
    if (!isBytes(bytes)) throw new TypeError("Kafka output must be bytes.");
    const view = toView(bytes);
    integer(view.byteLength, 0, this.#maximum - this.#length);
    if (view.byteLength > 0) this.#chunks.push(view);
    this.#length += view.byteLength;
    return this;
  }
  #scalar(size: number, write: (view: DataView) => void): this {
    integer(size, 0, this.#maximum - this.#length);
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    return this.raw(bytes);
  }
  /** Unsigned byte. */
  byte(value: number): this {
    integer(value, 0, 255);
    return this.#scalar(1, (view) => view.setUint8(0, value));
  }
  /** Signed network-order int16. */
  short(value: number): this {
    integer(value, -32768, 32767);
    return this.#scalar(2, (view) => view.setInt16(0, value));
  }
  /** Signed network-order int32. */
  int(value: number): this {
    integer(value, -2147483648, 2147483647);
    return this.#scalar(4, (view) => view.setInt32(0, value));
  }
  /** Unsigned network-order CRC field. */
  uint(value: number): this {
    integer(value, 0, 4294967295);
    return this.#scalar(4, (view) => view.setUint32(0, value));
  }
  /** Signed network-order int64. */
  long(value: bigint): this {
    long(value);
    return this.#scalar(8, (view) => view.setBigInt64(0, value));
  }
  /** Classic nullable string, with a signed int16 UTF8 byte length. */
  text(value: string | null): this {
    if (value === null) return this.short(-1);
    if (typeof value !== "string" || value.length > Math.min(32767, this.#maximum - this.#length - 2)) {
      throw new RangeError("Kafka text exceeds the admitted byte ceiling.");
    }
    const bytes = utf8(value);
    integer(bytes.byteLength, 0, 32767);
    integer(bytes.byteLength + 2, 0, this.#maximum - this.#length);
    return this.short(bytes.byteLength).raw(bytes);
  }
  /** Classic nullable bytes, with a signed int32 byte length. */
  bytes(value: Uint8Array | null): this {
    if (value === null) return this.int(-1);
    if (!isBytes(value)) throw new TypeError("Kafka field must be nullable bytes.");
    const bytes = toView(value);
    integer(bytes.byteLength + 4, 0, this.#maximum - this.#length);
    return this.int(bytes.byteLength).raw(bytes);
  }
  /** Minimal signed zigzag int32. */
  varint(value: number): this {
    integer(value, -2147483648, 2147483647);
    return this.#var(BigInt(value));
  }
  /** Minimal signed zigzag int64. */
  varlong(value: bigint): this {
    return this.#var(long(value));
  }
  #var(value: bigint): this {
    let encoded = value < 0n ? -value * 2n - 1n : value * 2n;
    const bytes: number[] = [];
    do {
      const next = Number(encoded & 127n);
      encoded >>= 7n;
      bytes.push(next | (encoded === 0n ? 0 : 128));
    } while (encoded !== 0n);
    return this.raw(Uint8Array.from(bytes));
  }
  /** Joins admitted chunks into a new owned result; no source buffer escapes. */
  finish(): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(this.#length);
    let at = 0;
    for (const bytes of this.#chunks) {
      output.set(bytes, at);
      at += bytes.byteLength;
    }
    return output;
  }
}

/** Adds an admitted signed int32 body length; the returned frame owns its bytes. */
export function frame(body: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(body)) throw new TypeError("Kafka frame body must be bytes.");
  const bytes = toView(body);
  integer(bytes.byteLength, 0, MAX_FRAME);
  const output = new Uint8Array(bytes.byteLength + 4);
  new DataView(output.buffer).setInt32(0, bytes.byteLength);
  output.set(bytes, 4);
  return output;
}
/** Validates a complete classic frame and borrows only its exact body range. */
export function unframe(bytes: Uint8Array): Uint8Array {
  const reader = new Reader(bytes), length = reader.int();
  integer(length, 0, MAX_FRAME);
  const body = reader.take(length);
  reader.done();
  return body;
}
