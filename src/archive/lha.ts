/** Bounded LHA header levels 0–2 with stored-member ranges and explicit CRC scopes. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One physical record. Names are inert archive metadata, never host paths or source identities. */
export interface LhaEntryType {
  readonly id: number;
  readonly level: 0 | 1 | 2;
  readonly method: string;
  /** ASCII by default. A caller-supplied decoder owns any other encoding interpretation. */
  readonly name: string;
  /** Each access returns an owned copy, including directory separator bytes before decoding. */
  readonly rawName: Uint8Array;
  readonly rawDirectory: Uint8Array;
  readonly kind: "file" | "directory" | "special";
  readonly readable: boolean;
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly offset: number;
  readonly size: number;
  readonly storedSize: number;
  readonly crc16: number;
  /** Base-byte sum applies only to levels 0/1; common CRC covers the complete header. Neither authenticates it. */
  readonly headerIntegrity: "sum-verified" | "crc16-verified" | "sum-and-crc16-verified";
  readonly os?: number;
  readonly mode?: number;
  /** Bounded, uninterpreted advisory extension identifiers. Structural unknowns are refused. */
  readonly extensions: readonly number[];
}
/** Borrowed-source admission and retained index limits. Byte allowances persist across open and later reads. */
export interface LhaOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 100,000 physical member records, including directories. */
  readonly maxEntries?: number;
  /** Default: 8 MiB of serialized headers retained/inspected across the index. */
  readonly maxHeaderBytes?: number;
  /** Default: 64 KiB for one complete header and its extension chain. */
  readonly maxEntryHeaderBytes?: number;
  /** Default: 1,024 extensions in one record. Chains must advance and terminate. */
  readonly maxExtensions?: number;
  /** Default: 4,096 raw name/directory bytes and UTF-8 bytes of the decoded name per record. */
  readonly maxNameBytes?: number;
  /** Receives owned raw bytes and their role. Default accepts ASCII only; separators remain inert. */
  readonly decodeName?: (bytes: Uint8Array, role: "name" | "directory") => string;
  /** Default: false. Source identity alone does not establish replay stability. */
  readonly allowUnverifiedSource?: boolean;
}
/** Selected owned output. Verification scans the entire stored member, including unselected suffixes. */
export interface LhaReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default: true. A full selection always verifies the file CRC, even when this option is false. */
  readonly verify?: boolean;
}
/** CRC evidence covers payload bytes only; neither file CRC nor header checks authenticate an author. */
export interface LhaReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "crc16-verified" | "pending";
  readonly work: ArchiveWorkType;
}
/** Limits and abort authority retained by a nested member source. */
export interface LhaMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Indexed physical members. The caller retains ownership of the source and any provider resources. */
export interface LhaArchiveType {
  readonly entries: readonly LhaEntryType[];
  readonly work: ArchiveWorkType;
  read(id: number, options?: LhaReadOptionsType): Promise<LhaReadType>;
  /** Exact stored bytes for nesting. Partial nested reads do not imply a whole-member CRC check. */
  member(id: number, options?: LhaMemberOptionsType): ByteSourceType;
}

/** Reflected CRC-16/ARC (polynomial 0xA001, initial zero), authored as a fixed eight-step byte recurrence. */
function crc16(bytes: Uint8Array, state = 0, zero = -2): number {
  for (let at = 0; at < bytes.length; at++) {
    state ^= at === zero || at === zero + 1 ? 0 : bytes[at]!;
    for (let bit = 0; bit < 8; bit++) state = state & 1 ? (state >>> 1) ^ 0xa001 : state >>> 1;
  }
  return state;
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function signalOf(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}
/** Each distinct aggregate owner is charged once. Reservations are not rolled back after later refusal. */
function together(owners: readonly (ArchiveLedgerType | undefined)[]): ArchiveLedgerType {
  const unique = [...new Set(owners.filter((owner): owner is ArchiveLedgerType => owner !== undefined))];
  return {
    reserve(kind, count) {
      for (const owner of unique) owner.reserve(kind, count);
    },
    inspect: () => unique[0]!.inspect(),
  };
}

/** Index one archive at offset zero; no executable-stub search, extraction, repair or source disposal occurs. */
export async function openLha(input: ByteSourceType, supplied: LhaOpenOptionsType = {}): Promise<LhaArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "LHA source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown LHA source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("LHA source identity must be a bounded string.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) unsupported("LHA requires stable source evidence.");
  const source: ByteSourceType = Object.freeze({
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  });
  const maximum = {
    entries: options.maxEntries ?? 100000,
    headers: options.maxHeaderBytes ?? 8 * 1024 * 1024,
    one: options.maxEntryHeaderBytes ?? 65536,
    extensions: options.maxExtensions ?? 1024,
    name: options.maxNameBytes ?? 4096,
  };
  for (const [key, value] of Object.entries(maximum)) integer(value, `LHA maximum ${key}`);
  const local = createArchiveLedger(options);
  const lifetime = together([local, options.ledger]);
  const budget = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal);
  const entries: LhaEntryType[] = [];
  let at = 0;
  let headers = 0;
  let ended = false;
  /** Copies borrowed scratch before another source call or a foreign name callback can reuse it. */
  const headerRead = async (offset: number, length: number, current: number): Promise<Uint8Array> => {
    if (length > maximum.headers - headers || length > maximum.one - current) {
      throw new ArchiveError("budget-exceeded", "LHA serialized header admission exceeded.");
    }
    budget.decoded(length);
    const bytes = (await budget.read(offset, length)).slice();
    headers += length;
    return bytes;
  };
  while (at < size) {
    options.signal?.throwIfAborted();
    // A single zero at EOF is the supported trailer. A low zero length byte in
    // a level-2 header is not confused with it because that record has more bytes.
    if (size - at === 1) {
      const trailer = await budget.read(at, 1);
      budget.decoded(1);
      if (trailer[0] !== 0) invalid("LHA requires a single zero-byte terminator.");
      ended = true;
      break;
    }
    if (entries.length >= maximum.entries) throw new ArchiveError("budget-exceeded", "LHA entry limit exceeded.");
    if (size - at < 22) invalid("LHA member header or trailer is truncated.");
    const prefix = await headerRead(at, 22, 0);
    const level = prefix[20]!;
    if (level !== 0 && level !== 1 && level !== 2) unsupported("Only LHA header levels 0, 1 and 2 are supported.");
    const length = level === 2 ? view(prefix).getUint16(0, true) : prefix[0]! + 2;
    const minimum = level === 2 ? 26 : level === 1 ? 27 : 24;
    if (length < minimum) invalid("LHA base header is too short.");
    const remainder = await headerRead(at + 22, length - 22, 22);
    const pieces = [prefix, remainder];
    let fullSize = length;
    const base = new Uint8Array(length);
    base.set(prefix);
    base.set(remainder, 22);
    const fields = view(base);
    if (level !== 2) {
      let sum = 0;
      for (let index = 2; index < length; index++) sum = (sum + base[index]!) & 255;
      if (sum !== base[1]) throw new ArchiveError("checksum-mismatch", "LHA base header byte sum mismatch.");
    }
    const method = String.fromCharCode(...base.subarray(2, 7));
    if (!/^-(?:lh[0-7d]|lz[45s])-$/.test(method)) unsupported("Unknown LHA method envelope.");
    let storedSize = fields.getUint32(7, true);
    const originalSize = fields.getUint32(11, true);
    let name: Uint8Array = new Uint8Array();
    let directory: Uint8Array = new Uint8Array();
    let crc: number;
    let os: number | undefined;
    let mode: number | undefined;
    let chain: number;
    if (level === 2) {
      crc = fields.getUint16(21, true);
      os = base[23]!;
      chain = 24;
    } else {
      const nameLength = base[21]!;
      if (nameLength > length - minimum) invalid("LHA filename exceeds the base header.");
      name = base.slice(22, 22 + nameLength);
      crc = fields.getUint16(22 + nameLength, true);
      if (level === 1) os = base[24 + nameLength]!;
      // This profile understands only the conventional 12-byte Unix level-0
      // suffix. Other tails might change kind/encoding and are not discarded.
      if (level === 0 && length !== 24 + nameLength) {
        const tail = base.subarray(24 + nameLength);
        if (tail.length !== 12 || tail[0] !== 85 || tail[1] !== 0) unsupported("Unknown LHA level-0 extended area.");
        os = 85;
        mode = view(tail).getUint16(6, true);
      }
      chain = length - 2;
    }
    if (level === 1) {
      let next = fields.getUint16(chain, true);
      let count = 0;
      while (next !== 0) {
        if (++count > maximum.extensions) throw new ArchiveError("budget-exceeded", "LHA extension count exceeded.");
        if (next < 3 || next > storedSize) invalid("LHA level-1 extension skip size underflows.");
        const extension = await headerRead(at + fullSize, next, fullSize);
        pieces.push(extension);
        fullSize += next;
        storedSize -= next;
        next = view(extension).getUint16(next - 2, true);
      }
    }
    const header = new Uint8Array(fullSize);
    let joined = 0;
    for (const piece of pieces) {
      header.set(piece, joined);
      joined += piece.length;
    }
    const raw = view(header);
    const seen = new Set<number>();
    const extensions: number[] = [];
    let common: number | undefined;
    let commonOffset = -1;
    if (level !== 0) {
      let cursor = chain;
      let count = 0;
      while (true) {
        if (cursor > fullSize - 2) invalid("LHA extension chain lacks a terminator.");
        const countBytes = raw.getUint16(cursor, true);
        if (countBytes === 0) {
          if (cursor + 2 !== fullSize) invalid("LHA extension header has uninterpreted trailing bytes.");
          break;
        }
        if (++count > maximum.extensions) throw new ArchiveError("budget-exceeded", "LHA extension count exceeded.");
        if (countBytes < 3 || countBytes > fullSize - cursor - 2) invalid("LHA extension extent is invalid.");
        const type = header[cursor + 2]!;
        if (seen.has(type)) unsupported("Duplicate LHA extension types are outside this profile.");
        seen.add(type);
        extensions.push(type);
        const payload = header.subarray(cursor + 3, cursor + countBytes);
        if (type === 0) {
          if (payload.length < 2) invalid("LHA common CRC field is truncated.");
          common = view(payload).getUint16(0, true);
          commonOffset = cursor + 3;
        } else if (type === 1) name = payload.slice();
        else if (type === 2) directory = payload.slice();
        else if (type === 0x50) {
          if (payload.length !== 2) invalid("LHA Unix mode must contain two bytes.");
          mode = view(payload).getUint16(0, true);
        } else if (![0x3f, 0x41, 0x51, 0x52, 0x53, 0x54].includes(type)) {
          unsupported("LHA structural or unknown extension is outside this profile.");
        }
        cursor += countBytes;
      }
    }
    if (level === 2 && common === undefined) unsupported("This LHA level-2 profile requires a common header CRC.");
    if (common !== undefined && crc16(header, 0, commonOffset) !== common) {
      throw new ArchiveError("checksum-mismatch", "LHA common header CRC16 mismatch.");
    }
    if (name.length + directory.length > maximum.name) {
      throw new ArchiveError("budget-exceeded", "LHA raw name limit exceeded.");
    }
    if (name.length === 0 && method !== "-lhd-") invalid("LHA file name is missing.");
    /** Decode from a separate owned copy, so callback mutation cannot change retained wire evidence. */
    const decode = (bytes: Uint8Array, role: "name" | "directory"): string => {
      if (bytes.some((byte) => byte === 0)) invalid("LHA name contains a NUL byte.");
      let result: string;
      if (options.decodeName) result = options.decodeName(bytes.slice(), role);
      else {
        if (bytes.some((byte) => byte > 127 && !(role === "directory" && byte === 255))) {
          unsupported("Non-ASCII LHA names require an explicit decoder.");
        }
        result = String.fromCharCode(...bytes.map((byte) => role === "directory" && byte === 255 ? 47 : byte));
      }
      if (typeof result !== "string") throw new TypeError("LHA name decoder must return a string.");
      if (result.length > maximum.name || new TextEncoder().encode(result).length > maximum.name) {
        throw new ArchiveError("budget-exceeded", "LHA decoded name exceeds policy.");
      }
      return result;
    };
    const decodedName = decode(directory, "directory") + decode(name, "name");
    if (new TextEncoder().encode(decodedName).length > maximum.name) {
      throw new ArchiveError("budget-exceeded", "LHA combined name exceeds policy.");
    }
    budget.decoded(new TextEncoder().encode(decodedName).length);
    options.signal?.throwIfAborted();
    const offset = at + fullSize;
    if (storedSize > size - offset) invalid("LHA member payload exceeds the source snapshot.");
    const fileType = mode === undefined ? 0 : mode & 0xf000;
    const kind = fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000
      ? "special"
      : method === "-lhd-"
      ? "directory"
      : fileType === 0x4000
      ? "special"
      : "file";
    if (method === "-lh0-" && storedSize !== originalSize) invalid("LHA stored member size fields disagree.");
    if (method === "-lhd-" && (storedSize !== 0 || originalSize !== 0)) {
      unsupported("LHA directory with payload is unsupported.");
    }
    const entry: LhaEntryType = Object.freeze({
      id: entries.length,
      level,
      method,
      name: decodedName,
      get rawName() {
        return name.slice();
      },
      get rawDirectory() {
        return directory.slice();
      },
      kind,
      readable: kind === "file" && method === "-lh0-",
      headerOffset: at,
      headerSize: fullSize,
      offset,
      size: originalSize,
      storedSize,
      crc16: crc,
      headerIntegrity: common === undefined
        ? "sum-verified"
        : level === 2
        ? "crc16-verified"
        : "sum-and-crc16-verified",
      ...(os === undefined ? {} : { os }),
      ...(mode === undefined ? {} : { mode }),
      extensions: Object.freeze(extensions),
    });
    entries.push(entry);
    at = offset + storedSize;
  }
  if (!ended) invalid("LHA archive lacks its single zero-byte terminator.");
  const entryOf = (id: number): LhaEntryType => {
    integer(id, "LHA entry ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown LHA member ID.");
    if (!entry.readable) unsupported("Only ordinary -lh0- stored LHA members can be read.");
    return entry;
  };
  const read = async (id: number, suppliedRead: LhaReadOptionsType = {}): Promise<LhaReadType> => {
    const opts = { ...suppliedRead };
    const entry = entryOf(id);
    const offset = opts.offset ?? 0;
    const length = opts.length ?? entry.size - offset;
    integer(offset, "LHA selected offset");
    integer(length, "LHA selected length");
    if (offset > entry.size || length > entry.size - offset) throw new RangeError("LHA selection exceeds member.");
    const signal = signalOf(options.signal, opts.signal);
    signal?.throwIfAborted();
    const target = together([local, options.ledger, opts.ledger]);
    const verify = opts.verify !== false || (offset === 0 && length === entry.size);
    const total = verify ? entry.size : length;
    const requests = total ? verify ? Math.ceil(total / 65536) : 1 : 0;
    // Physical costs are known before selected allocation. Actual reads consume
    // these credits, so one operation never charges source/request work twice.
    let sourceCredit = total;
    let requestCredit = requests;
    const ledger: ArchiveLedgerType = {
      reserve(kind, count) {
        if (kind === "sourceBytes" && count <= sourceCredit) sourceCredit -= count;
        else if (kind === "requests" && count <= requestCredit) requestCredit -= count;
        else target.reserve(kind, count);
      },
      inspect: () => target.inspect(),
    };
    const work = new ArchiveBudget(source, { ...opts, ledger }, signal);
    if (total > work.limits.maxSourceBytes || requests > work.limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "LHA selected physical work exceeds policy.");
    }
    work.decoded(total);
    work.output(length);
    target.reserve("sourceBytes", total);
    target.reserve("requests", requests);
    const bytes = new Uint8Array(length);
    let state = 0;
    if (verify) {
      for (let position = 0; position < entry.size;) {
        const chunk = await work.read(entry.offset + position, Math.min(65536, entry.size - position));
        state = crc16(chunk, state);
        const from = Math.max(offset, position);
        const end = Math.min(offset + length, position + chunk.length);
        if (end > from) bytes.set(chunk.subarray(from - position, end - position), from - offset);
        position += chunk.length;
      }
      if (state !== entry.crc16) throw new ArchiveError("checksum-mismatch", "LHA member CRC16 mismatch.");
    } else if (length) bytes.set(await work.read(entry.offset + offset, length));
    signal?.throwIfAborted();
    return { bytes, integrity: verify ? "crc16-verified" : "pending", work: work.inspect() };
  };
  options.signal?.throwIfAborted();
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    read,
    member(id: number, suppliedMember: LhaMemberOptionsType = {}): ByteSourceType {
      const entry = entryOf(id);
      const opts = { ...suppliedMember };
      const memberLedger = createArchiveLedger(opts);
      const ledger = together([memberLedger, opts.ledger === options.ledger ? undefined : opts.ledger]);
      const signal = signalOf(options.signal, opts.signal);
      return Object.freeze({
        size: entry.size,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify(["opfs/lha", identity, entry.headerOffset, entry.offset, entry.size]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, extra: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const active = signalOf(signal, extra.signal);
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
