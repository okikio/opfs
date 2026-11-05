/** Bounded inspection of a single uncompressed SVR4 newc/CRC CPIO archive. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Raw archive identity is retained even when several names share one payload. */
export interface CpioEntryType {
  readonly id: number;
  readonly name: string;
  readonly format: "newc" | "crc";
  readonly kind: "file" | "directory" | "symbolic-link" | "device" | "fifo" | "socket";
  /** Logical size after resolving a regular-file hard-link group. */
  readonly size: number;
  /** Bytes physically attached to this header, before alignment padding. */
  readonly storedSize: number;
  /** Physical data owner for regular files; links never refer to host paths. */
  readonly dataEntryId?: number;
  readonly inode: number;
  readonly deviceMajor: number;
  readonly deviceMinor: number;
  readonly linkCount: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  /** Unix seconds, not JavaScript milliseconds. */
  readonly mtime: number;
  /** Unsigned additive byte sum for CRC; ignored for newc. This is not CRC32. */
  readonly checksum: number;
}

export interface CpioOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Maximum ordinary headers. Default 100,000. The required trailer is separate. */
  readonly maxEntries?: number;
  /** Maximum encoded name including terminal NUL bytes. Default 64 KiB. */
  readonly maxNameBytes?: number;
  /** Cumulative encoded names, including the trailer. Default 1 MiB. */
  readonly maxMetadataBytes?: number;
  /** Accept mutation risk explicitly when the source has no declared snapshot stability. */
  readonly allowUnverifiedSource?: boolean;
}

export interface CpioReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true: CRC verifies the complete data-owner payload, including for a prefix. */
  readonly verify?: boolean;
}

/** Integrity covers only the physical data owner's payload, never alias headers or authentication. */
export interface CpioReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "byte-sum-verified" | "pending" | "none";
  readonly dataEntryId: number;
  readonly work: ArchiveWorkType;
}

/** The source and its resources remain borrowed. Metadata is frozen after the complete bounded scan. */
export interface CpioArchiveType {
  readonly entries: readonly CpioEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: CpioReadOptionsType): Promise<CpioReadType>;
}

/** Check format padding as bytes; never silently turn unexpected content into padding. */
async function zeros(budget: ArchiveBudget, offset: number, length: number): Promise<void> {
  for (let at = 0; at < length;) {
    const count = Math.min(65536, length - at);
    const bytes = await budget.read(offset + at, count);
    budget.decoded(count);
    if (bytes.some((value) => value !== 0)) invalid("CPIO alignment or trailing padding contains nonzero bytes.");
    at += count;
  }
}

/** Fixed-width hexadecimal fields must not accept parseInt's valid-prefix behavior. */
function fields(header: Uint8Array): number[] {
  const values: number[] = [];
  for (let offset = 6; offset < 110; offset += 8) {
    let value = 0;
    for (const byte of header.subarray(offset, offset + 8)) {
      const digit = byte >= 48 && byte <= 57
        ? byte - 48
        : byte >= 65 && byte <= 70
        ? byte - 55
        : byte >= 97 && byte <= 102
        ? byte - 87
        : -1;
      if (digit < 0) invalid("CPIO numeric fields require eight hexadecimal digits.");
      value = value * 16 + digit;
    }
    values.push(value);
  }
  return values;
}

/** The mode's upper bits encode an object kind, not permission to create that object. */
function kindOf(mode: number): CpioEntryType["kind"] {
  switch (mode & 0xf000) {
    case 0x8000:
      return "file";
    case 0x4000:
      return "directory";
    case 0xa000:
      return "symbolic-link";
    case 0x2000:
    case 0x6000:
      return "device";
    case 0x1000:
      return "fifo";
    case 0xc000:
      return "socket";
    default:
      return unsupported("CPIO object mode is not supported.");
  }
}

/**
 * Index a single newc/CRC archive without reading ordinary member payloads.
 * A trailer is required, alignment and trailing bytes must be zero, and concatenated
 * archives are refused. This deliberately does not claim the broader initramfs grammar.
 */
export async function openCpio(source: ByteSourceType, options: CpioOpenOptionsType = {}): Promise<CpioArchiveType> {
  if (!source.stability && !options.allowUnverifiedSource) {
    unsupported("CPIO index reads require declared source stability or explicit unverified-source acceptance.");
  }
  const maxEntries = options.maxEntries ?? 100000;
  const maxNameBytes = options.maxNameBytes ?? 65536;
  const maxMetadataBytes = options.maxMetadataBytes ?? 1024 * 1024;
  for (const [name, value] of Object.entries({ maxEntries, maxNameBytes, maxMetadataBytes })) integer(value, name);
  // Capture metadata and bind the borrowed reader so later caller object edits cannot change the indexed extent.
  const snapshot: ByteSourceType = {
    size: source.size,
    ...(source.identity === undefined ? {} : { identity: source.identity }),
    ...(source.stability === undefined ? {} : { stability: source.stability }),
    read: source.read.bind(source),
  };
  const budget = new ArchiveBudget(snapshot, options, options.signal);
  const entries: CpioEntryType[] = [];
  const offsets: number[] = [];
  const groups = new Map<string, number[]>();
  let position = 0;
  let metadataBytes = 0;
  while (true) {
    const header = await budget.read(position, 110);
    budget.decoded(110);
    const magic = new TextDecoder().decode(header.subarray(0, 6));
    if (magic !== "070701" && magic !== "070702") unsupported("Only SVR4 newc and CRC CPIO are supported.");
    const data = fields(header);
    const [inode, mode, uid, gid, linkCount, mtime, storedSize, deviceMajor, deviceMinor] = data;
    const nameBytes = data[11]!;
    const checksum = data[12]!;
    if (nameBytes === 0) invalid("CPIO name must contain a terminating NUL.");
    if (nameBytes > maxNameBytes || nameBytes > maxMetadataBytes - metadataBytes) {
      throw new ArchiveError("budget-exceeded", "CPIO encoded name metadata limit exceeded.");
    }
    metadataBytes += nameBytes;
    position += 110;
    const encodedName = await budget.read(position, nameBytes);
    budget.decoded(nameBytes);
    let end = encodedName.length;
    while (end > 0 && encodedName[end - 1] === 0) end--;
    if (end === encodedName.length || end === 0 || encodedName.subarray(0, end).includes(0)) {
      invalid("CPIO names require nonempty text followed only by terminal NUL bytes.");
    }
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encodedName.subarray(0, end));
    } catch {
      return unsupported("CPIO names must be valid UTF-8 for this profile.");
    }
    position += nameBytes;
    const namePadding = (4 - position % 4) % 4;
    await zeros(budget, position, namePadding);
    position += namePadding;
    if (storedSize! > snapshot.size - position) invalid("CPIO data extent exceeds source.");
    if (name === "TRAILER!!!") {
      if (storedSize !== 0) invalid("CPIO trailer cannot carry data.");
      await zeros(budget, position, snapshot.size - position);
      break;
    }
    if (entries.length >= maxEntries) throw new ArchiveError("budget-exceeded", "CPIO entry limit exceeded.");
    if (linkCount === 0) invalid("CPIO ordinary entries require a positive link count.");
    const kind = kindOf(mode!);
    if (kind !== "file" && kind !== "symbolic-link" && storedSize !== 0) {
      invalid("CPIO non-file object carries unsupported data.");
    }
    const id = entries.length;
    entries.push({
      id,
      name,
      format: magic === "070701" ? "newc" : "crc",
      kind,
      size: storedSize!,
      storedSize: storedSize!,
      ...(kind === "file" ? { dataEntryId: id } : {}),
      inode: inode!,
      mode: mode!,
      uid: uid!,
      gid: gid!,
      linkCount: linkCount!,
      mtime: mtime!,
      deviceMajor: deviceMajor!,
      deviceMinor: deviceMinor!,
      checksum,
    });
    offsets.push(position);
    if (kind === "file") {
      const key = `${deviceMajor}:${deviceMinor}:${inode}`;
      const group = groups.get(key);
      if (group) group.push(id);
      else groups.set(key, [id]);
    }
    position += storedSize!;
    const bodyPadding = (4 - storedSize! % 4) % 4;
    await zeros(budget, position, bodyPadding);
    position += bodyPadding;
  }
  // GNU can place data at the last link; resolution must happen after scanning every header.
  for (const group of groups.values()) {
    const first = entries[group[0]!]!;
    if (!group.some((id) => entries[id]!.linkCount > 1)) continue;
    if (group.length > first.linkCount) unsupported("CPIO hard-link group exceeds its declared link count.");
    if (
      group.some((id) => {
        const entry = entries[id]!;
        return entry.linkCount !== first.linkCount || entry.linkCount < 2 || entry.mode !== first.mode ||
          entry.uid !== first.uid || entry.gid !== first.gid || entry.mtime !== first.mtime;
      })
    ) unsupported("CPIO hard-link group metadata disagrees.");
    const owners = group.filter((id) => entries[id]!.storedSize > 0);
    if (owners.length > 1) unsupported("CPIO hard-link group has multiple data-bearing records.");
    const owner = owners[0] ?? first.id;
    for (const id of group) entries[id] = { ...entries[id]!, size: entries[owner]!.storedSize, dataEntryId: owner };
  }
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({
      ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
      stability: snapshot.stability ?? "unverified",
    }),
    async read(id: number, readOptions: CpioReadOptionsType = {}): Promise<CpioReadType> {
      integer(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("CPIO entry ID does not exist.");
      if (entry.kind !== "file") {
        unsupported("Only regular CPIO file payloads can be read; links and devices are never followed.");
      }
      const owner = entries[entry.dataEntryId!]!;
      const offset = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - offset;
      integer(offset, "Member offset");
      integer(length, "Member length");
      if (offset > entry.size || length > entry.size - offset) {
        throw new RangeError("CPIO member range exceeds file size.");
      }
      const readBudget = new ArchiveBudget(snapshot, readOptions, readOptions.signal);
      const verify = owner.format === "crc" && (readOptions.verify ?? true);
      const workLength = verify ? owner.storedSize : length;
      // The full physical extent is known, so reject impossible local work before allocating the returned range.
      if (
        workLength > readBudget.limits.maxSourceBytes || Math.ceil(workLength / 65536) > readBudget.limits.maxRequests
      ) {
        throw new ArchiveError("budget-exceeded", "CPIO member verification/read exceeds source work limits.");
      }
      readBudget.output(length);
      readBudget.decoded(workLength);
      readOptions.signal?.throwIfAborted();
      const bytes = new Uint8Array(length);
      let sum = 0;
      const start = verify ? 0 : offset;
      const end = verify ? owner.storedSize : offset + length;
      for (let at = start; at < end;) {
        const count = Math.min(65536, end - at);
        const chunk = await readBudget.read(offsets[owner.id]! + at, count);
        if (verify) { for (const byte of chunk) sum = (sum + byte) >>> 0; }
        const from = Math.max(at, offset);
        const until = Math.min(at + count, offset + length);
        if (until > from) bytes.set(chunk.subarray(from - at, until - at), from - offset);
        at += count;
      }
      if (verify && sum !== owner.checksum) {
        throw new ArchiveError("checksum-mismatch", "CPIO data-owner byte sum mismatch.");
      }
      return {
        bytes,
        dataEntryId: owner.id,
        integrity: owner.format === "newc" ? "none" : verify ? "byte-sum-verified" : "pending",
        work: readBudget.inspect(),
      };
    },
  });
}
