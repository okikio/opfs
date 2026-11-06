/** Candidate-free inert acquisition. No downloaded module, hook or archived executable is run. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Refuse an unadmitted input before retaining or interpreting it further. */
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
/** Narrow parsed input or a native result without trusting its individual fields. */
export function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object record.");
  return value as Record<string, unknown>;
}
/** Admit one required string; domain-specific checks remain with its owner. */
export function text(value: unknown): string {
  check(typeof value === "string", "Expected a string.");
  return value;
}
/** Admit a nonnegative, exactly represented extent at or below the supplied cap. */
export function integer(value: unknown, maximum: number): number {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    "Invalid admitted extent.",
  );
  return value;
}
/** Hash exact retained bytes. SHA-1 is used only for upstream Git blob identity. */
export function digest(bytes: Uint8Array, algorithm = "sha256"): string {
  return createHash(algorithm).update(bytes).digest("hex");
}
/** Include Git's length-prefixed blob header when comparing an immutable source pin. */
export function gitBlob(bytes: Uint8Array): string {
  return createHash("sha1").update("blob " + bytes.byteLength + "\0").update(bytes).digest("hex");
}
/** Preserve a canonical relative identity; only directories may end in one slash. */
export function safe(name: string, directory = false): string {
  check(
    name.length > 0 && name.length <= 4096 && !name.startsWith("/") && !name.includes("\\") && !name.includes("\0"),
    "Unsafe acquired path.",
  );
  const value = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  check(
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Unsafe acquired path component.",
  );
  return value;
}
/** Write a fresh receipt/snapshot under the owned staging root, refusing replacement. */
export function snapshot(root: string, path: string, bytes: Uint8Array): void {
  safe(path);
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
}
/** Retain an authored JSON receipt separately from its unformatted original inputs. */
export function json(root: string, path: string, value: unknown): void {
  snapshot(root, path, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}

/** Fresh staging is published by rename only after admission succeeds; failed evidence remains separate. */
export async function output(path: string, work: (staging: string) => Promise<void>): Promise<void> {
  const staging = path + ".partial";
  check(!existsSync(path), "Acquisition output already exists.");
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(staging, { mode: 0o700 });
  try {
    await work(staging);
    check(!existsSync(path), "Acquisition output appeared during admission.");
    renameSync(staging, path);
  } catch (reason) {
    try {
      json(staging, "failure.json", {
        name: reason instanceof Error ? reason.name : typeof reason,
        message: String(reason).slice(0, 2048),
      });
    } catch (receipt) {
      throw new AggregateError([reason, receipt], "Admission failed and its failure receipt could not be retained.");
    }
    // A failed stage remains inspectable. It is never published as a successful acquisition.
    throw reason;
  }
}

/** One deadline covers headers, all body chunks and every permitted redirect. */
export async function fetchBytes(
  initial: string,
  maximum: number,
  deadline: number,
  redirect: (from: URL, to: URL) => boolean = () => false,
): Promise<Buffer<ArrayBuffer>> {
  let url = new URL(initial);
  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = deadline - Date.now();
    check(remaining > 0, "Whole acquisition deadline.");
    check(
      url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443"),
      "Acquisition HTTPS authority.",
    );
    const response = await globalThis.fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(Math.min(20_000, remaining)),
      headers: { "User-Agent": "opfs-inert-fixture-review" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      check(location && attempt < 3, "Unexpected or excessive acquisition redirect.");
      const target = new URL(location, url);
      check(redirect(url, target), "Unapproved redirect authority.");
      url = target;
      continue;
    }
    const declared = response.headers.get("content-length");
    if (response.status !== 200 || (declared !== null && !(/^\d+$/.test(declared) && Number(declared) <= maximum))) {
      await response.body?.cancel();
      throw new Error("Acquisition HTTP status/declared response ceiling: " + response.status);
    }
    check(response.body, "Acquisition omitted response body.");
    const reader = response.body.getReader(), pieces: Uint8Array[] = [];
    let count = 0, chunks = 0;
    try {
      for (;;) {
        check(Date.now() < deadline && ++chunks <= 65536, "Acquisition time/chunk ceiling.");
        const next = await reader.read();
        if (next.done) break;
        count += next.value.byteLength;
        check(count <= maximum, "Acquisition response ceiling.");
        pieces.push(next.value);
      }
      return Buffer.concat(pieces, count);
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }
  throw new Error("Acquisition redirect ceiling.");
}

/** One admitted TAR inventory row; data borrows the bounded expansion allocation. */
export interface MemberType {
  readonly name: string;
  readonly kind: "file" | "directory" | "link";
  readonly mode: number;
  readonly size: number;
  readonly data: Buffer<ArrayBuffer>;
  readonly pax: Readonly<Record<string, string>>;
}
const decoder = new TextDecoder("utf-8", { fatal: true });
function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes: Uint8Array): number {
  const value = field(bytes).trim();
  check(value === "" || /^[0-7]+$/.test(value), "Unsupported native TAR numeric encoding.");
  const number = value === "" ? 0 : Number.parseInt(value, 8);
  check(Number.isSafeInteger(number), "Inexact native TAR number.");
  return number;
}
function paxFields(bytes: Uint8Array): Record<string, string> {
  check(bytes.length <= 256 * 1024, "TAR extended metadata ceiling.");
  const result: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    check(space > at && space - at <= 8, "Invalid PAX length.");
    const lengthText = decoder.decode(bytes.subarray(at, space));
    check(/^[1-9]\d*$/.test(lengthText), "Invalid PAX decimal length.");
    const length = Number(lengthText), end = at + length;
    check(end <= bytes.length && end > space + 2 && bytes[end - 1] === 10, "PAX record extent.");
    const pair = decoder.decode(bytes.subarray(space + 1, end - 1)), equal = pair.indexOf("=");
    check(equal > 0, "PAX key/value framing.");
    const key = pair.slice(0, equal), value = pair.slice(equal + 1);
    check(
      !(key in result) && key.length <= 128 && value.length <= 8192 && Object.keys(result).length < 16,
      "PAX metadata inventory.",
    );
    result[key] = value;
    at = end;
  }
  return result;
}

/**
 * Bound gzip expansion before interpreting TAR headers. This acquisition-only
 * reader checks checksums and supports bounded PAX/GNU names; it never follows
 * links, writes archive paths or imports the production archive reader.
 */
export function tar(
  raw: Uint8Array,
  maximum: number,
  maxMembers: number,
): { readonly expandedBytes: number; readonly members: readonly MemberType[] } {
  const expanded = gunzipSync(raw, { maxOutputLength: maximum });
  check(expanded.length % 512 === 0, "TAR block alignment.");
  const members: MemberType[] = [], names = new Set<string>();
  let at = 0, declared = 0, physical = 0;
  let global: Record<string, string> = {}, local: Record<string, string> = {};
  while (at + 512 <= expanded.length) {
    const header = expanded.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      check(
        at + 1024 <= expanded.length && expanded.subarray(at).every((byte) => byte === 0),
        "TAR exact zero termination.",
      );
      check(Object.keys(local).length === 0, "Unconsumed TAR local metadata.");
      return { expandedBytes: expanded.length, members };
    }
    check(++physical <= maxMembers * 4, "TAR physical member ceiling.");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    check(checksum === octal(header.subarray(148, 156)), "TAR header checksum.");
    const type = header[156], rawSize = octal(header.subarray(124, 136));
    const prefix = field(header.subarray(345, 500));
    const rawName = (prefix ? prefix + "/" : "") + field(header.subarray(0, 100));
    const metadata = { ...global, ...local };
    check(metadata.size === undefined || /^\d+$/.test(metadata.size), "Invalid PAX decimal size.");
    const size = type === 120 || type === 103 || type === 76 || type === 75
      ? rawSize
      : metadata.size === undefined
      ? rawSize
      : integer(Number(metadata.size), maximum);
    check(size <= maximum && at + 512 + size <= expanded.length, "TAR declared member ceiling.");
    const data = expanded.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 120 || type === 103) {
      const value = paxFields(data);
      if (type === 103) global = { ...global, ...value };
      else local = { ...local, ...value };
      check(Object.keys(global).length <= 16 && Object.keys(local).length <= 16, "Aggregate PAX metadata ceiling.");
      continue;
    }
    if (type === 76 || type === 75) {
      check(data.length <= 8192, "GNU long-name ceiling.");
      local[type === 76 ? "path" : "linkpath"] = field(data);
      continue;
    }
    check(type === 0 || type === 48 || type === 53 || type === 49 || type === 50, "Unsupported acquired TAR entry.");
    const kind = type === 53 ? "directory" : type === 49 || type === 50 ? "link" : "file";
    const name = metadata.path ?? rawName, identity = safe(name, kind === "directory");
    check(!names.has(identity) && members.length < maxMembers, "Duplicate acquired TAR identity/member ceiling.");
    names.add(identity);
    check(kind === "file" || size === 0, "Special TAR entry contains payload.");
    const mode = octal(header.subarray(100, 108));
    check(!(mode & 0o6000), "Acquired set-ID mode.");
    declared += size;
    check(declared <= maximum, "TAR aggregate declared extent.");
    members.push({ name, kind, mode, size, data, pax: metadata });
    local = {};
  }
  throw new Error("Missing TAR zero termination.");
}
