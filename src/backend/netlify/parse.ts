/**
 * Checks for Netlify Blobs keys, ETags, signed URLs and JSON bodies.
 *
 * Each helper takes one value from a caller or a response and returns it checked,
 * or throws a `NetlifyError`. None of them does I/O.
 *
 * @module
 */
import { NetlifyError } from "./error.ts";

export function fail(code: NetlifyError["code"], phase: "api" | "data", status?: number): never {
  throw new NetlifyError(code, phase, status);
}

/** Reject ill-formed UTF-16 instead of letting TextEncoder silently replace key/token identity. */
export function text(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed() || new TextEncoder().encode(value).length > maximum) {
    throw new TypeError(`Netlify ${label} must be bounded well-formed text without controls.`);
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) throw new TypeError(`Netlify ${label} must not contain control characters.`);
  }
  return value;
}

/** Keep each actionable key inside the qualified URL-path subset; never rewrite a provider identity. */
export function key(value: string): string {
  text(value, 600, "key");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value)) {
    throw new TypeError("Netlify key is outside the qualified ASCII segment profile.");
  }
  return value;
}

export function etag(value: string): string {
  text(value, 4096, "ETag");
  if (value.length === 0) throw new TypeError("Netlify conditional ETag must not be empty.");
  return value;
}

/** Validate without reserializing: changing a signed URL's spelling can invalidate its capability. */
export function address(value: string, allowHttp: boolean): string {
  if (typeof value !== "string" || value.length > 16384) throw new TypeError("Netlify URL must be a bounded string.");
  text(value, 16384, "URL");
  if (/\s/.test(value)) throw new TypeError("Netlify URL must not contain unescaped whitespace.");
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) || url.username || url.password || url.hash
  ) throw new TypeError("Netlify URL authority is not permitted.");
  return value;
}

/** Bound parsed JSON structure separately from its serialized-byte ceiling. */
export function json(bytes: Uint8Array, phase: "api" | "data"): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    fail("invalid-response", phase);
  }
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 16) fail("budget-exceeded", phase);
    if (typeof item === "number" && !Number.isFinite(item)) fail("invalid-response", phase);
    if (Array.isArray(item)) { for (const child of item) inspect(child, depth + 1); }
    else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  return value;
}

export function object(value: unknown, phase: "api" | "data"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid-response", phase);
  return value as Record<string, unknown>;
}
