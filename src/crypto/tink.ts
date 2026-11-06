import { sourceRange } from "../source.ts";
import type { ByteSourceType, SourceReadOptionsType } from "../source.ts";
import { isBytes, toView } from "../bytes.ts";

/** Raw high-entropy HKDF input, or a borrowed HKDF key with caller-declared input length. */
export type TinkKeyType = Uint8Array | { readonly key: CryptoKey; readonly size: number };

/** Explicit cryptographic capabilities and bounded profile selection. No global state is acquired on import. */
export interface TinkOptionsType {
  readonly subtle: SubtleCrypto;
  /** Must fill every byte using a cryptographically secure RNG. Deterministic fills belong only in tests. */
  readonly randomFill: (bytes: Uint8Array<ArrayBuffer>) => void;
  /** Tink ciphertext segment size, including the first header. Defaults to 1 MiB; implementation ceiling is 16 MiB. */
  readonly segmentBytes?: number;
  /** AES key length derived through HKDF-SHA256. Defaults to 32 bytes. */
  readonly derivedKeyBytes?: 16 | 32;
  /** Maximum plaintext allocation for one selected range. Defaults to 8 MiB. */
  readonly maxReadBytes?: number;
  /** Maximum covering segments in one selected read. Defaults to 64. */
  readonly maxSegmentsPerRead?: number;
  /** Maximum associated-data copy. Defaults to 64 KiB; the wire profile itself does not impose this policy. */
  readonly maxAssociatedDataBytes?: number;
  /** Maximum raw or declared HKDF input length. Defaults to 64 KiB. */
  readonly maxKeyBytes?: number;
}

/** Source consistency and cancellation policy for opening or encrypting one envelope. */
export interface TinkOpenOptionsType extends SourceReadOptionsType {
  /** Allows an otherwise undeclared source only under an explicit caller stability assertion. */
  readonly assumeStable?: boolean;
  /** Optional application-owned identity binding ciphertext snapshot, key context, AAD and profile for replay. */
  readonly identity?: string;
}

/** Evidence for one selected read, not a claim about unchecked segments. */
export interface TinkReadType {
  readonly bytes: Uint8Array;
  readonly scope: "authenticated-segments";
  readonly firstSegment: number;
  readonly segmentCount: number;
  readonly ciphertextBytes: number;
}

/** Opened plaintext source; each read authenticates every complete covering segment before returning. */
export interface TinkSourceType extends ByteSourceType {
  readonly profile: "tink-aes-gcm-hkdf-sha256";
  readonly finalSegmentVerified: true;
  readVerified(offset: number, length: number, options?: SourceReadOptionsType): Promise<TinkReadType>;
  /** Reads all encrypted segments under an explicit whole-ciphertext admission budget. */
  verify(options: SourceReadOptionsType & { readonly maxCiphertextBytes: number }): Promise<{
    readonly scope: "whole-envelope";
    readonly segments: number;
    readonly ciphertextBytes: number;
  }>;
}

/** A fixed SHA256, RAW-ciphertext profile. Tink keyset serialization and output prefixes are separate contracts. */
export interface TinkProfileType {
  readonly segmentBytes: number;
  readonly derivedKeyBytes: 16 | 32;
  readonly maxReadBytes: number;
  readonly maxSegmentsPerRead: number;
  readonly maxAssociatedDataBytes: number;
  readonly maxKeyBytes: number;
  ciphertextSize(plaintextSize: number): number;
  encrypt(
    source: ByteSourceType,
    key: TinkKeyType,
    associatedData?: Uint8Array,
    options?: TinkOpenOptionsType,
  ): ReadableStream<Uint8Array>;
  open(
    source: ByteSourceType,
    key: TinkKeyType,
    associatedData?: Uint8Array,
    options?: TinkOpenOptionsType,
  ): Promise<TinkSourceType>;
}

/** Structural, parameter or authentication failure; causes retain native crypto errors without exposing key material. */
export class TinkError extends Error {
  readonly code: "format" | "authentication" | "key" | "limit" | "stability";
  constructor(code: TinkError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TinkError";
    this.code = code;
  }
}

/** Checked arithmetic is required before allocations or nonce-index conversion. */
function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TinkError("limit", `${name} must be a nonnegative safe integer.`);
  }
}

/**
 * Native slots authorize key length; shadowed metadata must not admit a short
 * key or evade allocation policy. Copy before asynchronous derivation so the
 * caller cannot mutate the admitted raw input during credential work.
 */
function inputKey(input: TinkKeyType, derivedBytes: number, maxKeyBytes: number): Uint8Array<ArrayBuffer> | CryptoKey {
  if (isBytes(input)) {
    const bytes = toView(input);
    if (bytes.byteLength < derivedBytes) {
      throw new TinkError("key", "HKDF input key material is shorter than the derived AES key.");
    }
    if (bytes.byteLength > maxKeyBytes) throw new TinkError("limit", "HKDF input exceeds maxKeyBytes.");
    return new Uint8Array(bytes);
  }
  integer(input.size, "HKDF input key size");
  if (input.size > maxKeyBytes) throw new TinkError("limit", "Declared HKDF input exceeds maxKeyBytes.");
  const { key } = input;
  if (
    input.size < derivedBytes || key.type !== "secret" || key.algorithm.name !== "HKDF" ||
    (!key.usages.includes("deriveKey") && !key.usages.includes("deriveBits"))
  ) {
    throw new TinkError("key", "A borrowed key must be HKDF input with adequate declared length and derivation usage.");
  }
  return key;
}

/** Native extents, not caller-owned length getters, authorize associated-data allocation. */
function inputData(input: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (!isBytes(input)) throw new TinkError("format", "Associated data must be native Uint8Array bytes.");
  const bytes = toView(input);
  if (bytes.byteLength > maximum) throw new TinkError("limit", "Associated data exceeds maxAssociatedDataBytes.");
  return new Uint8Array(bytes);
}

/** HKDF associated data binds the entire file's derived key, not GCM's per-segment additionalData field. */
async function derive(
  subtle: SubtleCrypto,
  input: Uint8Array<ArrayBuffer> | CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<CryptoKey> {
  const material = input instanceof Uint8Array
    ? await subtle.importKey("raw", input, "HKDF", false, ["deriveKey"])
    : input;
  const parameters: HkdfParams = { name: "HKDF", hash: "SHA-256", salt, info };
  if (material.usages.includes("deriveKey")) {
    return await subtle.deriveKey(parameters, material, { name: "AES-GCM", length: bytes * 8 }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  const bits = new Uint8Array(await subtle.deriveBits(parameters, material, bytes * 8));
  try {
    return await subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bits.fill(0);
  }
}

/** Encodes the Tink nonce: seven-byte file prefix, uint32 big-endian index, finality byte. */
function nonce(prefix: Uint8Array, index: number, final: boolean): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new TinkError("limit", "Segment nonce index overflow.");
  }
  const value = new Uint8Array(12);
  value.set(prefix);
  new DataView(value.buffer).setUint32(7, index, false);
  value[11] = final ? 1 : 0;
  return value;
}

/** Multiple range reads need a source consistency contract; an identifier alone does not establish one. */
function stability(source: ByteSourceType, options: TinkOpenOptionsType): "immutable" | "provider" | "caller" {
  sourceRange(source.size, 0, 0);
  if (source.stability !== undefined) return source.stability;
  if (options.assumeStable) return "caller";
  throw new TinkError(
    "stability",
    "An encrypted source requires declared snapshot stability or explicit caller assertion.",
  );
}

/** Sources are borrowed and exact reads are checked at this composition boundary. */
async function read(
  source: ByteSourceType,
  offset: number,
  length: number,
  options: SourceReadOptionsType,
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const bytes = await source.read(offset, length, options);
  options.signal?.throwIfAborted();
  if (!isBytes(bytes)) {
    throw new TinkError("format", "Cipher/source range was truncated or oversized.");
  }
  const view = toView(bytes);
  if (view.byteLength !== length) throw new TinkError("format", "Cipher/source range was truncated or oversized.");
  return view;
}

/**
 * Creates the exact Tink AES-GCM-HKDF SHA256 framing profile with zero first-segment offset.
 *
 * Primitives and randomness are explicit borrowed capabilities. Configuration
 * never authenticates a key or starts I/O. Ciphertext carries only header and
 * segment data, so callers retain profile parameters and associated data.
 */
export function createTink(options: TinkOptionsType): TinkProfileType {
  const segmentBytes = options.segmentBytes ?? 1024 * 1024;
  const derivedKeyBytes = options.derivedKeyBytes ?? 32;
  const maxReadBytes = options.maxReadBytes ?? 8 * 1024 * 1024;
  const maxSegmentsPerRead = options.maxSegmentsPerRead ?? 64;
  const maxAssociatedDataBytes = options.maxAssociatedDataBytes ?? 64 * 1024;
  const maxKeyBytes = options.maxKeyBytes ?? 64 * 1024;
  const headerBytes = derivedKeyBytes + 8;
  integer(segmentBytes, "segmentBytes");
  integer(maxReadBytes, "maxReadBytes");
  integer(maxSegmentsPerRead, "maxSegmentsPerRead");
  integer(maxAssociatedDataBytes, "maxAssociatedDataBytes");
  integer(maxKeyBytes, "maxKeyBytes");
  if (
    ![16, 32].includes(derivedKeyBytes) || segmentBytes <= headerBytes + 16 || segmentBytes > 16 * 1024 * 1024 ||
    maxReadBytes === 0 || maxSegmentsPerRead === 0 || maxKeyBytes < derivedKeyBytes
  ) {
    throw new TinkError("limit", "Invalid Tink key size, segment size or selected-read budget.");
  }
  const capacity = segmentBytes - 16;
  const firstCapacity = capacity - headerBytes;
  const subtle = options.subtle;
  const randomFill = options.randomFill;

  /** All non-final segments are maximal; empty input still has one authenticated final segment. */
  function plaintextLayout(length: number): { segments: number; size: number } {
    integer(length, "plaintextSize");
    const segments = 1 + Math.ceil(Math.max(0, length - firstCapacity) / capacity);
    if (segments > 0x100000000) throw new TinkError("limit", "Tink permits at most 2^32 segments.");
    const size = length + headerBytes + segments * 16;
    integer(size, "ciphertextSize");
    return { segments, size };
  }

  return Object.freeze<TinkProfileType>({
    segmentBytes,
    derivedKeyBytes,
    maxReadBytes,
    maxSegmentsPerRead,
    maxAssociatedDataBytes,
    maxKeyBytes,
    ciphertextSize: (length) => plaintextLayout(length).size,
    encrypt(source, key, associatedData = new Uint8Array(), settings = {}) {
      stability(source, settings);
      const plaintextSize = source.size;
      const layout = plaintextLayout(plaintextSize);
      const info = inputData(associatedData, maxAssociatedDataBytes);
      const material = inputKey(key, derivedKeyBytes, maxKeyBytes);
      const controller = new AbortController();
      const signal = settings.signal === undefined
        ? controller.signal
        : AbortSignal.any([settings.signal, controller.signal]);
      let header: Uint8Array<ArrayBuffer> | undefined;
      let derived: CryptoKey | undefined;
      let index = 0;
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            signal.throwIfAborted();
            if (header === undefined) {
              header = new Uint8Array(headerBytes);
              header[0] = headerBytes;
              randomFill(header.subarray(1));
              try {
                derived = await derive(subtle, material, header.slice(1, 1 + derivedKeyBytes), info, derivedKeyBytes);
              } finally {
                if (material instanceof Uint8Array) material.fill(0);
              }
              signal.throwIfAborted();
              output.enqueue(header.slice());
              return;
            }
            const length = Math.min(index === 0 ? firstCapacity : capacity, plaintextSize - offset);
            const plaintext = length === 0 ? new Uint8Array() : await read(source, offset, length, { signal });
            const final = index === layout.segments - 1;
            const encrypted = await subtle.encrypt(
              { name: "AES-GCM", iv: nonce(header.subarray(1 + derivedKeyBytes), index, final), tagLength: 128 },
              derived!,
              new Uint8Array(plaintext),
            );
            signal.throwIfAborted();
            output.enqueue(new Uint8Array(encrypted));
            offset += length;
            index++;
            if (final) output.close();
          } catch (reason) {
            if (!signal.aborted) output.error(reason);
            else output.error(signal.reason);
          }
        },
        cancel(reason) {
          controller.abort(reason);
        },
      }, { highWaterMark: 0 });
    },
    async open(source, key, associatedData = new Uint8Array(), settings = {}) {
      const sourceStability = stability(source, settings);
      settings.signal?.throwIfAborted();
      const info = inputData(associatedData, maxAssociatedDataBytes);
      const material = inputKey(key, derivedKeyBytes, maxKeyBytes);
      const ciphertextSize = source.size;
      sourceRange(ciphertextSize, 0, 0);
      if (ciphertextSize < headerBytes + 16) {
        throw new TinkError("format", "Encrypted source is shorter than its header and final tag.");
      }
      const segments = Math.ceil(ciphertextSize / segmentBytes);
      if (segments > 0x100000000) throw new TinkError("limit", "Tink segment count exceeds the nonce index range.");
      const lastBytes = ciphertextSize - (segments - 1) * segmentBytes - (segments === 1 ? headerBytes : 0);
      if (lastBytes < 16 || (segments > 1 && lastBytes === 16)) {
        throw new TinkError("format", "Invalid final Tink segment size.");
      }
      const size = ciphertextSize - headerBytes - segments * 16;
      const header = new Uint8Array(await read(source, 0, headerBytes, settings));
      if (header[0] !== headerBytes) {
        throw new TinkError("format", "Header length does not match the selected Tink profile.");
      }
      let derived: CryptoKey;
      try {
        derived = await derive(subtle, material, header.slice(1, 1 + derivedKeyBytes), info, derivedKeyBytes);
      } finally {
        if (material instanceof Uint8Array) material.fill(0);
      }

      /** Never expose speculative plaintext. GCM resolves only after its complete segment tag passes. */
      async function segment(
        index: number,
        readOptions: SourceReadOptionsType,
      ): Promise<{ plaintext: Uint8Array; bytes: number }> {
        const at = index === 0 ? headerBytes : index * segmentBytes;
        const length = Math.min(segmentBytes, ciphertextSize - index * segmentBytes) - (index === 0 ? headerBytes : 0);
        const ciphertext = await read(source, at, length, readOptions);
        readOptions.signal?.throwIfAborted();
        try {
          const plaintext = new Uint8Array(
            await subtle.decrypt(
              {
                name: "AES-GCM",
                iv: nonce(header.subarray(1 + derivedKeyBytes), index, index === segments - 1),
                tagLength: 128,
              },
              derived,
              new Uint8Array(ciphertext),
            ),
          );
          readOptions.signal?.throwIfAborted();
          return { plaintext, bytes: ciphertext.length };
        } catch (cause) {
          readOptions.signal?.throwIfAborted();
          throw new TinkError("authentication", "Encrypted segment authentication failed.", { cause });
        }
      }

      // Authenticate finality before callers can use the computed plaintext length
      // for EOF-relative access. This checks the last unit, not all earlier units.
      const final = await segment(segments - 1, settings);
      final.plaintext.fill(0);

      async function readVerified(
        offset: number,
        length: number,
        readOptions: SourceReadOptionsType = {},
      ): Promise<TinkReadType> {
        readOptions.signal?.throwIfAborted();
        sourceRange(size, offset, length);
        if (length > maxReadBytes) throw new TinkError("limit", "Selected plaintext range exceeds maxReadBytes.");
        const first = offset < firstCapacity ? 0 : 1 + Math.floor((offset - firstCapacity) / capacity);
        if (length === 0) {
          return {
            bytes: new Uint8Array(),
            scope: "authenticated-segments",
            firstSegment: Math.min(first, segments - 1),
            segmentCount: 0,
            ciphertextBytes: 0,
          };
        }
        const lastOffset = offset + length - 1;
        const last = lastOffset < firstCapacity ? 0 : 1 + Math.floor((lastOffset - firstCapacity) / capacity);
        if (last - first + 1 > maxSegmentsPerRead) {
          throw new TinkError("limit", "Selected range exceeds maxSegmentsPerRead.");
        }
        const output = new Uint8Array(length);
        let written = 0;
        let ciphertextBytes = 0;
        try {
          for (let index = first; index <= last; index++) {
            const result = await segment(index, readOptions);
            try {
              const base = index === 0 ? 0 : firstCapacity + (index - 1) * capacity;
              const from = Math.max(offset - base, 0);
              const count = Math.min(result.plaintext.length - from, length - written);
              output.set(result.plaintext.subarray(from, from + count), written);
              written += count;
              ciphertextBytes += result.bytes;
            } finally {
              result.plaintext.fill(0);
            }
          }
          return {
            bytes: output,
            scope: "authenticated-segments",
            firstSegment: first,
            segmentCount: last - first + 1,
            ciphertextBytes,
          };
        } catch (reason) {
          output.fill(0);
          throw reason;
        }
      }

      return {
        size,
        ...(settings.identity === undefined ? {} : { identity: settings.identity }),
        stability: sourceStability,
        profile: "tink-aes-gcm-hkdf-sha256",
        finalSegmentVerified: true,
        readVerified,
        read: async (offset, length, readOptions) => (await readVerified(offset, length, readOptions)).bytes,
        async verify(verifyOptions) {
          integer(verifyOptions.maxCiphertextBytes, "maxCiphertextBytes");
          if (ciphertextSize > verifyOptions.maxCiphertextBytes) {
            throw new TinkError("limit", "Whole-envelope verification exceeds its ciphertext budget.");
          }
          let ciphertextBytes = 0;
          for (let index = 0; index < segments; index++) {
            const result = await segment(index, verifyOptions);
            ciphertextBytes += result.bytes;
            result.plaintext.fill(0);
          }
          return { scope: "whole-envelope", segments, ciphertextBytes };
        },
      };
    },
  });
}

/** Acquires native WebCrypto only when explicitly called; the resulting profile has no global registry or background work. */
export function createNativeTink(options: Omit<TinkOptionsType, "subtle" | "randomFill"> = {}): TinkProfileType {
  const crypto = globalThis.crypto;
  if (crypto?.subtle === undefined) {
    throw new TinkError("key", "Native WebCrypto is unavailable; inject explicit capabilities.");
  }
  return createTink({
    ...options,
    subtle: crypto.subtle,
    randomFill: (bytes) => {
      crypto.getRandomValues(bytes);
    },
  });
}
