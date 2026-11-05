/** Bounded Microsoft Cabinet inspection and NONE/MSZIP folder previews. @module */
import type { ByteSourceType } from "../source.ts";
import { readMszip } from "./mszip.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One literal CFFILE record. A CAB folder is a compression unit, not a pathname directory. */
export interface CabEntryType {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly folderId: number;
  /** Logical uncompressed offset inside the folder. */
  readonly folderOffset: number;
  /** Raw DOS date/time and attributes; no locale or execution policy is inferred. */
  readonly date: number;
  readonly time: number;
  readonly attributes: number;
}

/** One physical CFDATA unit. Checksums are optional parity checks, not authentication. */
export interface CabBlockType {
  readonly id: number;
  readonly folderId: number;
  readonly folderOffset: number;
  /** Absolute source payload offset, excluding the CFDATA header and reserved bytes. */
  readonly offset: number;
  readonly storedSize: number;
  readonly size: number;
  /** Zero explicitly means absent, even if a computed checksum would also be zero. */
  readonly checksum: number;
}

export interface CabFolderType {
  readonly id: number;
  readonly compression: "none" | "mszip" | "quantum" | "lzx";
  /** Original typeCompress, including algorithm parameters. */
  readonly compressionCode: number;
  readonly size: number;
  /** Exact NONE or MSZIP compression with no CFDATA reserved area is readable. */
  readonly readable: boolean;
  /** Per-block opaque reserve length; checksum coverage is not assumed for nonzero lengths. */
  readonly blockReserveBytes: number;
  readonly blocks: readonly CabBlockType[];
}

export interface CabOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default 256; the on-disk count remains a 16-bit field. */
  readonly maxFolders?: number;
  /** Default 100,000. */
  readonly maxEntries?: number;
  /** Total CFDATA units across folders. Default 100,000. */
  readonly maxBlocks?: number;
  /** Maximum encoded filename including NUL. Default and profile maximum 256 bytes. */
  readonly maxNameBytes?: number;
  /** Retained/parsed structural bytes, including reserved areas. Default 1 MiB. */
  readonly maxMetadataBytes?: number;
  readonly allowUnverifiedSource?: boolean;
}

export interface CabReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true: verify complete required blocks, including MSZIP history prerequisites. */
  readonly verify?: boolean;
  /** Cumulative MSZIP DEFLATE blocks across this replay. Default 8192; implementation maximum 65536. */
  readonly maxDeflateBlocks?: number;
}

/** Each status names a physical required block, including MSZIP history outside the selected file/range. */
export interface CabBlockReadType {
  readonly blockId: number;
  readonly role: "covering" | "history";
  readonly status: "checksum-verified" | "checksum-absent" | "pending";
}

export interface CabReadType {
  readonly bytes: Uint8Array;
  /** Raw DEFLATE blocks processed across the required MSZIP units; zero for NONE and empty reads. */
  readonly deflateBlocks: number;
  /** Verified only when every required block has a present, matching checksum; empty ranges have none. */
  readonly integrity: "block-checksum-verified" | "pending" | "none";
  readonly blocks: readonly CabBlockReadType[];
  readonly work: ArchiveWorkType;
}

/** Immutable bounded metadata; the source stays borrowed and no host files are created. */
export interface CabArchiveType {
  readonly entries: readonly CabEntryType[];
  readonly folders: readonly CabFolderType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: CabReadOptionsType): Promise<CabReadType>;
}

/** Mathematical CAB parity: little-endian full words, big-endian remainder, XOR the supplied seed. */
function parity(bytes: Uint8Array, seed = 0): number {
  let sum = seed;
  let at = 0;
  for (; at + 4 <= bytes.length; at += 4) {
    sum ^= bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16 | bytes[at + 3]! << 24;
  }
  let remainder = 0;
  for (; at < bytes.length; at++) remainder = remainder * 256 + bytes[at]!;
  return (sum ^ remainder) >>> 0;
}

/** A bounded standalone v1.3 cabinet: listing accepts known codecs; NONE and MSZIP folders are readable. */
export async function openCab(source: ByteSourceType, options: CabOpenOptionsType = {}): Promise<CabArchiveType> {
  options = { ...options };
  const archiveSignal = options.signal;
  const { size, identity, stability } = source;
  integer(size, "CAB source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown CAB source stability evidence.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("CAB source identity must be a string of at most 8192 UTF16 code units.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("CAB index reads require declared source stability or explicit unverified-source acceptance.");
  }
  const maxFolders = options.maxFolders ?? 256;
  const maxEntries = options.maxEntries ?? 100000;
  const maxBlocks = options.maxBlocks ?? 100000;
  const maxNameBytes = options.maxNameBytes ?? 256;
  const maxMetadataBytes = options.maxMetadataBytes ?? 1024 * 1024;
  for (const [name, value] of Object.entries({ maxFolders, maxEntries, maxBlocks, maxNameBytes, maxMetadataBytes })) {
    integer(value, name);
  }
  if (maxNameBytes > 256) throw new RangeError("CAB profile filename limit is 256 encoded bytes including NUL.");
  const snapshot: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: source.read.bind(source),
  };
  const localLedger = createArchiveLedger(options);
  const openingLedger = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      localLedger.reserve(kind, count);
      openingLedger?.reserve(kind, count);
    },
    inspect: () => localLedger.inspect(),
  };
  const budget = new ArchiveBudget(snapshot, { ...options, ledger: lifetime }, archiveSignal);
  let metadata = 0;
  // Reserve metadata before source allocation; bytes read ahead within the file table count too.
  const readMetadata = async (offset: number, length: number): Promise<Uint8Array> => {
    if (length > maxMetadataBytes - metadata) throw new ArchiveError("budget-exceeded", "CAB metadata limit exceeded.");
    metadata += length;
    budget.decoded(length);
    return await budget.read(offset, length);
  };
  const header = await readMetadata(0, 36);
  const h = view(header);
  if (h.getUint32(0, true) !== 0x4643534d) invalid("CAB signature must be MSCF at source offset zero.");
  if (h.getUint32(4, true) || h.getUint32(12, true) || h.getUint32(20, true)) {
    invalid("CAB reserved header words must be zero.");
  }
  if (header[24] !== 3 || header[25] !== 1) unsupported("Only CAB format version 1.3 is supported.");
  if (h.getUint32(8, true) !== snapshot.size) invalid("CAB declared size must equal the complete source extent.");
  const filesAt = h.getUint32(16, true);
  const folderCount = h.getUint16(26, true);
  const fileCount = h.getUint16(28, true);
  const flags = h.getUint16(30, true);
  if ((flags & ~7) !== 0) unsupported("CAB header has unsupported flags.");
  if ((flags & 3) !== 0 || h.getUint16(34, true) !== 0) unsupported("Multi-cabinet CAB sets are not supported.");
  if (folderCount > maxFolders || fileCount > maxEntries) {
    throw new ArchiveError("budget-exceeded", "CAB directory count limit exceeded.");
  }
  if (folderCount === 0) unsupported("This CAB profile requires at least one folder.");
  let at = 36;
  let folderReserve = 0;
  let blockReserve = 0;
  if (flags & 4) {
    const reserved = view(await readMetadata(at, 4));
    const headerReserve = reserved.getUint16(0, true);
    folderReserve = reserved.getUint8(2);
    blockReserve = reserved.getUint8(3);
    at += 4;
    await readMetadata(at, headerReserve);
    at += headerReserve;
  }
  const descriptors: { offset: number; count: number; code: number }[] = [];
  for (let id = 0; id < folderCount; id++) {
    const folder = view(await readMetadata(at, 8 + folderReserve));
    const offset = folder.getUint32(0, true);
    const count = folder.getUint16(4, true);
    const code = folder.getUint16(6, true);
    if ((code & 15) > 3 || ((code & 15) === 0 && code !== 0)) {
      unsupported("CAB folder compression profile is not supported.");
    }
    descriptors.push({ offset, count, code });
    at += 8 + folderReserve;
  }
  if (filesAt < at) invalid("CAB file table overlaps the header or folder table.");
  const dataStart = descriptors.reduce((minimum, folder) => Math.min(minimum, folder.offset), snapshot.size);
  if (dataStart < filesAt || dataStart > snapshot.size) {
    invalid("CAB folder data starts outside the admitted data region.");
  }
  const entries: CabEntryType[] = [];
  at = filesAt;
  for (let id = 0; id < fileCount; id++) {
    if (16 > dataStart - at) invalid("CAB file header overlaps folder data.");
    const file = view(await readMetadata(at, 16));
    const size = file.getUint32(0, true);
    const folderOffset = file.getUint32(4, true);
    const folderId = file.getUint16(8, true);
    const attributes = file.getUint16(14, true);
    if (folderId >= 0xfffd) unsupported("CAB file continuation markers require an unsupported cabinet set.");
    if (folderId >= folderCount) invalid("CAB file refers to a missing folder.");
    at += 16;
    const encoded = await readMetadata(at, Math.min(maxNameBytes, dataStart - at));
    const end = encoded.indexOf(0);
    if (end < 0) invalid("CAB filename terminator is missing or exceeds the admitted name limit.");
    if (end === 0) invalid("CAB filenames cannot be empty.");
    const nameBytes = encoded.subarray(0, end);
    if (!(attributes & 0x80) && nameBytes.some((byte) => byte > 127)) {
      unsupported("CAB non-ASCII names require the UTF-8 attribute; locale decoding is not implicit.");
    }
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes);
    } catch {
      return unsupported("CAB filename UTF-8 is invalid.");
    }
    entries.push(
      Object.freeze({
        id,
        name,
        size,
        folderId,
        folderOffset,
        date: file.getUint16(10, true),
        time: file.getUint16(12, true),
        attributes,
      }),
    );
    at += end + 1;
  }
  const directoryEnd = at;
  const folders: CabFolderType[] = [];
  const suffixes: Uint8Array[] = [];
  const spans: { start: number; end: number }[] = [];
  let blockCount = 0;
  for (let id = 0; id < descriptors.length; id++) {
    const descriptor = descriptors[id]!;
    if (descriptor.count > maxBlocks - blockCount) {
      throw new ArchiveError("budget-exceeded", "CAB block count limit exceeded.");
    }
    let position = descriptor.offset;
    if (position < directoryEnd || position > snapshot.size) {
      invalid("CAB folder data overlaps the directory or exceeds source.");
    }
    let size = 0;
    const blocks: CabBlockType[] = [];
    for (let index = 0; index < descriptor.count; index++) {
      const raw = await readMetadata(position, 8 + blockReserve);
      const block = view(raw);
      const storedSize = block.getUint16(4, true);
      const plainSize = block.getUint16(6, true);
      if (plainSize === 0) unsupported("Split/zero-output CAB blocks are not supported.");
      if (plainSize > 32768) invalid("CAB uncompressed block exceeds 32 KiB.");
      if (
        storedSize === 0 || (descriptor.code === 0 && storedSize !== plainSize) ||
        (descriptor.code === 1 && (storedSize < 3 || storedSize > 32780))
      ) {
        invalid("CAB block sizes do not match the folder profile.");
      }
      position += 8 + blockReserve;
      if (storedSize > snapshot.size - position) invalid("CAB block payload exceeds source.");
      blocks.push(
        Object.freeze({
          id: blockCount++,
          folderId: id,
          folderOffset: size,
          offset: position,
          storedSize,
          size: plainSize,
          checksum: block.getUint32(0, true),
        }),
      );
      // Read support excludes nonzero block reserves; do not assume their ambiguous checksum scope.
      suffixes.push(raw.slice(4, 8));
      position += storedSize;
      size += plainSize;
    }
    spans.push({ start: descriptor.offset, end: position });
    const compression = (["none", "mszip", "quantum", "lzx"] as const)[descriptor.code & 15]!;
    folders.push(
      Object.freeze({
        id,
        compression,
        compressionCode: descriptor.code,
        size,
        readable: (descriptor.code === 0 || descriptor.code === 1) && blockReserve === 0,
        blockReserveBytes: blockReserve,
        blocks: Object.freeze(blocks),
      }),
    );
  }
  spans.sort((left, right) => left.start - right.start);
  let previousEnd = directoryEnd;
  for (const span of spans) {
    if (span.start < previousEnd) invalid("CAB physical folder extents overlap.");
    previousEnd = span.end;
  }
  if (previousEnd !== snapshot.size) unsupported("CAB trailing data outside the last folder is not supported.");
  for (const entry of entries) {
    const folder = folders[entry.folderId]!;
    if (entry.folderOffset > folder.size || entry.size > folder.size - entry.folderOffset) {
      invalid("CAB file range exceeds its logical folder.");
    }
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    folders: Object.freeze(folders),
    work: budget.inspect(),
    source: Object.freeze({
      ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
      stability: snapshot.stability ?? "unverified",
    }),
    async read(id: number, readOptions: CabReadOptionsType = {}): Promise<CabReadType> {
      readOptions = { ...readOptions };
      const maxDeflateBlocks = readOptions.maxDeflateBlocks ?? 8192;
      integer(maxDeflateBlocks, "MSZIP DEFLATE block limit");
      if (maxDeflateBlocks > 65536) throw new RangeError("MSZIP DEFLATE block limit exceeds 65536.");
      integer(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("CAB entry ID does not exist.");
      const folder = folders[entry.folderId]!;
      if (folder.compressionCode !== 0 && folder.compressionCode !== 1) {
        unsupported("Only exact NONE and MSZIP CAB folder payloads can be read.");
      }
      if (folder.blockReserveBytes !== 0) {
        unsupported("CAB CFDATA reserved-area checksum scope is not supported for payload reads.");
      }
      const offset = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - offset;
      integer(offset, "Member offset");
      integer(length, "Member length");
      if (offset > entry.size || length > entry.size - offset) {
        throw new RangeError("CAB requested member range exceeds file.");
      }
      const start = entry.folderOffset + offset;
      const end = start + length;
      const selected = length === 0
        ? []
        : folder.blocks.filter((block) => block.folderOffset < end && block.folderOffset + block.size > start);
      const compressed = folder.compressionCode === 1;
      const required = compressed && selected.length > 0
        ? folder.blocks.filter((block) => block.folderOffset < end)
        : selected;
      const verify = readOptions.verify ?? true;
      // An operation signal may add cancellation authority but cannot replace opening authority.
      const signals = [archiveSignal, readOptions.signal].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      signal?.throwIfAborted();
      const extra = readOptions.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== openingLedger) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      // The complete known source/request cost is reserved below before allocating output.
      // Actual reads consume that admission locally without charging external ledgers twice.
      const readBudget = new ArchiveBudget(snapshot, {
        ...readOptions,
        ledger: {
          reserve(kind, count) {
            if (kind !== "sourceBytes" && kind !== "requests") ledger.reserve(kind, count);
          },
          inspect: () => ledger.inspect(),
        },
      }, signal);
      let workLength = 0;
      let sourceLength = 0;
      for (const block of required) {
        const decoded = compressed
          ? block.size + (block === required.at(-1) ? 0 : Math.min(32768, block.folderOffset + block.size))
          : verify && block.checksum !== 0
          ? block.size
          : Math.min(end, block.folderOffset + block.size) - Math.max(start, block.folderOffset);
        workLength += decoded;
        sourceLength += compressed ? block.storedSize : decoded;
      }
      if (sourceLength > readBudget.limits.maxSourceBytes || required.length > readBudget.limits.maxRequests) {
        throw new ArchiveError("budget-exceeded", "CAB selected block work exceeds source limits.");
      }
      ledger.reserve("sourceBytes", sourceLength);
      ledger.reserve("requests", required.length);
      readBudget.output(length);
      readBudget.decoded(workLength);
      signal?.throwIfAborted();
      const bytes = new Uint8Array(length);
      const evidence: CabBlockReadType[] = [];
      let history = new Uint8Array(0);
      let deflateBlocks = 0;
      for (const block of required) {
        const from = Math.max(start, block.folderOffset);
        const until = Math.min(end, block.folderOffset + block.size);
        const check = verify && block.checksum !== 0;
        const readAt = compressed || check ? block.folderOffset : from;
        const body = await readBudget.read(
          compressed ? block.offset : block.offset + readAt - block.folderOffset,
          compressed ? block.storedSize : check ? block.size : until - from,
        );
        if (check && parity(suffixes[block.id]!, parity(body)) !== block.checksum) {
          throw new ArchiveError("checksum-mismatch", "CAB required block parity checksum mismatch.");
        }
        const decoded = compressed
          ? readMszip(body, block.size, history, signal, () => {
            if (deflateBlocks === maxDeflateBlocks) {
              throw new ArchiveError("budget-exceeded", "MSZIP cumulative DEFLATE block limit exceeded.");
            }
            deflateBlocks++;
          })
          : body;
        if (until > from) bytes.set(decoded.subarray(from - readAt, until - readAt), from - start);
        if (compressed && block !== required.at(-1)) {
          const next = new Uint8Array(Math.min(32768, history.length + decoded.length));
          const retained = Math.max(0, next.length - decoded.length);
          next.set(history.subarray(history.length - retained));
          next.set(decoded.subarray(Math.max(0, decoded.length - next.length)), retained);
          history = next;
        }
        evidence.push(
          Object.freeze({
            blockId: block.id,
            role: block.folderOffset < end && block.folderOffset + block.size > start ? "covering" : "history",
            status: block.checksum === 0 ? "checksum-absent" : check ? "checksum-verified" : "pending",
          }),
        );
      }
      signal?.throwIfAborted();
      return {
        bytes,
        deflateBlocks,
        blocks: Object.freeze(evidence),
        work: readBudget.inspect(),
        integrity: evidence.length > 0 && evidence.every((block) => block.status === "checksum-verified")
          ? "block-checksum-verified"
          : evidence.some((block) => block.status === "pending")
          ? "pending"
          : "none",
      };
    },
  });
}
