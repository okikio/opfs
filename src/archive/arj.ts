/** Bounded single-volume ARJ headers and STORED member previews. @module */
import type { ByteSourceType } from "../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  crc32,
  createArchiveLedger,
  integer,
  invalid,
  unsupported,
  view,
} from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One physical file record. Names and comments are inert metadata, never host paths. */
export interface ArjEntryType {
  readonly id: number;
  readonly name: string;
  readonly comment: string;
  /** Each access returns an independent owned copy of the original encoded field. */
  readonly rawName: Uint8Array;
  readonly rawComment: Uint8Array;
  readonly kind: "file" | "directory";
  readonly method: number;
  readonly readable: boolean;
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly offset: number;
  readonly size: number;
  readonly storedSize: number;
  readonly crc32: number;
  readonly headerIntegrity: "crc32-verified";
  readonly host: number;
  readonly version: number;
  readonly minimumVersion: number;
  /** Raw host-specific mode and timestamp integers; no UTC or POSIX interpretation is implied. */
  readonly mode: number;
  readonly modified: number;
  readonly accessed?: number;
  readonly created?: number;
  /** File flag byte retained with its file-header meaning, not the main-header meaning. */
  readonly flags: number;
}
/** Captured opening authority persists across later reads and nested member sources. */
export interface ArjOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 100,000 physical member records, including directories. */
  readonly maxEntries?: number;
  /** Default: 8 MiB of total serialized headers inspected while opening. */
  readonly maxHeaderBytes?: number;
  /** Default: 65,535 bytes for one basic header body, excluding framing and CRC. */
  readonly maxEntryHeaderBytes?: number;
  /** Default: 4,096 raw bytes and decoded UTF-8 bytes per name or comment. */
  readonly maxNameBytes?: number;
  /** Default is strict ASCII. A different interpretation receives an owned copy. */
  readonly decodeName?: (bytes: Uint8Array, role: "name" | "comment") => string;
  /** Default: false. Source identity does not establish replay stability. */
  readonly allowUnverifiedSource?: boolean;
}
/** Verification scans all bytes of the selected member, including an unselected suffix. */
export interface ArjReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default: true. A complete selection always verifies CRC32, even if false. */
  readonly verify?: boolean;
}
/** Member CRC32 covers payload bytes, not names, freshness, or publisher identity. */
export interface ArjReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "crc32-verified" | "pending";
  readonly work: ArchiveWorkType;
}
/** Additional lifetime limits and cancellation for a nested exact-range member source. */
export interface ArjMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** The archive borrows its original source; it acquires no closeable resources. */
export interface ArjArchiveType {
  /** Decoded main-header name and comment. They are inert metadata. */
  readonly name: string;
  readonly comment: string;
  readonly entries: readonly ArjEntryType[];
  readonly work: ArchiveWorkType;
  read(id: number, options?: ArjReadOptionsType): Promise<ArjReadType>;
  /** Partial nested reads carry no whole-member CRC claim. Opening authority is retained. */
  member(id: number, options?: ArjMemberOptionsType): ByteSourceType;
}

function combined(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}

/** Open a physical archive at offset zero. No SFX search, repair, extraction, or source disposal occurs. */
export async function openArj(input: ByteSourceType, supplied: ArjOpenOptionsType = {}): Promise<ArjArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "ARJ source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown ARJ source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("ARJ source identity must be a bounded string.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) unsupported("ARJ requires stable source evidence.");
  const sourceRead = input.read.bind(input);
  const source: ByteSourceType = Object.freeze({
    size,
    read(offset: number, length: number, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
      // A foreign ledger may abort synchronously after ArchiveBudget's first check.
      opts.signal?.throwIfAborted();
      return sourceRead(offset, length, opts);
    },
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  });
  const maximum = {
    entries: options.maxEntries ?? 100000,
    headers: options.maxHeaderBytes ?? 8 * 1024 * 1024,
    one: options.maxEntryHeaderBytes ?? 65535,
    name: options.maxNameBytes ?? 4096,
  };
  for (const [key, value] of Object.entries(maximum)) integer(value, `ARJ maximum ${key}`);
  // Bind foreign methods once while retaining their original object identity for
  // deduplication. Later mutation cannot replace admitted accounting authority.
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
  const local = createArchiveLedger(options);
  const opening = capture(options.ledger);
  const together = (values: readonly (ArchiveLedgerType | undefined)[], signal?: AbortSignal): ArchiveLedgerType => {
    const unique = [...new Set(values.filter((value): value is ArchiveLedgerType => value !== undefined))];
    return {
      reserve(kind, count) {
        for (const owner of unique) owner.reserve(kind, count);
        signal?.throwIfAborted();
      },
      inspect: () => local.inspect(),
    };
  };
  const budget = new ArchiveBudget(
    source,
    { ...options, ledger: together([local, opening], options.signal) },
    options.signal,
  );
  let at = 0;
  let inspected = 0;
  const entries: ArjEntryType[] = [];
  const text = (bytes: Uint8Array, role: "name" | "comment"): string => {
    if (bytes.length > maximum.name) throw new ArchiveError("budget-exceeded", "ARJ encoded field exceeds policy.");
    let value: string;
    if (options.decodeName) value = options.decodeName(bytes.slice(), role);
    else {
      if (bytes.some((byte) => byte > 127)) unsupported("ARJ non-ASCII metadata requires an explicit decoder.");
      value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new TypeError("ARJ decoder must return a NUL-free string.");
    }
    if (value.length > maximum.name || new TextEncoder().encode(value).length > maximum.name) {
      throw new ArchiveError("budget-exceeded", "ARJ decoded field exceeds policy.");
    }
    options.signal?.throwIfAborted();
    return value;
  };
  /** Charge metadata before copying any borrowed source scratch into the index parser. */
  const header = async (offset: number, length: number): Promise<Uint8Array> => {
    if (length > maximum.headers - inspected) {
      throw new ArchiveError("budget-exceeded", "ARJ header allowance exceeded.");
    }
    budget.decoded(length);
    const value = await budget.read(offset, length);
    options.signal?.throwIfAborted();
    const owned = value.slice();
    inspected += length;
    return owned;
  };
  let main = true;
  let archiveName: string | undefined, archiveComment: string | undefined;
  let ended = false;
  while (at < size) {
    options.signal?.throwIfAborted();
    const start = at;
    const prefix = await header(at, 4);
    if (view(prefix).getUint16(0, true) !== 0xea60) invalid("ARJ header signature mismatch.");
    const length = view(prefix).getUint16(2, true);
    at += 4;
    if (length === 0) {
      if (main) invalid("ARJ archive lacks a main header.");
      if (at !== size) unsupported("ARJ trailing data is outside the single-volume profile.");
      ended = true;
      break;
    }
    if (!main && entries.length >= maximum.entries) {
      throw new ArchiveError("budget-exceeded", "ARJ member count exceeded.");
    }
    if (length > maximum.one) throw new ArchiveError("budget-exceeded", "ARJ basic header exceeds policy.");
    if (length < 32) invalid("ARJ basic header cannot hold fixed fields and two terminators.");
    const body = await header(at, length);
    const expected = view(await header(at + length, 4)).getUint32(0, true);
    if (((crc32(body) ^ 0xffffffff) >>> 0) !== expected) {
      throw new ArchiveError("checksum-mismatch", "ARJ basic header CRC32 mismatch.");
    }
    const fields = view(body);
    const fixed = body[0]!;
    if (main ? fixed !== 30 && fixed !== 34 : fixed !== 30 && fixed !== 46) {
      unsupported("Unknown ARJ fixed header layout.");
    }
    if (fixed > length - 2) invalid("ARJ fixed header exceeds its basic body.");
    const flags = body[4]!, method = body[5]!, type = body[6]!;
    if (body[2]! > 11) unsupported("ARJ minimum decoder revision is newer than the implemented profile.");
    if (main) {
      if (type !== 2) invalid("ARJ first record is not a main header.");
      if (
        method !== 0 || flags & ~0x10 || body[28] !== 0 || body[29] !== 0 || fields.getUint32(20, true) !== 0 ||
        fields.getUint16(26, true) !== 0
      ) {
        unsupported("ARJ encrypted, secure, volume, recovery, chapter, or dual-name main headers are unsupported.");
      }
      if (fixed === 34 && (fields.getUint32(30, true) !== 0)) {
        unsupported("ARJ recovery or stub main fields are unsupported.");
      }
    } else {
      if (flags & ~0x12 || body[28] !== 0 || body[29] !== 0) {
        unsupported("ARJ encrypted, continued, chapter, backup, or dual-name members are unsupported.");
      }
      if (type !== 0 && type !== 1 && type !== 3) {
        unsupported("ARJ labels, chapters and special entries are unsupported.");
      }
      if (method > 4) unsupported("Unknown ARJ compression method envelope.");
      if (fixed === 46 && (fields.getUint32(30, true) !== 0 || fields.getUint32(42, true) !== 0)) {
        unsupported("ARJ resumed members or unknown revision-9 fields are unsupported.");
      }
    }
    const nameEnd = body.indexOf(0, fixed);
    const commentEnd = nameEnd < 0 ? -1 : body.indexOf(0, nameEnd + 1);
    if (nameEnd < 0 || commentEnd !== length - 1) {
      invalid("ARJ name/comment termination or basic header tail is invalid.");
    }
    if (nameEnd - fixed > maximum.name || commentEnd - nameEnd - 1 > maximum.name) {
      throw new ArchiveError("budget-exceeded", "ARJ encoded field exceeds policy.");
    }
    const rawName = body.slice(fixed, nameEnd), rawComment = body.slice(nameEnd + 1, commentEnd);
    // The entire basic header is owned before either foreign decoder can reenter.
    const name = text(rawName, "name"), comment = text(rawComment, "comment");
    if (main) {
      archiveName = name;
      archiveComment = comment;
    }
    at += length + 4;
    const extension = view(await header(at, 2)).getUint16(0, true);
    at += 2;
    if (extension !== 0) unsupported("ARJ nonzero structural extensions require a separately implemented grammar.");
    if (!main) {
      const storedSize = fields.getUint32(12, true), original = fields.getUint32(16, true);
      if (storedSize > size - at) invalid("ARJ member extent exceeds the source.");
      if (method === 0 && storedSize !== original) invalid("ARJ STORED sizes differ.");
      if (type === 3 && (storedSize !== 0 || original !== 0 || method !== 0)) {
        invalid("ARJ directory contains payload or compression.");
      }
      if (name.length === 0) invalid("ARJ member name is empty.");
      entries.push(Object.freeze({
        id: entries.length,
        name,
        comment,
        get rawName() {
          return rawName.slice();
        },
        get rawComment() {
          return rawComment.slice();
        },
        kind: type === 3 ? "directory" : "file",
        method,
        readable: method === 0 && type !== 3,
        headerOffset: start,
        headerSize: at - start,
        offset: at,
        size: original,
        storedSize,
        crc32: fields.getUint32(20, true),
        headerIntegrity: "crc32-verified",
        host: body[3]!,
        version: body[1]!,
        minimumVersion: body[2]!,
        mode: fields.getUint16(26, true),
        modified: fields.getUint32(8, true),
        flags,
        ...(fixed === 46 ? { accessed: fields.getUint32(34, true), created: fields.getUint32(38, true) } : {}),
      }));
      at += storedSize;
    }
    main = false;
  }
  if (!ended || archiveName === undefined || archiveComment === undefined) {
    invalid("ARJ archive lacks its main or zero-size end header.");
  }
  const entryOf = (id: number): ArjEntryType => {
    integer(id, "ARJ entry ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown ARJ member ID.");
    if (!entry.readable) unsupported("Only ordinary STORED ARJ members can be read.");
    return entry;
  };
  const read = async (id: number, suppliedRead: ArjReadOptionsType = {}): Promise<ArjReadType> => {
    const opts = { ...suppliedRead };
    const extraOwner = capture(opts.ledger);
    const entry = entryOf(id), offset = opts.offset ?? 0, length = opts.length ?? entry.size - offset;
    integer(offset, "ARJ selected offset");
    integer(length, "ARJ selected length");
    if (offset > entry.size || length > entry.size - offset) throw new RangeError("ARJ selection exceeds member.");
    const signal = combined(options.signal, opts.signal);
    signal?.throwIfAborted();
    const target = together([local, opening, extraOwner], signal);
    const verify = opts.verify !== false || (offset === 0 && length === entry.size);
    const total = verify ? entry.size : length;
    const requests = total ? verify ? Math.ceil(total / 65536) : 1 : 0;
    let sourceCredit = total, requestCredit = requests;
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
    if (total > work.limits.maxSourceBytes || requests > work.limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "ARJ selected physical work exceeds policy.");
    }
    work.decoded(total);
    work.output(length);
    target.reserve("sourceBytes", total);
    target.reserve("requests", requests);
    signal?.throwIfAborted();
    const bytes = new Uint8Array(length);
    let state = 0xffffffff;
    if (verify) {
      for (let position = 0; position < entry.size;) {
        const chunk = await work.read(entry.offset + position, Math.min(65536, entry.size - position));
        state = crc32(chunk, state);
        const from = Math.max(offset, position), end = Math.min(offset + length, position + chunk.length);
        if (end > from) bytes.set(chunk.subarray(from - position, end - position), from - offset);
        position += chunk.length;
      }
      if (((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new ArchiveError("checksum-mismatch", "ARJ member CRC32 mismatch.");
      }
    } else if (length) bytes.set(await work.read(entry.offset + offset, length));
    signal?.throwIfAborted();
    return { bytes, integrity: verify ? "crc32-verified" : "pending", work: work.inspect() };
  };
  options.signal?.throwIfAborted();
  return Object.freeze({
    name: archiveName,
    comment: archiveComment,
    entries: Object.freeze(entries),
    work: budget.inspect(),
    read,
    member(id: number, suppliedMember: ArjMemberOptionsType = {}): ByteSourceType {
      const opts = { ...suppliedMember };
      const extraOwner = capture(opts.ledger);
      const entry = entryOf(id), signal = combined(options.signal, opts.signal);
      signal?.throwIfAborted();
      const ledger = together([createArchiveLedger(opts), extraOwner === opening ? undefined : extraOwner], signal);
      return Object.freeze({
        size: entry.size,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify(["opfs/arj", identity, entry.headerOffset, entry.offset, entry.size]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, extra: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const active = combined(signal, extra.signal);
          return (await read(id, {
            ...opts,
            ledger,
            offset,
            length,
            verify: false,
            ...(active === undefined ? {} : { signal: active }),
          })).bytes;
        },
      });
    },
  });
}
