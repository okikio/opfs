/** Internal UnixFS routing hash. This noncryptographic algorithm never verifies content. @module */

/** Seed-zero MurmurHash3 x64-128, first word serialized big-endian as Boxo's New64().Sum does.
 * The caller admits the native input and arithmetic work before this synchronous operation.
 * Arithmetic is modulo 2^64; input words are little-endian and the returned eight bytes are owned.
 * This is a TypeScript reimplementation of Austin Appleby's public-domain algorithm, pinned at
 * aappleby/smhasher 07bb4de10a63e8cc2e1724865454eba635742383, src/MurmurHash3.cpp.
 */
export function murmur(bytes: Uint8Array): Uint8Array {
  const mask = 0xffffffffffffffffn, c1 = 0x87c37b91114253d5n, c2 = 0x4cf5ad432745937fn;
  const rotate = (value: bigint, shift: bigint): bigint => ((value << shift) | (value >> (64n - shift))) & mask;
  const mix = (value: bigint): bigint => {
    value = ((value ^ (value >> 33n)) * 0xff51afd7ed558ccdn) & mask;
    value = ((value ^ (value >> 33n)) * 0xc4ceb9fe1a85ec53n) & mask;
    return value ^ (value >> 33n);
  };
  const word = (offset: number, length: number): bigint => {
    let value = 0n;
    for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]!);
    return value;
  };
  let h1 = 0n, h2 = 0n, offset = 0;
  for (; offset + 16 <= bytes.length; offset += 16) {
    let k1 = (word(offset, 8) * c1) & mask, k2 = (word(offset + 8, 8) * c2) & mask;
    k1 = (rotate(k1, 31n) * c2) & mask;
    h1 = rotate(h1 ^ k1, 27n);
    h1 = (((h1 + h2) & mask) * 5n + 0x52dce729n) & mask;
    k2 = (rotate(k2, 33n) * c1) & mask;
    h2 = rotate(h2 ^ k2, 31n);
    h2 = (((h2 + h1) & mask) * 5n + 0x38495ab5n) & mask;
  }
  const left = bytes.length - offset;
  if (left > 8) {
    const k2 = (word(offset + 8, left - 8) * c2) & mask;
    h2 ^= (rotate(k2, 33n) * c1) & mask;
  }
  if (left) {
    const k1 = (word(offset, Math.min(8, left)) * c1) & mask;
    h1 ^= (rotate(k1, 31n) * c2) & mask;
  }
  h1 ^= BigInt(bytes.length);
  h2 ^= BigInt(bytes.length);
  h1 = (h1 + h2) & mask;
  h2 = (h2 + h1) & mask;
  h1 = mix(h1);
  h2 = mix(h2);
  h1 = (h1 + h2) & mask;
  const result = new Uint8Array(8);
  for (let i = 0; i < 8; i++) result[i] = Number((h1 >> BigInt(56 - i * 8)) & 255n);
  return result;
}
