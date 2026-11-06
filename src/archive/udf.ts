/** Bounded UDF 1.02 physical-partition inspection without mounting an image. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One recorded physical interval in the file's logical byte order. */
export interface UdfExtentType {
  readonly offset: number;
  readonly length: number;
}
/** One physical file identifier; file aliases retain separate IDs and the shared ICB address. */
export interface UdfEntryType {
  readonly id: number;
  readonly parentId: number;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly recordOffset: number;
  readonly icb: number;
  readonly size: number;
  readonly hidden: boolean;
  readonly allocation: "short" | "long";
  readonly extents: readonly UdfExtentType[];
}
/** Index bounds are independent of payload size. All counts include refused/deleted records already examined. */
export interface UdfOpenOptionsType extends ArchiveLimitsType {
  /** Volume/integrity descriptors, including recognition records. Default 256. */
  readonly maxDescriptors?: number;
  /** All directory identifiers, including parent and deleted identifiers. Default 100,000. */
  readonly maxEntries?: number;
  /** Root depth zero. Default 64. */
  readonly maxDepth?: number;
  /** Aggregate directory bytes admitted before queuing. Default 8 MiB. */
  readonly maxDirectoryBytes?: number;
  /** Aggregate retained UTF-8 name bytes. Default 1 MiB. */
  readonly maxNamesBytes?: number;
  /** Recorded extents in unique ICBs, admitted before materialization. Default 100,000. */
  readonly maxExtents?: number;
  readonly allowUnverifiedSource?: boolean;
  readonly signal?: AbortSignal;
}
/** Exact selected interval; UDF descriptor CRCs supply no dedicated payload checksum. */
export interface UdfReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Owned selected bytes with actual work and no authentication claim. */
export interface UdfReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
/** Persistent additional limits across all reads through one borrowed member source. */
export interface UdfMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Strict single-volume 2048-byte-sector UDF 1.02 read-only image profile. */
export interface UdfArchiveType {
  readonly revision: "1.02";
  readonly partition: { readonly number: number; readonly offset: number; readonly length: number };
  readonly entries: readonly UdfEntryType[];
  readonly metadata: "descriptor-crc16-verified";
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: UdfReadOptionsType): Promise<UdfReadType>;
  member(id: number, options?: UdfMemberOptionsType): ByteSourceType;
}

/** One checked direct-entry ICB; shared by file aliases without following a second path. */
interface FileType {
  readonly size: number;
  readonly kind: "file" | "directory";
  readonly allocation: "short" | "long";
  readonly extents: readonly UdfExtentType[];
  readonly descriptorBytes: number;
}

/** Source reservations precede selected-buffer allocation; actual reads consume local
 * credits while ArchiveBudget still records their real work and checks per-call limits.
 * Credits belong to one serial operation and are never shared across concurrent reads. */
function admission(target: ArchiveLedgerType): {
  ledger: ArchiveLedgerType;
  reserve(sourceBytes: number, requests: number): void;
} {
  const credit = { sourceBytes: 0, requests: 0 };
  return {
    ledger: {
      reserve(kind, count) {
        if ((kind === "sourceBytes" || kind === "requests") && count <= credit[kind]) credit[kind] -= count;
        else target.reserve(kind, count);
      },
      inspect: () => target.inspect(),
    },
    reserve(sourceBytes, requests) {
      target.reserve("sourceBytes", sourceBytes);
      target.reserve("requests", requests);
      credit.sourceBytes += sourceBytes;
      credit.requests += requests;
    },
  };
}

/** CRC-ITU-T with initial zero, most-significant bit first. No table or module cache is retained. */
function crc16(bytes: Uint8Array): number {
  let state = 0;
  for (const byte of bytes) {
    state ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) state = ((state << 1) ^ (state & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return state;
}
function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("UDF integer exceeds safe indexing.");
  return Number(value);
}
function bytesOf(block: number, length: number, maximum: number): number {
  const offset = BigInt(block) * 2048n;
  if (offset + BigInt(length) > BigInt(maximum)) invalid("UDF extent exceeds its enclosing volume or partition.");
  return exact(offset);
}
function zeros(bytes: Uint8Array, label: string): void {
  if (bytes.some((byte) => byte !== 0)) invalid(`UDF ${label} must contain zero bytes.`);
}
function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
/** Check location in the descriptor's own coordinate system (volume sector or partition block).
 * An ECMA descriptor may omit its CRC; this strict inspection profile instead requires
 * CRC coverage through every interpreted byte before accepting metadata authority. */
function tag(bytes: Uint8Array, location: number, minimum: number, expected?: number): number {
  if (bytes.length < 16 || minimum < 16 || minimum > bytes.length) invalid("UDF descriptor is truncated.");
  const data = view(bytes);
  let sum = 0;
  for (let at = 0; at < 16; at++) if (at !== 4) sum += bytes[at]!;
  if ((sum & 255) !== bytes[4]) throw new ArchiveError("checksum-mismatch", "UDF descriptor tag checksum mismatch.");
  if (data.getUint16(2, true) !== 2) unsupported("UDF descriptor version must be 2 in this 1.02 profile.");
  if (bytes[5] !== 0 || data.getUint32(12, true) !== location) {
    invalid("UDF reserved tag byte or tag location differs.");
  }
  const length = data.getUint16(10, true);
  if (length > bytes.length - 16 || length < minimum - 16) {
    invalid("UDF descriptor CRC does not cover interpreted fields.");
  }
  if (crc16(bytes.subarray(16, 16 + length)) !== data.getUint16(8, true)) {
    throw new ArchiveError("checksum-mismatch", "UDF descriptor body CRC16 mismatch.");
  }
  const id = data.getUint16(0, true);
  if (expected !== undefined && id !== expected) {
    unsupported(`UDF descriptor ${id} is unsupported here; expected ${expected}.`);
  }
  return id;
}
/** Only OSTA CS0 is decoded. Names stay literal components and never become host paths. */
function nameOf(bytes: Uint8Array): string {
  const mode = bytes[0];
  if (mode !== 8 && mode !== 16) unsupported("UDF name must use OSTA compressed Unicode 8 or 16.");
  if (bytes.length < 2 || (mode === 16 && bytes.length % 2 !== 1)) invalid("UDF compressed Unicode name is truncated.");
  let result = "";
  for (let at = 1; at < bytes.length; at += mode === 8 ? 1 : 2) {
    const code = mode === 8 ? bytes[at]! : bytes[at]! * 256 + bytes[at + 1]!;
    if (code === 0 || code === 47 || code >= 0xd800 && code <= 0xdfff) {
      invalid("UDF name contains NUL, separator or surrogate.");
    }
    result += String.fromCharCode(code);
  }
  return result;
}
function charspec(bytes: Uint8Array): void {
  if (bytes.length !== 64 || bytes[0] !== 0 || text(bytes.subarray(1, 24)) !== "OSTA Compressed Unicode") {
    unsupported("UDF character set must be OSTA CS0.");
  }
  zeros(bytes.subarray(24), "character-set padding");
}
function domain(bytes: Uint8Array): void {
  if (bytes.length !== 32 || bytes[0] !== 0 || text(bytes.subarray(1, 20)) !== "*OSTA UDF Compliant") {
    unsupported("UDF domain is not OSTA UDF Compliant.");
  }
  zeros(bytes.subarray(20, 24), "domain identifier padding");
  if (view(bytes).getUint16(24, true) !== 0x0102) unsupported("Only the UDF 1.02 domain revision is supported.");
}
function signals(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}

/** Parse one physical partition and a bounded directory tree. Payload contents remain unverified. */
export async function openUdf(input: ByteSourceType, supplied: UdfOpenOptionsType = {}): Promise<UdfArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "UDF source size");
  if (size % 2048 || size < 257 * 2048) invalid("UDF image must contain sector 256 and complete 2048-byte sectors.");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown UDF source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("UDF identity must be a bounded string.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("UDF needs stable source evidence or explicit unverified acceptance.");
  }
  const snapshot: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const maximum = {
    descriptors: options.maxDescriptors ?? 256,
    entries: options.maxEntries ?? 100000,
    depth: options.maxDepth ?? 64,
    directories: options.maxDirectoryBytes ?? 8 * 1024 * 1024,
    names: options.maxNamesBytes ?? 1024 * 1024,
    extents: options.maxExtents ?? 100000,
  };
  for (const [label, count] of Object.entries(maximum)) integer(count, `UDF maximum ${label}`);
  const local = createArchiveLedger(options);
  const opening = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      opening?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
  const openingAdmission = admission(lifetime);
  const work = new ArchiveBudget(snapshot, { ...options, ledger: openingAdmission.ledger }, options.signal);
  let descriptors = 0;
  const system = async (block: number): Promise<Uint8Array> => {
    if (++descriptors > maximum.descriptors) {
      throw new ArchiveError("budget-exceeded", "UDF system descriptors exceed policy.");
    }
    const bytes = await work.read(bytesOf(block, 2048, size), 2048);
    work.decoded(bytes.length);
    return bytes;
  };
  let beginning = false;
  let recognized = false;
  let terminated = false;
  for (let block = 16; block < 256; block++) {
    const bytes = await system(block);
    const id = text(bytes.subarray(1, 6));
    // ISO bridge descriptors can precede the extended recognition area.
    if (!beginning && id === "CD001") continue;
    if (bytes[0] !== 0 || bytes[6] !== 1) invalid("UDF recognition descriptor framing differs.");
    if (!beginning && id === "BEA01") {
      beginning = true;
      continue;
    }
    if (beginning && !recognized && id === "NSR02") {
      recognized = true;
      continue;
    }
    if (beginning && recognized && id === "TEA01") {
      terminated = true;
      break;
    }
    unsupported("UDF recognition sequence must contain BEA01, NSR02 and TEA01.");
  }
  if (!terminated) invalid("UDF recognition terminator is missing.");
  const anchor = await system(256);
  tag(anchor, 256, 512, 2);
  const anchorData = view(anchor);
  const sequenceLength = anchorData.getUint32(16, true);
  const sequenceBlock = anchorData.getUint32(20, true);
  if (sequenceLength < 16 * 2048 || sequenceLength % 2048) {
    invalid("UDF main descriptor extent must contain complete sectors.");
  }
  bytesOf(sequenceBlock, sequenceLength, size);
  let partition: Uint8Array | undefined;
  let logical: Uint8Array | undefined;
  let primary = false;
  terminated = false;
  for (let at = 0; at < sequenceLength / 2048; at++) {
    const block = sequenceBlock + at;
    const bytes = await system(block);
    const id = tag(bytes, block, 16);
    if (id === 8) {
      tag(bytes, block, 512, 8);
      terminated = true;
      break;
    }
    if (id === 1) {
      tag(bytes, block, 512, 1);
      if (primary) unsupported("UDF duplicate prevailing primary descriptors are unsupported.");
      if (view(bytes).getUint16(56, true) !== 1 || view(bytes).getUint16(58, true) !== 1) {
        unsupported("UDF multi-volume sets are unsupported.");
      }
      primary = true;
    } else if (id === 5) {
      tag(bytes, block, 512, 5);
      if (partition) unsupported("UDF requires exactly one physical partition descriptor.");
      partition = bytes;
    } else if (id === 6) {
      tag(bytes, block, 440);
      if (logical) unsupported("UDF duplicate prevailing logical descriptors are unsupported.");
      logical = bytes;
    } else if (id !== 4 && id !== 7) unsupported("UDF continuation or unknown volume descriptor is unsupported.");
  }
  if (!terminated || !primary || !partition || !logical) invalid("UDF main descriptor sequence is incomplete.");
  const pd = view(partition);
  if (pd.getUint16(20, true) !== 1 || pd.getUint32(184, true) !== 1 || text(partition.subarray(25, 31)) !== "+NSR02") {
    unsupported("UDF requires an allocated read-only NSR02 partition.");
  }
  zeros(partition.subarray(31, 48), "partition contents identifier padding");
  const partitionNumber = pd.getUint16(22, true);
  const partitionLength = exact(BigInt(pd.getUint32(192, true)) * 2048n);
  const partitionOffset = bytesOf(pd.getUint32(188, true), partitionLength, size);
  const ld = view(logical);
  if (ld.getUint32(212, true) !== 2048 || ld.getUint32(264, true) !== 6 || ld.getUint32(268, true) !== 1) {
    unsupported("UDF needs one type-1 partition map and 2048-byte logical blocks.");
  }
  tag(logical, ld.getUint32(12, true), 446);
  if (
    logical[440] !== 1 || logical[441] !== 6 || ld.getUint16(442, true) !== 1 ||
    ld.getUint16(444, true) !== partitionNumber
  ) unsupported("UDF physical partition map differs from its descriptor.");
  charspec(logical.subarray(20, 84));
  domain(logical.subarray(216, 248));
  const partitionRange = (block: number, length: number): number =>
    partitionOffset + bytesOf(block, length, partitionLength);
  /** Long allocation addresses refer to partition-map indices, not partition numbers. */
  const longAddress = (bytes: Uint8Array, at: number): { block: number; length: number } => {
    if (at + 16 > bytes.length) invalid("UDF long allocation address is truncated.");
    const data = view(bytes);
    const length = data.getUint32(at, true);
    if (length >>> 30 || data.getUint16(at + 8, true) !== 0) {
      unsupported("UDF long address requires recorded extent in its sole partition map.");
    }
    const block = data.getUint32(at + 4, true);
    partitionRange(block, length);
    return { block, length };
  };
  const integrityLength = ld.getUint32(432, true);
  const integrityBlock = ld.getUint32(436, true);
  if (!integrityLength || integrityLength % 2048) invalid("UDF integrity sequence is missing or unaligned.");
  bytesOf(integrityBlock, integrityLength, size);
  let closed = false;
  terminated = false;
  for (let at = 0; at < integrityLength / 2048; at++) {
    const block = integrityBlock + at;
    const bytes = await system(block);
    const id = tag(bytes, block, 16);
    if (id === 8) {
      tag(bytes, block, 512, 8);
      terminated = true;
      break;
    }
    if (id !== 9 || closed) unsupported("UDF requires one closed integrity descriptor.");
    const data = view(bytes);
    tag(bytes, block, 80, 9);
    const count = data.getUint32(72, true);
    const implementation = data.getUint32(76, true);
    if (count !== 1 || implementation < 46 || implementation > 2048 - 88) {
      unsupported("UDF integrity tables exceed the single partition profile.");
    }
    tag(bytes, block, 88 + implementation, 9);
    if (data.getUint32(28, true) !== 1 || data.getUint32(32, true) !== 0) {
      unsupported("UDF open or chained integrity state is unsupported.");
    }
    if (data.getUint16(128, true) > 0x0102) unsupported("UDF minimum reader revision exceeds 1.02.");
    closed = true;
  }
  if (!closed || !terminated) invalid("UDF closed integrity sequence terminator is missing.");
  const fileSet = longAddress(logical, 248);
  if (fileSet.length < 512 || fileSet.length % 2048 && fileSet.length !== 512) {
    unsupported("UDF file-set sequence requires a complete descriptor or sectors.");
  }
  let fsd: Uint8Array | undefined;
  for (let at = 0; at < Math.ceil(fileSet.length / 2048); at++) {
    if (++descriptors > maximum.descriptors) {
      throw new ArchiveError("budget-exceeded", "UDF system descriptors exceed policy.");
    }
    const length = Math.min(2048, fileSet.length - at * 2048);
    const bytes = await work.read(partitionRange(fileSet.block + at, length), length);
    work.decoded(length);
    const id = tag(bytes, fileSet.block + at, 512);
    if (id === 8) break;
    if (id !== 256 || fsd) unsupported("UDF requires exactly one file-set descriptor.");
    fsd = bytes;
  }
  if (!fsd) invalid("UDF file-set descriptor is missing.");
  charspec(fsd.subarray(48, 112));
  charspec(fsd.subarray(240, 304));
  domain(fsd.subarray(416, 448));
  if (
    view(fsd).getUint32(40, true) !== 0 || view(fsd).getUint32(44, true) !== 0 || view(fsd).getUint32(448, true) !== 0
  ) unsupported("UDF multiple file sets or file-set continuation is unsupported.");
  const rootAddress = longAddress(fsd, 400);
  const files = new Map<number, FileType>();
  let extentCount = 0;
  const getFile = async (address: { block: number; length: number }): Promise<FileType> => {
    if (address.length < 176 || address.length > 2048) unsupported("UDF requires one direct-entry ICB sector.");
    const cached = files.get(address.block);
    if (cached) {
      if (cached.descriptorBytes > address.length) invalid("UDF alias ICB extent truncates its cached descriptor.");
      return cached;
    }
    const bytes = await work.read(partitionRange(address.block, 2048), 2048);
    work.decoded(2048);
    tag(bytes, address.block, 176, 261);
    const data = view(bytes);
    if (
      data.getUint16(20, true) !== 4 || data.getUint16(24, true) !== 1 || bytes[26] !== 0 ||
      data.getUint32(16, true) !== 0
    ) unsupported("UDF requires ICB strategy4 with one direct entry.");
    const kind = bytes[27] === 4
      ? "directory"
      : bytes[27] === 5
      ? "file"
      : unsupported("UDF non-regular files and symbolic links are unsupported.");
    const flags = data.getUint16(34, true);
    if (flags & 0xf808 || (flags & 7) > 1) {
      unsupported("UDF transformed, multiversion, embedded or unsupported allocation profile.");
    }
    if (bytes[50] || bytes[51] || data.getUint32(52, true) || data.getUint32(112, true)) {
      unsupported("UDF record formats or external extended-attribute ICBs are unsupported.");
    }
    const size = exact(data.getBigUint64(56, true));
    const ea = data.getUint32(168, true);
    const ads = data.getUint32(172, true);
    if (ea > 2048 - 176 || ads > 2048 - 176 - ea) invalid("UDF FE variable fields exceed its sector.");
    if (176 + ea + ads > address.length || data.getUint16(10, true) + 16 > address.length) {
      invalid("UDF FE exceeds its declared ICB extent.");
    }
    tag(bytes, address.block, 176 + ea + ads, 261);
    const allocation = (flags & 7) === 0 ? "short" : "long";
    const width = allocation === "short" ? 8 : 16;
    if (ads % width) invalid("UDF allocation array has a partial descriptor.");
    if (ads / width > maximum.extents - extentCount) {
      throw new ArchiveError("budget-exceeded", "UDF extents exceed policy.");
    }
    extentCount += ads / width;
    work.output(ads / width * 24);
    const extents: UdfExtentType[] = [];
    let recorded = 0;
    for (let at = 176 + ea; at < 176 + ea + ads; at += width) {
      const length = data.getUint32(at, true);
      if (length >>> 30) unsupported("UDF sparse, unrecorded and continuation extents are unsupported.");
      const block = data.getUint32(at + 4, true);
      if (allocation === "long") longAddress(bytes, at);
      if (!length) continue;
      const offset = partitionRange(block, length);
      if (recorded >= size || length > size - recorded) invalid("UDF recorded extents exceed information length.");
      extents.push(Object.freeze({ offset, length }));
      recorded += length;
    }
    if (recorded !== size) invalid("UDF recorded extents differ from information length.");
    const file: FileType = {
      size,
      kind,
      allocation,
      extents: Object.freeze(extents),
      descriptorBytes: Math.max(176 + ea + ads, data.getUint16(10, true) + 16),
    };
    files.set(address.block, file);
    return file;
  };
  const entries: UdfEntryType[] = [];
  const root = await getFile(rootAddress);
  if (root.kind !== "directory") invalid("UDF root ICB is not a directory.");
  let directoryBytes = 0;
  const queue: { id: number; parentBlock: number; block: number; depth: number; file: typeof root }[] = [];
  const visited = new Set<number>();
  const enqueue = (id: number, parentBlock: number, block: number, depth: number, file: typeof root): void => {
    if (depth > maximum.depth) throw new ArchiveError("budget-exceeded", "UDF directory depth exceeds policy.");
    if (visited.has(block)) unsupported("UDF directory cycles and multiple parents are unsupported.");
    if (file.size > maximum.directories - directoryBytes) {
      throw new ArchiveError("budget-exceeded", "UDF directory extents exceed policy.");
    }
    directoryBytes += file.size;
    visited.add(block);
    queue.push({ id, parentBlock, block, depth, file });
  };
  enqueue(-1, rootAddress.block, rootAddress.block, 0, root);
  /** Reads intersecting physical intervals only; no descriptor or payload extent is followed by a name. */
  const copy = async (
    file: Pick<FileType, "extents">,
    offset: number,
    length: number,
    budget: ArchiveBudget,
    admitted: ReturnType<typeof admission>,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> => {
    let sourceBytes = 0;
    let requests = 0;
    let position = 0;
    for (const extent of file.extents) {
      const count = Math.min(offset + length, position + extent.length) - Math.max(offset, position);
      if (count > 0) {
        sourceBytes += count;
        requests++;
      }
      position += extent.length;
    }
    const previous = budget.inspect();
    if (
      sourceBytes > budget.limits.maxSourceBytes - previous.sourceBytes ||
      requests > budget.limits.maxRequests - previous.requests
    ) {
      throw new ArchiveError("budget-exceeded", "UDF selected source/request cost exceeds policy.");
    }
    signal?.throwIfAborted();
    admitted.reserve(sourceBytes, requests);
    signal?.throwIfAborted();
    const output = new Uint8Array(length);
    let logical = 0;
    for (const extent of file.extents) {
      const begin = Math.max(offset, logical);
      const end = Math.min(offset + length, logical + extent.length);
      if (end > begin) output.set(await budget.read(extent.offset + begin - logical, end - begin), begin - offset);
      logical += extent.length;
    }
    return output;
  };
  let records = 0;
  let names = 0;
  const encoder = new TextEncoder();
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index]!;
    work.decoded(directory.file.size);
    const bytes = await copy(directory.file, 0, directory.file.size, work, openingAdmission, options.signal);
    let at = 0;
    let parents = 0;
    for (; at < bytes.length;) {
      if (++records > maximum.entries) {
        throw new ArchiveError("budget-exceeded", "UDF directory identifiers exceed policy.");
      }
      if (bytes.length - at < 38) invalid("UDF directory identifier is truncated.");
      const data = view(bytes.subarray(at));
      const nameBytes = bytes[at + 19]!;
      const implementation = data.getUint16(36, true);
      const unpadded = 38 + implementation + nameBytes;
      const length = Math.ceil(unpadded / 4) * 4;
      if (implementation % 4 || implementation !== 0 && implementation < 32 || length > bytes.length - at) {
        invalid("UDF directory identifier fields exceed its extent.");
      }
      let logical = 0;
      let physical = -1;
      for (const extent of directory.file.extents) {
        if (at < logical + extent.length) {
          physical = extent.offset + at - logical;
          break;
        }
        logical += extent.length;
      }
      const record = bytes.subarray(at, at + length);
      tag(record, Math.floor((physical - partitionOffset) / 2048), length, 257);
      zeros(record.subarray(unpadded), "FID padding");
      if (data.getUint16(16, true) !== 1 || (record[18]! & 0xe0)) {
        unsupported("UDF file version or FID characteristics are unsupported.");
      }
      const flags = record[18]!;
      const address = longAddress(record, 20);
      if (flags & 8) {
        if (nameBytes || !(flags & 2) || flags & 4 || address.block !== directory.parentBlock) {
          invalid("UDF parent FID differs from its known parent.");
        }
        parents++;
      } else if (!(flags & 4)) {
        const name = nameOf(record.subarray(38 + implementation, unpadded));
        const size = encoder.encode(name).length;
        if (size > maximum.names - names) {
          throw new ArchiveError("budget-exceeded", "UDF retained names exceed policy.");
        }
        names += size;
        work.output(size + 64);
        const file = await getFile(address);
        if ((file.kind === "directory") !== Boolean(flags & 2)) invalid("UDF FID kind differs from its ICB.");
        const id = entries.length;
        entries.push(
          Object.freeze({
            id,
            parentId: directory.id,
            name,
            kind: file.kind,
            recordOffset: physical,
            icb: address.block,
            size: file.size,
            hidden: Boolean(flags & 1),
            allocation: file.allocation,
            extents: file.extents,
          }),
        );
        if (file.kind === "directory") enqueue(id, directory.block, address.block, directory.depth + 1, file);
      }
      at += length;
    }
    if (parents !== 1) invalid("UDF directory must contain exactly one parent FID.");
  }
  const selected = (id: number): UdfEntryType => {
    integer(id, "UDF entry ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown UDF entry ID.");
    if (entry.kind !== "file") unsupported("UDF payload reads require a regular file.");
    return entry;
  };
  const archive: UdfArchiveType = {
    revision: "1.02",
    partition: Object.freeze({ number: partitionNumber, offset: partitionOffset, length: partitionLength }),
    entries: Object.freeze(entries),
    metadata: "descriptor-crc16-verified",
    work: work.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    async read(id: number, supplied: UdfReadOptionsType = {}): Promise<UdfReadType> {
      const opts = { ...supplied };
      const entry = selected(id);
      const offset = opts.offset ?? 0;
      const length = opts.length ?? entry.size - offset;
      integer(offset, "UDF member offset");
      integer(length, "UDF member length");
      if (offset > entry.size || length > entry.size - offset) {
        throw new RangeError("UDF selected interval exceeds the file.");
      }
      const signal = signals(options.signal, opts.signal);
      const extra = opts.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== opening) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      const admitted = admission(ledger);
      const budget = new ArchiveBudget(snapshot, { ...opts, ledger: admitted.ledger }, signal);
      budget.output(length);
      signal?.throwIfAborted();
      const bytes = await copy(entry, offset, length, budget, admitted, signal);
      signal?.throwIfAborted();
      return { bytes, integrity: "none", work: budget.inspect() };
    },
    member(id: number, supplied: UdfMemberOptionsType = {}): ByteSourceType {
      const entry = selected(id);
      const opts = { ...supplied };
      const signal = signals(options.signal, opts.signal);
      signal?.throwIfAborted();
      const local = createArchiveLedger(opts);
      const extra = opts.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          local.reserve(kind, count);
          if (extra && extra !== opening) extra.reserve(kind, count);
        },
        inspect: () => local.inspect(),
      };
      return Object.freeze({
        size: entry.size,
        ...(identity === undefined ? {} : { identity: `udf:${identity.length}:${identity}:icb:${entry.icb}` }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, request?: { signal?: AbortSignal }): Promise<Uint8Array> {
          const active = signals(signal, request?.signal);
          return (await archive.read(id, {
            ...opts,
            offset,
            length,
            ledger,
            ...(active === undefined ? {} : { signal: active }),
          })).bytes;
        },
      });
    },
  };
  options.signal?.throwIfAborted();
  return Object.freeze(archive);
}
