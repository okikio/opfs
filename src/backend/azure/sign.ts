/**
 * Shared Key and bearer authorization for the Azure Blob client.
 *
 * These helpers build the canonical headers, canonical resource and string to
 * sign, and compute the Shared Key signature. They hold no state.
 *
 * @module
 */
import { atLeast, EMPTY_HEADER_VERSION, ZERO_CONTENT_LENGTH_VERSION } from "./limits.ts";
import type { AzureStorageVersionType } from "./types.ts";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { isBuffer, toView } from "../../bytes.ts";

/** Shared UTF-8 encoder used by block IDs and Shared Key signing. */
export const textEncoder = new TextEncoder();

/** Percent-encodes one blob name while preserving virtual-directory separators. */
export function encodePath(value: string): string {
  return value.split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** Compares protocol strings by code-unit order rather than locale collation. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Normalizes HTTP linear whitespace for Azure Shared Key canonicalization.
 *
 * Azure collapses linear whitespace outside quoted strings but preserves the
 * contents of quoted strings. A global whitespace regular expression would
 * therefore change a signed metadata value such as `"two  spaces"` and produce
 * an authorization value that Azure does not recognize.
 */
export function normalizeHeaderValue(value: string): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  let pendingSpace = false;

  for (const character of value) {
    if (quoted) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }

    if (character === '"') {
      if (pendingSpace && result.length > 0) result += " ";
      pendingSpace = false;
      quoted = true;
      result += character;
      continue;
    }

    if (character === " " || character === "\t" || character === "\r" || character === "\n") {
      pendingSpace = result.length > 0;
      continue;
    }

    if (pendingSpace && result.length > 0) result += " ";
    pendingSpace = false;
    result += character;
  }

  return result;
}

/** Returns canonical `x-ms-*` headers sorted exactly as Shared Key requires. */
export function getCanonicalHeaders(headers: Headers, version: AzureStorageVersionType): string {
  return [...headers.entries()]
    .filter(([name]) => name.toLowerCase().startsWith("x-ms-"))
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .filter(([, value]) => atLeast(version, EMPTY_HEADER_VERSION) || value.length > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
}

/**
 * Returns the Shared Key canonical resource, including repeated query values.
 *
 * Azurite endpoints contain `/devstoreaccount1` in the URL path. Prefixing the
 * account name therefore produces the documented duplicated emulator account
 * segment without special-case string construction.
 */
export function getCanonicalResource(url: URL, account: string): string {
  const valuesByName = new Map<string, string[]>();
  for (const [rawName, value] of url.searchParams) {
    const name = rawName.toLowerCase();
    const values = valuesByName.get(name) ?? [];
    values.push(value);
    valuesByName.set(name, values);
  }

  let result = `/${account}${url.pathname}`;
  for (const name of [...valuesByName.keys()].sort(compareText)) {
    const values = valuesByName.get(name)!.sort(compareText);
    result += `\n${name}:${values.join(",")}`;
  }
  return result;
}

/** Returns a deterministic request-body length when Web Fetch exposes one. */
export function getBodyLength(body: BodyInit | null | undefined): number | undefined {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return textEncoder.encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (isBuffer(body)) return new Uint8Array(body).byteLength;
  if (ArrayBuffer.isView(body)) return toView(body).byteLength;
  if (body instanceof URLSearchParams) return textEncoder.encode(body.toString()).byteLength;
  return undefined;
}

/** Returns the service-version-specific Content-Length field used by Shared Key signing. */
export function getSignedContentLength(headers: Headers, version: AzureStorageVersionType): string {
  const value = headers.get("content-length") ?? "";
  if (value !== "0") return value;
  return version <= ZERO_CONTENT_LENGTH_VERSION ? "0" : "";
}

/** Builds the Blob service Shared Key `StringToSign`. */
export function getStringToSign(
  method: string,
  url: URL,
  headers: Headers,
  account: string,
  version: AzureStorageVersionType,
): string {
  const lines = [
    method.toUpperCase(),
    headers.get("content-encoding") ?? "",
    headers.get("content-language") ?? "",
    getSignedContentLength(headers, version),
    headers.get("content-md5") ?? "",
    headers.get("content-type") ?? "",
    "", // x-ms-date is used, so the Date line is empty.
    headers.get("if-modified-since") ?? "",
    headers.get("if-match") ?? "",
    headers.get("if-none-match") ?? "",
    headers.get("if-unmodified-since") ?? "",
    headers.get("range") ?? "",
  ];
  return `${lines.join("\n")}\n${getCanonicalHeaders(headers, version)}${getCanonicalResource(url, account)}`;
}

/** Signs one Shared Key request with HMAC-SHA256 and Base64 output. */
export async function getSharedKeyAuthorization(
  method: string,
  url: URL,
  headers: Headers,
  account: string,
  key: string,
  version: AzureStorageVersionType,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    decodeBase64(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    textEncoder.encode(getStringToSign(method, url, headers, account, version)),
  );
  return `SharedKey ${account}:${encodeBase64(new Uint8Array(signature))}`;
}

/** Resolves a static or refreshable Microsoft Entra bearer token. */
export async function getBearerToken(value: string | (() => string | Promise<string>)): Promise<string> {
  return typeof value === "function" ? await value() : value;
}
