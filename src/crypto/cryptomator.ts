/** Selected authenticated Cryptomator format 8 previews; no password or filesystem acquisition. @module */
import { isBytes, toView } from "../bytes.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType, SourceReadOptionsType } from "../source.ts";
import { createArchiveLedger, integer, limitsOf } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Explicit key context and finite aggregate work policy. Native cryptography is a trusted capability. */
export interface CryptomatorOptionsType extends ArchiveLimitsType, SourceReadOptionsType {
  readonly subtle: SubtleCrypto;
  /** Maximum compact configuration bytes. Default: 16 KiB; hard ceiling: 64 KiB. */
  readonly maxConfigurationBytes?: number;
  /** Maximum ciphertext filename bytes, including suffix. Default: 4096; hard ceiling: 16384. */
  readonly maxNameBytes?: number;
  /** Maximum complete covering chunks per read/verification. Default: 256; hard ceiling: 4096. */
  readonly maxChunks?: number;
  /** Aggregate admitted native calls, including imports, verification and generation; unused credits are not refunded. Default: 8192; ceiling: 1,000,000. */
  readonly maxNativeCalls?: number;
  /** Concurrent admitted operations; excess operations refuse without queueing. Default: 4; ceiling: 16. */
  readonly maxConcurrent?: number;
  /** Maximum live plaintext-source key slots. Default: 64; hard ceiling: 1024. Dispose sources to release slots. */
  readonly maxOpenFiles?: number;
}

/** Additional authority can narrow a read; it cannot remove the opening limits, ledger or signal. */
export interface CryptomatorReadOptionsType extends ArchiveLimitsType, SourceReadOptionsType {}

/** A stable encrypted source remains borrowed. The caller can explicitly assert otherwise unverified stability. */
export interface CryptomatorOpenOptionsType extends CryptomatorReadOptionsType {
  readonly allowUnverifiedSource?: boolean;
}

/** Authentication applies only to the complete chunks covering this returned range. */
export interface CryptomatorReadType {
  readonly bytes: Uint8Array;
  readonly scope: "covering-chunks-authenticated";
  readonly firstChunk: number;
  readonly chunks: number;
  readonly work: ArchiveWorkType;
}

/** A plaintext source whose exact reads authenticate all complete covering chunks before returning. */
export interface CryptomatorSourceType extends ByteSourceType, AsyncDisposable {
  readonly profile: "cryptomator-format8-siv-gcm";
  readonly header: "authenticated";
  readonly originalLength: "not-authenticated";
  readVerified(offset: number, length: number, options?: CryptomatorReadOptionsType): Promise<CryptomatorReadType>;
  /** Checks all present chunks, not original EOF or freshness. No complete plaintext file is retained. */
  verify(options: CryptomatorReadOptionsType & { readonly maxCiphertextBytes: number }): Promise<{
    readonly scope: "all-present-chunks-authenticated";
    readonly chunks: number;
    readonly work: ArchiveWorkType;
  }>;
}

/** A key-owning capability for one verified configuration; sources and cancellation signals remain borrowed. */
export interface CryptomatorVaultType extends AsyncDisposable {
  readonly format: 8;
  readonly cipherCombo: "SIV_GCM";
  readonly shorteningThreshold: number;
  /** Ordinary .c9r names only. The name is associated with its directory ID, not file contents. */
  decryptName(name: string, parentDirectoryId: string, options?: CryptomatorReadOptionsType): Promise<{
    readonly name: string;
    readonly scope: "name-and-parent-authenticated";
    readonly work: ArchiveWorkType;
  }>;
  open(source: ByteSourceType, options?: CryptomatorOpenOptionsType): Promise<CryptomatorSourceType>;
}

/** One operation can consume only its own pre-admitted native calls. */
type DispatchType = <T>(task: () => Promise<T>) => Promise<T>;

/** Stable failures do not include key bytes, decrypted names, or native exception text. */
export class CryptomatorError extends Error {
  readonly code: "format" | "profile" | "authentication" | "limit" | "closed" | "stability";
  constructor(code: CryptomatorError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CryptomatorError";
    this.code = code;
  }
}

function fail(code: CryptomatorError["code"], message: string): never {
  throw new CryptomatorError(code, message);
}
/** Hard ceilings protect allocation even if a caller supplies a large aggregate ledger. */
function cap(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  const result = value ?? fallback;
  integer(result, name);
  if (result > ceiling) fail("limit", `${name} exceeds the implementation ceiling.`);
  return result;
}
/** Byte inputs may be cross-realm; copy before the first asynchronous capability call. */
function copy(input: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!isBytes(input)) throw new TypeError("Expected byte input.");
  return new Uint8Array(toView(input));
}
/** Preserve every parent signal, with no listeners owned by this module. */
function signals(...values: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = [...new Set(values.filter((value): value is AbortSignal => value !== undefined))];
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}
/** Capturing dispatch prevents later method replacement from changing an admitted aggregate authority. */
function owner(ledger: ArchiveLedgerType | undefined): ArchiveLedgerType | undefined {
  return ledger && { reserve: ledger.reserve.bind(ledger), inspect: ledger.inspect.bind(ledger) };
}
/** Intersect per-call limits while retaining opening lifetime ceilings separately. */
function narrow(left: ArchiveLimitsType, right: ArchiveLimitsType): ArchiveLimitsType {
  const a = limitsOf(left), b = limitsOf(right);
  return {
    maxSourceBytes: Math.min(a.maxSourceBytes, b.maxSourceBytes),
    maxRequests: Math.min(a.maxRequests, b.maxRequests),
    maxDecodedBytes: Math.min(a.maxDecodedBytes, b.maxDecodedBytes),
    maxOutputBytes: Math.min(a.maxOutputBytes, b.maxOutputBytes),
  };
}
/** A local receipt plus distinct aggregate owners; refused reservations are never refunded. */
function accounting(policy: ArchiveLimitsType, ledgers: readonly (ArchiveLedgerType | undefined)[]) {
  const local = createArchiveLedger(policy);
  const unique = [...new Set([local, ...ledgers].filter((value): value is ArchiveLedgerType => value !== undefined))];
  return {
    reserve(kind: keyof ArchiveWorkType, count: number) {
      for (const ledger of unique) ledger.reserve(kind, count);
    },
    inspect: local.inspect,
  };
}

/** Strict base64url decoding also rejects aliases in JWT signing fields and stored names. */
function unbase64(value: string, padded: boolean): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value) || (!padded && value.includes("="))) {
    fail("format", "Invalid base64url framing.");
  }
  const bare = value.replace(/=+$/, "");
  if (bare.length % 4 === 1 || (padded && value.length % 4 !== 0)) fail("format", "Invalid base64url length.");
  let text: string;
  try {
    text = atob(bare.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(bare.length / 4) * 4, "="));
  } catch {
    return fail("format", "Invalid base64url value.");
  }
  const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
  const canonical = btoa(text).replace(/\+/g, "-").replace(/\//g, "_");
  if ((padded ? canonical : canonical.replace(/=+$/, "")) !== value) fail("format", "Noncanonical base64url value.");
  return bytes;
}
/** The selected JWT profile has only primitive fields. This avoids duplicate-key and nested-JSON ambiguity. */
function fields(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("format", "Configuration JSON is not UTF-8.");
  }
  let at = 0;
  const whitespace = () => {
    while (/[\t\r\n ]/.test(text[at] ?? "x")) at++;
  };
  const token =
    /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const next = (): unknown => {
    whitespace();
    token.lastIndex = at;
    const match = token.exec(text);
    if (!match) fail("format", "Configuration must contain primitive JSON fields.");
    at = token.lastIndex;
    if (/^-?\d/.test(match[0])) return { numeric: match[0] };
    try {
      return JSON.parse(match[0]);
    } catch {
      return fail("format", "Invalid configuration JSON primitive.");
    }
  };
  const result: Record<string, unknown> = Object.create(null);
  whitespace();
  if (text[at++] !== "{") fail("format", "Configuration must be a JSON object.");
  whitespace();
  if (text[at] !== "}") {
    for (;;) {
      const key = next();
      if (typeof key !== "string" || Object.hasOwn(result, key)) {
        fail("format", "Duplicate or invalid configuration key.");
      }
      whitespace();
      if (text[at++] !== ":") fail("format", "Invalid configuration field.");
      result[key] = next();
      whitespace();
      if (text[at] !== ",") break;
      at++;
    }
  }
  if (text[at++] !== "}") fail("format", "Invalid configuration object.");
  whitespace();
  if (at !== text.length) fail("format", "Trailing configuration JSON.");
  return result;
}
/** Selected integers retain their signed JSON spelling until canonical, exact admission. */
function numberField(value: unknown, name: string): number {
  if (
    typeof value !== "object" || value === null || !("numeric" in value) || typeof value.numeric !== "string" ||
    !/^(?:0|[1-9]\d*)$/.test(value.numeric)
  ) {
    return fail("format", `${name} must be a canonical nonnegative JSON integer.`);
  }
  const result = Number(value.numeric);
  integer(result, name);
  return result;
}
/** Fixed-width GF(2^128) doubling: reduction uses a mask rather than a secret-dependent branch. */
function double(block: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (block[i]! << 1) | ((block[i + 1] ?? 0) >>> 7);
  out[15] = out[15]! ^ (0x87 & -(block[0]! >>> 7));
  return out;
}
/** Input sizes, not data values, choose the CMAC/S2V padding branches. */
function xor(target: Uint8Array, other: Uint8Array, offset = 0): void {
  for (let i = 0; i < other.length; i++) target[offset + i] = target[offset + i]! ^ other[i]!;
}

/**
 * Verify an explicit configuration and acquire nonextractable native keys. The raw key is ENC32 || MAC32.
 * Native jobs are not abortable; opening waits for each to settle before clearing its owned raw copy.
 */
export async function openCryptomator(
  configuration: Uint8Array,
  masterKey: Uint8Array,
  supplied: CryptomatorOptionsType,
): Promise<CryptomatorVaultType> {
  const options = { ...supplied };
  const configLimit = cap(options.maxConfigurationBytes, 16384, 65536, "Configuration byte limit");
  const nameLimit = cap(options.maxNameBytes, 4096, 16384, "Name byte limit");
  const chunkLimit = cap(options.maxChunks, 256, 4096, "Chunk limit");
  const callLimit = cap(options.maxNativeCalls, 8192, 1000000, "Native call limit");
  const concurrent = cap(options.maxConcurrent, 4, 16, "Concurrent operation limit");
  const fileLimit = cap(options.maxOpenFiles, 64, 1024, "Open file limit");
  if (concurrent === 0) fail("limit", "At least one concurrent operation must be admitted.");
  if (
    !isBytes(configuration) || configuration.byteLength > configLimit || !isBytes(masterKey) ||
    masterKey.byteLength !== 64
  ) {
    fail("format", "Expected a bounded configuration and exactly 64 raw master-key bytes.");
  }
  const subtle = options.subtle;
  const crypto = {
    importKey: subtle.importKey.bind(subtle),
    decrypt: subtle.decrypt.bind(subtle),
    encrypt: subtle.encrypt.bind(subtle),
    sign: subtle.sign.bind(subtle),
    verify: subtle.verify.bind(subtle),
    generateKey: subtle.generateKey.bind(subtle),
  };
  const root = createArchiveLedger(options);
  // Original identities stay in the set; dispatch wrappers are captured independently.
  const rootOwners = new Map<ArchiveLedgerType, ArchiveLedgerType>();
  if (options.ledger) rootOwners.set(options.ledger, owner(options.ledger)!);
  const inherited = (extra?: ArchiveLedgerType) => {
    const owners = new Map(rootOwners);
    if (extra && !owners.has(extra)) owners.set(extra, owner(extra)!);
    return [root, ...owners.values()];
  };
  let calls = 0, closed = false;
  const active = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  /** Reserve the complete known call graph before effects; unused credits are not refunded. */
  function admitNative(count: number, signal?: AbortSignal): DispatchType {
    signal?.throwIfAborted();
    if (count > callLimit - calls) fail("limit", "Native call allowance exhausted.");
    calls += count;
    let remaining = count;
    return async <T>(task: () => Promise<T>): Promise<T> => {
      signal?.throwIfAborted();
      if (remaining === 0) fail("limit", "Operation native call credits exhausted.");
      remaining--;
      const result = await task();
      signal?.throwIfAborted();
      return result;
    };
  }
  options.signal?.throwIfAborted();
  for (const ledger of [root, ...rootOwners.values()]) ledger.reserve("decodedBytes", configuration.byteLength);
  options.signal?.throwIfAborted();
  const native = admitNative(6, options.signal);
  const encoded = copy(configuration), raw = copy(masterKey);
  let gcm: CryptoKey | undefined,
    cbc: CryptoKey | undefined,
    ctr: CryptoKey | undefined,
    equality: CryptoKey | undefined;
  let threshold = 0;
  try {
    options.signal?.throwIfAborted();
    const token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded);
    if (!/^[\x21-\x7e]+$/.test(token)) fail("format", "Configuration must be a compact JWT.");
    const parts = token.split(".");
    if (parts.length !== 3) fail("format", "Configuration must have three JWT fields.");
    const header = fields(unbase64(parts[0]!, false));
    if (header.alg !== "HS256" || header.typ !== "JWT" || Object.hasOwn(header, "crit")) {
      fail("profile", "Only ordinary HS256 JWT configurations are supported.");
    }
    const signature = unbase64(parts[2]!, false);
    if (signature.length !== 32) fail("format", "HS256 configuration tag must be 32 bytes.");
    const configKey = await native(() =>
      crypto.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
    );
    const valid = await native(() =>
      crypto.verify("HMAC", configKey, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    );
    if (!valid) fail("authentication", "Configuration authentication failed.");
    const payload = fields(unbase64(parts[1]!, false));
    if (numberField(payload.format, "Vault format") !== 8 || payload.cipherCombo !== "SIV_GCM") {
      fail("profile", "Only format 8 SIV_GCM is supported.");
    }
    threshold = cap(
      numberField(payload.shorteningThreshold, "Shortening threshold"),
      220,
      16384,
      "Shortening threshold",
    );
    if (threshold < 28) fail("profile", "Shortening threshold is too small for ordinary names.");
    gcm = await native(() => crypto.importKey("raw", raw.subarray(0, 32), "AES-GCM", false, ["decrypt"]));
    cbc = await native(() => crypto.importKey("raw", raw.subarray(32), "AES-CBC", false, ["encrypt"]));
    ctr = await native(() => crypto.importKey("raw", raw.subarray(0, 32), "AES-CTR", false, ["decrypt"]));
    equality = await native(() =>
      crypto.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"])
    );
  } finally {
    raw.fill(0);
    encoded.fill(0);
  }
  /** Register before foreign callbacks can run. There is no waiting-operation queue. */
  function run<T>(task: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new CryptomatorError("closed", "The vault capability is closed."));
    if (active.size >= concurrent) {
      return Promise.reject(new CryptomatorError("limit", "Concurrent operation allowance exhausted."));
    }
    const pending = Promise.resolve().then(task);
    active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
    return pending;
  }
  /** Native CBC adds a padding block. Select the requested non-padding block explicitly. */
  async function cmac(
    message: Uint8Array,
    work: ReturnType<typeof accounting>,
    native: DispatchType,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    work.reserve("decodedBytes", 32);
    signal?.throwIfAborted();
    const zero = new Uint8Array(16);
    const initial = new Uint8Array(
      await native(() => crypto.encrypt({ name: "AES-CBC", iv: zero }, cbc!, zero)),
    );
    const k1 = double(initial.subarray(0, 16)), k2 = double(k1);
    const full = message.length > 0 && message.length % 16 === 0;
    const length = Math.max(16, Math.ceil(message.length / 16) * 16);
    work.reserve("decodedBytes", length + 16);
    signal?.throwIfAborted();
    const input = new Uint8Array(length);
    input.set(message);
    if (!full) input[message.length] = 0x80;
    xor(input, full ? k1 : k2, length - 16);
    try {
      const result = new Uint8Array(
        await native(() => crypto.encrypt({ name: "AES-CBC", iv: zero }, cbc!, input)),
      );
      try {
        return result.slice(length - 16, length);
      } finally {
        result.fill(0);
      }
    } finally {
      input.fill(0);
      initial.fill(0);
      k1.fill(0);
      k2.fill(0);
    }
  }
  /** One AD item, including an empty root ID, is mandatory for a filename. */
  async function s2v(
    message: Uint8Array,
    directory: Uint8Array,
    work: ReturnType<typeof accounting>,
    native: DispatchType,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const first = await cmac(new Uint8Array(16), work, native, signal);
    const d = double(first);
    first.fill(0);
    const ad = await cmac(directory, work, native, signal);
    xor(d, ad);
    ad.fill(0);
    const input = message.length >= 16 ? copy(message) : new Uint8Array(16);
    if (message.length >= 16) xor(input, d, input.length - 16);
    else {
      input.set(message);
      input[message.length] = 0x80;
      const next = double(d);
      xor(input, next);
      next.fill(0);
    }
    try {
      return await cmac(input, work, native, signal);
    } finally {
      input.fill(0);
      d.fill(0);
    }
  }
  /** Native GCM failures are authentication failures; admission/abort failures retain their identity. */
  async function decryptGcm(
    key: CryptoKey,
    nonce: Uint8Array<ArrayBuffer>,
    body: Uint8Array<ArrayBuffer>,
    native: DispatchType,
    additionalData?: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const result = await native(async () => {
      try {
        return await crypto.decrypt(
          { name: "AES-GCM", iv: nonce, ...(additionalData ? { additionalData } : {}), tagLength: 128 },
          key,
          body,
        );
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "name" in cause && cause.name === "OperationError") {
          throw new CryptomatorError("authentication", "GCM authentication failed.", { cause });
        }
        throw cause;
      }
    });
    return new Uint8Array(result);
  }

  return Object.freeze({
    format: 8 as const,
    cipherCombo: "SIV_GCM" as const,
    shorteningThreshold: threshold,
    async decryptName(name: string, parentDirectoryId: string, suppliedRead: CryptomatorReadOptionsType = {}) {
      if (closed) fail("closed", "The vault capability is closed.");
      const opts = { ...suppliedRead };
      const signal = signals(options.signal, opts.signal);
      signal?.throwIfAborted();
      const work = accounting(narrow(options, opts), inherited(opts.ledger));
      if (typeof name !== "string" || name.length > nameLimit || name.length > threshold || !name.endsWith(".c9r")) {
        fail("profile", "Expected one bounded ordinary .c9r name.");
      }
      if (
        typeof parentDirectoryId !== "string" || parentDirectoryId.length > 36 ||
        !/^[\x20-\x7e]*$/.test(parentDirectoryId)
      ) fail("profile", "Expected an ASCII directory ID of at most 36 bytes.");
      const ciphertext = unbase64(name.slice(0, -4), true);
      if (ciphertext.length <= 16) fail("format", "An encrypted filename must contain a nonempty name.");
      const directory = new TextEncoder().encode(parentDirectoryId);
      return run(async () => {
        signal?.throwIfAborted();
        const size = ciphertext.length - 16;
        work.reserve("outputBytes", size);
        work.reserve("decodedBytes", size);
        signal?.throwIfAborted();
        const native = admitNative(9, signal);
        const tag = ciphertext.slice(0, 16), counter = copy(tag);
        counter[8] = counter[8]! & 0x7f;
        counter[12] = counter[12]! & 0x7f;
        let plain: Uint8Array<ArrayBuffer> | undefined, recomputed: Uint8Array<ArrayBuffer> | undefined;
        try {
          plain = new Uint8Array(
            await native(() =>
              crypto.decrypt({ name: "AES-CTR", counter, length: 128 }, ctr!, ciphertext.subarray(16))
            ),
          );
          recomputed = await s2v(plain, directory, work, native, signal);
          // HMAC is an internal native equality witness, never a Cryptomator wire field.
          work.reserve("decodedBytes", 32);
          const witness = await native(() => crypto.sign("HMAC", equality!, recomputed!));
          const valid = await native(() => crypto.verify("HMAC", equality!, witness, tag));
          if (!valid) fail("authentication", "Filename authentication failed.");
          let decoded: string;
          try {
            decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
          } catch {
            return fail("profile", "Authenticated filename is not UTF-8.");
          }
          if (
            decoded.normalize("NFC") !== decoded ||
            (decoded.includes("\0") || decoded.includes("/") || decoded.includes("\\")) || decoded === "." ||
            decoded === ".."
          ) fail("profile", "Authenticated filename is outside the inert NFC name profile.");
          signal?.throwIfAborted();
          return { name: decoded, scope: "name-and-parent-authenticated" as const, work: work.inspect() };
        } finally {
          plain?.fill(0);
          recomputed?.fill(0);
          counter.fill(0);
        }
      });
    },
    async open(input: ByteSourceType, suppliedOpen: CryptomatorOpenOptionsType = {}) {
      if (closed) fail("closed", "The vault capability is closed.");
      const opts = { ...suppliedOpen }, { size, identity, stability } = input;
      integer(size, "Encrypted file size");
      if (size < 68) fail("format", "Truncated encrypted file header.");
      if (stability !== undefined && stability !== "immutable" && stability !== "provider" && stability !== "caller") {
        fail("stability", "Unknown source stability.");
      }
      if (!stability && !opts.allowUnverifiedSource) {
        fail("stability", "A stable source or explicit caller assertion is required.");
      }
      if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
        fail("stability", "Source identity must be a bounded string.");
      }
      const source = Object.freeze({ size, read: input.read.bind(input) });
      const body = size - 68, whole = Math.floor(body / 32796), tail = body % 32796;
      if (tail !== 0 && tail < 29) fail("profile", "A partial or explicit empty final chunk is outside this profile.");
      const clearSize = whole * 32768 + (tail ? tail - 28 : 0);
      integer(clearSize, "Plaintext size");
      const chunkCount = whole + (tail ? 1 : 0);
      const policy = narrow(options, opts), fileLedger = createArchiveLedger(policy);
      const fileOwners = new Map(rootOwners);
      if (opts.ledger && !fileOwners.has(opts.ledger)) fileOwners.set(opts.ledger, owner(opts.ledger)!);
      const owners = (ledger?: ArchiveLedgerType) => {
        const list = new Map(fileOwners);
        if (ledger && !list.has(ledger)) list.set(ledger, owner(ledger)!);
        return [root, fileLedger, ...list.values()];
      };
      const parentSignal = signals(options.signal, opts.signal);
      const opening = accounting(policy, owners());
      /** The source may lend scratch bytes: make an owned copy before another callback can reuse it. */
      async function extent(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
        signal?.throwIfAborted();
        const value = await source.read(offset, length, signal ? { signal } : {});
        signal?.throwIfAborted();
        if (!isBytes(value) || value.byteLength !== length) {
          fail("format", "Encrypted source returned an incomplete byte extent.");
        }
        return copy(value);
      }
      return run(async () => {
        parentSignal?.throwIfAborted();
        if (releases.size >= fileLimit) fail("limit", "Open plaintext-source limit exceeded.");
        const pendingSlot = () => {};
        releases.add(pendingSlot);
        try {
          opening.reserve("sourceBytes", 68);
          opening.reserve("requests", 1);
          opening.reserve("decodedBytes", 40);
          parentSignal?.throwIfAborted();
          const native = admitNative(2, parentSignal);
          const header = await extent(0, 68, parentSignal);
          const nonce = header.slice(0, 12);
          let fileKey: CryptoKey | undefined;
          let fileClosed = false;
          const payload = await decryptGcm(gcm!, nonce, header.slice(12), native);
          try {
            for (let i = 0; i < 8; i++) {
              if (payload[i] !== 255) fail("profile", "Unsupported authenticated header reserved value.");
            }
            fileKey = await native(() => crypto.importKey("raw", payload.subarray(8), "AES-GCM", false, ["decrypt"]));
          } finally {
            payload.fill(0);
          }
          /** All covering costs are known and admitted before selected output or chunk storage is allocated. */
          const read = (offset: number, length: number, suppliedRead: CryptomatorReadOptionsType, keep: boolean) => {
            if (fileClosed || closed) fail("closed", "The plaintext source is closed.");
            const readOptions = { ...suppliedRead };
            sourceRange(clearSize, offset, length);
            const signal = signals(parentSignal, readOptions.signal);
            const work = accounting(narrow(policy, readOptions), owners(readOptions.ledger));
            const first = length === 0 ? 0 : Math.floor(offset / 32768);
            const last = length === 0 ? -1 : Math.floor((offset + length - 1) / 32768);
            const count = last - first + 1;
            if (count > chunkLimit) fail("limit", "Covering chunk limit exceeded.");
            return run(async () => {
              signal?.throwIfAborted();
              const start = 68 + first * 32796, end = count ? Math.min(size, 68 + (last + 1) * 32796) : start;
              work.reserve("sourceBytes", end - start);
              work.reserve("requests", count);
              const decoded = count ? Math.min(clearSize, (last + 1) * 32768) - first * 32768 : 0;
              work.reserve("decodedBytes", decoded);
              work.reserve("outputBytes", keep ? length : 0);
              signal?.throwIfAborted();
              const native = admitNative(count, signal);
              const out = new Uint8Array(keep ? length : 0);
              try {
                for (let index = first; index <= last; index++) {
                  signal?.throwIfAborted();
                  const at = 68 + index * 32796, cipherLength = Math.min(32796, size - at);
                  const ciphertext = await extent(at, cipherLength, signal);
                  const aad = new Uint8Array(20);
                  new DataView(aad.buffer).setBigUint64(0, BigInt(index));
                  aad.set(nonce, 8);
                  const plaintext = await decryptGcm(
                    fileKey!,
                    ciphertext.slice(0, 12),
                    ciphertext.slice(12),
                    native,
                    aad,
                  );
                  try {
                    if (keep) {
                      const from = Math.max(offset, index * 32768),
                        to = Math.min(offset + length, index * 32768 + plaintext.length);
                      out.set(plaintext.subarray(from - index * 32768, to - index * 32768), from - offset);
                    }
                  } finally {
                    plaintext.fill(0);
                  }
                }
                signal?.throwIfAborted();
                return {
                  bytes: out,
                  scope: "covering-chunks-authenticated" as const,
                  firstChunk: first,
                  chunks: count,
                  work: work.inspect(),
                };
              } catch (error) {
                out.fill(0);
                throw error;
              }
            });
          };
          const release = () => {
            fileClosed = true;
            fileKey = undefined;
            releases.delete(release);
          };
          const result: CryptomatorSourceType = {
            size: clearSize,
            stability: stability ?? "caller",
            profile: "cryptomator-format8-siv-gcm",
            header: "authenticated",
            originalLength: "not-authenticated",
            // Ciphertext identity alone does not identify plaintext key context. Deliberately omit identity.
            read: async (offset, length, readOptions = {}) => (await read(offset, length, readOptions, true)).bytes,
            readVerified: async (offset, length, readOptions = {}) => read(offset, length, readOptions, true),
            async [Symbol.asyncDispose]() {
              fileClosed = true;
              await Promise.allSettled([...active]);
              release();
            },
            async verify(suppliedVerify) {
              const verifyOptions = { ...suppliedVerify };
              integer(verifyOptions.maxCiphertextBytes, "Whole-file ciphertext allowance");
              if (size > verifyOptions.maxCiphertextBytes) fail("limit", "Whole-file ciphertext allowance exceeded.");
              const checked = await read(0, clearSize, verifyOptions, false);
              signals(parentSignal, verifyOptions.signal)?.throwIfAborted();
              return { scope: "all-present-chunks-authenticated", chunks: chunkCount, work: checked.work };
            },
          };
          parentSignal?.throwIfAborted();
          releases.add(release);
          return Object.freeze(result);
        } finally {
          releases.delete(pendingSlot);
        }
      });
    },
    async [Symbol.asyncDispose]() {
      closed = true;
      await Promise.allSettled([...active]);
      for (const release of releases) release();
      gcm = undefined;
      cbc = undefined;
      ctr = undefined;
      equality = undefined;
    },
  });
}
