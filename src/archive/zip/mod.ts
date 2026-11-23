/**
 * Open a ZIP or ZIP64 archive and read selected members without extracting the rest.
 *
 * `openZip` reads the central directory once. Each `read` plans the member's work, checks its local header and
 * decodes only that member. The folder splits the reader by concern:
 *
 * | Module          | Owns                                                        |
 * | --------------- | ----------------------------------------------------------- |
 * | `mod.ts`        | `openZip` and the public entry point                        |
 * | `plan.ts`       | the deterministic work plan for one member read             |
 * | `directory.ts`  | central directory, ZIP64 and extra-field parsing            |
 * | `member.ts`     | STORED, DEFLATE, BZip2, LZMA and ZipCrypto member reads     |
 * | `aes.ts`        | WinZip AES member reads; `cipher.ts` holds the primitives   |
 * | `zipcrypto.ts`  | the legacy PKWARE (ZipCrypto) stream cipher                  |
 * | `bzip.ts`, `lzma.ts` | method 12 and 14 relays to the shared codecs           |
 * | `types.ts`      | the public data shapes                                      |
 *
 * @module
 */
import type { ByteSourceType } from "../../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  createArchiveLedger,
  integer,
  invalid,
  limitsOf,
  uint64,
  unsupported,
  view,
} from "../record.ts";
import type { ArchiveWorkType } from "../record.ts";
import { parseDirectory } from "./directory.ts";
import { readMember } from "./member.ts";
import { planRead } from "./plan.ts";
import type {
  DirectoryRecordType,
  ZipArchiveType,
  ZipOpenOptionsType,
  ZipPlanType,
  ZipReadOptionsType,
  ZipReadType,
} from "./types.ts";
export type {
  ZipAesMetadataType,
  ZipArchiveType,
  ZipEntryType,
  ZipInflateType,
  ZipOpenOptionsType,
  ZipPlanType,
  ZipReadOptionsType,
  ZipReadType,
} from "./types.ts";
export type { ZipAesOptionsType } from "./cipher.ts";
export type { ZipBzipOptionsType } from "./bzip.ts";
export type { ZipLzmaOptionsType } from "./lzma.ts";
export { ArchiveError, createArchiveLedger } from "../record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../record.ts";

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
  const select = (id: number): DirectoryRecordType => {
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
      ...(input.lzma ? { lzma: { ...input.lzma } } : {}),
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
