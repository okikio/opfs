/** Bounded standalone QCOW2 guest-byte views. No guest filesystem is mounted. @module */
import { ArchiveBudget, assertInteger, createArchiveLedger, toSafeInteger } from "../archive/budget.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, invalid, unsupported } from "../archive/error.ts";
import { createView } from "../archive/field.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/budget.ts";
export { ArchiveError } from "../archive/error.ts";
export { createArchiveLedger } from "../archive/budget.ts";
export type { ArchiveErrorCodeType } from "../archive/error.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/budget.ts";

/** Opening limits remain aggregate authority for every later read and nested source. */
export interface Qcow2OpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 1 TiB of logical guest bytes. This does not authorize a guest-sized allocation. */
  readonly maxGuestBytes?: number;
  /** Default: 8 MiB of serialized metadata inspected, including repeated header bytes. */
  readonly maxMetadataBytes?: number;
  /** Default: 1,048,576 serialized table entries admitted, including unused entries. L2 validation uses two passes. */
  readonly maxTableEntries?: number;
  /** Default: 1,024 distinct L2 table clusters. The metadata byte cap also applies. */
  readonly maxL2Tables?: number;
  /** Default: 65,536 distinct refcount-block extents. Their counter values are not inspected. */
  readonly maxRefcountBlocks?: number;
  /** Default: 4,096 guest cluster segments per selection, before output allocation. */
  readonly maxSegments?: number;
  /** Default: false. An identifier alone does not prove stable replay. */
  readonly allowUnverifiedSource?: boolean;
}
/** Exact guest selection; opening limits and cancellation cannot be replaced. */
export interface Qcow2ReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}
/** Additional aggregate lifetime limits for a borrowed exact-range guest source. */
export interface Qcow2SourceOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** One selected cluster intersection. A zero region never causes payload I/O. */
export interface Qcow2SegmentType {
  readonly offset: number;
  readonly length: number;
  readonly kind: "allocated" | "hole" | "zero";
  /** Present for allocated bytes and preallocated explicit-zero bytes. */
  readonly sourceOffset?: number;
  /** A wire hint only. The actual reference count is not checked. */
  readonly copied: boolean;
}
/** Owned guest bytes; QCOW2 mapping metadata provides no payload authentication. */
export interface Qcow2ReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
/** An active mapping index. Refcount values and guest filesystems remain outside this profile. */
export interface Qcow2ImageType {
  readonly version: 2 | 3;
  readonly size: number;
  readonly clusterSize: number;
  readonly headerLength: number;
  readonly l2Tables: number;
  readonly refcountBlocks: number;
  readonly validation: "active-mapping-bounds";
  readonly refcountValidation: "not-checked";
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
  /** Pure, bounded selected-cluster inspection; no source reads or reference-count truth claim. */
  map(offset: number, length: number): readonly Qcow2SegmentType[];
  /**
   * Reads guest bytes from the virtual disk.
   * @param options Range, limits and cancellation.
   */
  read(options?: Qcow2ReadOptionsType): Promise<Qcow2ReadType>;
  /** No resource ownership transfers. Partial guest reads retain all opening authority. */
  source(options?: Qcow2SourceOptionsType): ByteSourceType;
}

function combined(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}

interface ExtentType {
  readonly start: number;
  readonly end: number;
  readonly role: string;
}

/** Read a stable physical image. No backing paths, codecs, repair, mounts, or source disposal occur. */
export async function openQcow2(input: ByteSourceType, supplied: Qcow2OpenOptionsType = {}): Promise<Qcow2ImageType> {
  const options = { ...supplied };
  const { size: physicalSize, stability, identity } = input;
  assertInteger(physicalSize, "QCOW2 physical size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown QCOW2 source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("QCOW2 source identity must be a bounded string.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    throw unsupported("QCOW2 requires stable replay evidence.");
  }
  const sourceRead = input.read.bind(input);
  const source: ByteSourceType = Object.freeze({
    size: physicalSize,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read(offset: number, length: number, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
      opts.signal?.throwIfAborted();
      return sourceRead(offset, length, opts);
    },
  });
  const maximum = {
    guest: options.maxGuestBytes ?? 1024 ** 4,
    metadata: options.maxMetadataBytes ?? 8 * 1024 * 1024,
    entries: options.maxTableEntries ?? 1048576,
    l2: options.maxL2Tables ?? 1024,
    refcounts: options.maxRefcountBlocks ?? 65536,
    segments: options.maxSegments ?? 4096,
  };
  for (const [key, count] of Object.entries(maximum)) assertInteger(count, `QCOW2 maximum ${key}`);
  const owners = new WeakMap<ArchiveLedgerType, ArchiveLedgerType>();
  const capture = (owner: ArchiveLedgerType | undefined): ArchiveLedgerType | undefined => {
    if (!owner) return undefined;
    let saved = owners.get(owner);
    if (!saved) {
      saved = { reserve: owner.reserve.bind(owner), inspect: owner.inspect.bind(owner) };
      owners.set(owner, saved);
    }
    return saved;
  };
  const local = createArchiveLedger(options), opening = capture(options.ledger);
  const together = (values: readonly (ArchiveLedgerType | undefined)[], signal?: AbortSignal): ArchiveLedgerType => {
    const unique = [...new Set(values.filter((value): value is ArchiveLedgerType => value !== undefined))];
    return {
      reserve(kind, count) {
        for (const owner of unique) {
          owner.reserve(kind, count);
          signal?.throwIfAborted();
        }
        signal?.throwIfAborted();
      },
      inspect: () => local.inspect(),
    };
  };
  const budget = new ArchiveBudget(source, {
    ...options,
    ledger: together([local, opening], options.signal),
  }, options.signal);
  let metadata = 0, tableEntries = 0;
  /** Metadata is copied before any following source read can reuse borrowed scratch. */
  const header = async (offset: number, length: number): Promise<Uint8Array> => {
    if (length > maximum.metadata - metadata) {
      throw new ArchiveError("budget-exceeded", "QCOW2 metadata limit exceeded.");
    }
    budget.decoded(length);
    const bytes = await budget.read(offset, length);
    options.signal?.throwIfAborted();
    metadata += length;
    return bytes.slice();
  };
  const entries = (count: number): void => {
    if (count > maximum.entries - tableEntries) {
      throw new ArchiveError("budget-exceeded", "QCOW2 table entry limit exceeded.");
    }
    tableEntries += count;
  };
  const prefix = createView(await header(0, 72));
  if (prefix.getUint32(0) !== 0x514649fb) throw invalid("QCOW2 magic mismatch.");
  const version = prefix.getUint32(4);
  if (version !== 2 && version !== 3) throw unsupported("QCOW2 supports only versions 2 and 3.");
  if (prefix.getBigUint64(8) !== 0n || prefix.getUint32(16) !== 0) {
    throw unsupported("QCOW2 backing files are unsupported.");
  }
  const clusterBits = prefix.getUint32(20);
  if (clusterBits < 9 || clusterBits > 21) {
    throw unsupported("QCOW2 cluster size is outside the 512-byte to 2-MiB profile.");
  }
  const clusterSize = 2 ** clusterBits, cluster = BigInt(clusterSize);
  const size = toSafeInteger(prefix.getBigUint64(24), `QCOW2 ${"guest size"}`);
  if (size > maximum.guest) throw new ArchiveError("budget-exceeded", "QCOW2 guest size limit exceeded.");
  if (prefix.getUint32(32) !== 0) throw unsupported("QCOW2 encryption is unsupported.");
  const l1Size = prefix.getUint32(36), l1Offset = toSafeInteger(prefix.getBigUint64(40), `QCOW2 ${"L1 offset"}`);
  const refcountOffset = toSafeInteger(prefix.getBigUint64(48), `QCOW2 ${"refcount offset"}`),
    refcountClusters = prefix.getUint32(56);
  if (prefix.getUint32(60) !== 0 || prefix.getBigUint64(64) !== 0n) {
    throw unsupported("QCOW2 internal snapshots are unsupported.");
  }
  const first = createView(await header(0, clusterSize));
  for (let at = 0; at < 72; at++) {
    if (first.getUint8(at) !== prefix.getUint8(at)) throw invalid("QCOW2 header changed while opening.");
  }
  let headerLength = 72;
  if (version === 3) {
    for (const offset of [72, 80, 88]) {
      if (first.getBigUint64(offset) !== 0n) {
        throw unsupported("QCOW2 feature masks are outside the standalone profile.");
      }
    }
    if (first.getUint32(96) !== 4) throw unsupported("QCOW2 requires 16-bit refcount entries in this profile.");
    headerLength = first.getUint32(100);
    if (headerLength !== 104 && headerLength !== 112) {
      throw unsupported("QCOW2 header length is outside the known profile.");
    }
    if (headerLength === 112) {
      for (let at = 104; at < 112; at++) {
        if (first.getUint8(at) !== 0) throw unsupported("QCOW2 additional fields are unsupported.");
      }
    }
  }
  // Extension padding has no universal zero-byte requirement. Its extent, not
  // an invented padding value, is validated. Unknown extensions are a profile refusal.
  let extension = headerLength, terminated = false;
  const extensionTypes = new Set<number>();
  while (extension <= clusterSize - 8) {
    const type = first.getUint32(extension), length = first.getUint32(extension + 4);
    extension += 8;
    if (type === 0) {
      if (length !== 0) throw invalid("QCOW2 extension terminator has data.");
      terminated = true;
      break;
    }
    if (extensionTypes.has(type)) throw invalid("QCOW2 duplicate header extension.");
    extensionTypes.add(type);
    const padded = toSafeInteger((BigInt(length) + 7n) / 8n * 8n, `QCOW2 ${"extension size"}`);
    if (padded > clusterSize - extension) throw invalid("QCOW2 extension exceeds the first cluster.");
    if (type !== 0x6803f857) throw unsupported("QCOW2 header extension is outside the known profile.");
    if (length % 48 !== 0) throw invalid("QCOW2 feature-name table has incomplete records.");
    for (let at = extension; at < extension + length; at += 48) {
      if (first.getUint8(at) > 2 || first.getUint8(at + 1) > 63) throw invalid("QCOW2 invalid feature-name record.");
    }
    extension += padded;
  }
  if (!terminated) throw invalid("QCOW2 header extensions lack a terminator.");
  /** Protect an allocation role while requiring only its actual serialized bytes.
   * L1 alone may protect padding beyond physical EOF; other roles require the full extent.
   */
  const extent = (offset: number, length: number, role: string, storedLength = length): ExtentType => {
    if (offset % clusterSize !== 0) throw invalid(`QCOW2 ${role} is not cluster aligned.`);
    if (offset > physicalSize || storedLength > physicalSize - offset) {
      throw invalid(`QCOW2 ${role} exceeds the physical source.`);
    }
    return {
      start: offset,
      end: toSafeInteger(BigInt(offset) + BigInt(length), `QCOW2 ${"protected extent end"}`),
      role,
    };
  };
  const rounded = (length: bigint): number =>
    toSafeInteger((length + cluster - 1n) / cluster * cluster, `QCOW2 ${"rounded extent"}`);
  const roles: ExtentType[] = [extent(0, clusterSize, "header")];
  const l1Bytes = toSafeInteger(BigInt(l1Size) * 8n, `QCOW2 ${"L1 length"}`);
  if ((BigInt(size) + cluster - 1n) / cluster > BigInt(l1Size) * (cluster / 8n)) {
    throw invalid("QCOW2 L1 table does not cover the guest size.");
  }
  if (l1Bytes === 0 && l1Offset !== 0) throw invalid("QCOW2 empty L1 table has an offset.");
  // Only serialized L1 entries must exist physically. A valid all-hole image
  // can end after its last entry. Protect the rounded allocation role without
  // inventing stored padding or reading beyond physical EOF.
  if (l1Bytes) roles.push(extent(l1Offset, rounded(BigInt(l1Bytes)), "L1", l1Bytes));
  entries(l1Size);
  const l1 = createView(await header(l1Offset, l1Bytes));
  const refcountBytes = toSafeInteger(BigInt(refcountClusters) * cluster, `QCOW2 ${"refcount table length"}`);
  if (!refcountBytes && refcountOffset !== 0) throw invalid("QCOW2 empty refcount table has an offset.");
  if (refcountBytes) roles.push(extent(refcountOffset, refcountBytes, "refcount table"));
  entries(refcountBytes / 8);
  const refcounts = createView(await header(refcountOffset, refcountBytes));
  const refcountBlocks = new Set<number>();
  for (let at = 0; at < refcountBytes; at += 8) {
    const value = refcounts.getBigUint64(at);
    if ((value & 511n) !== 0n) throw invalid("QCOW2 refcount table has reserved bits.");
    if (value === 0n) continue;
    const offset = toSafeInteger(value, `QCOW2 ${"refcount block offset"}`);
    if (refcountBlocks.has(offset)) throw invalid("QCOW2 aliased refcount-block roles are unsupported.");
    if (refcountBlocks.size >= maximum.refcounts) {
      throw new ArchiveError("budget-exceeded", "QCOW2 refcount-block limit exceeded.");
    }
    refcountBlocks.add(offset);
    roles.push(extent(offset, clusterSize, "refcount block"));
  }
  const tables = new Map<number, DataView>();
  const offsetMask = 0x00fffffffffffe00n, copiedMask = 1n << 63n;
  for (let index = 0; index < l1Size; index++) {
    const value = l1.getBigUint64(index * 8);
    if ((value & ~(offsetMask | copiedMask)) !== 0n) throw invalid("QCOW2 L1 entry has reserved bits.");
    const offset = toSafeInteger(value & offsetMask, `QCOW2 ${"L2 offset"}`);
    if (offset === 0) {
      if (value !== 0n) throw invalid("QCOW2 absent L2 table has a copied hint.");
      continue;
    }
    if (tables.has(offset)) continue;
    if (tables.size >= maximum.l2) throw new ArchiveError("budget-exceeded", "QCOW2 L2-table limit exceeded.");
    roles.push(extent(offset, clusterSize, "L2"));
    entries(clusterSize / 8);
    const table = createView(await header(offset, clusterSize));
    for (let at = 0; at < clusterSize; at += 8) {
      const descriptor = table.getBigUint64(at);
      if ((descriptor & (1n << 62n)) !== 0n) throw unsupported("QCOW2 compressed clusters are unsupported.");
      if ((descriptor & ~(offsetMask | copiedMask | 1n)) !== 0n) throw invalid("QCOW2 L2 entry has reserved bits.");
      if (version === 2 && (descriptor & 1n) !== 0n) throw invalid("QCOW2 version 2 has an explicit-zero bit.");
      const dataOffset = toSafeInteger(descriptor & offsetMask, `QCOW2 ${"data offset"}`);
      if (!dataOffset && (descriptor & copiedMask) !== 0n) {
        throw invalid("QCOW2 host offset zero with copied hint requires external data.");
      }
      if (dataOffset) extent(dataOffset, clusterSize, "data cluster");
    }
    tables.set(offset, table);
  }
  // Sort once; lookup of a payload cluster uses binary search rather than an
  // unbounded table-by-table metadata overlap scan. Shared L2 references are deduplicated.
  roles.sort((a, b) => a.start - b.start);
  for (let index = 1; index < roles.length; index++) {
    if (roles[index]!.start < roles[index - 1]!.end) throw invalid("QCOW2 conflicting metadata roles overlap.");
  }
  const dataExtent = (offset: number): void => {
    let low = 0, high = roles.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (roles[middle]!.end <= offset) low = middle + 1;
      else high = middle;
    }
    if (low < roles.length && roles[low]!.start < offset + clusterSize) {
      throw invalid("QCOW2 payload overlaps metadata.");
    }
  };
  for (const table of tables.values()) {
    for (let at = 0; at < clusterSize; at += 8) {
      const offset = toSafeInteger(table.getBigUint64(at) & offsetMask, `QCOW2 ${"data offset"}`);
      if (offset) dataExtent(offset);
    }
  }
  const map = (offset: number, length: number): readonly Qcow2SegmentType[] => {
    options.signal?.throwIfAborted();
    assertInteger(offset, "QCOW2 guest offset");
    assertInteger(length, "QCOW2 guest length");
    if (offset > size || length > size - offset) throw new RangeError("QCOW2 selection exceeds guest bytes.");
    const count = length ? Math.ceil(((offset % clusterSize) + length) / clusterSize) : 0;
    if (count > maximum.segments) throw new ArchiveError("budget-exceeded", "QCOW2 selected segment limit exceeded.");
    const segments: Qcow2SegmentType[] = [];
    const perL2 = clusterSize / 8;
    for (let at = offset; at < offset + length;) {
      const guestCluster = Math.floor(at / clusterSize), inCluster = at % clusterSize;
      const l2Offset = toSafeInteger(
        l1.getBigUint64(Math.floor(guestCluster / perL2) * 8) & offsetMask,
        `QCOW2 ${"L2 offset"}`,
      );
      const descriptor = l2Offset ? tables.get(l2Offset)!.getBigUint64((guestCluster % perL2) * 8) : 0n;
      const host = toSafeInteger(descriptor & offsetMask, `QCOW2 ${"data offset"}`);
      const amount = Math.min(clusterSize - inCluster, offset + length - at);
      segments.push(Object.freeze({
        offset: at,
        length: amount,
        kind: (descriptor & 1n) !== 0n ? "zero" : host ? "allocated" : "hole",
        copied: (descriptor & copiedMask) !== 0n,
        ...(host ? { sourceOffset: host + inCluster } : {}),
      }));
      at += amount;
    }
    options.signal?.throwIfAborted();
    return Object.freeze(segments);
  };
  const read = async (suppliedRead: Qcow2ReadOptionsType = {}): Promise<Qcow2ReadType> => {
    const opts = { ...suppliedRead }, extraOwner = capture(opts.ledger);
    const signal = combined(options.signal, opts.signal);
    signal?.throwIfAborted();
    const offset = opts.offset ?? 0, length = opts.length ?? size - offset;
    const segments = map(offset, length);
    let sourceBytes = 0, requests = 0;
    for (const segment of segments) {
      if (segment.kind === "allocated") {
        sourceBytes += segment.length;
        requests += Math.ceil(segment.length / 65536);
      }
    }
    const target = together([local, opening, extraOwner], signal);
    let sourceCredit = sourceBytes, requestCredit = requests;
    const ledger: ArchiveLedgerType = {
      reserve(kind, count) {
        if (kind === "sourceBytes" && count <= sourceCredit) sourceCredit -= count;
        else if (kind === "requests" && count <= requestCredit) requestCredit -= count;
        else target.reserve(kind, count);
        signal?.throwIfAborted();
      },
      inspect: () => target.inspect(),
    };
    const work = new ArchiveBudget(source, { ...opts, ledger }, signal);
    if (sourceBytes > work.limits.maxSourceBytes || requests > work.limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "QCOW2 selected physical work exceeds policy.");
    }
    work.decoded(length);
    work.output(length);
    target.reserve("sourceBytes", sourceBytes);
    target.reserve("requests", requests);
    signal?.throwIfAborted();
    const bytes = new Uint8Array(length);
    for (const segment of segments) {
      if (segment.kind === "allocated") {
        for (let at = 0; at < segment.length;) {
          const amount = Math.min(65536, segment.length - at);
          bytes.set(await work.read(segment.sourceOffset! + at, amount), segment.offset - offset + at);
          at += amount;
        }
      }
    }
    signal?.throwIfAborted();
    return { bytes, integrity: "none", work: work.inspect() };
  };
  options.signal?.throwIfAborted();
  return Object.freeze({
    version,
    size,
    clusterSize,
    headerLength,
    l2Tables: tables.size,
    refcountBlocks: refcountBlocks.size,
    validation: "active-mapping-bounds",
    refcountValidation: "not-checked",
    integrity: "none",
    work: budget.inspect(),
    map,
    read,
    source(suppliedSource: Qcow2SourceOptionsType = {}): ByteSourceType {
      const opts = { ...suppliedSource }, extraOwner = capture(opts.ledger);
      const signal = combined(options.signal, opts.signal);
      signal?.throwIfAborted();
      const ledger = together([createArchiveLedger(opts), extraOwner === opening ? undefined : extraOwner], signal);
      const derived = identity === undefined
        ? undefined
        : JSON.stringify(["opfs/qcow2", identity, version, size, clusterSize]);
      return Object.freeze({
        size,
        ...(derived === undefined || derived.length > 8192 ? {} : { identity: derived }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, extra: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const active = combined(signal, extra.signal);
          return (await read({ ...opts, ledger, offset, length, ...(active === undefined ? {} : { signal: active }) }))
            .bytes;
        },
      });
    },
  });
}
