/** Bounded physical RAR5 indexing and STORED member preview without extraction. @module */
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
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Physical file header identity. Names remain inert archive strings, including separators. */
export interface RarEntryType {
  readonly id: number;
  readonly name: string;
  readonly kind: "file" | "directory" | "special";
  readonly offset: number;
  readonly packedSize: number;
  readonly size: number;
  readonly sizeKnown: boolean;
  readonly host: number;
  readonly attributes: number;
  readonly method: number;
  readonly version: number;
  readonly encrypted: boolean;
  readonly solid: boolean;
  readonly split: boolean;
  readonly extraTypes: readonly number[];
  readonly crc32?: number;
  readonly readable: boolean;
  readonly restrictions: readonly string[];
}
/** These index limits supplement the ordinary byte/request ledger. */
export interface RarOpenOptionsType extends ArchiveLimitsType {
  /** All physical headers, including main, services and end. Default 100,000. */
  readonly maxHeaders?: number;
  /** Aggregate encoded header bytes, including CRC and size fields. Default 8 MiB. */
  readonly maxHeaderBytes?: number;
  /** Retained file names in encoded UTF-8 bytes. Default 1 MiB. */
  readonly maxNamesBytes?: number;
  readonly allowUnverifiedSource?: boolean;
  readonly signal?: AbortSignal;
}
/** CRC-present members are fully scanned by default, even for a small selected interval. */
export interface RarReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly verify?: boolean;
  readonly signal?: AbortSignal;
}
/** CRC is accidental-corruption evidence, never authentication. */
export interface RarReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "crc32-verified" | "pending" | "not-provided";
  readonly work: ArchiveWorkType;
}
/** Original-header index. Quick-open caches and service bodies are never authoritative here. */
export interface RarArchiveType {
  readonly entries: readonly RarEntryType[];
  readonly services: number;
  readonly metadata: "header-crc32-verified";
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: RarReadOptionsType): Promise<RarReadType>;
}

function exact(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("RAR integer exceeds exact JavaScript indexing.");
  return Number(value);
}
/** RAR permits overallocated vints. The tenth byte may carry only bit 63. */
class Cursor {
  at = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  vint(): number {
    let result = 0n;
    for (let byte = 0; byte < 10; byte++) {
      const next = this.take(1)[0]!;
      if (byte === 9 && (next & 0xfe)) invalid("RAR vint exceeds 64 bits.");
      result |= BigInt(next & 127) << BigInt(byte * 7);
      if (!(next & 128)) return exact(result);
    }
    invalid("RAR vint has no terminator.");
  }
  take(count: number): Uint8Array {
    if (count > this.bytes.length - this.at) invalid("RAR header field is truncated.");
    const bytes = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return bytes;
  }
  uint32(): number {
    return view(this.take(4)).getUint32(0, true);
  }
  end(): void {
    if (this.at !== this.bytes.length) invalid("RAR header has uninterpreted fields.");
  }
}
/** Parse every record envelope, even after finding an encryption/redirection marker.
 * Optional record bodies are opaque; their presence never grants decoding authority. */
function extras(bytes: Uint8Array, budget: ArchiveBudget): readonly number[] {
  const cursor = new Cursor(bytes);
  const types: number[] = [];
  const seen = new Set<number>();
  while (cursor.at < bytes.length) {
    const record = new Cursor(cursor.take(cursor.vint()));
    const type = record.vint();
    if (seen.has(type)) unsupported("Duplicate RAR extra record types are outside this profile.");
    budget.decoded(16);
    seen.add(type);
    types.push(type);
  }
  return Object.freeze(types);
}
function signalOf(left: AbortSignal | undefined, right: AbortSignal | undefined): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}

/** Index a single physical RAR5 archive. The borrowed source is never closed or cancelled. */
export async function openRar(input: ByteSourceType, supplied: RarOpenOptionsType = {}): Promise<RarArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "RAR source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown RAR source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("RAR identity must be a bounded string.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) unsupported("RAR requires stable source evidence.");
  const source: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const maximum = {
    headers: options.maxHeaders ?? 100000,
    bytes: options.maxHeaderBytes ?? 8 * 1024 * 1024,
    names: options.maxNamesBytes ?? 1024 * 1024,
  };
  for (const [label, value] of Object.entries(maximum)) integer(value, `RAR maximum ${label}`);
  const local = createArchiveLedger(options);
  const opening = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      opening?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
  const budget = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal);
  const signature = await budget.read(0, 8);
  if (![82, 97, 114, 33, 26, 7, 1, 0].every((value, at) => signature[at] === value)) {
    unsupported("Only RAR5 signatures at offset zero are supported.");
  }
  budget.decoded(8);
  const entries: RarEntryType[] = [];
  const lookup = new Map<number, RarEntryType>();
  let offset = 8;
  let headers = 0;
  let headerBytes = 0;
  let names = 0;
  let main = false;
  let ended = false;
  let services = 0;
  while (offset < size) {
    if (++headers > maximum.headers) throw new ArchiveError("budget-exceeded", "RAR header count exceeds policy.");
    const prefix = await budget.read(offset, 5);
    const expectedCrc = view(prefix).getUint32(0, true);
    const encoded = [prefix[4]!];
    while (encoded[encoded.length - 1]! & 128) {
      if (encoded.length === 3) invalid("RAR header size exceeds its three-byte field.");
      encoded.push((await budget.read(offset + 4 + encoded.length, 1))[0]!);
    }
    const bodySize = new Cursor(Uint8Array.from(encoded)).vint();
    const fullSize = 4 + encoded.length + bodySize;
    if (fullSize > maximum.bytes - headerBytes) {
      throw new ArchiveError("budget-exceeded", "RAR header bytes exceed policy.");
    }
    headerBytes += fullSize;
    budget.decoded(fullSize);
    const bodyOffset = exact(BigInt(offset) + BigInt(4 + encoded.length));
    const body = await budget.read(bodyOffset, bodySize);
    const state = crc32(body, crc32(Uint8Array.from(encoded)));
    if (((state ^ 0xffffffff) >>> 0) !== expectedCrc) {
      throw new ArchiveError("checksum-mismatch", "RAR physical header CRC32 mismatch.");
    }
    const cursor = new Cursor(body);
    const type = cursor.vint();
    const flags = cursor.vint();
    if (flags > 0x7f) unsupported("RAR common header flags exceed the supported profile.");
    const extraSize = flags & 1 ? cursor.vint() : 0;
    const packedSize = flags & 2 ? cursor.vint() : 0;
    if (extraSize > body.length - cursor.at) invalid("RAR extra area overlaps its common fields.");
    const fields = new Cursor(body.subarray(cursor.at, body.length - extraSize));
    const types = extras(body.subarray(body.length - extraSize), budget);
    const dataOffset = exact(BigInt(bodyOffset) + BigInt(bodySize));
    const next = BigInt(dataOffset) + BigInt(packedSize);
    if (next > BigInt(size)) invalid("RAR data extent exceeds the source.");
    if (type === 4) unsupported("Encrypted RAR headers are unsupported.");
    if (!main && type !== 1) invalid("RAR main header must precede other blocks.");
    if (type === 1) {
      if (main || flags & 0x7a) unsupported("RAR main header layout is outside this profile.");
      const archiveFlags = fields.vint();
      if (archiveFlags > 0x1f || archiveFlags & 7) unsupported("RAR volume or solid archive profile is unsupported.");
      fields.end();
      main = true;
    } else if (type === 2 || type === 3) {
      const fileFlags = fields.vint();
      if (fileFlags > 15) unsupported("RAR file flags exceed the supported profile.");
      const unpackedSize = fields.vint();
      const attributes = fields.vint();
      if (fileFlags & 2) fields.uint32();
      const checksum = fileFlags & 4 ? fields.uint32() : undefined;
      const compression = fields.vint();
      const host = fields.vint();
      const nameBytes = fields.take(fields.vint());
      fields.end();
      if (type === 2 && nameBytes.length > maximum.names - names) {
        throw new ArchiveError("budget-exceeded", "RAR retained names exceed policy.");
      }
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      if (!name.length || name.includes("\0")) invalid("RAR name is empty or contains NUL.");
      if (type === 3) services++;
      else {
        names += nameBytes.length;
        budget.decoded(96 + nameBytes.length + types.length * 8);
        const version = compression & 63;
        const method = (compression >>> 7) & 7;
        const dictionary = (compression >>> 10) & 31;
        const solid = Boolean(compression & 64);
        const encrypted = types.includes(1);
        const split = Boolean(flags & 24);
        const directory = Boolean(fileFlags & 1);
        const special = types.includes(5) || host === 1 && (attributes & 0xf000) !== 0 &&
            (attributes & 0xf000) !== (directory ? 0x4000 : 0x8000);
        const kind = special ? "special" : directory ? "directory" : "file";
        const restrictions: string[] = [];
        if (kind !== "file") restrictions.push(kind);
        if (method !== 0) restrictions.push("compression");
        if (
          version > 1 || compression > 0x1fffff || version === 0 && compression > 0x7fff ||
          dictionary > (version === 0 ? 15 : 23)
        ) {
          restrictions.push("codec-flags");
        }
        if (encrypted) restrictions.push("encryption");
        if (solid || flags & 32) restrictions.push("dependency");
        if (split) restrictions.push("split-volume");
        if (fileFlags & 8) restrictions.push("unknown-size");
        if (host > 1 || attributes > 0xffffffff) restrictions.push("host");
        if (types.some((value) => value < 1 || value > 6)) restrictions.push("extra-record");
        if (method === 0 && !encrypted && !(fileFlags & 8) && packedSize !== unpackedSize) {
          restrictions.push("stored-size");
        }
        const entry: RarEntryType = Object.freeze({
          id: offset,
          name,
          kind,
          offset: dataOffset,
          packedSize,
          size: unpackedSize,
          sizeKnown: !(fileFlags & 8),
          host,
          attributes,
          method,
          version,
          encrypted,
          solid,
          split,
          extraTypes: types,
          ...(checksum === undefined ? {} : { crc32: checksum }),
          readable: restrictions.length === 0,
          restrictions: Object.freeze(restrictions),
        });
        entries.push(entry);
        lookup.set(offset, entry);
      }
    } else if (type === 5) {
      if (fields.vint() !== 0 || flags & 0x7b) unsupported("RAR end-volume flags or extra fields are unsupported.");
      fields.end();
      if (next !== BigInt(size)) unsupported("This RAR profile requires EOF immediately after the end header.");
      ended = true;
    } else unsupported(`RAR header type ${type} is unsupported.`);
    offset = exact(next);
    if (ended) break;
  }
  if (!main || !ended) invalid("RAR main or end header is missing.");
  const archive: RarArchiveType = {
    entries: Object.freeze(entries),
    services,
    metadata: "header-crc32-verified",
    work: budget.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    async read(id, supplied = {}) {
      const opts = { ...supplied };
      integer(id, "RAR entry ID");
      const entry = lookup.get(id);
      if (!entry) throw new RangeError("Unknown RAR entry ID.");
      if (!entry.readable) unsupported(`RAR member cannot be read: ${entry.restrictions.join(", ")}.`);
      const start = opts.offset ?? 0;
      const length = opts.length ?? entry.size - start;
      integer(start, "RAR selected offset");
      integer(length, "RAR selected length");
      if (start > entry.size || length > entry.size - start) throw new RangeError("RAR selection exceeds member.");
      const signal = signalOf(options.signal, opts.signal);
      const extra = opts.ledger;
      const target: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== opening) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      const verify = opts.verify !== false && entry.crc32 !== undefined;
      const total = verify ? entry.size : length;
      const requests = total ? verify ? Math.ceil(total / 65536) : 1 : 0;
      // Known physical costs are admitted before selected allocation. Credits prevent
      // ArchiveBudget's actual reads from charging the same ledger a second time.
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
      signal?.throwIfAborted();
      if (total > work.limits.maxSourceBytes || requests > work.limits.maxRequests) {
        throw new ArchiveError("budget-exceeded", "RAR selected source work exceeds policy.");
      }
      work.decoded(total);
      work.output(length);
      target.reserve("sourceBytes", total);
      target.reserve("requests", requests);
      const bytes = new Uint8Array(length);
      let state = 0xffffffff;
      if (verify) {
        for (let at = 0; at < entry.size;) {
          const chunk = await work.read(entry.offset + at, Math.min(65536, entry.size - at));
          state = crc32(chunk, state);
          const from = Math.max(start, at);
          const to = Math.min(start + length, at + chunk.length);
          if (to > from) bytes.set(chunk.subarray(from - at, to - at), from - start);
          at += chunk.length;
        }
        if (((state ^ 0xffffffff) >>> 0) !== entry.crc32) {
          throw new ArchiveError("checksum-mismatch", "RAR member CRC32 mismatch.");
        }
      } else if (length) bytes.set(await work.read(entry.offset + start, length));
      signal?.throwIfAborted();
      return {
        bytes,
        integrity: verify ? "crc32-verified" : entry.crc32 === undefined ? "not-provided" : "pending",
        work: work.inspect(),
      };
    },
  };
  options.signal?.throwIfAborted();
  return Object.freeze(archive);
}
