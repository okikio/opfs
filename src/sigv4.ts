/** Internal AWS cryptography; callers own canonical bytes, credentials, clocks, and transport. @module */
import { encodeHex } from "@std/encoding/hex";

/** Hashes supplied bytes with the explicitly borrowed authority. No input ownership transfers. */
export async function sha256(subtle: SubtleCrypto, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

/** Encodes a digest in the lowercase hexadecimal form required by AWS headers. */
export function hex(bytes: Uint8Array): string {
  return encodeHex(bytes).toLowerCase();
}

/** One HMAC step; the imported key is local and is never installed in a global cache. */
export async function hmac(subtle: SubtleCrypto, key: BufferSource, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
}

/** Service is explicit so an S3 signing key cannot accidentally authorize Glacier. */
export async function signingKey(
  subtle: SubtleCrypto,
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const day = await hmac(subtle, new TextEncoder().encode(`AWS4${secret}`), date);
  const regional = await hmac(subtle, day, region);
  const scoped = await hmac(subtle, regional, service);
  return await hmac(subtle, scoped, "aws4_request");
}
