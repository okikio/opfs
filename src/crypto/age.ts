/** Authenticated age v1 payload ranges with an application-unlocked file key. @module */
import { z } from "zod";
import { decodeBase64 } from "@std/encoding/base64";
import { isBuffer, isBytes, toView } from "../bytes.ts";
import { aggregate } from "../close.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType, SourceReadOptionsType } from "../source.ts";
import { createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Recipient unlocking, ASCII armor and encryption are separate profiles. */
export const AgeProfileSchema: z.ZodLiteral<"age-v1-file-key"> = z.literal("age-v1-file-key");
export type AgeProfileType = z.infer<typeof AgeProfileSchema>;
/** Authenticated recipient metadata remains opaque; this reader does not unwrap it. */
export const AgeStanzaSchema: z.ZodReadonly<
  z.ZodObject<{
    type: z.ZodString;
    args: z.ZodReadonly<z.ZodArray<z.ZodString>>;
    body: z.ZodString;
  }, z.core.$strict>
> = z.object({ type: z.string(), args: z.array(z.string()).readonly(), body: z.string() }).strict().readonly();
export type AgeStanzaType = z.infer<typeof AgeStanzaSchema>;

/**
 * Borrowed authenticated-decryption capability for one IETF ChaCha20-Poly1305 unit.
 *
 * Key/nonce/sealed inputs are private per-call copies. Associated data is empty.
 * The provider must authenticate before resolving. A failed authentication
 * barrier rejects with AgeError("authentication", a sanitized message). Other
 * capability/provider failures retain their original reasons; the reader does
 * not classify them by names or messages. Its returned bytes remain
 * provider-owned; the reader admits their native extent and takes a private copy.
 * The interface and copying cannot prove that a provider performs cryptography.
 */
export interface AgeAeadType {
  decrypt(
    key: Uint8Array<ArrayBuffer>,
    nonce: Uint8Array<ArrayBuffer>,
    sealed: Uint8Array<ArrayBuffer>,
    options?: SourceReadOptionsType,
  ): Promise<Uint8Array>;
}
export interface AgeReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** No globals, identity files, passwords, plugins or network endpoints are discovered. */
export interface AgeOpenOptionsType extends AgeReadOptionsType {
  readonly profile: AgeProfileType;
  /** Exactly 16 high-entropy bytes, already unwrapped by the application. Copied before other getters. */
  readonly fileKey: Uint8Array;
  readonly subtle: SubtleCrypto;
  readonly aead: AgeAeadType;
  /** Original header including LF framing: default 64 KiB; hard ceiling 2 MiB. */
  readonly maxHeaderBytes?: number;
  /** Default 256; hard ceiling 1024. Unknown stanza types remain opaque. */
  readonly maxStanzas?: number;
  /** Type plus arguments: default 64; hard ceiling 256. */
  readonly maxTokens?: number;
  /** One visible ASCII token: default 1024 bytes; hard ceiling 8192. */
  readonly maxTokenBytes?: number;
  /** Decoded extent of one opaque stanza body: default 64 KiB; hard ceiling 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Logical payload size: default and implementation ceiling 1 TiB. */
  readonly maxPlaintextBytes?: number;
  /** One returned interval: default 1 MiB; hard ceiling 32 MiB. */
  readonly maxReadBytes?: number;
  /** Authenticated covering units per range: default 1024; hard ceiling 16384. */
  readonly maxChunks?: number;
  /** Whole verification units: default 16384; hard ceiling 16777216. */
  readonly maxVerifyChunks?: number;
  /** Reader-owned materialization units: default 96 MiB; hard ceiling 256 MiB. Excludes provider scratch and native heap. */
  readonly maxMemoryBytes?: number;
}
/** Original header bytes are authenticated without serialization or normalization. */
export interface AgeHeaderType {
  readonly raw: string;
  readonly bytes: number;
  readonly stanzas: readonly AgeStanzaType[];
  readonly mac: string;
}
/** Costs include reserved work, including failed requests. Provider-internal allocation is opaque. */
export interface AgeWorkType extends ArchiveWorkType {
  readonly chunks: number;
  readonly authenticatedBytes: number;
  readonly nativeCalls: number;
  readonly materializedBytes: number;
  readonly peakMaterializedBytes: number;
}
/**
 * Reader-owned allocation units only, not a whole-provider heap bound. These
 * exclude injected AEAD implementation scratch and native crypto internals.
 * The optional Node factory documents its additional bounded private copies.
 */
export interface AgePlanType {
  readonly offset: number;
  readonly length: number;
  readonly firstChunk: number;
  readonly chunkCount: number;
  readonly sourceBytes: number;
  readonly requests: number;
  readonly decodedBytes: number;
  readonly outputBytes: number;
  readonly authenticatedBytes: number;
  readonly materializedBytes: number;
  readonly peakMaterializedBytes: number;
}
export interface AgeReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "selected-chunks-authenticated";
  readonly firstChunk: number;
  readonly chunkCount: number;
  readonly work: AgeWorkType;
}
export interface AgeVerifyType {
  readonly integrity: "all-chunks-authenticated";
  readonly work: AgeWorkType;
}
/** Borrow only while its opening owner is alive; returned copies belong to the caller. */
export interface AgeSourceType extends ByteSourceType {
  read(offset: number, length: number, options?: AgeReadOptionsType): Promise<Uint8Array>;
}
/**
 * Opening authenticates the header and final unit, not skipped intermediate units.
 *
 * Only one operation may run at once; overlapping calls reject rather than queue.
 * cancel() returns promptly. closed joins borrowed callbacks and retains late
 * failures; a callback must not await closed while it owns the callback being
 * joined. Disposal is cancel followed by that join. Keys/scratch are cleared
 * best-effort; JavaScript cannot guarantee erasure of native/JIT/GC copies.
 */
export interface AgeOpenedType extends AsyncDisposable {
  readonly profile: AgeProfileType;
  readonly header: AgeHeaderType;
  readonly size: number;
  readonly integrity: "header-and-final-chunk-authenticated";
  readonly source: AgeSourceType;
  readonly work: AgeWorkType;
  readonly closed: Promise<void>;
  plan(offset: number, length: number): AgePlanType;
  read(offset: number, length: number, options?: AgeReadOptionsType): Promise<AgeReadType>;
  verify(options?: AgeReadOptionsType): Promise<AgeVerifyType>;
  cancel(reason?: unknown): void;
  dispose(): Promise<void>;
}
/** Stable local categories; provider failures retain their own reasons during cancellation. */
export class AgeError extends Error {
  readonly code:
    | "format"
    | "profile"
    | "key"
    | "authentication"
    | "limit"
    | "stability"
    | "closed"
    | "busy"
    | "capability";
  constructor(code: AgeError["code"], message: string) {
    super(message);
    this.name = "AgeError";
    this.code = code;
  }
}
function fail(code: AgeError["code"], message: string): never {
  throw new AgeError(code, message);
}
function cap(value: number, limit: number, label: string): void {
  integer(value, label);
  if (value > limit) fail("limit", `${label} exceeds the admitted limit.`);
}
function policy(value: number | undefined, fallback: number, hard: number, label: string): number {
  const result = value ?? fallback;
  cap(result, hard, label);
  return result;
}
interface OwnerType {
  readonly ledger: ArchiveLedgerType;
  readonly reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  readonly owners: readonly OwnerType[];
  readonly signal: AbortSignal;
}
/** Capture recognized option fields once; unrelated getters never run. */
function readOptions(supplied: AgeReadOptionsType): AgeReadOptionsType {
  const out: AgeReadOptionsType = {};
  for (
    const name of ["signal", "ledger", "maxSourceBytes", "maxRequests", "maxDecodedBytes", "maxOutputBytes"] as const
  ) {
    const value = supplied[name];
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: true });
  }
  return out;
}
function authority(options: AgeReadOptionsType, signal: AbortSignal, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (owners.some((owner) => owner.ledger === ledger)) continue;
    const { reserve, inspect } = ledger;
    if (typeof reserve !== "function" || typeof inspect !== "function") {
      throw new TypeError("Age ledger requires reserve and inspect.");
    }
    owners.push({ ledger, reserve: reserve.bind(ledger) });
  }
  cap(owners.length, 16, "Age inherited budget owners");
  const signals = [signal, ...(parent ? [parent.signal] : []), ...(options.signal ? [options.signal] : [])];
  return { owners, signal: AbortSignal.any([...new Set(signals)]) };
}
function fresh(): { -readonly [K in keyof AgeWorkType]: AgeWorkType[K] } {
  return {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    chunks: 0,
    authenticatedBytes: 0,
    nativeCalls: 0,
    materializedBytes: 0,
    peakMaterializedBytes: 0,
  };
}
type WorkType = ReturnType<typeof fresh>;
/** Raw Base64 has standard alphabet, no padding, and canonical unused bits. */
function base64(value: string): number {
  if (!/^[A-Za-z0-9+/]*$/.test(value) || value.length % 4 === 1) fail("format", "Invalid age raw Base64.");
  const mod = value.length % 4;
  if (mod) {
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[value.length - 1]!);
    if (last & (mod === 2 ? 15 : 3)) fail("format", "Noncanonical age raw Base64 pad bits.");
  }
  return Math.floor(value.length * 3 / 4);
}
/** A plain native extent snapshot ignores own length/buffer getters and subclass methods. */
function bytes(value: unknown, size: number, label: string): Uint8Array<ArrayBuffer> {
  if (!isBytes(value)) fail("capability", `${label} must be native bytes.`);
  const extent = toView(value);
  if (extent.byteLength !== size) fail("capability", `${label} has an unexpected extent.`);
  return new Uint8Array(extent);
}

/**
 * Open binary age v1 with a caller-unlocked file key and explicit crypto.
 *
 * A known stable source is required. Opening scans bounded header lookahead,
 * reads the nonce and authenticates the final chunk before exposing size.
 * Whole-payload verification is a separate operation. No recipient is unlocked.
 */
export async function openAge(input: ByteSourceType, supplied: AgeOpenOptionsType): Promise<AgeOpenedType> {
  const borrowedKey = supplied.fileKey;
  if (!isBytes(borrowedKey)) fail("key", "Age requires a native 16-byte file key.");
  const keyExtent = toView(borrowedKey);
  if (keyExtent.byteLength !== 16) fail("key", "Age requires exactly 16 unlocked file-key bytes.");
  const key = new Uint8Array(keyExtent);
  try {
    return await openOwned(input, supplied, key);
  } finally {
    key.fill(0);
  }
}

/** Key capture precedes every remaining policy/source/capability getter and await. */
async function openOwned(
  input: ByteSourceType,
  supplied: AgeOpenOptionsType,
  fileKey: Uint8Array<ArrayBuffer>,
): Promise<AgeOpenedType> {
  const options: AgeOpenOptionsType = {
    ...readOptions(supplied),
    profile: supplied.profile,
    fileKey,
    subtle: supplied.subtle,
    aead: supplied.aead,
  };
  for (
    const name of [
      "maxHeaderBytes",
      "maxStanzas",
      "maxTokens",
      "maxTokenBytes",
      "maxBodyBytes",
      "maxPlaintextBytes",
      "maxReadBytes",
      "maxChunks",
      "maxVerifyChunks",
      "maxMemoryBytes",
    ] as const
  ) {
    const value = supplied[name];
    if (value !== undefined) Object.defineProperty(options, name, { value, enumerable: true });
  }
  const profile = AgeProfileSchema.parse(options.profile);
  const limits = {
    header: policy(options.maxHeaderBytes, 65536, 2 << 20, "Age header bytes"),
    stanzas: policy(options.maxStanzas, 256, 1024, "Age stanzas"),
    tokens: policy(options.maxTokens, 64, 256, "Age stanza tokens"),
    token: policy(options.maxTokenBytes, 1024, 8192, "Age token bytes"),
    body: policy(options.maxBodyBytes, 65536, 1 << 20, "Age stanza body bytes"),
    plain: policy(options.maxPlaintextBytes, 2 ** 40, 2 ** 40, "Age plaintext bytes"),
    read: policy(options.maxReadBytes, 1 << 20, 32 << 20, "Age returned bytes"),
    chunks: policy(options.maxChunks, 1024, 16384, "Age range chunks"),
    verify: policy(options.maxVerifyChunks, 16384, 16777216, "Age whole-verification chunks"),
    memory: policy(options.maxMemoryBytes, 96 << 20, 256 << 20, "Age materialization units"),
  };
  const { size: physicalSize, identity, stability, read: sourceMethod } = input;
  integer(physicalSize, "Age source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length === 0 || identity.length > 8192)) {
    fail("stability", "Age source identity must be nonempty and bounded.");
  }
  if (stability !== "immutable" && stability !== "provider" && stability !== "caller") {
    fail("stability", "Age random access requires explicit stable-source evidence.");
  }
  if (typeof sourceMethod !== "function") throw new TypeError("Age source requires an exact read method.");
  const sourceRead = sourceMethod.bind(input);
  const { importKey, deriveBits, verify } = options.subtle;
  const aeadMethod = options.aead.decrypt;
  if ([importKey, deriveBits, verify, aeadMethod].some((method) => typeof method !== "function")) {
    throw new TypeError("Age requires HKDF, HMAC and authenticated-decryption methods.");
  }
  const cryptoImport = importKey.bind(options.subtle),
    cryptoDerive = deriveBits.bind(options.subtle),
    cryptoVerify = verify.bind(options.subtle);
  const decrypt = aeadMethod.bind(options.aead);
  const controller = new AbortController();
  const opening = authority(options, controller.signal);
  let stopped = false, active = true, payloadKey: Uint8Array<ArrayBuffer> | undefined;
  const late: unknown[] = [];
  const joined = Promise.withResolvers<void>();
  // Preserve the original rejected promise for consumers without an unhandled
  // rejection while an application is still retiring its active read.
  void joined.promise.catch(() => {});
  function finish(): void {
    if (!stopped || active) return;
    payloadKey?.fill(0);
    payloadKey = undefined;
    options.signal?.removeEventListener("abort", onAbort);
    if (late.length === 1) joined.reject(late[0]);
    else if (late.length > 1) joined.reject(aggregate(late, "Age borrowed callbacks failed while closing."));
    else joined.resolve();
  }
  function cancel(reason: unknown = new AgeError("closed", "Age owner is closed.")): void {
    if (stopped) return;
    stopped = true;
    controller.abort(reason);
    payloadKey?.fill(0);
    finish();
  }
  function onAbort(): void {
    cancel(options.signal!.reason);
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  function alive(auth: AuthorityType = opening): void {
    auth.signal.throwIfAborted();
    if (stopped) fail("closed", "Age owner is closed.");
  }
  function charge(auth: AuthorityType, work: WorkType, kind: keyof ArchiveWorkType, count: number): void {
    integer(count, "Age work reservation");
    alive(auth);
    for (const owner of auth.owners) {
      owner.reserve(kind, count);
      alive(auth);
    }
    work[kind] += count;
  }
  /** Only a borrowed callback rejection is a late provider failure; a later
   * alive() cancellation check is not observed twice as provider cleanup. */
  async function borrowed<T>(callback: () => PromiseLike<T>, auth: AuthorityType = opening): Promise<T> {
    alive(auth);
    try {
      return await callback();
    } catch (reason) {
      if (stopped) late.push(reason);
      throw reason;
    }
  }
  async function fetch(
    offset: number,
    length: number,
    auth: AuthorityType,
    work: WorkType,
    prepaid = false,
  ): Promise<Uint8Array<ArrayBuffer>> {
    sourceRange(physicalSize, offset, length);
    if (!prepaid) {
      charge(auth, work, "sourceBytes", length);
      charge(auth, work, "requests", 1);
    }
    alive(auth);
    const result = await borrowed(() => sourceRead(offset, length, { signal: auth.signal }), auth);
    alive(auth);
    return bytes(result, length, "Age source read");
  }
  const openWork = fresh();
  const headerBuffers: Uint8Array<ArrayBuffer>[] = [];
  let fetched = 0, position = 0, bufferIndex = 0, byteIndex = 0;
  /** Header lookahead is charged even when the last fetched buffer includes
   * payload bytes. LF belongs to the original authenticated byte transcript. */
  async function line(): Promise<{ text: string; start: number }> {
    const start = position, pieces: string[] = [];
    for (;;) {
      alive();
      if (bufferIndex === headerBuffers.length) {
        const length = Math.min(4096, limits.header - fetched, physicalSize - fetched);
        if (length <= 0) fail("format", "Age header has no bounded LF terminator.");
        cap(12 * (fetched + length) + 3 * 65552 + 1024, limits.memory, "Age opening materialization");
        charge(opening, openWork, "decodedBytes", 2 * length);
        const value = await fetch(fetched, length, opening, openWork);
        headerBuffers.push(value);
        fetched += length;
        openWork.materializedBytes += 3 * length;
        openWork.peakMaterializedBytes = Math.max(openWork.peakMaterializedBytes, 12 * fetched + 3 * 65552 + 1024);
      }
      const current = headerBuffers[bufferIndex]!;
      const lf = current.indexOf(10, byteIndex);
      const end = lf < 0 ? current.length : lf;
      for (let i = byteIndex; i < end; i++) {
        if (current[i]! < 32 || current[i]! > 126) {
          fail("format", "Age header requires visible ASCII and LF framing.");
        }
      }
      pieces.push(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current.subarray(byteIndex, end)));
      position += end - byteIndex;
      byteIndex = end;
      if (lf >= 0) {
        byteIndex++;
        position++;
        if (byteIndex === current.length) {
          bufferIndex++;
          byteIndex = 0;
        }
        return { text: pieces.join(""), start };
      }
      bufferIndex++;
      byteIndex = 0;
    }
  }
  function prefix(length: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(length);
    let at = 0;
    for (const value of headerBuffers) {
      const take = Math.min(length - at, value.length);
      out.set(value.subarray(0, take), at);
      at += take;
      if (at === length) break;
    }
    if (at !== length) fail("format", "Age header transcript is incomplete.");
    return out;
  }
  let aad: Uint8Array<ArrayBuffer> | undefined, nonceSalt: Uint8Array<ArrayBuffer> | undefined;
  try {
    alive();
    if ((await line()).text !== "age-encryption.org/v1") {
      fail("profile", "Expected binary age v1; armor and other versions are unsupported.");
    }
    const stanzas: AgeStanzaType[] = [];
    let footer: { text: string; start: number };
    for (;;) {
      const start = await line();
      if (start.text.startsWith("--- ")) {
        footer = start;
        break;
      }
      if (!start.text.startsWith("-> ")) fail("format", "Expected an age stanza or MAC footer.");
      cap(stanzas.length + 1, limits.stanzas, "Age recipient stanzas");
      // Admit cardinality and each ASCII extent before split() allocates an
      // array or any token substring. The original transcript remains intact.
      let tokenCount = 1, tokenBytes = 0;
      cap(tokenCount, limits.tokens, "Age stanza tokens");
      for (let index = 3; index < start.text.length; index++) {
        if (start.text.charCodeAt(index) === 32) {
          if (tokenBytes === 0) fail("format", "Age stanza tokens cannot be empty.");
          tokenBytes = 0;
          cap(++tokenCount, limits.tokens, "Age stanza tokens");
        } else {
          cap(++tokenBytes, limits.token, "Age token bytes");
        }
      }
      if (tokenBytes === 0) fail("format", "Age stanza tokens cannot be empty.");
      const tokens = start.text.slice(3).split(" ");
      const pieces: string[] = [];
      let bodyBytes = 0;
      for (;;) {
        const body = (await line()).text;
        if (body.length > 64) fail("format", "Age body lines cannot exceed 64 Base64 characters.");
        bodyBytes += base64(body);
        cap(bodyBytes, limits.body, "Age stanza body bytes");
        pieces.push(body);
        if (body.length < 64) break;
      }
      charge(opening, openWork, "decodedBytes", bodyBytes);
      stanzas.push(Object.freeze({ type: tokens[0]!, args: Object.freeze(tokens.slice(1)), body: pieces.join("") }));
    }
    if (stanzas.length === 0) fail("format", "Age requires at least one recipient stanza.");
    const macText = footer.text.slice(4);
    if (macText.length !== 43 || base64(macText) !== 32) fail("format", "Age header MAC has an invalid extent.");
    const headerBytes = position, aadBytes = footer.start + 3;
    charge(opening, openWork, "decodedBytes", aadBytes + headerBytes + 32);
    aad = prefix(aadBytes);
    const rawHeader = prefix(headerBytes);
    const header: AgeHeaderType = Object.freeze({
      raw: new TextDecoder().decode(rawHeader),
      bytes: headerBytes,
      stanzas: Object.freeze(stanzas),
      mac: macText,
    });
    rawHeader.fill(0);
    const mac = new Uint8Array(decodeBase64(macText));
    const ikm = await borrowed(() => cryptoImport("raw", fileKey, "HKDF", false, ["deriveBits"]));
    alive();
    openWork.nativeCalls++;
    const derive = async function derive(
      salt: Uint8Array<ArrayBuffer>,
      label: string,
    ): Promise<Uint8Array<ArrayBuffer>> {
      const result = await borrowed(() =>
        cryptoDerive({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(label) }, ikm, 256)
      );
      alive();
      openWork.nativeCalls++;
      if (!isBuffer(result)) fail("capability", "Age HKDF must return an ArrayBuffer.");
      return bytes(new Uint8Array(result), 32, "Age derived key");
    };
    const headerKey = await derive(new Uint8Array(0), "header");
    try {
      const hmac = await borrowed(() =>
        cryptoImport("raw", headerKey, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
      );
      alive();
      openWork.nativeCalls++;
      const valid = await borrowed(() => cryptoVerify("HMAC", hmac, mac, aad!));
      alive();
      openWork.nativeCalls++;
      if (valid !== true) fail("authentication", "Age header authentication failed.");
    } finally {
      headerKey.fill(0);
      mac.fill(0);
      aad.fill(0);
    }
    const payloadOffset = headerBytes + 16;
    const sealedBytes = physicalSize - payloadOffset;
    if (sealedBytes < 16) fail("format", "Age payload requires a nonce and final authentication tag.");
    const chunks = Math.ceil(sealedBytes / 65552), size = sealedBytes - 16 * chunks;
    if (size < 0 || chunks !== Math.max(1, Math.ceil(size / 65536))) {
      fail("format", "Age sealed payload has an invalid chunk extent.");
    }
    cap(size, limits.plain, "Age logical plaintext bytes");
    const logicalIdentity = identity === undefined
      ? undefined
      : JSON.stringify([profile, identity, headerBytes, size, macText]);
    if (logicalIdentity !== undefined) cap(logicalIdentity.length, 8192, "Age derived source identity");
    nonceSalt = await fetch(headerBytes, 16, opening, openWork);
    payloadKey = await derive(nonceSalt, "payload");
    nonceSalt.fill(0);
    for (const buffer of headerBuffers) buffer.fill(0);
    headerBuffers.length = 0;

    const plan = function plan(offset: number, length: number, whole = false): AgePlanType {
      alive();
      sourceRange(size, offset, length);
      if (!whole) cap(length, limits.read, "Age returned interval");
      const firstChunk = Math.floor(offset / 65536);
      const count = whole ? chunks : length === 0 ? 0 : Math.floor((offset + length - 1) / 65536) - firstChunk + 1;
      cap(count, whole ? limits.verify : limits.chunks, "Age operation chunks");
      const first = whole ? 0 : firstChunk;
      const authenticatedBytes = count === 0 ? 0 : Math.min(size, (first + count) * 65536) - first * 65536;
      const sourceBytes = authenticatedBytes + 16 * count;
      const outputBytes = whole ? 0 : length;
      const materializedBytes = sourceBytes + 2 * authenticatedBytes + 44 * count + outputBytes;
      const peakMaterializedBytes = outputBytes +
        (count ? Math.min(65552, sourceBytes) + 2 * Math.min(65536, authenticatedBytes) + 44 : 0);
      cap(peakMaterializedBytes, limits.memory, "Age operation materialization");
      return Object.freeze({
        offset,
        length,
        firstChunk: first,
        chunkCount: count,
        sourceBytes,
        requests: count,
        decodedBytes: 2 * authenticatedBytes,
        outputBytes,
        authenticatedBytes,
        materializedBytes,
        peakMaterializedBytes,
      });
    };
    const chunk = async function chunk(
      index: number,
      auth: AuthorityType,
      work: WorkType,
      prepaid: boolean,
    ): Promise<Uint8Array<ArrayBuffer>> {
      const offset = payloadOffset + index * 65552;
      const length = Math.min(65552, physicalSize - offset);
      const plainLength = length - 16;
      if (!prepaid) {
        charge(auth, work, "sourceBytes", length);
        charge(auth, work, "requests", 1);
        charge(auth, work, "decodedBytes", 2 * plainLength);
      }
      const sealed = await fetch(offset, length, auth, work, true);
      let key: Uint8Array<ArrayBuffer> | undefined, nonce: Uint8Array<ArrayBuffer> | undefined;
      try {
        alive(auth);
        key = new Uint8Array(payloadKey!);
        nonce = new Uint8Array(12);
        let counter = BigInt(index);
        for (let i = 10; i >= 0; i--) {
          nonce[i] = Number(counter & 255n);
          counter >>= 8n;
        }
        nonce[11] = index === chunks - 1 ? 1 : 0;
        const callKey = key, callNonce = nonce;
        // The provider owns the authentication sentinel. Unknown foreign
        // failures retain their exact reason, including undefined.
        const result = await borrowed(() => decrypt(callKey, callNonce, sealed, { signal: auth.signal }), auth);
        alive(auth);
        const owned = bytes(result, plainLength, "Age authenticated plaintext");
        work.chunks++;
        work.authenticatedBytes += plainLength;
        work.nativeCalls++;
        work.materializedBytes += length + 2 * plainLength + 44;
        work.peakMaterializedBytes = Math.max(work.peakMaterializedBytes, length + 2 * plainLength + 44);
        return owned;
      } finally {
        sealed.fill(0);
        key?.fill(0);
        nonce?.fill(0);
      }
    };
    // Finality authentication is mandatory even for an early selected range.
    const final = await chunk(chunks - 1, opening, openWork, false);
    final.fill(0);
    alive();
    active = false;
    const operation = async function operation<T>(
      suppliedRead: AgeReadOptionsType,
      action: (auth: AuthorityType, work: WorkType) => Promise<T>,
    ): Promise<T> {
      alive();
      if (active) fail("busy", "Age permits one operation at a time.");
      active = true;
      try {
        const auth = authority(readOptions(suppliedRead), controller.signal, opening);
        alive(auth);
        return await action(auth, fresh());
      } finally {
        active = false;
        finish();
      }
    };
    const read = async function read(
      offset: number,
      length: number,
      readOptions: AgeReadOptionsType = {},
    ): Promise<AgeReadType> {
      return await operation<AgeReadType>(readOptions, async (auth, work) => {
        const selected = plan(offset, length);
        // Reserve every dimension before allocating a result or fetching a unit.
        charge(auth, work, "sourceBytes", selected.sourceBytes);
        charge(auth, work, "requests", selected.requests);
        charge(auth, work, "decodedBytes", selected.decodedBytes);
        charge(auth, work, "outputBytes", length);
        const output = new Uint8Array(length);
        let success = false;
        try {
          for (let index = selected.firstChunk; index < selected.firstChunk + selected.chunkCount; index++) {
            const plain = await chunk(index, auth, work, true);
            try {
              alive(auth);
              const start = Math.max(offset, index * 65536),
                end = Math.min(offset + length, index * 65536 + plain.length);
              output.set(plain.subarray(start - index * 65536, end - index * 65536), start - offset);
            } finally {
              plain.fill(0);
            }
          }
          alive(auth);
          work.materializedBytes += length;
          work.peakMaterializedBytes = selected.peakMaterializedBytes;
          success = true;
          return {
            bytes: output,
            integrity: "selected-chunks-authenticated",
            firstChunk: selected.firstChunk,
            chunkCount: selected.chunkCount,
            work: Object.freeze({ ...work }),
          };
        } finally {
          if (!success) output.fill(0);
        }
      });
    };
    const verifyAll = async function verifyAll(readOptions: AgeReadOptionsType = {}): Promise<AgeVerifyType> {
      return await operation<AgeVerifyType>(readOptions, async (auth, work) => {
        const all = plan(0, size, true);
        charge(auth, work, "sourceBytes", all.sourceBytes);
        charge(auth, work, "requests", all.requests);
        charge(auth, work, "decodedBytes", all.decodedBytes);
        charge(auth, work, "outputBytes", 0);
        for (let index = 0; index < chunks; index++) {
          const plain = await chunk(index, auth, work, true);
          plain.fill(0);
        }
        alive(auth);
        return { integrity: "all-chunks-authenticated", work: Object.freeze({ ...work }) };
      });
    };
    const source: AgeSourceType = Object.freeze({
      size,
      stability,
      ...(logicalIdentity === undefined ? {} : { identity: logicalIdentity }),
      async read(offset: number, length: number, readOptions: AgeReadOptionsType = {}): Promise<Uint8Array> {
        return (await read(offset, length, readOptions)).bytes;
      },
    });
    const dispose = async function dispose(): Promise<void> {
      cancel();
      await joined.promise;
    };
    return Object.freeze<AgeOpenedType>({
      profile,
      header,
      size,
      integrity: "header-and-final-chunk-authenticated",
      get source() {
        alive();
        return source;
      },
      work: Object.freeze({ ...openWork }),
      closed: joined.promise,
      plan: (offset: number, length: number) => plan(offset, length),
      read,
      verify: verifyAll,
      cancel,
      dispose,
      [Symbol.asyncDispose]: dispose,
    });
  } catch (reason) {
    cancel(reason);
    active = false;
    finish();
    throw reason;
  } finally {
    aad?.fill(0);
    nonceSalt?.fill(0);
    for (const buffer of headerBuffers) buffer.fill(0);
  }
}
