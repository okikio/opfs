/** Bounded CID syntax and block integrity, independent of a gateway or DAG decoder. @module */
import { decodeBase32, encodeBase32 } from "@std/encoding/base32";
import { decodeBase58, encodeBase58 } from "@std/encoding/base58";
import { decodeHex } from "@std/encoding/hex";
import { isBytes, toView } from "../bytes.ts";

/** Implementation admission bound, including digest and varint fields. */
export const MAX_CID_BYTES = 256;

/** Parsed wire fields. Codec/hash numbers are opaque; parsing does not imply decoder support.
 * Byte arrays are owned copies. `id` is canonical CIDv1 base32, including for CIDv0 input.
 */
export interface CidType {
  readonly version: 0 | 1;
  readonly codec: number;
  readonly hashCode: number;
  readonly digest: Uint8Array;
  readonly bytes: Uint8Array;
  readonly id: string;
}

/** Reads one minimal unsigned LEB128 value in the safe-integer domain.
 * Used by CID and CAR framing; a truncated or overlong field is never clamped.
 */
export function readUnsigned(bytes: Uint8Array, offset = 0): { readonly value: number; readonly length: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) throw new RangeError("Missing varint.");
  let value = 0;
  let scale = 1;
  for (let count = 0; count < 8 && offset + count < bytes.length; count++) {
    const byte = bytes[offset + count]!;
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) throw new RangeError("Varint exceeds the safe integer domain.");
    if (byte < 128) {
      if (count > 0 && byte === 0) throw new TypeError("Non-minimal varint.");
      return { value, length: count + 1 };
    }
    scale *= 128;
  }
  throw new TypeError("Truncated or oversized varint.");
}

/** Formats CIDv1 bytes without padding; this supplies one identity across supported text bases. */
function base32(bytes: Uint8Array): string {
  return `b${encodeBase32(bytes).replace(/=+$/, "").toLowerCase()}`;
}

/** Reads one CID prefix from a CAR section. Remaining section bytes belong to the block.
 * At most 256 CID bytes are inspected, even if the section contains a large payload.
 */
export function readCid(input: Uint8Array): { readonly cid: CidType; readonly length: number } {
  if (!isBytes(input)) throw new TypeError("CID input must be a Uint8Array.");
  // Parse one owned prefix so later source mutation cannot change fields between
  // parsing and identity construction. Shared-memory copying is not an atomic snapshot.
  const bytes = new Uint8Array(toView(input).subarray(0, MAX_CID_BYTES));
  let offset = 0;
  let version: 0 | 1;
  let codec: number;
  if (bytes[0] === 0x12 && bytes[1] === 0x20) {
    version = 0;
    codec = 0x70;
  } else {
    const field = readUnsigned(bytes);
    if (field.value !== 1) throw new TypeError("Only CIDv0 and CIDv1 are supported.");
    version = 1;
    offset = field.length;
    const format = readUnsigned(bytes, offset);
    codec = format.value;
    offset += format.length;
  }
  const hash = readUnsigned(bytes, offset);
  offset += hash.length;
  const size = readUnsigned(bytes, offset);
  offset += size.length;
  if (size.value > MAX_CID_BYTES - offset || size.value > bytes.length - offset) {
    throw new RangeError("CID digest is truncated or exceeds the CID byte limit.");
  }
  const length = offset + size.value;
  const wire = new Uint8Array(bytes.subarray(0, length));
  const canonical = version === 1 ? wire : new Uint8Array([1, 0x70, ...wire]);
  return {
    length,
    cid: Object.freeze({
      version,
      codec,
      hashCode: hash.value,
      digest: wire.slice(offset),
      bytes: wire,
      id: base32(canonical),
    }),
  };
}

/** Parses a whole CID, rejecting trailing bytes and noncanonical text.
 * Text supports CIDv0, CIDv1 base32lower (`b`), base58btc (`z`) and base16lower (`f`).
 * Other multibases are deliberately unsupported. No URI, path or whitespace is accepted.
 */
export function parseCid(input: string | Uint8Array): CidType {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    if (input.length === 0 || input.length > 512) throw new RangeError("CID text exceeds the implementation limit.");
    if (input.length === 46 && input.startsWith("Qm")) {
      bytes = decodeBase58(input);
      if (encodeBase58(bytes) !== input) throw new TypeError("Noncanonical CIDv0 text.");
    } else if (/^b[a-z2-7]+$/.test(input)) {
      const text = input.slice(1).toUpperCase();
      bytes = decodeBase32(text.padEnd(Math.ceil(text.length / 8) * 8, "="));
      if (base32(bytes) !== input) throw new TypeError("Noncanonical base32 CID.");
    } else if (/^z[1-9A-HJ-NP-Za-km-z]+$/.test(input)) {
      bytes = decodeBase58(input.slice(1));
      if (`z${encodeBase58(bytes)}` !== input) throw new TypeError("Noncanonical base58 CID.");
    } else if (/^f(?:[0-9a-f]{2})+$/.test(input)) {
      bytes = decodeHex(input.slice(1));
    } else throw new TypeError("Unsupported or malformed CID text.");
    if (!(input.length === 46 && input.startsWith("Qm")) && bytes[0] !== 1) {
      throw new TypeError("Multibase CID text must contain CIDv1.");
    }
  } else {
    if (!isBytes(input)) throw new TypeError("CID input must be a string or Uint8Array.");
    bytes = toView(input);
  }
  if (bytes.byteLength > MAX_CID_BYTES) throw new RangeError("CID exceeds the implementation byte limit.");
  const result = readCid(bytes);
  if (result.length !== bytes.byteLength) throw new TypeError("Trailing CID bytes.");
  return result.cid;
}

/** Verifies a complete serialized block, never a UnixFS file range or reconstructed representation.
 * Only full SHA2-256 (code 0x12, 32-byte digest) is supported. The default block
 * allocation bound is 8 MiB. Input bytes are copied before asynchronous hashing;
 * cancellation is checked before and after Web Crypto, which cannot be interrupted.
 */
export async function verifyBlock(
  cid: string | Uint8Array,
  input: Uint8Array,
  options: { readonly signal?: AbortSignal; readonly maxBytes?: number } = {},
): Promise<void> {
  const { signal, maxBytes = 8 * 1024 * 1024 } = options;
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid block byte limit.");
  const parsed = parseCid(cid);
  if (parsed.hashCode !== 0x12 || parsed.digest.length !== 32) throw new TypeError("Unsupported CID multihash.");
  if (!isBytes(input)) throw new TypeError("Block input must be a Uint8Array.");
  const view = toView(input);
  if (view.byteLength > maxBytes) throw new RangeError("Block exceeds its byte limit.");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(view)));
  signal?.throwIfAborted();
  if (digest.some((byte, index) => byte !== parsed.digest[index])) throw new TypeError("CID block digest mismatch.");
}
