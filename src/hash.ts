/**
 * Checksums and digests that format readers compute over bytes as they stream.
 *
 * Archive, compression and dataset readers verify a stored check against the bytes they decode. Each format names
 * one algorithm, and several formats share one, so the algorithms live here rather than in the first format that
 * needed them:
 *
 * | Export   | Algorithm                                  | Used by                                     |
 * | -------- | ------------------------------------------ | ------------------------------------------- |
 * | `crc32`  | CRC-32 (ISO-HDLC, reflected `0xEDB88320`)  | ZIP read and write, gzip, 7z, RAR, ARJ, XZ, BGZF, MCAP, Parquet |
 * | `Crc64`  | CRC-64/XZ (reflected `0xC96C5795D7870F42`) | XZ block checks                             |
 * | `Sha256` | SHA-256 (FIPS 180-4), incremental          | XZ block checks                             |
 *
 * All three follow the bytes in chunks, so a reader never keeps a copy of a block only to check it. None of them
 * authenticates anything: whoever can change the bytes can also recompute the check.
 *
 * Three related algorithms stay with their only owner, because their callers add format rules around the
 * arithmetic: Kafka's CRC-32C (frame-size admission), and the CRC-16 variants in LHA and UDF. AWS request signing
 * uses Web Crypto through `aws.ts`, since it needs HMAC and awaits a key import anyway.
 *
 * @module
 */

/**
 * Advance a CRC-32 register over `bytes` and return the new register.
 *
 * The register starts at `0xffffffff` and the caller applies the final XOR, so one value can follow a member
 * across many chunks: `state = crc32(chunk, state)`, then `(state ^ 0xffffffff) >>> 0` at the end. No table is
 * kept, so importing this module allocates nothing.
 */
export function crc32(bytes: Uint8Array, state = 0xffffffff): number {
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = (state >>> 1) ^ (0xedb88320 & -(state & 1));
  }
  return state >>> 0;
}

/** CRC64/XZ keeps a reflected 64-bit register in two uint32 words.
 * A read owns one 2 KiB interleaved low/high table, built only when CRC64 is needed.
 * This replaces eight bit iterations per input byte with one byte recurrence,
 * without per-byte BigInt values or a retained body buffer. It is not authentication. */
export class Crc64 {
  /** 256 entries of (low, high) words, interleaved so one byte reads two adjacent slots. */
  readonly #table = new Uint32Array(512);
  /** The 64-bit register, split into its low and high 32-bit words. */
  #low = 0xffffffff;
  #high = 0xffffffff;
  constructor() {
    for (let value = 0; value < 256; value++) {
      let low = value;
      let high = 0;
      for (let bit = 0; bit < 8; bit++) {
        const carry = low & 1;
        low = (low >>> 1 | high << 31) >>> 0;
        high >>>= 1;
        if (carry) {
          low = (low ^ 0xd7870f42) >>> 0;
          high = (high ^ 0xc96c5795) >>> 0;
        }
      }
      this.#table[value * 2] = low;
      this.#table[value * 2 + 1] = high;
    }
  }
  /** Start a new message. */
  reset(): void {
    this.#low = 0xffffffff;
    this.#high = 0xffffffff;
  }
  /** Add the next bytes of the message. */
  update(bytes: Uint8Array): void {
    let low = this.#low;
    let high = this.#high;
    for (const byte of bytes) {
      const index = ((low ^ byte) & 255) * 2;
      low = (this.#table[index]! ^ (low >>> 8 | high << 24)) >>> 0;
      high = (this.#table[index + 1]! ^ high >>> 8) >>> 0;
    }
    this.#low = low;
    this.#high = high;
  }
  /** The check as sixteen lowercase hex digits, high word first; the register is not reset. */
  hex(): string {
    return ((this.#high ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0") +
      ((this.#low ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }
}

/** Round constants K0 to K63: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);
/** Initial state: the first 32 bits of the fractional parts of the square roots of the first eight primes. */
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** Rotate a 32-bit word right by `bits`; the FIPS 180-4 ROTR operation. */
const rotate = (value: number, bits: number): number => value >>> bits | value << (32 - bits);

/**
 * Streaming SHA-256. Call {@link Sha256.update} per chunk, then {@link Sha256.hex} once; `reset` reuses it.
 *
 * Web Crypto's `digest()` takes only a complete buffer. `@std/crypto` accepts an iterable, but it lists only Deno and
 * browsers as supported and pulls chunks while a decoder pushes them, so the package keeps this implementation.
 * Tests compare it with Web Crypto at every padding boundary.
 */
export class Sha256 {
  /** The eight working hash words (H0 to H7 in FIPS 180-4), updated once per 64-byte block. */
  readonly #state = new Uint32Array(8);
  /** The 64-word message schedule (W0 to W63), reused for every block so hashing allocates nothing per chunk. */
  readonly #words = new Uint32Array(64);
  /** Input bytes that do not yet fill a 64-byte block. Only the first `#pending` bytes are meaningful. */
  readonly #block = new Uint8Array(64);
  /** How many bytes of `#block` hold input, from 0 to 63 between calls. */
  #pending = 0;
  /** Total input length in bytes. A safe integer covers every block this package can admit. */
  #length = 0;

  constructor() {
    this.reset();
  }

  /** Start a new message. */
  reset(): void {
    this.#state.set(INITIAL);
    this.#pending = 0;
    this.#length = 0;
  }

  /** Add the next bytes of the message. The chunk is read, never retained. */
  update(bytes: Uint8Array): void {
    let at = 0;
    this.#length += bytes.length;
    if (this.#pending > 0) {
      const take = Math.min(64 - this.#pending, bytes.length);
      this.#block.set(bytes.subarray(0, take), this.#pending);
      this.#pending += take;
      at = take;
      if (this.#pending < 64) return;
      this.#compress(this.#block, 0);
      this.#pending = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.#compress(bytes, at);
    if (at < bytes.length) {
      this.#block.set(bytes.subarray(at), 0);
      this.#pending = bytes.length - at;
    }
  }

  /** Finish the message and return the 32-byte digest. The hasher must be reset before reuse. */
  digest(): Uint8Array {
    const bits = this.#length * 8;
    const tail = new Uint8Array(this.#pending < 56 ? 64 : 128);
    tail.set(this.#block.subarray(0, this.#pending));
    tail[this.#pending] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.#compress(tail, at);
    const out = new Uint8Array(32);
    const result = new DataView(out.buffer);
    for (let index = 0; index < 8; index++) result.setUint32(index * 4, this.#state[index]!);
    return out;
  }

  /** Finish the message and return the digest as 64 lowercase hex digits. */
  hex(): string {
    return Array.from(this.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Mix one 64-byte block that starts at `at` into the state; `bytes` is read, never kept. */
  #compress(bytes: Uint8Array, at: number): void {
    const w = this.#words;
    for (let index = 0; index < 16; index++) {
      const offset = at + index * 4;
      w[index] = bytes[offset]! << 24 | bytes[offset + 1]! << 16 | bytes[offset + 2]! << 8 | bytes[offset + 3]!;
    }
    for (let index = 16; index < 64; index++) {
      const a = w[index - 15]!;
      const b = w[index - 2]!;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3;
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10;
      w[index] = w[index - 16]! + s0 + w[index - 7]! + s1;
    }
    const s = this.#state;
    let a = s[0]!, b = s[1]!, c = s[2]!, d = s[3]!, e = s[4]!, f = s[5]!, g = s[6]!, h = s[7]!;
    for (let index = 0; index < 64; index++) {
      const t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + K[index]! + w[index]! | 0;
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    s[0] = s[0]! + a;
    s[1] = s[1]! + b;
    s[2] = s[2]! + c;
    s[3] = s[3]! + d;
    s[4] = s[4]! + e;
    s[5] = s[5]! + f;
    s[6] = s[6]! + g;
    s[7] = s[7]! + h;
  }
}
