/**
 * Deno KV size limits, driver defaults and size-policy checks.
 *
 * @module
 */
import type { DenoKvKeyType } from "./types.ts";

/** Maximum serialized Deno KV key size documented by the runtime. */
export const DENO_KV_MAX_KEY_BYTES = 2 * 1024;

/** Maximum serialized Deno KV value size documented by the runtime. */
export const DENO_KV_MAX_VALUE_BYTES = 64 * 1024;

/** Maximum total serialized size of one Deno KV atomic operation. */
export const DENO_KV_MAX_ATOMIC_BYTES = 800 * 1024;

/** Conservative raw Uint8Array payload budget below the serialized 64 KiB provider ceiling. */
export const DENO_KV_SAFE_PART_BYTES = 60 * 1024;

/** Conservative decoded inline body budget after base64 expansion and record metadata. */
export const DENO_KV_SAFE_INLINE_BYTES = 40 * 1024;

/** Conservative decoded payload kept in one raw binary part. */
export const DENO_KV_DEFAULT_PART_BYTES = 48 * 1024;

/** Conservative decoded payload kept inline with filesystem metadata. */
export const DENO_KV_DEFAULT_INLINE_BYTES = 32 * 1024;

/** Explicit safety ceiling that prevents one logical file from creating unbounded keys. */
export const DENO_KV_DEFAULT_MAX_PARTS = 10_000;

/** Default concurrent exact reads/deletes for partitioned file bodies. */
export const DENO_KV_DEFAULT_CONCURRENCY = 8;

/** Default grace period before superseded or unpublished physical generations are eligible for collection. */
export const DENO_KV_DEFAULT_COLLECT_AGE_MS = 60 * 60 * 1000;

/** Default deletion budget for one explicit collection pass. */
export const DENO_KV_DEFAULT_COLLECT_DELETES = 10_000;

/** Validates a positive safe integer configuration value. */
export function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  return resolved;
}

/** Validates physical part policy before any derived logical-size arithmetic is used. */
export function validateSizePolicy(partBytes: number, inlineBytes: number, maxParts: number): void {
  if (partBytes > DENO_KV_SAFE_PART_BYTES) {
    throw new RangeError(
      `partBytes must be <= ${DENO_KV_SAFE_PART_BYTES} bytes so serialization overhead stays below ` +
        `Deno KV's ${DENO_KV_MAX_VALUE_BYTES}-byte value ceiling.`,
    );
  }
  if (inlineBytes > DENO_KV_SAFE_INLINE_BYTES) {
    throw new RangeError(
      `inlineBytes must be <= ${DENO_KV_SAFE_INLINE_BYTES} decoded bytes so base64 data plus record metadata ` +
        "stays below Deno KV's serialized value ceiling.",
    );
  }
  if (maxParts > Math.floor(Number.MAX_SAFE_INTEGER / partBytes)) {
    throw new RangeError("maxParts and partBytes must produce an exactly representable logical file-size limit.");
  }
}

/** UTF-8 encoder used for conservative Deno KV tuple-size planning. */
export const keyEncoder = new TextEncoder();

/** Conservatively estimates serialized tuple bytes for the key component types used here. */
export function estimateKeyBytes(value: DenoKvKeyType): number {
  let bytes = 0;
  for (const component of value) {
    bytes += 16;
    if (typeof component === "string") bytes += keyEncoder.encode(component).byteLength;
    else if (typeof component === "number") bytes += 8;
    else bytes += 32;
  }
  return bytes;
}
