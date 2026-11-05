import { openZipAes } from "./aes.ts";
import type { ZipAesOptionsType, ZipAesStateType } from "./aes.ts";
export type { ZipAesOptionsType } from "./aes.ts";
import { createZipCrypto } from "./password.ts";
import { readZipBzip } from "./zip-bzip.ts";
import type { ZipBzipOptionsType } from "./zip-bzip.ts";
export type { ZipBzipOptionsType } from "./zip-bzip.ts";
import { createArchiveLedger } from "./record.ts";
import type { ByteSourceType } from "../source.ts";
import { close } from "../close.ts";
import { isBytes, toRequestBytes, toView } from "../bytes.ts";
import { ArchiveBudget, ArchiveError, crc32, integer, invalid, limitsOf, uint64, unsupported, view } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** A stable directory identity. Duplicate names remain separate entries. */
export interface ZipEntryType {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly encrypted: boolean;
  /** Exact inspected encryption profile; reading still requires explicit password/capability admission. */
  readonly encryption?: "zipcrypto" | "winzip-aes" | "unsupported";
  readonly aes?: ZipAesMetadataType;
  readonly directory: boolean;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly crc32: number;
}

/** Inspected WinZip AES extra-field values. Ciphertext authentication does not authenticate this metadata. */
export interface ZipAesMetadataType {
  readonly version: 1 | 2;
  readonly strength: 128 | 192 | 256;
  readonly method: number;
}

/** Opening limits also bound cumulative work for this directory and every later member read. */
export interface ZipOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly maxDirectoryBytes?: number;
  readonly maxEntries?: number;
  /** Explicitly accepts mutation risk when an injected source declares no snapshot stability. */
  readonly allowUnverifiedSource?: boolean;
  /** Used only for non-UTF-8 names; default accepts ASCII and refuses ambiguous legacy bytes. */
  readonly decodeName?: (bytes: Uint8Array) => string;
}

/** A codec factory is called per read and must provide an independently owned raw-DEFLATE transform. */
export type ZipInflateType = () => TransformStream<Uint8Array, Uint8Array>;

/** A decoded interval; per-read limits can narrow, but cannot raise, the remaining opening allowance. */
export interface ZipReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  readonly verify?: boolean;
  readonly inflate?: ZipInflateType;
  /** Optional bounded BZip2 kernel policy for unencrypted compression method 12. */
  readonly bzip?: ZipBzipOptionsType;
  /** Explicit password bytes. Copied before source I/O; no password text encoding is inferred. */
  readonly password?: Uint8Array;
  /** Maximum password byte length. Default 1024. No text encoding is inferred. */
  readonly maxPasswordBytes?: number;
  /** Explicit native capability and finite limits for the WinZip AES STORED read profile. */
  readonly aes?: ZipAesOptionsType;
}

/** CRC verification detects accidental corruption, not malicious modification or sender identity. */
export interface ZipReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "checksum-pending" | "checksum-verified" | "not-provided";
  readonly work: ArchiveWorkType;
  /** BZip2 block/stream checks are separate from the ZIP CRC over the complete plaintext member. */
  readonly codec?: {
    readonly kind: "bzip2";
    readonly integrity: "checksum-pending" | "checksum-verified";
    readonly verifiedBlocks: number;
    readonly steps: number;
    readonly memoryBytes: number;
  };
  /** Authentication covers ciphertext only, never names, ZIP metadata, a sender or the whole archive. */
  readonly encryption?: { readonly kind: "zipcrypto"; readonly authentication: "none" } | {
    readonly kind: "winzip-aes";
    readonly authentication: "ciphertext-verified";
  };
}

/** Deterministic admission. Local-header lengths and codec availability remain execution-time facts. */
export interface ZipPlanType {
  readonly supported: boolean;
  readonly reason?: "encrypted-member" | "compression-method" | "budget-exceeded";
  readonly access: "direct-range" | "decode-from-start" | "authenticated-range";
  readonly outputBytes: number;
  /** Minimum plaintext work from metadata. Native chunking and BZip2 block transforms can require more. */
  readonly decodedBytes: number;
  readonly sourceBytes: number;
  readonly headerBytes: "unknown";
  readonly verification: "none" | "full-member-crc" | "full-member-decode";
  readonly authentication?: "full-member-hmac";
  readonly cryptoBlocks?: number;
}

/**
 * An opened directory borrows its source and captures its descriptor and read method before I/O.
 * Opening limits, ledger and abort signal remain authoritative for every read.
 * It owns no provider or background work; changing underlying bytes invalidates its offsets.
 */
export interface ZipArchiveType {
  readonly entries: readonly ZipEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  plan(id: number, options?: ZipReadOptionsType): ZipPlanType;
  read(id: number, options?: ZipReadOptionsType): Promise<ZipReadType>;
}

/** Private local-header evidence must not be mutable through public metadata objects. */
interface EntryType {
  readonly entry: ZipEntryType;
  readonly name: Uint8Array;
  readonly flags: number;
  readonly offset: number;
  readonly time: number;
  readonly needed: number;
}

/** Open a single-disk ZIP/ZIP64 directory without extracting its members. */
export async function openZip(source: ByteSourceType, options: ZipOpenOptionsType = {}): Promise<ZipArchiveType> {
  options = { ...options };
  const size = source.size, identity = source.identity, stability = source.stability, read = source.read.bind(source);
  integer(size, "ZIP source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Invalid ZIP source identity.");
  }
  if (stability !== undefined && stability !== "immutable" && stability !== "provider" && stability !== "caller") {
    throw new TypeError("Unknown ZIP source stability evidence.");
  }
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("ZIP unverified-source acceptance must be an explicit boolean.");
  }
  if (options.decodeName !== undefined && typeof options.decodeName !== "function") {
    throw new TypeError("ZIP name decoder must be a function.");
  }
  if (!stability && options.allowUnverifiedSource !== true) {
    unsupported("ZIP index reads require declared source stability or explicit unverified-source acceptance.");
  }
  // Source descriptors and the opening authority belong to this snapshot. Later
  // reads cannot substitute a source method, reset its ledger or replace its abort.
  source = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read,
  };
  const limits = limitsOf(options), lifetime = createArchiveLedger(options), external = options.ledger;
  const openingLedger = {
    reserve(kind: keyof ArchiveWorkType, count: number): void {
      lifetime.reserve(kind, count);
      external?.reserve(kind, count);
    },
    inspect: lifetime.inspect,
  };
  const budget = new ArchiveBudget(source, { ...options, ledger: openingLedger }, options.signal);
  const maxDirectory = options.maxDirectoryBytes ?? 16 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 100_000;
  integer(maxDirectory, "Directory limit");
  integer(maxEntries, "Entry limit");
  if (source.size < 22) invalid("ZIP end record is missing.");
  const tailOffset = Math.max(0, source.size - 22 - 65535);
  const tail = await budget.read(tailOffset, source.size - tailOffset);
  const data = view(tail);
  let end = -1;
  // A signature inside the comment is not an end record unless its declared end is EOF.
  for (let index = tail.byteLength - 22; index >= 0; index--) {
    if (
      data.getUint32(index, true) === 0x06054b50 && index + 22 + data.getUint16(index + 20, true) === tail.byteLength
    ) {
      end = index;
      break;
    }
  }
  if (end < 0) invalid("ZIP end record is missing or has trailing bytes.");
  if (data.getUint16(end + 4, true) !== 0 || data.getUint16(end + 6, true) !== 0) {
    unsupported("Split ZIP archives are unsupported.");
  }
  let count = data.getUint16(end + 10, true);
  if (data.getUint16(end + 8, true) !== count) unsupported("Split ZIP entry counts are unsupported.");
  let directorySize = data.getUint32(end + 12, true);
  let directoryOffset = data.getUint32(end + 16, true);
  let directoryEnd = tailOffset + end;
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorOffset = tailOffset + end - 20;
    if (locatorOffset < 0) invalid("ZIP64 locator is missing.");
    const locator = view(await budget.read(locatorOffset, 20));
    if (locator.getUint32(0, true) !== 0x07064b50) invalid("ZIP64 locator is missing.");
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) {
      unsupported("Split ZIP64 archives are unsupported.");
    }
    const recordOffset = uint64(locator, 8);
    const record = view(await budget.read(recordOffset, 56));
    if (record.getUint32(0, true) !== 0x06064b50 || uint64(record, 4) < 44) invalid("Invalid ZIP64 end record.");
    if (recordOffset + 12 + uint64(record, 4) !== locatorOffset) {
      invalid("ZIP64 end record extent disagrees with locator.");
    }
    if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) {
      unsupported("Split ZIP64 archives are unsupported.");
    }
    count = uint64(record, 32);
    if (uint64(record, 24) !== count) unsupported("Split ZIP64 entry counts are unsupported.");
    directorySize = uint64(record, 40);
    directoryOffset = uint64(record, 48);
    directoryEnd = recordOffset;
  }
  if (count > maxEntries || directorySize > maxDirectory) {
    throw new ArchiveError("budget-exceeded", "ZIP directory limit exceeded.");
  }
  if (directoryOffset > directoryEnd || directorySize > directoryEnd - directoryOffset) {
    invalid("ZIP directory overlaps end records.");
  }
  // A legacy-name callback may initiate another borrowed read. Its scratch view
  // must not replace directory evidence while this synchronous parser is running.
  const directory = new Uint8Array(await budget.read(directoryOffset, directorySize));
  const records = parseDirectory(directory, count, directoryOffset, options.decodeName);
  const entries = Object.freeze(records.map((record) => record.entry));
  const select = (id: number): EntryType => {
    integer(id, "Entry ID");
    const record = records[id];
    if (!record) throw new RangeError("ZIP entry ID does not exist.");
    return record;
  };
  /** Planning checks remaining local authority without reserving it. External
   * ledgers remain independent admission owners whose limits are not introspected. */
  const captured = (input: ZipReadOptionsType): ZipReadOptionsType => {
    const opts = {
      ...input,
      ...(input.aes ? { aes: { ...input.aes } } : {}),
      ...(input.bzip ? { bzip: { ...input.bzip } } : {}),
    };
    const requested = limitsOf(opts), used = lifetime.inspect();
    const signal = options.signal && opts.signal
      ? AbortSignal.any([options.signal, opts.signal])
      : options.signal ?? opts.signal;
    return {
      ...opts,
      maxSourceBytes: Math.min(requested.maxSourceBytes, limits.maxSourceBytes - used.sourceBytes),
      maxRequests: Math.min(requested.maxRequests, limits.maxRequests - used.requests),
      maxDecodedBytes: Math.min(requested.maxDecodedBytes, limits.maxDecodedBytes - used.decodedBytes),
      maxOutputBytes: Math.min(requested.maxOutputBytes, limits.maxOutputBytes - used.outputBytes),
      ...(signal ? { signal } : {}),
    };
  };
  return Object.freeze({
    entries,
    work: budget.inspect(),
    source: Object.freeze({
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      stability: source.stability ?? "unverified",
    }),
    plan(id: number, readOptions: ZipReadOptionsType = {}): ZipPlanType {
      return planRead(select(id), captured(readOptions));
    },
    read(id: number, readOptions: ZipReadOptionsType = {}): Promise<ZipReadType> {
      const opts = captured(readOptions), own = createArchiveLedger(opts), extra = opts.ledger;
      // The operation owner also spans separate local-header and compressed-data
      // budgets. Sharing an opening ledger again must not reserve the same event twice.
      const ledger = {
        reserve(kind: keyof ArchiveWorkType, count: number): void {
          own.reserve(kind, count);
          openingLedger.reserve(kind, count);
          if (extra && extra !== external) extra.reserve(kind, count);
        },
        inspect: own.inspect,
      };
      return readMember(source, select(id), directoryOffset, { ...opts, ledger });
    },
  });
}

/** Directory offsets are authoritative only after local-header agreement is checked during reads. */
function parseDirectory(
  bytes: Uint8Array,
  count: number,
  boundary: number,
  decodeName?: (bytes: Uint8Array) => string,
): EntryType[] {
  const data = view(bytes);
  const records: EntryType[] = [];
  const offsets = new Set<number>();
  let position = 0;
  for (let id = 0; id < count; id++) {
    if (position > bytes.byteLength - 46 || data.getUint32(position, true) !== 0x02014b50) {
      invalid("Invalid ZIP directory record.");
    }
    const flags = data.getUint16(position + 8, true);
    const method = data.getUint16(position + 10, true);
    let compressedSize = data.getUint32(position + 20, true);
    let size = data.getUint32(position + 24, true);
    const nameSize = data.getUint16(position + 28, true);
    const extraSize = data.getUint16(position + 30, true);
    const commentSize = data.getUint16(position + 32, true);
    let disk = data.getUint16(position + 34, true);
    let offset = data.getUint32(position + 42, true);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > bytes.byteLength) invalid("Truncated ZIP directory record.");
    const rawName = bytes.slice(position + 46, position + 46 + nameSize);
    const extra = view(bytes.subarray(position + 46 + nameSize, position + 46 + nameSize + extraSize));
    const values = zip64(
      extra,
      size === 0xffffffff,
      compressedSize === 0xffffffff,
      offset === 0xffffffff,
      disk === 0xffff,
    );
    size = values.size ?? size;
    compressedSize = values.compressedSize ?? compressedSize;
    offset = values.offset ?? offset;
    disk = values.disk ?? disk;
    if (disk !== 0) unsupported("Split ZIP members are unsupported.");
    if (offset >= boundary || compressedSize > boundary - offset) invalid("ZIP member extent overlaps directory.");
    if (offsets.has(offset)) invalid("Distinct ZIP entries alias the same local header.");
    offsets.add(offset);
    let name: string;
    if (flags & 0x800) {
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      } catch {
        invalid("ZIP UTF-8 name is invalid.");
      }
    } else if (decodeName) name = decodeName(rawName.slice());
    else {
      if (rawName.some((byte) => byte > 127)) unsupported("Non-ASCII ZIP names require an explicit legacy decoder.");
      name = new TextDecoder().decode(rawName);
    }
    if (typeof name !== "string") throw new TypeError("ZIP name decoder must return a string.");
    const host = data.getUint16(position + 4, true) >>> 8;
    const unixKind = host === 3 ? (data.getUint32(position + 38, true) >>> 16) & 0xf000 : 0;
    const kind = unixKind === 0xa000
      ? "symbolic-link"
      : unixKind === 0x4000 || name.endsWith("/")
      ? "directory"
      : unixKind === 0 || unixKind === 0x8000
      ? "file"
      : "other";
    const aes = readAesExtra(extra);
    const supportedAes = aes && (aes.method === 0 || aes.method === 8) && method === 99 && (flags & 1) &&
      !(flags & 0x2048) &&
      data.getUint16(position + 6, true) >= (aes.method === 0 ? 10 : 20);
    if (aes?.version === 2 && data.getUint32(position + 16, true) !== 0) {
      invalid("WinZip AE-2 requires a zero CRC field.");
    }
    const entry = Object.freeze({
      id,
      name,
      size,
      compressedSize,
      method,
      encrypted: Boolean(flags & 0x2041),
      ...(aes ? { aes: Object.freeze(aes) } : {}),
      ...(!(flags & 0x2041) ? {} : {
        encryption: supportedAes
          ? "winzip-aes" as const
          : (flags & 1) && !(flags & 0x2040) && !hasExtra(extra, 0x9901) && data.getUint16(position + 6, true) >= 20 &&
              (method === 0 || method === 8)
          ? "zipcrypto" as const
          : "unsupported" as const,
      }),
      directory: kind === "directory",
      kind,
      crc32: data.getUint32(position + 16, true),
    });
    records.push({
      entry,
      name: rawName,
      flags,
      offset,
      time: data.getUint16(position + 12, true),
      needed: data.getUint16(position + 6, true),
    });
    position = next;
  }
  if (position !== bytes.byteLength) unsupported("Extra ZIP directory records are unsupported.");
  return records;
}

/** Validate the full bounded extra area: an early match must not hide trailing corruption or duplicate profiles. */
function findExtra(data: DataView, wanted: number): DataView | undefined {
  let at = 0;
  let found: DataView | undefined;
  while (at < data.byteLength) {
    if (data.byteLength - at < 4) invalid("Truncated ZIP extra field.");
    const id = data.getUint16(at, true);
    const size = data.getUint16(at + 2, true);
    if (size > data.byteLength - at - 4) invalid("ZIP extra field exceeds record.");
    if (id === wanted) {
      if (found) invalid("Duplicate ZIP encryption extra fields are ambiguous.");
      found = new DataView(data.buffer, data.byteOffset + at + 4, size);
    }
    at += 4 + size;
  }
  return found;
}

/** Exact current AES metadata only. Unknown vendor/version/extensions remain explicitly unsupported. */
function readAesExtra(data: DataView): ZipAesMetadataType | undefined {
  const field = findExtra(data, 0x9901);
  if (!field) return undefined;
  if (field.byteLength !== 7) return undefined;
  const version = field.getUint16(0, true);
  const strength = field.getUint8(4);
  if ((version !== 1 && version !== 2) || field.getUint16(2, true) !== 0x4541 || strength < 1 || strength > 3) {
    return undefined;
  }
  return { version, strength: strength === 1 ? 128 : strength === 2 ? 192 : 256, method: field.getUint16(5, true) };
}

function hasExtra(data: DataView, wanted: number): boolean {
  return findExtra(data, wanted) !== undefined;
}

/** ZIP64 extra values appear only for sentinel fields and in their specified order. */
function zip64(
  data: DataView,
  size: boolean,
  compressed: boolean,
  offset: boolean,
  disk: boolean,
): { size?: number; compressedSize?: number; offset?: number; disk?: number } {
  let position = 0;
  let result: { size?: number; compressedSize?: number; offset?: number; disk?: number } | undefined;
  while (position < data.byteLength) {
    if (position > data.byteLength - 4) invalid("Truncated ZIP extra field.");
    const id = data.getUint16(position, true);
    const length = data.getUint16(position + 2, true);
    const end = position + 4 + length;
    if (end > data.byteLength) invalid("ZIP extra field exceeds record.");
    if (id === 1) {
      if (result) invalid("Duplicate ZIP64 extra fields are ambiguous.");
      result = {};
      let cursor = position + 4;
      for (const [needed, key] of [[size, "size"], [compressed, "compressedSize"], [offset, "offset"]] as const) {
        if (needed) {
          if (cursor > end - 8) invalid("ZIP64 field is missing a required value.");
          result[key] = uint64(data, cursor);
          cursor += 8;
        }
      }
      if (disk) {
        if (cursor > end - 4) invalid("ZIP64 disk value is missing.");
        result.disk = data.getUint32(cursor, true);
      }
    }
    position = end;
  }
  if (!result && (size || compressed || offset || disk)) invalid("ZIP64 extra field is missing.");
  return result ?? {};
}

/** Planning never acquires a source, decoder or runtime capability. */
function planRead(record: EntryType, options: ZipReadOptionsType): ZipPlanType {
  const entry = record.entry;
  limitsOf(options);
  const offset = options.offset ?? 0;
  const length = options.length ?? entry.size - offset;
  integer(offset, "Decoded offset");
  integer(length, "Decoded length");
  if (offset > entry.size || length > entry.size - offset) throw new RangeError("Requested range exceeds ZIP member.");
  const complete = Boolean(options.verify) || (offset === 0 && length === entry.size);
  if (entry.encryption === "winzip-aes" && entry.aes && options.password !== undefined && options.aes) {
    const maximum = options.aes.maxCiphertextBytes ?? 8 * 1024 * 1024;
    const maxBlocks = options.aes.maxBlocks ?? 8192;
    integer(maximum, "AES ciphertext limit");
    integer(maxBlocks, "AES block limit");
    if (maximum > 8 * 1024 * 1024 || maxBlocks > 8192) {
      throw new RangeError("WinZip AES implementation ceilings are 8 MiB ciphertext and 8192 native AES blocks.");
    }
    const ciphertext = entry.compressedSize - entry.aes.strength / 16 - 12;
    if (ciphertext < 0 || (entry.aes.method === 0 && ciphertext !== entry.size)) {
      invalid("WinZip AES ciphertext framing disagrees with member sizes.");
    }
    const deflate = entry.aes.method === 8;
    const crc = entry.aes.version === 1 && complete;
    const begin = crc ? 0 : Math.floor(offset / 16) * 16;
    const end = crc ? entry.size : length ? Math.min(entry.size, Math.ceil((offset + length) / 16) * 16) : begin;
    const decrypt = deflate ? (complete || length ? ciphertext : 0) : end - begin;
    const blocks = Math.ceil(decrypt / 16);
    const decoded = ciphertext * 2 + decrypt + (deflate ? complete ? entry.size : length ? offset + length : 0 : 0);
    const reason =
      ciphertext > maximum || blocks > maxBlocks || length > (options.maxOutputBytes ?? 16 * 1024 * 1024) ||
        decoded > (options.maxDecodedBytes ?? 64 * 1024 * 1024) ||
        entry.compressedSize > (options.maxSourceBytes ?? 64 * 1024 * 1024)
        ? "budget-exceeded" as const
        : undefined;
    return {
      supported: !reason,
      ...(reason ? { reason } : {}),
      access: deflate ? "decode-from-start" : "authenticated-range",
      outputBytes: length,
      decodedBytes: decoded,
      sourceBytes: entry.compressedSize,
      headerBytes: "unknown",
      verification: crc ? "full-member-crc" : deflate && complete ? "full-member-decode" : "none",
      authentication: "full-member-hmac",
      cryptoBlocks: blocks,
    };
  }
  const legacy = entry.encrypted && entry.encryption === "zipcrypto" && options.password !== undefined;
  const plaintext = complete ? entry.size : entry.method === 0 && !legacy ? length : offset + length;
  const decoded = legacy ? plaintext + (entry.method === 0 ? 12 : entry.compressedSize) : plaintext;
  const source = legacy && entry.method === 0
    ? plaintext + 12
    : entry.method === 0
    ? (complete ? entry.size : length)
    : entry.compressedSize;
  const reason = entry.encrypted && !legacy
    ? "encrypted-member"
    : entry.method !== 0 && entry.method !== 8 && !(entry.method === 12 && record.needed >= 46)
    ? "compression-method"
    : length > (options.maxOutputBytes ?? 16 * 1024 * 1024) ||
        decoded > (options.maxDecodedBytes ?? 64 * 1024 * 1024) || source > (options.maxSourceBytes ?? 64 * 1024 * 1024)
    ? "budget-exceeded"
    : undefined;
  return {
    supported: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    access: entry.method === 0 && !legacy ? "direct-range" : "decode-from-start",
    outputBytes: length,
    decodedBytes: decoded,
    sourceBytes: source,
    headerBytes: "unknown",
    verification: complete ? "full-member-crc" : "none",
  };
}

/** A member read owns its decoder/reader; the underlying random-access source stays borrowed. */
async function readMember(
  source: ByteSourceType,
  record: EntryType,
  boundary: number,
  options: ZipReadOptionsType,
): Promise<ZipReadType> {
  options = {
    ...options,
    ...(options.aes ? { aes: { ...options.aes } } : {}),
    ...(options.bzip ? { bzip: { ...options.bzip } } : {}),
  };
  const plan = planRead(record, options);
  const aggregate = record.entry.encrypted ? createArchiveLedger(options) : undefined;
  const callerLedger = options.ledger;
  const accounting = aggregate
    ? {
      reserve(kind: keyof ArchiveWorkType, count: number): void {
        aggregate.reserve(kind, count);
        callerLedger?.reserve(kind, count);
      },
      inspect: () => aggregate.inspect(),
    }
    : undefined;
  const effective = accounting ? { ...options, ledger: accounting } : options;
  const budget = new ArchiveBudget(source, effective, options.signal);
  if (!plan.supported) {
    if (plan.reason === "budget-exceeded") {
      throw new ArchiveError("budget-exceeded", "ZIP member exceeds the admitted work/output limits.");
    }
    unsupported(
      plan.reason === "encrypted-member"
        ? "Encrypted ZIP member requires an exact supported encryption profile."
        : "ZIP compression method is unsupported.",
    );
  }
  const entry = record.entry;
  if (entry.encryption === "winzip-aes") return readAesMember(record, boundary, options, plan, budget);
  const cipher = entry.encryption === "zipcrypto" && options.password !== undefined
    ? createZipCrypto(options.password, options.maxPasswordBytes)
    : undefined;
  const encryption = cipher ? { encryption: { kind: "zipcrypto" as const, authentication: "none" as const } } : {};
  try {
    // Exact source ranges may share scratch storage; keep this fixed header
    // independent of the later name/extra/payload reads that reuse that storage.
    const header = view(new Uint8Array(await budget.read(record.offset, 30)));
    if (
      header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== record.flags ||
      header.getUint16(8, true) !== entry.method
    ) invalid("ZIP local header disagrees with directory.");
    if (entry.method === 12 && header.getUint16(4, true) < 46) {
      unsupported("ZIP BZip2 requires local version-needed 4.6 or later.");
    }
    if (cipher && header.getUint16(10, true) !== record.time) {
      invalid("ZIP encrypted local time disagrees with directory.");
    }
    const nameSize = header.getUint16(26, true);
    const extraSize = header.getUint16(28, true);
    const name = await budget.read(record.offset + 30, nameSize);
    if (name.length !== record.name.length || name.some((byte, index) => byte !== record.name[index])) {
      invalid("ZIP local name disagrees with directory.");
    }
    const dataOffset = record.offset + 30 + nameSize + extraSize;
    if (dataOffset > boundary || entry.compressedSize > boundary - dataOffset) {
      invalid("ZIP member data overlaps directory.");
    }
    const localExtra = cipher ? view(await budget.read(record.offset + 30 + nameSize, extraSize)) : undefined;
    if (localExtra && hasExtra(localExtra, 0x9901)) unsupported("ZIP AES extra fields cannot be read as ZipCrypto.");
    if (!(record.flags & 8)) {
      const sizes = zip64(
        localExtra ?? view(await budget.read(record.offset + 30 + nameSize, extraSize)),
        header.getUint32(22, true) === 0xffffffff,
        header.getUint32(18, true) === 0xffffffff,
        false,
        false,
      );
      if (
        header.getUint32(14, true) !== entry.crc32 || (sizes.size ?? header.getUint32(22, true)) !== entry.size ||
        (sizes.compressedSize ?? header.getUint32(18, true)) !== entry.compressedSize
      ) invalid("ZIP local sizes or checksum disagree with directory.");
    }
    const cipherHeader = cipher ? 12 : 0;
    if (entry.compressedSize < cipherHeader) invalid("ZIP encryption header is truncated.");
    const payloadSize = entry.compressedSize - cipherHeader;
    const payloadOffset = dataOffset + cipherHeader;
    if (entry.method === 0 && entry.size !== payloadSize) invalid("Stored ZIP member sizes disagree.");
    if (cipher) {
      budget.decoded(12);
      const decodedHeader = cipher.decrypt(await budget.read(dataOffset, 12));
      const expected = record.flags & 8 ? record.time >>> 8 : entry.crc32 >>> 24;
      if (decodedHeader[11] !== expected) {
        throw new ArchiveError("checksum-mismatch", "ZIP password verifier failed; wrong password or corrupt data.");
      }
    }
    const offset = options.offset ?? 0;
    const length = plan.outputBytes;
    const complete = plan.verification === "full-member-crc";
    if (entry.method === 0 && !complete && !cipher) {
      budget.decoded(length);
      budget.output(length);
      const bytes = new Uint8Array(await budget.read(dataOffset + offset, length));
      return { bytes, integrity: "checksum-pending", work: budget.inspect() };
    }
    const chunks: Uint8Array[] = [];
    let decoded = 0;
    let state = 0xffffffff;
    const consume = (value: Uint8Array, admitted = false): void => {
      if (!isBytes(value)) invalid("ZIP decoder returned a non-byte chunk.");
      const bytes = toView(value);
      if (!admitted) budget.decoded(bytes.byteLength);
      if (bytes.byteLength > entry.size - decoded) invalid("ZIP decoded bytes exceed declared member size.");
      if (complete) state = crc32(bytes, state);
      const start = Math.max(0, offset - decoded);
      const end = Math.min(bytes.byteLength, offset + length - decoded);
      if (end > start) {
        budget.output(end - start);
        const selected = bytes.slice(start, end);
        chunks.push(selected);
      }
      decoded += bytes.byteLength;
    };
    if (entry.method === 12) {
      const terminal = await readZipBzip(
        source,
        payloadOffset,
        payloadSize,
        effective,
        budget,
        complete,
        offset + length,
        consume,
      );
      if ((complete && (terminal.status !== "complete" || decoded !== entry.size)) || decoded < offset + length) {
        invalid("ZIP BZip2 member ended before its declared size.");
      }
      if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
      }
      options.signal?.throwIfAborted();
      const work = budget.inspect();
      return {
        bytes: join(chunks, length),
        integrity: complete ? "checksum-verified" : "checksum-pending",
        codec: {
          kind: "bzip2",
          integrity: terminal.integrity,
          verifiedBlocks: terminal.verifiedBlocks,
          steps: terminal.steps,
          memoryBytes: terminal.memoryBytes,
        },
        work: {
          ...work,
          sourceBytes: work.sourceBytes + terminal.work.sourceBytes,
          requests: work.requests + terminal.work.requests,
        },
      };
    } else if (entry.method === 0) {
      const extent = complete ? entry.size : cipher ? offset + length : entry.size;
      for (let position = 0; position < extent; position += 65536) {
        const chunk = await budget.read(payloadOffset + position, Math.min(65536, extent - position));
        if (cipher) budget.decoded(chunk.length);
        consume(cipher ? cipher.decrypt(chunk) : chunk, Boolean(cipher));
      }
    } else {
      let position = 0;
      const abort = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
      const compressedBudget = new ArchiveBudget(source, {
        ...effective,
        maxSourceBytes: budget.limits.maxSourceBytes - budget.inspect().sourceBytes,
        maxRequests: budget.limits.maxRequests - budget.inspect().requests,
      }, signal);
      const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          if (position === payloadSize) {
            controller.close();
            return;
          }
          const size = Math.min(65536, payloadSize - position);
          let bytes = await compressedBudget.read(payloadOffset + position, size);
          if (cipher) {
            compressedBudget.decoded(size);
            bytes = cipher.decrypt(bytes);
          }
          position += size;
          // Native codec BufferSource excludes shared backing; preserve canonical
          // fixed buffers and snapshot foreign/shared ranges through the byte owner.
          controller.enqueue(toRequestBytes(bytes));
        },
      }, { highWaterMark: 0 });
      let transform: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>;
      if (options.inflate) transform = options.inflate();
      else {
        try {
          transform = new DecompressionStream("deflate-raw");
        } catch {
          unsupported("Raw-DEFLATE is unavailable; inject an explicit codec factory.");
        }
      }
      const reader = input.pipeThrough(transform).getReader();
      let eof = false;
      let cancellation: Promise<void> | undefined;
      const cancel = (reason?: unknown): Promise<void> => cancellation ??= reader.cancel(reason);
      const onAbort = (): void => {
        abort.abort(options.signal?.reason);
        // Observe this promise immediately; cleanup below remains its sole reporter.
        void cancel(options.signal?.reason).catch(() => {});
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      let failures: unknown[] = [];
      try {
        while (complete || decoded < offset + length) {
          signal.throwIfAborted();
          const result = await reader.read();
          signal.throwIfAborted();
          if (result.done) {
            eof = true;
            break;
          }
          consume(result.value);
        }
        if ((complete && decoded !== entry.size) || decoded < offset + length) {
          invalid("ZIP member ended before its declared size.");
        }
      } catch (reason) {
        failures = [reason];
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        abort.abort();
        await close([() => cancellation ?? (eof ? undefined : cancel()), () => reader.releaseLock()], failures);
      }
      const compressedWork = compressedBudget.inspect();
      const initial = budget.inspect();
      const result = join(chunks, length);
      if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
      }
      return {
        bytes: result,
        ...encryption,
        integrity: complete ? "checksum-verified" : "checksum-pending",
        work: {
          ...initial,
          sourceBytes: initial.sourceBytes + compressedWork.sourceBytes,
          requests: initial.requests + compressedWork.requests,
          decodedBytes: initial.decodedBytes + compressedWork.decodedBytes,
        },
      };
    }
    if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "ZIP member CRC32 failed.");
    }
    return {
      bytes: join(chunks, length),
      ...encryption,
      integrity: complete ? "checksum-verified" : "checksum-pending",
      work: budget.inspect(),
    };
  } finally {
    cipher?.clear();
  }
}

/** AES owns a bounded ciphertext snapshot and key state. Authentication finishes before any plaintext native call. */
async function readAesMember(
  record: EntryType,
  boundary: number,
  options: ZipReadOptionsType,
  plan: ZipPlanType,
  budget: ArchiveBudget,
): Promise<ZipReadType> {
  const metadata = record.entry.aes!;
  const capability = options.aes!;
  const native = { subtle: capability.subtle };
  const passwordLimit = options.maxPasswordBytes ?? 1024;
  integer(passwordLimit, "maxPasswordBytes");
  if (!isBytes(options.password)) throw new TypeError("ZIP password must be explicit byte data.");
  const caller = toView(options.password);
  if (caller.length > passwordLimit) {
    throw new ArchiveError("budget-exceeded", "ZIP password exceeds maxPasswordBytes.");
  }
  // Snapshot before the first source await, so caller mutation cannot change the admitted password.
  const password = new Uint8Array(caller);
  const entry = record.entry;
  const offset = options.offset ?? 0;
  const length = plan.outputBytes;
  const complete = plan.verification === "full-member-crc";
  const signal = options.signal;
  let cipher: ZipAesStateType | undefined;
  let owned: Uint8Array<ArrayBuffer> | undefined;
  try {
    // The local fixed fields remain evidence after subsequent borrowed reads.
    const header = view(new Uint8Array(await budget.read(record.offset, 30)));
    if (
      header.getUint32(0, true) !== 0x04034b50 || header.getUint16(4, true) < (metadata.method === 0 ? 10 : 20) ||
      header.getUint16(6, true) !== record.flags || header.getUint16(8, true) !== 99
    ) {
      invalid("WinZip AES local header disagrees with directory.");
    }
    const nameSize = header.getUint16(26, true);
    const extraSize = header.getUint16(28, true);
    const dataOffset = record.offset + 30 + nameSize + extraSize;
    if (dataOffset > boundary || entry.compressedSize > boundary - dataOffset) {
      invalid("WinZip AES member data overlaps directory.");
    }
    const name = await budget.read(record.offset + 30, nameSize);
    if (name.length !== record.name.length || name.some((byte, index) => byte !== record.name[index])) {
      invalid("WinZip AES local name disagrees with directory.");
    }
    const extra = view(await budget.read(record.offset + 30 + nameSize, extraSize));
    const local = readAesExtra(extra);
    if (
      !local || local.version !== metadata.version || local.strength !== metadata.strength ||
      local.method !== metadata.method
    ) {
      invalid("WinZip AES local profile disagrees with directory.");
    }
    if (!(record.flags & 8)) {
      const sizes = zip64(
        extra,
        header.getUint32(22, true) === 0xffffffff,
        header.getUint32(18, true) === 0xffffffff,
        false,
        false,
      );
      if (
        header.getUint32(14, true) !== entry.crc32 || (sizes.size ?? header.getUint32(22, true)) !== entry.size ||
        (sizes.compressedSize ?? header.getUint32(18, true)) !== entry.compressedSize
      ) {
        invalid("WinZip AES local sizes or CRC disagree with directory.");
      }
    }
    const saltSize = metadata.strength / 16;
    if (
      entry.compressedSize < saltSize + 12 ||
      (metadata.method === 0 && entry.compressedSize - saltSize - 12 !== entry.size)
    ) {
      invalid("WinZip AES STORED ciphertext size disagrees with plaintext size.");
    }
    // Native sign/verify each copies and processes the complete ciphertext. Reserve both passes before acquisition/copy.
    budget.decoded((entry.compressedSize - saltSize - 12) * 2);
    owned = new Uint8Array(await budget.read(dataOffset, entry.compressedSize));
    const ciphertext = owned.subarray(saltSize + 2, owned.length - 10);
    cipher = await openZipAes(
      password,
      owned.subarray(0, saltSize),
      owned.subarray(saltSize, saltSize + 2),
      ciphertext,
      owned.subarray(owned.length - 10),
      native,
      signal,
    );
    if (metadata.method === 8) return await readAesDeflate(entry, options, plan, budget, cipher, ciphertext);
    const begin = complete ? 0 : Math.floor(offset / 16) * 16;
    const end = complete ? entry.size : length ? Math.min(entry.size, Math.ceil((offset + length) / 16) * 16) : begin;
    budget.output(length);
    const selected = new Uint8Array(length);
    let state = 0xffffffff;
    for (let position = begin; position < end; position += 16) {
      const blockEnd = Math.min(entry.size, position + 16);
      budget.decoded(blockEnd - position);
      const plain = await cipher.decryptBlock(position, ciphertext.subarray(position, blockEnd));
      try {
        if (complete) state = crc32(plain, state);
        const start = Math.max(offset, position);
        const finish = Math.min(offset + length, blockEnd);
        if (finish > start) selected.set(plain.subarray(start - position, finish - position), start - offset);
      } finally {
        plain.fill(0);
      }
    }
    if (complete && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "WinZip AE-1 plaintext CRC32 failed.");
    }
    return {
      bytes: selected,
      integrity: metadata.version === 2 ? "not-provided" : complete ? "checksum-verified" : "checksum-pending",
      encryption: { kind: "winzip-aes", authentication: "ciphertext-verified" },
      work: budget.inspect(),
    };
  } finally {
    cipher?.clear();
    password.fill(0);
    owned?.fill(0);
  }
}

/**
 * Authenticate first (in the caller), then decrypt all bounded compressed bytes, then inflate.
 * Native AES calls settle serially before any decoder exists. The compressed plaintext buffer
 * stays owned until the explicit pipeTo promise and decoder reader have both retired.
 */
async function readAesDeflate(
  entry: ZipEntryType,
  options: ZipReadOptionsType,
  plan: ZipPlanType,
  budget: ArchiveBudget,
  cipher: ZipAesStateType,
  ciphertext: Uint8Array<ArrayBuffer>,
): Promise<ZipReadType> {
  const offset = options.offset ?? 0;
  const length = plan.outputBytes;
  const full = plan.verification !== "none";
  const crc = plan.verification === "full-member-crc";
  const authentication = { kind: "winzip-aes" as const, authentication: "ciphertext-verified" as const };
  if (!length && !full) {
    return {
      bytes: new Uint8Array(),
      encryption: authentication,
      integrity: entry.aes!.version === 2 ? "not-provided" : "checksum-pending",
      work: budget.inspect(),
    };
  }
  budget.decoded(ciphertext.length);
  const compressed = new Uint8Array(ciphertext.length);
  try {
    for (let position = 0; position < ciphertext.length; position += 16) {
      const plain = await cipher.decryptBlock(
        position,
        ciphertext.subarray(position, Math.min(position + 16, ciphertext.length)),
      );
      try {
        compressed.set(plain, position);
      } finally {
        plain.fill(0);
      }
    }
    options.signal?.throwIfAborted();
    budget.output(length);
    const selected = new Uint8Array(length);
    let transform: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>;
    if (options.inflate) transform = options.inflate();
    else {
      try {
        transform = new DecompressionStream("deflate-raw");
      } catch {
        unsupported("Raw-DEFLATE is unavailable; inject an explicit codec factory.");
      }
    }
    let position = 0;
    const abort = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        signal.throwIfAborted();
        if (position === compressed.length) {
          controller.close();
          return;
        }
        const end = Math.min(position + 1024, compressed.length);
        controller.enqueue(compressed.slice(position, end));
        position = end;
      },
    }, { highWaterMark: 0 });
    if (transform.readable.locked || transform.writable.locked) {
      throw new TypeError("ZIP AES codec factory must return independently owned unlocked streams.");
    }
    const reader = transform.readable.getReader();
    const writing = input.pipeTo(transform.writable, { signal });
    // The hidden pipeThrough promise would not provide a settlement barrier before compressed-buffer retirement.
    void writing.catch(() => {});
    let cancellation: Promise<void> | undefined;
    const cancel = (reason?: unknown): Promise<void> => cancellation ??= reader.cancel(reason);
    const onAbort = (): void => {
      abort.abort(options.signal?.reason);
      void cancel(options.signal?.reason).catch(() => {});
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let eof = false;
    let readFailed = false;
    let decoded = 0;
    let state = 0xffffffff;
    const failures: unknown[] = [];
    try {
      while (full || decoded < offset + length) {
        signal.throwIfAborted();
        let next: Awaited<ReturnType<typeof reader.read>>;
        try {
          next = await reader.read();
        } catch (reason) {
          readFailed = true;
          throw reason;
        }
        signal.throwIfAborted();
        if (next.done) {
          eof = true;
          break;
        }
        if (!isBytes(next.value)) invalid("ZIP AES decoder returned a non-byte chunk.");
        const bytes = toView(next.value);
        budget.decoded(bytes.length);
        if (bytes.length > entry.size - decoded) invalid("ZIP AES decoded bytes exceed declared member size.");
        if (crc) state = crc32(bytes, state);
        const start = Math.max(offset, decoded);
        const end = Math.min(offset + length, decoded + bytes.length);
        if (end > start) selected.set(bytes.subarray(start - decoded, end - decoded), start - offset);
        decoded += bytes.length;
      }
      if ((full && decoded !== entry.size) || decoded < offset + length) {
        invalid("ZIP AES decoded member ended before declared size.");
      }
    } catch (reason) {
      failures.push(reason);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      const stop = failures.length ? failures[0] : new Error("ZIP AES prefix decoding is complete.");
      if (!eof) abort.abort(stop);
      await close([
        () => cancellation ?? (!eof && !readFailed ? cancel(stop) : undefined),
        async () => {
          try {
            await writing;
          } catch (reason) {
            // pipeTo and reader.read can report the same pipeline failure. This is one event observed twice.
            if (reason !== stop && !(failures.length && reason === failures[0])) throw reason;
          }
        },
        () => reader.releaseLock(),
      ], failures);
    }
    if (crc && ((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw new ArchiveError("checksum-mismatch", "WinZip AE-1 plaintext CRC32 failed.");
    }
    return {
      bytes: selected,
      encryption: authentication,
      integrity: entry.aes!.version === 2 ? "not-provided" : crc ? "checksum-verified" : "checksum-pending",
      work: budget.inspect(),
    };
  } finally {
    compressed.fill(0);
  }
}

function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== length) invalid("ZIP selected output length disagrees with request.");
  return bytes;
}
