/** Bounded compact JWE snapshots, authenticated before plaintext publication. @module */
import { z } from "zod";
import { decodeBase64Url } from "@std/encoding/base64url";
import { isBuffer, isBytes, toView } from "../bytes.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType } from "../source.ts";
import { createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** The caller pins the algorithm independently of the untrusted protected header. */
export const JweProfileSchema: z.ZodEnum<
  { "jwe-compact-dir-a128gcm": "jwe-compact-dir-a128gcm"; "jwe-compact-dir-a256gcm": "jwe-compact-dir-a256gcm" }
> = z.enum(["jwe-compact-dir-a128gcm", "jwe-compact-dir-a256gcm"]);
export type JweProfileType = z.infer<typeof JweProfileSchema>;
/** Known authenticated declarations; unknown noncritical members remain in the original raw header. */
export const JweProtectedSchema: z.ZodObject<{
  alg: z.ZodLiteral<"dir">;
  enc: z.ZodEnum<{ A128GCM: "A128GCM"; A256GCM: "A256GCM" }>;
  kid: z.ZodOptional<z.ZodString>;
  typ: z.ZodOptional<z.ZodString>;
  cty: z.ZodOptional<z.ZodString>;
}, z.core.$strict> = z.object({
  alg: z.literal("dir"),
  enc: z.enum(["A128GCM", "A256GCM"]),
  kid: z.string().optional(),
  typ: z.string().optional(),
  cty: z.string().optional(),
}).strict();
export type JweProtectedType = z.infer<typeof JweProtectedSchema>;
/** Only high-entropy direct AES keys; no password derivation or key resolution occurs. */
export type JweKeyType = Uint8Array | CryptoKey;
export interface JweReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Cryptography and input remain borrowed; opening owns one bounded plaintext snapshot. */
export interface JweOpenOptionsType extends JweReadOptionsType {
  readonly profile: JweProfileType;
  readonly key: JweKeyType;
  readonly subtle: SubtleCrypto;
  readonly allowUnverifiedSource?: boolean;
  /** Complete compact ASCII input: default 12 MiB; hard ceiling 48 MiB. */ readonly maxEnvelopeBytes?: number;
  /** Complete plaintext snapshot: default 8 MiB; hard ceiling 32 MiB. */ readonly maxPlaintextBytes?: number;
  /** Decoded protected header: default 8 KiB; hard ceiling 64 KiB. */ readonly maxHeaderBytes?: number;
  /** Header JSON depth: default 8; hard ceiling 16. */ readonly maxHeaderDepth?: number;
  /** Header JSON values: default 256; hard ceiling 4096. */ readonly maxHeaderNodes?: number;
  /** Each decoded header string/key: default 4096 UTF-8 bytes; hard ceiling 16384. */ readonly maxStringBytes?: number;
  /** Conservative materialization policy units, not measured heap: default 96 MiB; hard ceiling 384 MiB. */ readonly maxMemoryBytes?:
    number;
  /** One returned interval: default 1 MiB; hard ceiling 32 MiB. */ readonly maxReadBytes?: number;
}
/** Authentication and retained plaintext are separate from returned range bytes. */
export interface JweWorkType extends ArchiveWorkType {
  readonly authenticatedBytes: number;
  readonly retainedPlaintextBytes: number;
  readonly nativeCalls: number;
  readonly materializedBytes: number;
}
export interface JweReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "whole-jwe-message-authenticated";
  readonly work: ArchiveWorkType;
}
/** Exact original encoded header is AAD; its serialization is never reconstructed. */
export interface JweHeaderType {
  readonly encoded: string;
  readonly raw: string;
  readonly protected: Readonly<JweProtectedType>;
}
/** Borrow this source only while its opening owner is alive. Returned copies remain caller-owned. */
export interface JweSourceType extends ByteSourceType {
  read(offset: number, length: number, options?: JweReadOptionsType): Promise<Uint8Array>;
}
/** Disposal rejects new/reentrant unfinished reads and clears the private snapshot best-effort. */
export interface JweOpenedType extends Disposable {
  readonly profile: JweProfileType;
  readonly header: JweHeaderType;
  readonly integrity: "whole-jwe-message-authenticated";
  readonly source: JweSourceType;
  readonly work: JweWorkType;
  read(offset: number, length: number, options?: JweReadOptionsType): Promise<JweReadType>;
  dispose(): void;
}
/** Native authentication failures omit provider causes, keys and speculative plaintext. */
export class JweError extends Error {
  readonly code: "format" | "profile" | "key" | "authentication" | "limit" | "stability" | "disposed";
  constructor(code: JweError["code"], message: string) {
    super(message);
    this.name = "JweError";
    this.code = code;
  }
}
function fail(code: JweError["code"], message: string): never {
  throw new JweError(code, message);
}
function cap(n: number, max: number, label: string): void {
  integer(n, label);
  if (n > max) fail("limit", `${label} exceeds the admitted limit.`);
}
function policy(value: number | undefined, fallback: number, hard: number, label: string): number {
  const n = value ?? fallback;
  cap(n, hard, label);
  return n;
}
interface OwnerType {
  readonly identity: ArchiveLedgerType;
  readonly reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  readonly owners: readonly OwnerType[];
  readonly signal: AbortSignal | undefined;
}
function authority(options: JweReadOptionsType, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (owners.some((owner) => owner.identity === ledger)) continue;
    const { reserve, inspect } = ledger;
    if (typeof reserve !== "function" || typeof inspect !== "function") {
      throw new TypeError("JWE ledger requires reserve and inspect.");
    }
    owners.push({ identity: ledger, reserve: reserve.bind(ledger) });
  }
  cap(owners.length, 16, "JWE inherited budget owners");
  const a = parent?.signal, b = options.signal;
  return { owners, signal: a && b && a !== b ? AbortSignal.any([a, b]) : a ?? b };
}
/** Foreign admission callbacks may abort or dispose synchronously. Check again after every one. */
function charge(
  auth: AuthorityType,
  work: { sourceBytes: number; requests: number; decodedBytes: number; outputBytes: number },
  kind: keyof ArchiveWorkType,
  n: number,
  alive: () => void,
): void {
  integer(n, "JWE work");
  alive();
  auth.signal?.throwIfAborted();
  for (const owner of auth.owners) {
    owner.reserve(kind, n);
    alive();
    auth.signal?.throwIfAborted();
  }
  work[kind] += n;
}
function fresh(): { sourceBytes: number; requests: number; decodedBytes: number; outputBytes: number } {
  return { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
}

/** Parse only finite JSON grammar; reject duplicate decoded names before JSON.parse can discard evidence. */
function headerJson(
  text: string,
  depthLimit: number,
  nodesLimit: number,
  stringLimit: number,
): Record<string, unknown> {
  let at = 0, nodes = 0;
  const primitive = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  const whitespace = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at]!)) at++;
  };
  const string = (): string => {
    const start = at;
    if (text[at++] !== '"') fail("format", "Expected a JWE JSON string.");
    let closed = false;
    while (at < text.length) {
      const c = text.charCodeAt(at++);
      if (c === 34) {
        closed = true;
        break;
      }
      if (c < 32) fail("format", "Control byte in JWE JSON string.");
      if (c === 92) {
        const escaped = text[at++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) fail("format", "Invalid JWE JSON escape.");
          at += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) fail("format", "Invalid JWE JSON escape.");
      }
    }
    if (!closed) fail("format", "Unterminated JWE JSON string.");
    cap(at - start, stringLimit * 6 + 2, "JWE encoded header string");
    const value: unknown = JSON.parse(text.slice(start, at));
    if (typeof value !== "string") fail("format", "Invalid JWE JSON string.");
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
      fail("format", "Unpaired surrogate in JWE header.");
    }
    cap(value.length, stringLimit, "JWE header string");
    cap(new TextEncoder().encode(value).byteLength, stringLimit, "JWE UTF-8 header string");
    return value;
  };
  const value = (depth: number): void => {
    cap(++nodes, nodesLimit, "JWE header nodes");
    cap(depth, depthLimit, "JWE header depth");
    whitespace();
    const c = text[at];
    if (c === '"') {
      string();
      return;
    }
    if (c === "{" || c === "[") {
      const object = c === "{", end = object ? "}" : "]", names = new Set<string>();
      at++;
      whitespace();
      if (text[at] === end) {
        at++;
        return;
      }
      for (;;) {
        if (object) {
          const name = string();
          if (names.has(name)) fail("format", "Duplicate JWE header member.");
          names.add(name);
          whitespace();
          if (text[at++] !== ":") fail("format", "Missing JWE JSON colon.");
        }
        value(depth + 1);
        whitespace();
        if (text[at] === end) {
          at++;
          return;
        }
        if (text[at++] !== ",") fail("format", "Missing JWE JSON delimiter.");
        whitespace();
      }
    }
    primitive.lastIndex = at;
    const token = primitive.exec(text);
    if (!token) fail("format", "Invalid JWE JSON token.");
    at += token[0].length;
  };
  value(0);
  whitespace();
  if (at !== text.length) fail("format", "Trailing JWE header JSON bytes.");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("format", "JWE protected header must be an object.");
  }
  return parsed as Record<string, unknown>;
}
/** Canonical pad-bit admission avoids allocating another complete encoded ciphertext for comparison. */
function decodedLength(value: string): number {
  const mod = value.length % 4;
  if (mod === 1) fail("format", "Invalid JWE base64url extent.");
  if (mod) {
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(value[value.length - 1]!);
    if (last < 0 || (last & (mod === 2 ? 15 : 3))) fail("format", "Noncanonical JWE base64url pad bits.");
  }
  return Math.floor(value.length * 3 / 4);
}

/**
 * Authenticate one complete compact envelope before exposing any plaintext.
 *
 * This whole-buffer profile is intended for bounded blobs. It is not ciphertext
 * random access or byte streaming. Native crypto cannot be interrupted: abort
 * joins the pending call and clears owned plaintext scratch before opening rejects.
 */
export async function openJwe(input: ByteSourceType, supplied: JweOpenOptionsType): Promise<JweOpenedType> {
  // Key admission must precede every other foreign getter, not only awaits.
  const borrowed = supplied.key;
  let owned: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (isBytes(borrowed)) {
      const bytes = toView(borrowed);
      if (bytes.byteLength !== 16 && bytes.byteLength !== 32) {
        fail("key", "JWE requires a 16-byte or 32-byte direct key.");
      }
      owned = new Uint8Array(bytes);
    }
    return await openSnapshot(input, supplied, owned ?? borrowed);
  } finally {
    owned?.fill(0);
  }
}

/** Snapshot only declared policy fields so unrelated getters cannot affect key admission. */
function readOptions(supplied: JweReadOptionsType): JweReadOptionsType {
  const options: JweReadOptionsType = {};
  for (
    const name of ["signal", "ledger", "maxSourceBytes", "maxRequests", "maxDecodedBytes", "maxOutputBytes"] as const
  ) {
    const value = supplied[name];
    if (value !== undefined) Object.defineProperty(options, name, { value, enumerable: true });
  }
  return options;
}

/** The raw key is already private; all remaining acquisition failures retire it in openJwe. */
async function openSnapshot(
  input: ByteSourceType,
  supplied: JweOpenOptionsType,
  capturedKey: JweKeyType,
): Promise<JweOpenedType> {
  const options: JweOpenOptionsType = { key: capturedKey, profile: supplied.profile, subtle: supplied.subtle };
  for (
    const name of [
      "signal",
      "ledger",
      "maxSourceBytes",
      "maxRequests",
      "maxDecodedBytes",
      "maxOutputBytes",
      "allowUnverifiedSource",
      "maxEnvelopeBytes",
      "maxPlaintextBytes",
      "maxHeaderBytes",
      "maxHeaderDepth",
      "maxHeaderNodes",
      "maxStringBytes",
      "maxMemoryBytes",
      "maxReadBytes",
    ] as const
  ) {
    const value = supplied[name];
    if (value !== undefined) Object.defineProperty(options, name, { value, enumerable: true });
  }
  const profile = JweProfileSchema.parse(options.profile);
  const requiredBytes = profile === "jwe-compact-dir-a128gcm" ? 16 : 32,
    enc = requiredBytes === 16 ? "A128GCM" : "A256GCM";
  const limits = {
    envelope: policy(options.maxEnvelopeBytes, 12 << 20, 48 << 20, "JWE envelope bytes"),
    plain: policy(options.maxPlaintextBytes, 8 << 20, 32 << 20, "JWE plaintext bytes"),
    header: policy(options.maxHeaderBytes, 8 << 10, 64 << 10, "JWE header bytes"),
    depth: policy(options.maxHeaderDepth, 8, 16, "JWE header depth"),
    nodes: policy(options.maxHeaderNodes, 256, 4096, "JWE header nodes"),
    string: policy(options.maxStringBytes, 4096, 16384, "JWE header string bytes"),
    memory: policy(options.maxMemoryBytes, 96 << 20, 384 << 20, "JWE materialization"),
    read: policy(options.maxReadBytes, 1 << 20, 32 << 20, "JWE returned interval"),
  };
  const { size, identity, stability } = input, read = input.read.bind(input);
  integer(size, "JWE source size");
  cap(size, limits.envelope, "JWE envelope bytes");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("JWE identity must be a bounded string.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown JWE source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    fail("stability", "JWE requires a stable source assertion.");
  }
  const subtle = options.subtle, decrypt = subtle.decrypt.bind(subtle), importKey = subtle.importKey.bind(subtle);
  const opening = authority(options),
    work = { ...fresh(), authenticatedBytes: 0, retainedPlaintextBytes: 0, nativeCalls: 0, materializedBytes: 0 };
  opening.signal?.throwIfAborted();
  let material: Uint8Array<ArrayBuffer> | undefined, key: CryptoKey | undefined;
  if (isBytes(options.key)) {
    const bytes = toView(options.key);
    if (bytes.byteLength !== requiredBytes) fail("key", "JWE key size does not match the pinned profile.");
    material = options.key as Uint8Array<ArrayBuffer>;
  } else {
    key = options.key;
    const algorithm = key?.algorithm as AesKeyAlgorithm | undefined, usages = key?.usages;
    if (
      !key || key.type !== "secret" || algorithm?.name !== "AES-GCM" || algorithm.length !== requiredBytes * 8 ||
      !Array.isArray(usages) || usages.length > 8 || !usages.includes("decrypt")
    ) fail("key", "JWE requires a matching AES-GCM decrypt key.");
  }
  let wire: Uint8Array<ArrayBuffer> | undefined,
    ciphertext: Uint8Array | undefined,
    sealed: Uint8Array<ArrayBuffer> | undefined,
    plaintext: Uint8Array | undefined,
    published = false;
  try {
    // Reserve the complete physical input before allocation or the first provider callback.
    cap(size * 5 + 65536, limits.memory, "JWE initial materialization");
    charge(opening, work, "sourceBytes", size, () => {});
    charge(opening, work, "requests", Math.ceil(size / 65536), () => {});
    charge(opening, work, "decodedBytes", size, () => {});
    wire = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 65536) {
      opening.signal?.throwIfAborted();
      const length = Math.min(65536, size - offset);
      const chunk = await read(offset, length, opening.signal ? { signal: opening.signal } : {});
      opening.signal?.throwIfAborted();
      if (!isBytes(chunk)) fail("format", "JWE source returned non-bytes.");
      const bytes = toView(chunk);
      if (bytes.byteLength !== length) fail("format", "JWE source returned an inexact interval.");
      wire.set(bytes, offset);
    }
    const dots: number[] = [];
    for (let i = 0; i < wire.length; i++) {
      const n = wire[i]!;
      if (n === 46) {
        if (dots.length === 4) fail("format", "JWE has extra compact fields.");
        dots.push(i);
      } else if (!(n >= 65 && n <= 90 || n >= 97 && n <= 122 || n >= 48 && n <= 57 || n === 45 || n === 95)) {
        fail("format", "JWE compact serialization must be unpadded base64url ASCII.");
      }
    }
    if (dots.length !== 4) fail("format", "JWE requires five compact fields.");
    const text = new TextDecoder().decode(wire),
      parts = [
        text.slice(0, dots[0]),
        text.slice(dots[0]! + 1, dots[1]),
        text.slice(dots[1]! + 1, dots[2]),
        text.slice(dots[2]! + 1, dots[3]),
        text.slice(dots[3]! + 1),
      ];
    const lengths = parts.map(decodedLength), plainSize = lengths[3]!;
    if (!lengths[0] || parts[1] !== "" || lengths[2] !== 12 || lengths[4] !== 16) {
      fail("profile", "JWE requires an empty direct encrypted key, 12-byte IV and 16-byte tag.");
    }
    cap(lengths[0]!, limits.header, "JWE protected header");
    cap(plainSize, limits.plain, "JWE plaintext bytes");
    const memory = size * 5 + plainSize * 4 + lengths[0]! * 8 + 65536;
    cap(memory, limits.memory, "JWE complete materialization");
    work.materializedBytes = memory;
    charge(opening, work, "decodedBytes", lengths[0]! + plainSize * 4 + 44, () => {});
    charge(opening, work, "outputBytes", plainSize, () => {});
    const headerBytes = decodeBase64Url(parts[0]!);
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(headerBytes);
    } catch {
      fail("format", "JWE header is not strict UTF-8.");
    }
    const parsed = headerJson(raw, limits.depth, limits.nodes, limits.string);
    for (
      const field of ["crit", "zip", "jku", "jwk", "x5u", "x5c", "x5t", "x5t#S256", "epk", "apu", "apv", "p2s", "p2c"]
    ) {
      if (Object.hasOwn(parsed, field)) {
        fail("profile", `JWE header parameter ${field} is outside this direct profile.`);
      }
    }
    const own = (name: string): unknown => Object.hasOwn(parsed, name) ? parsed[name] : undefined;
    const known = JweProtectedSchema.safeParse({
      alg: own("alg"),
      enc: own("enc"),
      ...(own("kid") !== undefined ? { kid: own("kid") } : {}),
      ...(own("typ") !== undefined ? { typ: own("typ") } : {}),
      ...(own("cty") !== undefined ? { cty: own("cty") } : {}),
    });
    if (!known.success || known.data.enc !== enc) {
      fail("profile", "JWE algorithms do not match the caller-pinned profile.");
    }
    const iv = decodeBase64Url(parts[2]!), tag = decodeBase64Url(parts[4]!);
    ciphertext = decodeBase64Url(parts[3]!);
    sealed = new Uint8Array(plainSize + 16);
    sealed.set(ciphertext);
    sealed.set(tag, plainSize);
    const aad = new TextEncoder().encode(parts[0]!);
    opening.signal?.throwIfAborted();
    if (material) {
      work.nativeCalls++;
      try {
        key = await importKey("raw", material, { name: "AES-GCM" }, false, ["decrypt"]);
      } catch (error) {
        if (opening.signal?.aborted) {
          throw new AggregateError([opening.signal.reason, error], "Canceled JWE key import also failed.");
        }
        throw error;
      }
      opening.signal?.throwIfAborted();
    }
    work.nativeCalls++;
    let result: ArrayBuffer;
    try {
      result = await decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: aad, tagLength: 128 },
        key!,
        sealed,
      );
    } catch (error) {
      const reason = error !== null && typeof error === "object" && "name" in error && error.name === "OperationError"
        ? new JweError("authentication", "JWE authentication failed.")
        : error;
      if (opening.signal?.aborted) {
        throw new AggregateError([opening.signal.reason, reason], "Canceled JWE decryption also failed.");
      }
      throw reason;
    }
    if (!isBuffer(result)) fail("authentication", "JWE native decrypt returned a non-buffer result.");
    const borrowedPlaintext = new Uint8Array(result);
    opening.signal?.throwIfAborted();
    if (borrowedPlaintext.byteLength !== plainSize) {
      fail("authentication", "JWE native plaintext extent does not match ciphertext.");
    }
    // The injected provider may retain its result. Own a separate snapshot and
    // never erase or publish that borrowed backing buffer.
    plaintext = new Uint8Array(borrowedPlaintext);
    opening.signal?.throwIfAborted();
    work.authenticatedBytes = plainSize;
    work.retainedPlaintextBytes = plainSize;
    let disposed = false;
    const retained = plaintext;
    const alive = () => {
      if (disposed) fail("disposed", "JWE plaintext snapshot has been disposed.");
    };
    const dispose = (): void => {
      if (!disposed) {
        disposed = true;
        retained.fill(0);
      }
    };
    const selected = async (
      offset: number,
      length: number,
      suppliedRead: JweReadOptionsType = {},
    ): Promise<JweReadType> => {
      alive();
      const call = authority(readOptions(suppliedRead), opening), selectedWork = fresh();
      alive();
      call.signal?.throwIfAborted();
      sourceRange(plainSize, offset, length);
      cap(length, limits.read, "JWE returned interval");
      charge(call, selectedWork, "decodedBytes", length, alive);
      charge(call, selectedWork, "outputBytes", length, alive);
      // No await or foreign callback can interleave disposal after this final check and owned copy.
      alive();
      call.signal?.throwIfAborted();
      const bytes = new Uint8Array(length);
      bytes.set(retained.subarray(offset, offset + length));
      return Object.freeze({ bytes, integrity: "whole-jwe-message-authenticated", work: Object.freeze(selectedWork) });
    };
    const source: JweSourceType = Object.freeze({
      size: plainSize,
      stability: "immutable",
      async read(offset: number, length: number, options?: JweReadOptionsType): Promise<Uint8Array> {
        return (await selected(offset, length, options)).bytes;
      },
    });
    const header: JweHeaderType = Object.freeze({ encoded: parts[0]!, raw, protected: Object.freeze(known.data) });
    const opened: JweOpenedType = Object.freeze({
      profile,
      header,
      integrity: "whole-jwe-message-authenticated",
      source,
      work: Object.freeze({ ...work }),
      read: selected,
      dispose,
      [Symbol.dispose]: dispose,
    });
    published = true;
    return opened;
  } finally {
    material?.fill(0);
    wire?.fill(0);
    ciphertext?.fill(0);
    sealed?.fill(0);
    if (!published) plaintext?.fill(0);
  }
}
