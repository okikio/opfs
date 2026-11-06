/** Verified bounded Git loose objects and raw tree-entry codecs, without repository discovery. @module */
import { isBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { decompressStream } from "../archive/compress.ts";
import type { ArchiveLedgerType } from "../archive/record.ts";
import { budgetSource, createSourceBudget, sourceRange } from "../source.ts";
import type { ByteSourceType, SourceBudgetType, SourceReadOptionsType } from "../source.ts";
import { openBytes } from "../stream.ts";

/** Repository object format is explicit; reference widths must never be guessed from payloads. */
export type GitAlgorithmType = "sha1" | "sha256";
/** These modes are the canonical writer profile, not every historical fsck-tolerated spelling. */
export type GitModeType = "40000" | "100644" | "100755" | "120000" | "160000";
/** Name bytes are inert. A valid UTF-8 spelling does not make an entry a safe host path. */
export interface GitTreeEntryType {
  readonly mode: GitModeType;
  readonly kind: "tree" | "blob" | "executable" | "symlink" | "gitlink";
  readonly oid: string;
  readonly nameBytes: Uint8Array;
  /** Present only for strict UTF-8. No replacement decoding or normalization occurs. */
  readonly name?: string;
}
/** Pure tree encoding consumes exact byte names and an explicitly scoped object ID. */
export interface GitTreeInputType {
  readonly mode: GitModeType;
  readonly oid: string;
  readonly nameBytes: Uint8Array;
}
/** Finite parser/encoder bounds are local policy, not Git format maxima. */
export interface GitTreeOptionsType {
  readonly algorithm: GitAlgorithmType;
  readonly maxEntries?: number;
  readonly maxNameBytes?: number;
  readonly maxObjectBytes?: number;
}
/** Whole-object verification requires an explicit expected ID and borrowed trusted hash capability. */
export interface GitOptionsType extends GitTreeOptionsType, SourceReadOptionsType {
  readonly oid: string;
  readonly subtle: Pick<SubtleCrypto, "digest">;
  readonly maxCompressedBytes?: number;
  /** Physical source reservations survive failures and are never refunded. */
  readonly budget?: SourceBudgetType;
  /** Optional shared native codec work ledger; separate from physical source accounting. */
  readonly ledger?: ArchiveLedgerType;
}
/** Payload reads copy a private verified snapshot. A tree does not prove its referenced objects exist. */
export interface GitObjectType {
  readonly algorithm: GitAlgorithmType;
  readonly oid: string;
  readonly kind: "blob" | "tree" | "commit" | "tag";
  readonly size: number;
  readonly integrity: "sha1" | "sha256";
  readonly source: ByteSourceType;
  readonly budget: SourceBudgetType;
  read(options?: SourceReadOptionsType): Promise<Uint8Array>;
  /** Each call copies name buffers. Only a verified tree has entries. */
  entries(): readonly GitTreeEntryType[];
}
const ceiling = 64 * 1024 * 1024;
/** Bound sizes before allocations and foreign acquisition. */
function integer(value: number, label: string, maximum = ceiling): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RangeError(`Invalid Git ${label}.`);
  return value;
}
/** Repository format fixes every raw tree reference width before parsing. */
function width(algorithm: GitAlgorithmType): number {
  if (algorithm !== "sha1" && algorithm !== "sha256") {
    throw new TypeError("Git object algorithm must be explicit sha1 or sha256.");
  }
  return algorithm === "sha1" ? 20 : 32;
}
/** Only complete lowercase IDs; neither abbreviated names nor ref syntax can select an object. */
function objectId(value: string, algorithm: GitAlgorithmType): string {
  if (typeof value !== "string" || value.length !== width(algorithm) * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new TypeError("Git object ID differs from its algorithm or full lowercase format.");
  }
  return value;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
/** Canonical modes retain symlinks and gitlinks without following them. */
function kind(mode: GitModeType): GitTreeEntryType["kind"] {
  if (mode === "40000") return "tree";
  if (mode === "100644") return "blob";
  if (mode === "100755") return "executable";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  throw new TypeError("Unsupported Git tree mode.");
}
/** Raw-byte names are copied before exposure and never interpreted as extraction paths. */
function name(bytes: Uint8Array, maximum: number): Uint8Array<ArrayBuffer> {
  if (!isBytes(bytes)) throw new TypeError("Git tree names require Uint8Array bytes.");
  const view = toView(bytes);
  if (view.length === 0 || view.length > maximum) {
    throw new RangeError("Git tree name exceeds its byte budget or is empty.");
  }
  if (
    view.includes(0) || view.includes(47) || view.length === 1 && view[0] === 46 ||
    view.length === 2 && view[0] === 46 && view[1] === 46
  ) throw new TypeError("Invalid Git tree name bytes.");
  return new Uint8Array(view);
}
/** Git compares directory names as if they ended in '/', rather than a file's NUL. */
function compare(a: GitTreeInputType, b: GitTreeInputType): number {
  const length = Math.min(a.nameBytes.length, b.nameBytes.length);
  for (let at = 0; at < length; at++) {
    if (a.nameBytes[at] !== b.nameBytes[at]) return a.nameBytes[at]! - b.nameBytes[at]!;
  }
  const left = a.nameBytes.length === length ? a.mode === "40000" ? 47 : 0 : a.nameBytes[length]!;
  const right = b.nameBytes.length === length ? b.mode === "40000" ? 47 : 0 : b.nameBytes[length]!;
  return left - right;
}
/** Canonical Git sort does not itself exclude duplicate names with different modes. */
function duplicate(entries: readonly GitTreeInputType[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = hex(entry.nameBytes);
    if (seen.has(key)) throw new TypeError("Duplicate Git tree name bytes.");
    seen.add(key);
  }
}
/** UTF-8 is an optional lossless interpretation, never a normalization or replacement path. */
function exposed(entry: GitTreeInputType): GitTreeEntryType {
  let decoded: string | undefined;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(entry.nameBytes);
  } catch { /* Non-UTF-8 remains raw bytes. */ }
  return {
    mode: entry.mode,
    kind: kind(entry.mode),
    oid: entry.oid,
    nameBytes: new Uint8Array(entry.nameBytes),
    ...(decoded === undefined ? {} : { name: decoded }),
  };
}
/** Tree payload parsing runs only after whole loose-object hash verification. */
function tree(
  bytes: Uint8Array,
  algorithm: GitAlgorithmType,
  maxEntries: number,
  maxName: number,
): readonly GitTreeInputType[] {
  const entries: GitTreeInputType[] = [], oidBytes = width(algorithm);
  let at = 0;
  while (at < bytes.length) {
    if (entries.length >= maxEntries) throw new RangeError("Git tree exceeds its entry budget.");
    const modeAt = at;
    while (at < bytes.length && bytes[at] !== 32 && at - modeAt <= 6) at++;
    if (at >= bytes.length || bytes[at] !== 32 || at - modeAt > 6) throw new TypeError("Malformed Git tree mode.");
    let mode = "";
    for (let index = modeAt; index < at; index++) mode += String.fromCharCode(bytes[index]!);
    kind(mode as GitModeType);
    const nameAt = ++at;
    while (at < bytes.length && bytes[at] !== 0 && at - nameAt <= maxName) at++;
    if (at >= bytes.length || bytes[at] !== 0) throw new TypeError("Unterminated or oversized Git tree name.");
    const nameBytes = name(bytes.subarray(nameAt, at), maxName);
    at++;
    if (oidBytes > bytes.length - at) throw new TypeError("Truncated Git tree object ID.");
    const entry = { mode: mode as GitModeType, nameBytes, oid: hex(bytes.subarray(at, at + oidBytes)) };
    if (entries.length && compare(entries[entries.length - 1]!, entry) >= 0) {
      throw new TypeError("Git tree entries are not in canonical byte order.");
    }
    entries.push(entry);
    at += oidBytes;
  }
  duplicate(entries);
  return entries;
}
/**
 * Encode a bounded tree payload, without hashing, compression or publication.
 * Sorting follows native Git directory-sentinel order; raw input names are copied.
 * Caller input is never treated as already verified evidence.
 */
export function encodeGitTree(
  entries: readonly GitTreeInputType[],
  options: GitTreeOptionsType,
): Uint8Array<ArrayBuffer> {
  const algorithm = options.algorithm, oidBytes = width(algorithm);
  const maxEntries = integer(options.maxEntries ?? 100000, "tree entry budget", 1000000);
  const maxName = integer(options.maxNameBytes ?? 4096, "tree name budget", 1024 * 1024);
  const maximum = integer(options.maxObjectBytes ?? 8 * 1024 * 1024, "tree byte budget");
  if (entries.length > maxEntries) throw new RangeError("Git tree exceeds its entry budget.");
  let size = 0;
  const captured = entries.map((entry) => {
    const mode = entry.mode;
    kind(mode);
    const oid = objectId(entry.oid, algorithm), nameBytes = name(entry.nameBytes, maxName);
    const length = mode.length + 2 + nameBytes.length + oidBytes;
    if (length > maximum - size) throw new RangeError("Git tree exceeds its byte budget.");
    size += length;
    return { mode, oid, nameBytes };
  });
  duplicate(captured);
  captured.sort(compare);
  const output = new Uint8Array(size);
  let at = 0;
  for (const entry of captured) {
    for (let index = 0; index < entry.mode.length; index++) output[at++] = entry.mode.charCodeAt(index);
    output[at++] = 32;
    output.set(entry.nameBytes, at);
    at += entry.nameBytes.length;
    output[at++] = 0;
    for (let index = 0; index < oidBytes; index++) {
      output[at++] = parseInt(entry.oid.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return output;
}

/**
 * Fully decode and hash one bounded loose object before exposing its payload.
 * Defaults: 16 MiB compressed, 8 MiB decoded whole object, 100,000 tree entries and
 * 4,096-byte names; compressed/decoded hard ceilings 64 MiB. The borrowed source
 * is read in <=64KiB extents. A complete private decoded copy plus native hash/
 * codec allocations is required; this is not random-access decompression.
 */
export async function openGitObject(source: ByteSourceType, options: GitOptionsType): Promise<GitObjectType> {
  const algorithm = options.algorithm, expected = objectId(options.oid, algorithm), signal = options.signal;
  const digest = options.subtle.digest.bind(options.subtle);
  const compressed = integer(options.maxCompressedBytes ?? 16 * 1024 * 1024, "compressed byte budget");
  const maximum = integer(options.maxObjectBytes ?? 8 * 1024 * 1024, "decoded object byte budget");
  const maxEntries = integer(options.maxEntries ?? 100000, "tree entry budget", 1000000);
  const maxName = integer(options.maxNameBytes ?? 4096, "tree name budget", 1024 * 1024);
  const size = integer(source.size, "compressed source size");
  if (size > compressed) throw new RangeError("Git compressed source exceeds its byte budget.");
  const read = source.read.bind(source);
  const budget = options.budget ?? createSourceBudget({ maxBytes: compressed, maxRequests: 1024 });
  const checked = budgetSource({ size, read }, budget);
  signal?.throwIfAborted();
  let offset = 0;
  const producer = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset === size) {
        controller.close();
        return;
      }
      try {
        const length = Math.min(65536, size - offset);
        const bytes = await checked.read(offset, length, signal === undefined ? {} : { signal });
        // A foreign source can reuse its returned storage on the next read.
        const owned = new Uint8Array(toView(bytes));
        offset += length;
        controller.enqueue(owned);
      } catch (reason) {
        controller.error(reason);
      }
    },
  }, { highWaterMark: 0 });
  const decoded = decompressStream(producer, "deflate", {
    maxSourceBytes: compressed,
    maxRequests: 65536,
    maxDecodedBytes: maximum,
    maxOutputBytes: maximum,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(signal === undefined ? {} : { signal }),
  });
  const reader = openBytes(decoded), prefix = new Uint8Array(64);
  let headerBytes = 0, written = 0, terminal = false;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let objectKind: GitObjectType["kind"] | undefined;
  let failure: readonly unknown[] = [];
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        terminal = true;
        throw reason;
      }
      if (next.done) {
        terminal = true;
        break;
      }
      const chunk = toView(next.value);
      let at = 0;
      if (bytes === undefined) {
        while (at < chunk.length && bytes === undefined) {
          if (headerBytes === prefix.length) throw new TypeError("Git loose header exceeds 64 bytes.");
          const byte = chunk[at++]!;
          prefix[headerBytes++] = byte;
          if (byte === 0) {
            let header = "";
            for (let index = 0; index < headerBytes - 1; index++) header += String.fromCharCode(prefix[index]!);
            const match = /^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(header);
            if (match === null) throw new TypeError("Malformed Git loose object header.");
            const payloadSize = integer(Number(match[2]), "declared payload size");
            if (payloadSize > maximum - headerBytes) {
              throw new RangeError("Git declared object exceeds its decoded byte budget.");
            }
            objectKind = match[1] as GitObjectType["kind"];
            bytes = new Uint8Array(headerBytes + payloadSize);
            bytes.set(prefix.subarray(0, headerBytes));
            written = headerBytes;
          }
        }
      }
      if (bytes !== undefined) {
        if (chunk.length - at > bytes.length - written) throw new TypeError("Git payload exceeds its declared size.");
        bytes.set(chunk.subarray(at), written);
        written += chunk.length - at;
      }
    }
    if (bytes === undefined || objectKind === undefined || written !== bytes.length) {
      throw new TypeError("Git loose object is truncated.");
    }
  } catch (reason) {
    failure = [reason];
  }
  await close([...(terminal ? [] : [() => reader.cancel(failure[0])]), () => reader.releaseLock()], failure);
  if (bytes === undefined || objectKind === undefined) throw new TypeError("Git loose object is missing its header.");
  signal?.throwIfAborted();
  const computed = new Uint8Array(await digest(algorithm === "sha1" ? "SHA-1" : "SHA-256", bytes));
  signal?.throwIfAborted();
  if (computed.length !== width(algorithm) || hex(computed) !== expected) {
    throw new TypeError("Git loose object hash differs from the expected ID.");
  }
  const payload = bytes.subarray(headerBytes);
  const entries = objectKind === "tree" ? tree(payload, algorithm, maxEntries, maxName) : undefined;
  const identity = JSON.stringify(["git-object", algorithm, expected, objectKind, "payload"]);
  const ownedSource: ByteSourceType = Object.freeze({
    size: payload.length,
    identity,
    stability: "immutable" as const,
    async read(offset: number, length: number, options: SourceReadOptionsType = {}): Promise<Uint8Array> {
      options.signal?.throwIfAborted();
      sourceRange(payload.length, offset, length);
      return payload.slice(offset, offset + length);
    },
  });
  return Object.freeze({
    algorithm,
    oid: expected,
    kind: objectKind,
    size: payload.length,
    integrity: algorithm,
    source: ownedSource,
    budget,
    read: (options: SourceReadOptionsType = {}) => ownedSource.read(0, payload.length, options),
    entries() {
      if (entries === undefined) throw new TypeError("Git object is not a tree.");
      return entries.map(exposed);
    },
  });
}
