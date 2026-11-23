import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One ustar entry. Names and links are metadata, never automatically host paths. */
export interface TarEntryType {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly kind: "file" | "directory" | "symbolic-link" | "hard-link";
  readonly link: string;
}

/** Header scanning is sequential; a random-access source can skip padded payload extents. */
export interface TarOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
  /** Explicitly accepts mutation risk for a source without declared snapshot stability. */
  readonly allowUnverifiedSource?: boolean;
}

export interface TarReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}

/** ustar has header checksums, not content checksums or authentication. */
export interface TarReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "header-checksum-only";
  readonly work: ArchiveWorkType;
}

/** The source remains borrowed; opening eagerly retains only bounded entry metadata. */
export interface TarArchiveType {
  readonly entries: readonly TarEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: TarReadOptionsType): Promise<TarReadType>;
}

/** Open uncompressed POSIX ustar, refusing dialect extensions instead of misreading them. */
export async function openTar(source: ByteSourceType, options: TarOpenOptionsType = {}): Promise<TarArchiveType> {
  if (!source.stability && !options.allowUnverifiedSource) {
    unsupported("TAR index reads require declared source stability or explicit unverified-source acceptance.");
  }
  const budget = new ArchiveBudget(source, options, options.signal);
  const maximum = options.maxEntries ?? 100_000;
  integer(maximum, "Entry limit");
  const entries: TarEntryType[] = [];
  const offsets: number[] = [];
  let offset = 0;
  let terminated = false;
  while (offset < source.size) {
    const header = await budget.read(offset, 512);
    if (header.every((byte) => byte === 0)) {
      const second = await budget.read(offset + 512, 512);
      if (second.some((byte) => byte !== 0)) invalid("TAR end marker requires two zero blocks.");
      terminated = true;
      break;
    }
    if (entries.length >= maximum) throw new ArchiveError("budget-exceeded", "TAR entry limit exceeded.");
    let checksum = 0;
    for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (octal(header.subarray(148, 156)) !== checksum) {
      throw new ArchiveError("checksum-mismatch", "TAR header checksum failed.");
    }
    if (text(header.subarray(257, 263)) !== "ustar" || text(header.subarray(263, 265)) !== "00") {
      unsupported("Only POSIX ustar headers are supported.");
    }
    const type = header[156];
    const kind = type === 0 || type === 48
      ? "file"
      : type === 53
      ? "directory"
      : type === 50
      ? "symbolic-link"
      : type === 49
      ? "hard-link"
      : undefined;
    if (!kind) unsupported("TAR PAX/GNU/sparse/special records require an explicit supported profile.");
    const size = octal(header.subarray(124, 136));
    if (kind !== "file" && size !== 0) unsupported("Non-file ustar payloads are unsupported.");
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const link = text(header.subarray(157, 257));
    const paddedSize = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(paddedSize) || paddedSize > source.size - offset - 512) {
      invalid("TAR member exceeds source extent.");
    }
    entries.push(Object.freeze({ id: entries.length, name: prefix ? `${prefix}/${name}` : name, size, kind, link }));
    offsets.push(offset + 512);
    offset += 512 + paddedSize;
  }
  if (!terminated) invalid("TAR end marker is missing.");
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      stability: source.stability ?? "unverified",
    }),
    async read(id: number, readOptions: TarReadOptionsType = {}): Promise<TarReadType> {
      integer(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("TAR entry ID does not exist.");
      if (entry.kind !== "file") {
        unsupported("Only regular ustar member payloads can be read; links are never followed.");
      }
      const start = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - start;
      integer(start, "Member offset");
      integer(length, "Member length");
      if (start > entry.size || length > entry.size - start) {
        throw new RangeError("Requested range exceeds TAR member.");
      }
      const readBudget = new ArchiveBudget(source, readOptions, readOptions.signal);
      readBudget.output(length);
      readBudget.decoded(length);
      const bytes = await readBudget.read(offsets[id]! + start, length);
      return { bytes, integrity: "header-checksum-only", work: readBudget.inspect() };
    },
  });
}

/** NUL-terminated metadata is decoded without normalizing or projecting path components. */
function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
  } catch {
    unsupported("Non-UTF-8 ustar names require a separately supported encoding profile.");
  }
}

/** Base-256 numeric extensions are not silently interpreted as POSIX octal. */
function octal(bytes: Uint8Array): number {
  if (bytes[0]! & 128) unsupported("Base-256 TAR numeric fields are unsupported.");
  const raw = text(bytes).trim();
  if (!/^[0-7]+$/.test(raw)) invalid("TAR numeric field is not octal.");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) unsupported("TAR size exceeds exact JavaScript integers.");
  return value;
}
