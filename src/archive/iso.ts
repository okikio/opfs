/** Bounded selected-tree ISO 9660 and Joliet image inspection, without host mounting. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One physical directory record. Names remain literal components, including primary ;version suffixes. */
export interface IsoEntryType {
  readonly id: number;
  readonly parentId: number;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly recordOffset: number;
  readonly offset: number;
  readonly size: number;
  readonly hidden: boolean;
}
/** Observable compatibility deviation. All three positions are byte offsets within the image. */
export interface IsoParentMismatchType {
  readonly recordOffset: number;
  readonly declaredExtent: number;
  readonly expectedExtent: number;
}
/** Finite index bounds, independent of file payload sizes. Directory extents are admitted before queuing. */
export interface IsoOpenOptionsType extends ArchiveLimitsType {
  /** Default primary. Joliet selects exactly one recognized supplementary tree. Rock Ridge is unsupported. */
  readonly namespace?: "primary" | "joliet" | "rock-ridge";
  /** Default validate. Joliet-only compatibility skips parent extent equality, never framing, range, or size checks. */
  readonly jolietParent?: "validate" | "ignore-extent";
  /** Default 64 descriptors, including the terminator. */
  readonly maxDescriptors?: number;
  /** Default 100,000 ordinary records, excluding self/parent records. */
  readonly maxEntries?: number;
  /** Root depth is zero; default 64. */
  readonly maxDepth?: number;
  /** Sum of queued directory extent sizes, including root. Default 8 MiB. */
  readonly maxDirectoryBytes?: number;
  /** UTF-8 bytes retained in all entry names. Default 1 MiB. */
  readonly maxNamesBytes?: number;
  /** Default false. An identity does not establish source stability. */
  readonly allowUnverifiedSource?: boolean;
  readonly signal?: AbortSignal;
}
/** Exact selected interval; the format supplies no payload checksum. */
export interface IsoReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Owned selected bytes and actual logical work, without authentication evidence. */
export interface IsoReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
/** Limits shared by all reads from one nested member source. */
export interface IsoMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Immutable index of one selected namespace. Payload aliases keep distinct physical record identities. */
export interface IsoArchiveType {
  readonly namespace: "primary" | "joliet";
  readonly volumeBytes: number;
  /** Parent pointers never drive traversal. Each retained deviation reserves 24 output-accounting bytes. */
  readonly parents: {
    readonly policy: "validate" | "ignore-extent";
    readonly mismatches: readonly IsoParentMismatchType[];
  };
  readonly entries: readonly IsoEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: IsoReadOptionsType): Promise<IsoReadType>;
  /** Borrow a regular member extent. Names never become host paths or identity evidence. */
  member(id: number, options?: IsoMemberOptionsType): ByteSourceType;
}

/** ISO records duplicate multibyte numbers in both byte orders; neither copy is silently preferred. */
function both(bytes: Uint8Array, offset: number, width: 2 | 4): number {
  const data = view(bytes);
  const little = width === 2 ? data.getUint16(offset, true) : data.getUint32(offset, true);
  const big = width === 2 ? data.getUint16(offset + width) : data.getUint32(offset + width);
  if (little !== big) invalid("ISO both-endian numeric copies disagree.");
  return little;
}

/** Validate multiplication and addition before converting a declared block extent to a JavaScript index. */
function extent(block: number, length: number, maximum: number): number {
  const start = BigInt(block) * 2048n;
  if (start + BigInt(length) > BigInt(maximum)) invalid("ISO extent exceeds the declared volume or source.");
  return Number(start);
}

/** Only the two ISO structural identifiers receive special meaning; all other names stay literal. */
function nameOf(bytes: Uint8Array, joliet: boolean): string {
  if (!bytes.length) invalid("ISO directory identifier is empty.");
  if (joliet && bytes.length % 2) invalid("Joliet identifier has an odd byte length.");
  let name = "";
  for (let at = 0; at < bytes.length; at += joliet ? 2 : 1) {
    const code = joliet ? bytes[at]! * 256 + bytes[at + 1]! : bytes[at]!;
    if (code === 0 || code === 47 || (code >= 0xd800 && code <= 0xdfff)) {
      invalid("ISO identifier contains NUL, a separator, or a non-UCS-2 surrogate.");
    }
    if (!joliet && code > 127) unsupported("Primary ISO identifiers require ASCII in this profile.");
    name += String.fromCharCode(code);
  }
  return name;
}

/** A record never crosses its sector. Unsupported extent semantics are refused before traversal or payload access. */
function recordOf(
  bytes: Uint8Array,
  maximum: number,
): { offset: number; size: number; directory: boolean; flags: number; identifier: Uint8Array } {
  const length = bytes[0]!;
  if (length < 34 || length !== bytes.length || length % 2) invalid("ISO directory record length is invalid.");
  const names = bytes[32]!;
  const minimum = 33 + names + (names % 2 === 0 ? 1 : 0);
  if (!names || minimum > length) invalid("ISO identifier exceeds its directory record.");
  if (names % 2 === 0 && bytes[33 + names] !== 0) invalid("ISO identifier padding is nonzero.");
  const flags = bytes[25]!;
  if (flags & 0x60) invalid("ISO reserved file flags are set.");
  if (bytes[1] || bytes[26] || bytes[27] || (flags & 0x9c)) {
    unsupported(
      "ISO extended attributes, interleaving, associated/record/protected and multi-extent files are unsupported.",
    );
  }
  if (both(bytes, 28, 2) !== 1) unsupported("ISO member refers to another volume.");
  const size = both(bytes, 10, 4);
  const offset = extent(both(bytes, 2, 4), size, maximum);
  return { offset, size, directory: Boolean(flags & 2), flags, identifier: bytes.subarray(33, 33 + names) };
}

/** Open one 2048-byte user-data-sector, single-volume image. Boot/system areas and alternate namespaces are inert. */
export async function openIso(source: ByteSourceType, options: IsoOpenOptionsType = {}): Promise<IsoArchiveType> {
  options = { ...options };
  const namespace = options.namespace ?? "primary";
  if (namespace === "rock-ridge") {
    unsupported("Rock Ridge/SUSP semantics are not implemented; select primary or Joliet explicitly.");
  }
  if (namespace !== "primary" && namespace !== "joliet") throw new TypeError("Unknown ISO namespace.");
  const parentPolicy = options.jolietParent ?? "validate";
  if (parentPolicy !== "validate" && parentPolicy !== "ignore-extent") {
    throw new TypeError("Unknown Joliet parent policy.");
  }
  if (namespace !== "joliet" && options.jolietParent !== undefined) {
    throw new TypeError("jolietParent applies only to the Joliet namespace.");
  }
  const { size, identity, stability } = source;
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown ISO source stability evidence.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("ISO identity must be a string of at most 8192 UTF16 code units.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("ISO requires source stability or explicit unverified acceptance.");
  }
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
  const budget = new ArchiveBudget(snapshot, { ...options, ledger: lifetime }, options.signal);
  const policy = {
    descriptors: options.maxDescriptors ?? 64,
    entries: options.maxEntries ?? 100000,
    depth: options.maxDepth ?? 64,
    directories: options.maxDirectoryBytes ?? 8 * 1024 * 1024,
    names: options.maxNamesBytes ?? 1024 * 1024,
  };
  for (const [label, value] of Object.entries(policy)) integer(value, label);
  let primary: Uint8Array | undefined;
  let selected: Uint8Array | undefined;
  let terminated = false;
  let descriptorEnd = 16 * 2048;
  for (let index = 0; index < policy.descriptors; index++) {
    const bytes = await budget.read((16 + index) * 2048, 2048);
    budget.decoded(2048);
    descriptorEnd = (17 + index) * 2048;
    if (String.fromCharCode(...bytes.subarray(1, 6)) !== "CD001") invalid("ISO descriptor signature is invalid.");
    if (bytes[6] !== 1) unsupported("ISO descriptor version is unsupported.");
    const type = bytes[0]!;
    if (type === 255) {
      terminated = true;
      break;
    }
    if (type === 1) {
      if (primary) invalid("ISO has multiple primary volume descriptors.");
      primary = bytes.slice();
    } else if (type === 2 && bytes[88] === 37 && bytes[89] === 47 && [64, 67, 69].includes(bytes[90]!)) {
      if (namespace === "joliet") {
        if (selected) unsupported("Multiple Joliet trees require explicit descriptor selection, which is unsupported.");
        selected = bytes.slice();
      }
    } else if (type !== 0 && type !== 2 && type !== 3) invalid("ISO descriptor type is reserved.");
  }
  if (!terminated) throw new ArchiveError("budget-exceeded", "ISO descriptor terminator not found within limit.");
  if (!primary) invalid("ISO primary volume descriptor is missing.");
  if (namespace === "primary") selected = primary;
  if (!selected) unsupported("Requested Joliet namespace is absent.");
  const volume = selected;
  if (volume[7] !== 0 || volume[881] !== 1) {
    unsupported("ISO descriptor flags or file structure version are unsupported.");
  }
  if (both(volume, 120, 2) !== 1 || both(volume, 124, 2) !== 1) unsupported("ISO volume sets are unsupported.");
  if (both(volume, 128, 2) !== 2048) unsupported("ISO logical blocks must be 2048 bytes in this profile.");
  const blocks = both(volume, 80, 4);
  const volumeBytes = Number(BigInt(blocks) * 2048n);
  if (volumeBytes > size || volumeBytes < descriptorEnd) {
    invalid("ISO volume size exceeds source or excludes descriptors.");
  }
  if (
    both(primary, 80, 4) !== blocks || both(primary, 128, 2) !== 2048 || both(primary, 120, 2) !== 1 ||
    both(primary, 124, 2) !== 1
  ) invalid("ISO primary and selected volume geometry disagree.");
  const tableSize = both(volume, 132, 4);
  if (!tableSize) invalid("ISO path table size is zero.");
  const data = view(volume);
  for (const [at, little] of [[140, true], [144, true], [148, false], [152, false]] as const) {
    const block = data.getUint32(at, little);
    if (at === 140 || at === 148 || block) extent(block, tableSize, volumeBytes);
  }
  const root = recordOf(volume.subarray(156, 190), volumeBytes);
  if (!root.directory || root.identifier.length !== 1 || root.identifier[0] !== 0) {
    invalid("ISO root descriptor is not a self directory record.");
  }
  type Directory = {
    id: number;
    offset: number;
    size: number;
    parentOffset: number;
    parentSize: number;
    depth: number;
  };
  const queue: Directory[] = [];
  const visited = new Set<number>();
  let directoryBytes = 0;
  const admit = (directory: Directory): void => {
    if (directory.depth > policy.depth || directory.size > policy.directories - directoryBytes) {
      throw new ArchiveError("budget-exceeded", "ISO directory traversal limit exceeded.");
    }
    if (!directory.size || directory.size % 2048) invalid("ISO directory length must be a positive sector multiple.");
    if (visited.has(directory.offset)) invalid("ISO directory alias or cycle is unsupported.");
    visited.add(directory.offset);
    directoryBytes += directory.size;
    queue.push(directory);
  };
  admit({ id: -1, offset: root.offset, size: root.size, parentOffset: root.offset, parentSize: root.size, depth: 0 });
  const entries: IsoEntryType[] = [];
  const mismatches: IsoParentMismatchType[] = [];
  let retainedNames = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const directory = queue[cursor]!;
    let ordinal = 0;
    for (let sector = 0; sector < directory.size; sector += 2048) {
      const bytes = await budget.read(directory.offset + sector, 2048);
      budget.decoded(2048);
      for (let at = 0; at < 2048;) {
        const length = bytes[at]!;
        if (!length) {
          if (bytes.subarray(at).some((byte) => byte !== 0)) invalid("ISO directory sector padding is nonzero.");
          break;
        }
        if (length > 2048 - at) invalid("ISO directory record crosses a sector.");
        const record = recordOf(bytes.subarray(at, at + length), volumeBytes);
        const special = record.identifier.length === 1 && record.identifier[0]! < 2;
        if (ordinal < 2) {
          const self = ordinal === 0;
          if (
            !special || record.identifier[0] !== ordinal || !record.directory ||
            record.size !== (self ? directory.size : directory.parentSize)
          ) invalid("ISO self/parent directory record disagrees with traversal.");
          const expected = self ? directory.offset : directory.parentOffset;
          if (record.offset !== expected) {
            if (self || parentPolicy === "validate") {
              invalid("ISO self/parent directory extent disagrees with traversal.");
            }
            // A compatibility record remains observable; its extent is never followed as a graph edge.
            budget.output(24);
            mismatches.push(
              Object.freeze({
                recordOffset: directory.offset + sector + at,
                declaredExtent: record.offset,
                expectedExtent: expected,
              }),
            );
          }
        } else {
          if (special) invalid("ISO self/parent record occurs outside its structural position.");
          if (entries.length >= policy.entries) throw new ArchiveError("budget-exceeded", "ISO entry limit exceeded.");
          const name = nameOf(record.identifier, namespace === "joliet");
          const nameBytes = new TextEncoder().encode(name).length;
          if (nameBytes > policy.names - retainedNames) {
            throw new ArchiveError("budget-exceeded", "ISO retained name limit exceeded.");
          }
          retainedNames += nameBytes;
          const entry: IsoEntryType = Object.freeze({
            id: entries.length,
            parentId: directory.id,
            name,
            kind: record.directory ? "directory" : "file",
            recordOffset: directory.offset + sector + at,
            offset: record.offset,
            size: record.size,
            hidden: Boolean(record.flags & 1),
          });
          if (record.directory) {
            admit({
              id: entry.id,
              offset: entry.offset,
              size: entry.size,
              parentOffset: directory.offset,
              parentSize: directory.size,
              depth: directory.depth + 1,
            });
          }
          entries.push(entry);
        }
        ordinal++;
        at += length;
      }
    }
    if (ordinal < 2) invalid("ISO directory lacks self and parent records.");
  }
  const fileOf = (id: number): IsoEntryType => {
    integer(id, "ISO member id");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown ISO member id.");
    if (entry.kind !== "file") unsupported("ISO directory bytes are not ordinary member payloads.");
    return entry;
  };
  const read = async (id: number, supplied: IsoReadOptionsType = {}): Promise<IsoReadType> => {
    const extra = supplied.ledger;
    const active = options.signal && supplied.signal
      ? AbortSignal.any([options.signal, supplied.signal])
      : options.signal ?? supplied.signal;
    const ledger: ArchiveLedgerType = {
      reserve(kind, count) {
        lifetime.reserve(kind, count);
        if (extra && extra !== openingLedger) extra.reserve(kind, count);
      },
      inspect: () => lifetime.inspect(),
    };
    const opts = { ...supplied, ...(active === undefined ? {} : { signal: active }), ledger };
    const entry = fileOf(id);
    const offset = opts.offset ?? 0;
    const length = opts.length ?? entry.size - offset;
    integer(offset, "ISO member offset");
    integer(length, "ISO member length");
    if (offset > entry.size || length > entry.size - offset) throw new RangeError("ISO selected range exceeds member.");
    // Reserve the whole selected source/request workload before allocating output. The read loop charges
    // these dimensions locally but must not reserve the same aggregate admission a second time.
    const work = new ArchiveBudget(snapshot, {
      ...opts,
      ledger: {
        reserve(kind, count) {
          if (kind !== "sourceBytes" && kind !== "requests") ledger.reserve(kind, count);
        },
        inspect: () => ledger.inspect(),
      },
    }, opts.signal);
    if (length > work.limits.maxSourceBytes || Math.ceil(length / 65536) > work.limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "ISO selected range exceeds source work limits.");
    }
    opts.signal?.throwIfAborted();
    ledger.reserve("sourceBytes", length);
    ledger.reserve("requests", Math.ceil(length / 65536));
    work.output(length);
    work.decoded(length);
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at += 65536) {
      bytes.set(await work.read(entry.offset + offset + at, Math.min(65536, length - at)), at);
    }
    return { bytes, integrity: "none", work: work.inspect() };
  };
  return Object.freeze({
    namespace,
    volumeBytes,
    parents: Object.freeze({ policy: parentPolicy, mismatches: Object.freeze(mismatches) }),
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    read,
    member(id: number, supplied: IsoMemberOptionsType = {}): ByteSourceType {
      const entry = fileOf(id);
      const { signal, ...limits } = { ...supplied };
      const memberLedger = createArchiveLedger(limits);
      const extra = limits.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          memberLedger.reserve(kind, count);
          if (extra && extra !== openingLedger) extra.reserve(kind, count);
        },
        inspect: () => memberLedger.inspect(),
      };
      return Object.freeze({
        size: entry.size,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify(["opfs/iso", identity, entry.offset, entry.size]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const active = signal && opts.signal ? AbortSignal.any([signal, opts.signal]) : signal ?? opts.signal;
          return (await read(id, {
            ...limits,
            ledger,
            offset,
            length,
            ...(active === undefined ? {} : { signal: active }),
          })).bytes;
        },
      });
    },
  });
}
