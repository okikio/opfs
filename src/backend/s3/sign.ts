/**
 * Signature Version 4 request signing for the S3 client.
 *
 * These helpers build the canonical query string, encode paths, hash payloads and
 * derive the signing key. They hold no state.
 *
 * @module
 */
import type { S3RequestOptionsType } from "./types.ts";
import { encodeHex } from "@std/encoding/hex";
import { deriveSigningKey, hmac } from "../../sigv4.ts";
import { isBuffer, toView } from "../../bytes.ts";

/** Shared UTF-8 encoder used by SigV4 hashing and HMAC derivation. */
export const textEncoder = new TextEncoder();

/** SHA-256 of an empty payload, required by SigV4 for requests without a body. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Compares canonical protocol strings without locale-sensitive collation. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Percent-encodes one Signature Version 4 component using RFC 3986's unreserved set. */
export function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes a slash-delimited path while retaining path separators required by S3. */
export function encodePath(value: string): string {
  return value.split("/").map(encode).join("/");
}

/** Builds the canonical query string required by Signature Version 4. */
export function getQueryString(query: S3RequestOptionsType["query"]): string {
  const pairs: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) pairs.push([encode(name), encode(item)]);
  }
  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => {
    const nameOrder = compareText(leftName, rightName);
    return nameOrder === 0 ? compareText(leftValue, rightValue) : nameOrder;
  });
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/** Returns lowercase hexadecimal SHA-256 for one request payload. */
export async function getSha256(value: BufferSource | string): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).toLowerCase();
}

/**
 * Returns the SigV4 payload hash for one Web Fetch body.
 *
 * Replayable materialized values are hashed before the request is sent. A
 * `ReadableStream` or `FormData` body is not consumed because doing so would
 * either destroy the caller's stream or require us to reproduce Fetch's
 * multipart encoding. S3 explicitly permits `UNSIGNED-PAYLOAD` for those
 * request shapes, and callers can still provide an exact `payloadHash` through
 * {@link S3RequestOptionsType} when a provider or policy requires one.
 */
export async function getPayloadHash(body: BodyInit | null | undefined): Promise<string> {
  if (body === undefined || body === null) return EMPTY_SHA256;
  if (typeof body === "string") return await getSha256(body);
  if (isBuffer(body)) return await getSha256(body);
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(toView(body));
    return await getSha256(bytes);
  }
  if (body instanceof Blob) return await getSha256(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return await getSha256(body.toString());
  return "UNSIGNED-PAYLOAD";
}

/** Computes one HMAC-SHA256 step in the Signature Version 4 key derivation. */
export async function getHmac(key: BufferSource, value: string): Promise<Uint8Array> {
  return await hmac(crypto.subtle, key, value);
}

/** Derives the date, region, and service-specific Signature Version 4 signing key. */
export async function getSigningKey(secret: string, date: string, region: string): Promise<Uint8Array> {
  return await deriveSigningKey(crypto.subtle, secret, date, region, "s3");
}

/** Formats one UTC instant as the compact timestamp required by Signature Version 4. */
export function getAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Normalizes header whitespace before canonical signing. */
export function getHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
