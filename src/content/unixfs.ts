/** Verified UnixFS file ranges and literal directory links, without a transport or mutable filesystem. @module */
import { isBytes, toView } from "../bytes.ts";
import { parseCid } from "./cid.ts";
import { murmur } from "./murmur.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { createArchiveLedger } from "../archive/record.ts";

/** Borrowed block acquisition. Honor maxBytes before collecting a response when the backing API permits it.
 * The returned native byte view is copied and independently hashed; a reader's verification label is never trusted.
 * Callback allocation is opaque to this library, so its size checks bound owned copies, not foreign allocations.
 */
export type UnixfsBlockReaderType = (
  cid: string,
  options: { readonly maxBytes: number; readonly signal?: AbortSignal },
) => Promise<Uint8Array>;
/** Finite local policies, not UnixFS format maxima. All parent ledgers survive child opens and source reads. */
export interface UnixfsOptionsType extends ArchiveLimitsType {
  readonly subtle: Pick<SubtleCrypto, "digest">;
  readonly signal?: AbortSignal;
  /** Opt in to Kubo/Boxo's fanout-256 HAMT interpretation. Omission refuses HAMT nodes.
   * Native shortened high-bucket-byte-first bitmaps and big-endian Murmur routing differ from
   * the pinned UnixFS draft wording. Other fanouts/hash types are refused, never autodetected.
   */ readonly hamtProfile?: "kubo-fanout-256";
  /** Returned HAMT list entries: default 16384, hard 65536; not a format maximum. */ readonly maxDirectoryEntries?:
    number;
  /** Whole serialized block: default 1 MiB, hard 8 MiB. */ readonly maxBlockBytes?: number;
  /** Links per node: default 16384, hard 65536. */ readonly maxLinks?: number;
  /** Graph edges from this root: default 64, hard 128. */ readonly maxDepth?: number;
  /** Serialized Name bytes and caller UTF16 preflight: default 4096, hard 65536. HAMT includes its two-byte prefix. */ readonly maxNameBytes?:
    number;
  /** Estimated node index bytes per operation: default 4 MiB, hard 16 MiB. */ readonly maxIndexBytes?: number;
  /** Node admissions per operation, including cached references: default 4096, hard 65536. */ readonly maxNodes?:
    number;
  /** Traversed edges per operation, including cache hits: default 100000, hard 1000000. */ readonly maxEdges?: number;
  /** Parser, lookup, bitmap and bounded routing arithmetic work: default 16 Mi, hard 64 Mi. */ readonly maxSteps?:
    number;
  /** Operation-local retained block cache: default 4 MiB, hard 16 MiB; zero disables it. */ readonly maxCacheBytes?:
    number;
}
/** A call narrows parent authority; it cannot replace opening cancellation or lifetime accounting. */
export interface UnixfsCallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Exact buffered logical range; default length is the remaining file. Hard returned allocation is 16 MiB. */
export interface UnixfsReadOptionsType extends UnixfsCallOptionsType {
  readonly offset?: number;
  readonly length?: number;
}
/** Metadata is inert. Missing mode or time stays absent; it is never applied to a host file. */
export interface UnixfsMetadataType {
  readonly modeRaw?: number;
  readonly mode?: number;
  readonly mtime?: { readonly seconds: string; readonly nanoseconds?: number };
}
/** Tsize is a declared cumulative serialized-DAG hint, never logical file length or trustworthy accounting. */
export interface UnixfsLinkType {
  readonly name: string;
  readonly cid: string;
  readonly tsize?: string;
}
/** Acquired serialized bytes, hash/materialization work, returned bytes and bounded graph/parser work are separate. */
export interface UnixfsWorkType extends ArchiveWorkType {
  readonly nodes: number;
  readonly edges: number;
  readonly links: number;
  readonly steps: number;
  readonly indexBytes: number;
  readonly cacheBytes: number;
  readonly cacheHits: number;
  /** Touched HAMT shards, including operation-cache reuse. */ readonly hamtShards: number;
  /** Literal-name hash calls and admitted UTF8 input bytes; these are routing work only. */ readonly nameHashes:
    number;
  readonly hashBytes: number;
  /** Entries materialized by a complete HAMT list, without opening their targets. */ readonly directoryEntries: number;
}
/** Every acquired block matched its CID. Untouched branches can still be absent or internally inconsistent. */
export interface UnixfsReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "sha2-256-blocks";
  readonly scope: "selected-file-range";
  readonly work: UnixfsWorkType;
}
/** Complete selected-file traversal includes zero-length children; it says nothing about directory siblings. */
export interface UnixfsVerificationType {
  readonly integrity: "sha2-256-blocks";
  readonly scope: "complete-file";
  readonly work: UnixfsWorkType;
}
interface UnixfsBaseType {
  readonly cid: string;
  readonly integrity: "sha2-256-block";
  readonly metadata: UnixfsMetadataType;
  /** Work for opening this node, not cumulative work for all later operations. */ readonly work: UnixfsWorkType;
}
/** Logical size is committed by this verified node's inline bytes and child-size declarations. */
export interface UnixfsFileType extends UnixfsBaseType {
  readonly kind: "file";
  readonly size: number;
  read(options?: UnixfsReadOptionsType): Promise<UnixfsReadType>;
  verify(options?: UnixfsCallOptionsType): Promise<UnixfsVerificationType>;
  /** Immutable logical provenance; each read verifies selected blocks but does not prove complete-file availability. */
  source(options?: UnixfsCallOptionsType): ByteSourceType;
}
/** A complete local link list is not proof that any child block exists. Original link ordering is retained. */
export interface UnixfsDirectoryType extends UnixfsBaseType {
  readonly kind: "directory";
  readonly entries: readonly UnixfsLinkType[];
  /** Exact literal Name lookup, including punctuation. This is not an IPFS path or URI resolver. */
  open(name: string, options?: UnixfsCallOptionsType): Promise<UnixfsNodeType>;
}
/** Complete bounded name inventory for this directory. Target file DAGs are not inspected. */
export interface UnixfsListingType {
  readonly entries: readonly UnixfsLinkType[];
  readonly integrity: "sha2-256-blocks";
  readonly scope: "complete-directory-links";
  readonly profile: "kubo-fanout-256";
  readonly work: UnixfsWorkType;
}
/** An explicitly selected native HAMT profile; opening verifies only the local shard.
 * open() checks the selected route and its local leaf routing. list() visits all directory shards,
 * validates every name's route, and materializes a finite link inventory; it never opens target files.
 */
export interface UnixfsHamtType extends UnixfsBaseType {
  readonly kind: "hamt-directory";
  readonly profile: "kubo-fanout-256";
  open(name: string, options?: UnixfsCallOptionsType): Promise<UnixfsNodeType>;
  list(options?: UnixfsCallOptionsType): Promise<UnixfsListingType>;
}
/** Target bytes are an owned metadata copy. They are never followed or treated as a file's contents. */
export interface UnixfsSymlinkType extends UnixfsBaseType {
  readonly kind: "symlink";
  readonly target: Uint8Array;
}
export type UnixfsNodeType = UnixfsFileType | UnixfsDirectoryType | UnixfsHamtType | UnixfsSymlinkType;
interface LinkType extends UnixfsLinkType {
  readonly size?: number;
  readonly offset?: number;
}
interface NodeType {
  readonly cid: string;
  readonly kind: "file" | "directory" | "hamt-directory" | "symlink";
  readonly bytes: Uint8Array;
  readonly data: Uint8Array;
  readonly links: readonly LinkType[];
  readonly size: number;
  readonly metadata: UnixfsMetadataType;
}
interface PolicyType {
  readonly block: number;
  readonly links: number;
  readonly depth: number;
  readonly name: number;
  readonly index: number;
  readonly nodes: number;
  readonly edges: number;
  readonly steps: number;
  readonly cache: number;
  readonly entries: number;
}
function invalid(message: string): never {
  throw new TypeError(`UnixFS: ${message}`);
}
function unsupported(message: string): never {
  throw new TypeError(`Unsupported UnixFS profile: ${message}`);
}
function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `UnixFS ${label} limit exceeded.`);
}
function signals(...values: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = [...new Set(values.filter((value): value is AbortSignal => value !== undefined))];
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}
function exact(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("logical size exceeds exact JavaScript integers");
  return Number(value);
}

/** A work owner charges all distinct ancestor ledgers once. Failed reservations are never refunded. */
class Work {
  readonly ledgers: readonly ArchiveLedgerType[];
  readonly policy: PolicyType;
  readonly signal: AbortSignal | undefined;
  readonly cache = new Map<string, NodeType>();
  readonly used = {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    nodes: 0,
    edges: 0,
    links: 0,
    steps: 0,
    indexBytes: 0,
    cacheBytes: 0,
    cacheHits: 0,
    hamtShards: 0,
    nameHashes: 0,
    hashBytes: 0,
    directoryEntries: 0,
  };
  constructor(ledgers: readonly ArchiveLedgerType[], policy: PolicyType, signal: AbortSignal | undefined) {
    this.ledgers = [...new Set(ledgers)];
    this.policy = policy;
    this.signal = signal;
  }
  charge(kind: keyof ArchiveWorkType, count: number): void {
    this.signal?.throwIfAborted();
    for (const ledger of this.ledgers) ledger.reserve(kind, count);
    this.used[kind] += count;
  }
  step(count = 1): void {
    this.signal?.throwIfAborted();
    cap(count, this.policy.steps - this.used.steps, "parser steps");
    this.used.steps += count;
  }
  index(count: number): void {
    cap(count, this.policy.index - this.used.indexBytes, "index bytes");
    this.charge("decodedBytes", count);
    this.used.indexBytes += count;
  }
  edge(): void {
    this.step();
    cap(1, this.policy.edges - this.used.edges, "edges");
    this.used.edges++;
  }
  inspect(): UnixfsWorkType {
    return { ...this.used };
  }
}

/** Admit UTF8 hash input before allocating it. Hash steps conservatively cover bounded BigInt arithmetic. */
function nameHash(name: string, work: Work): Uint8Array {
  let length = 0;
  for (const point of name) {
    const code = point.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  work.step(length + 96 * Math.max(1, Math.ceil(length / 16)));
  work.charge("decodedBytes", length + 8);
  work.used.nameHashes++;
  work.used.hashBytes += length;
  const result = murmur(new TextEncoder().encode(name));
  work.signal?.throwIfAborted();
  return result;
}
/** Validate all leaves in each touched shard against its entire routing prefix.
 * Other shards remain unexamined. Internal shard edges consume one of exactly eight hash bytes.
 */
function shard(current: NodeType, path: readonly number[], work: Work): void {
  if (current.kind !== "hamt-directory") invalid("HAMT shard link targets a different node type");
  if (path.length >= 8) invalid("HAMT route exceeds its 64-bit hash");
  work.used.hamtShards++;
  for (const entry of current.links) {
    const bucket = Number.parseInt(entry.name.slice(0, 2), 16);
    work.step(path.length + 1);
    if (entry.name.length === 2) {
      if (path.length === 7) invalid("HAMT internal link exhausts its 64-bit hash");
      continue;
    }
    work.charge("decodedBytes", entry.name.length * 2);
    const hash = nameHash(entry.name.slice(2), work);
    if (hash[path.length] !== bucket || path.some((value, index) => value !== hash[index])) {
      invalid("HAMT leaf name disagrees with its complete hash route");
    }
  }
}

/** Minimal protobuf2 wire reader. uint64 remains BigInt until its actual semantic range is checked. */
class Proto {
  readonly bytes: Uint8Array;
  readonly work: Work;
  at = 0;
  constructor(bytes: Uint8Array, work: Work) {
    this.bytes = bytes;
    this.work = work;
  }
  uint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      this.work.step();
      const byte = this.bytes[this.at++];
      if (byte === undefined || (i === 9 && byte > 1)) invalid("truncated or overflowing uint64");
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) {
        if (i && byte === 0) invalid("non-minimal protobuf varint");
        return value;
      }
    }
    invalid("oversized protobuf varint");
  }
  field(): { field: number; wire: number } {
    const key = this.uint();
    if (key > 0xffffffffn || key < 8n) invalid("invalid protobuf field tag");
    return { field: Number(key >> 3n), wire: Number(key & 7n) };
  }
  data(): Uint8Array {
    const size = exact(this.uint());
    if (size > this.bytes.length - this.at) invalid("protobuf byte extent exceeds its enclosing message");
    this.work.step(size);
    const result = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return result;
  }
  fixed(): number {
    this.work.step(4);
    if (this.at + 4 > this.bytes.length) invalid("truncated fixed32");
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.at, 4).getUint32(0, true);
    this.at += 4;
    return value;
  }
}
function utf8(bytes: Uint8Array, maximum: number): string {
  cap(bytes.length, maximum, "name bytes");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function time(bytes: Uint8Array, work: Work): UnixfsMetadataType["mtime"] {
  const reader = new Proto(bytes, work);
  let seconds: string | undefined, nanoseconds: number | undefined;
  while (reader.at < bytes.length) {
    const { field, wire } = reader.field();
    if (field === 1 && wire === 0 && seconds === undefined) seconds = BigInt.asIntN(64, reader.uint()).toString();
    else if (field === 2 && wire === 5 && nanoseconds === undefined) {
      nanoseconds = reader.fixed();
      if (!nanoseconds || nanoseconds > 999999999) invalid("mtime fractional value outside 1..999999999");
    } else invalid("duplicate or unknown mtime field");
  }
  if (seconds === undefined) invalid("mtime requires Seconds");
  return Object.freeze({ seconds, ...(nanoseconds === undefined ? {} : { nanoseconds }) });
}
/** PBLink fields are ordered and unique; Hash syntax is checked even for an unopened child. */
function link(bytes: Uint8Array, work: Work): UnixfsLinkType {
  work.index(256); // Reserve link objects, array slots and duplicate-name bookkeeping before creating them.
  const reader = new Proto(bytes, work);
  let previous = 0, cid: string | undefined, name = "", tsize: string | undefined;
  while (reader.at < bytes.length) {
    const { field, wire } = reader.field();
    if (field <= previous || field > 3) invalid("PBLink fields must be ordered, known and unique");
    previous = field;
    if (field === 1 && wire === 2) {
      const hash = reader.data();
      if (hash.length > 256) invalid("PBLink CID exceeds admission limit");
      work.index(hash.length * 4); // Canonical base32 text plus owned CID parsing fields.
      cid = parseCid(hash).id;
    } else if (field === 2 && wire === 2) {
      const bytes = reader.data();
      cap(bytes.length, work.policy.name, "name bytes");
      work.index(bytes.length * 2);
      name = utf8(bytes, work.policy.name);
    } else if (field === 3 && wire === 0) tsize = reader.uint().toString();
    else invalid("PBLink wire type does not match its field");
  }
  if (cid === undefined) invalid("PBLink requires a valid Hash");
  return Object.freeze({ cid, name, ...(tsize === undefined ? {} : { tsize }) });
}
/** Strict UnixFS data, with both expanded and packed repeated blocksizes accepted in wire order. */
function node(cid: string, bytes: Uint8Array, codec: number, work: Work, hamt: boolean): NodeType {
  if (codec === 0x55) {
    return { cid, kind: "file", bytes, data: bytes, links: [], size: bytes.length, metadata: Object.freeze({}) };
  }
  const reader = new Proto(bytes, work), links: UnixfsLinkType[] = [];
  let data: Uint8Array | undefined, group: "links" | "data" | undefined, dataFirst = false;
  while (reader.at < bytes.length) {
    const { field, wire } = reader.field();
    if (field === 1 && wire === 2 && data === undefined) {
      dataFirst = group === undefined;
      group = "data";
      data = reader.data();
    } else if (field === 2 && wire === 2) {
      if (group === "data" && !dataFirst) invalid("PBNode Links cannot straddle Data");
      group = "links";
      cap(1, work.policy.links - links.length, "links per node");
      work.used.links++;
      links.push(link(reader.data(), work));
    } else invalid("PBNode field is duplicate, unknown or has the wrong wire type");
  }
  if (data === undefined) unsupported("missing UnixFS Data; legacy empty directories are not inferred");
  const inner = new Proto(data, work), seen = new Set<number>(), sizes: number[] = [];
  let type: number | undefined, body: Uint8Array = new Uint8Array(0), declared: number | undefined;
  let mode: number | undefined,
    mtime: UnixfsMetadataType["mtime"],
    hashType: number | undefined,
    fanout: number | undefined;
  while (inner.at < data.length) {
    const { field, wire } = inner.field();
    if (field !== 4) {
      if (seen.has(field)) invalid("duplicate singular UnixFS field");
      seen.add(field);
    }
    if (field === 1 && wire === 0) type = exact(inner.uint());
    else if (field === 2 && wire === 2) body = inner.data();
    else if (field === 3 && wire === 0) declared = exact(inner.uint());
    else if (field === 4 && (wire === 0 || wire === 2)) {
      const add = (value: bigint): void => {
        cap(1, work.policy.links - sizes.length, "blocksizes");
        work.index(8);
        sizes.push(exact(value));
      };
      if (wire === 0) add(inner.uint());
      else {
        const packed = new Proto(inner.data(), work);
        while (packed.at < packed.bytes.length) add(packed.uint());
      }
    } else if (field === 5 && wire === 0) hashType = exact(inner.uint());
    else if (field === 6 && wire === 0) fanout = exact(inner.uint());
    else if (field === 7 && wire === 0) {
      const raw = inner.uint();
      if (raw > 0xffffffffn) invalid("mode exceeds uint32");
      mode = Number(raw);
    } else if (field === 8 && wire === 2) mtime = time(inner.data(), work);
    else invalid("unknown UnixFS field or wire type");
  }
  const metadata = Object.freeze({
    ...(mode === undefined ? {} : { modeRaw: mode, mode: mode & 0xfff }),
    ...(mtime === undefined ? {} : { mtime }),
  });
  if (type !== 5 && (hashType !== undefined || fanout !== undefined)) unsupported("HAMT fields on a non-HAMT node");
  if (type === 2) {
    if (sizes.length !== links.length) invalid("File Links and blocksizes counts disagree");
    let size = body.length;
    const files: LinkType[] = [];
    for (let i = 0; i < links.length; i++) {
      if (links[i]!.name !== "") invalid("File child links cannot have nonempty names");
      if (sizes[i]! > Number.MAX_SAFE_INTEGER - size) unsupported("file size sum exceeds exact integers");
      files.push(Object.freeze({ ...links[i]!, size: sizes[i]!, offset: size }));
      size += sizes[i]!;
    }
    if (size !== (declared ?? 0)) invalid("File filesize does not match inline bytes plus blocksizes");
    return {
      cid,
      kind: "file",
      bytes,
      data: body,
      links: files,
      size,
      metadata,
    };
  }
  if (type !== 1 && type !== 4 && type !== 5) unsupported(`node type ${type === undefined ? "missing" : type}`);
  if (declared !== undefined || sizes.length) unsupported("file-size fields on a non-file node");
  if (type === 5) {
    if (!hamt) unsupported("HAMT requires explicit hamtProfile: kubo-fanout-256");
    if (hashType !== 0x22 || fanout !== 256) unsupported("HAMT requires Murmur3 x64-64 and fanout 256");
    if (body.length > 32) invalid("HAMT bitmap exceeds 256 buckets");
    let occupied = 0, previous = -1;
    work.step(body.length * 8);
    for (const byte of body) for (let bit = 0; bit < 8; bit++) occupied += (byte >> bit) & 1;
    if (occupied !== links.length) invalid("HAMT bitmap and link counts disagree");
    for (const entry of links) {
      work.step(entry.name.length + 1);
      if (!/^[0-9A-F]{2}/.test(entry.name)) invalid("HAMT link requires two uppercase bucket characters");
      const bucket = Number.parseInt(entry.name.slice(0, 2), 16), at = body.length - 1 - (bucket >> 3);
      if (bucket <= previous || at < 0 || !(body[at]! & (1 << (bucket & 7)))) {
        invalid("HAMT bucket order, uniqueness or occupancy disagrees");
      }
      previous = bucket;
    }
    return { cid, kind: "hamt-directory", bytes, data: body, links, size: 0, metadata };
  }
  if (type === 4) {
    if (links.length) invalid("Symlink cannot have child links");
    work.charge("decodedBytes", body.length); // The public metadata target is one additional owned copy.
    return { cid, kind: "symlink", bytes, data: body, links, size: 0, metadata };
  }
  const names = new Set<string>();
  for (const item of links) {
    if (names.has(item.name)) invalid("duplicate directory name");
    names.add(item.name);
  }
  return { cid, kind: "directory", bytes, data: body, links, size: 0, metadata };
}

/** Open one verified node. No gateway, filesystem, credentials or hash capability is discovered.
 * Raw and DAG-PB SHA2-256 nodes are supported; unopened references can use other profiles but fail if selected.
 * Read ranges inspect selected branches only. verify() on a file explicitly walks every descendant, including
 * zero-size links; neither operation verifies directory siblings or an entire CAR. The reader remains borrowed.
 */
export async function openUnixfs(
  root: string | Uint8Array,
  readBlock: UnixfsBlockReaderType,
  options: UnixfsOptionsType,
): Promise<UnixfsNodeType> {
  options = { ...options };
  if (typeof readBlock !== "function") throw new TypeError("UnixFS requires an explicit block reader.");
  const digest = options.subtle.digest.bind(options.subtle), openingSignal = options.signal;
  if (options.hamtProfile !== undefined && options.hamtProfile !== "kubo-fanout-256") {
    throw new TypeError("UnixFS requires a named supported HAMT profile.");
  }
  const hamt = options.hamtProfile === "kubo-fanout-256";
  const policy: PolicyType = {
    block: options.maxBlockBytes ?? 1048576,
    links: options.maxLinks ?? 16384,
    depth: options.maxDepth ?? 64,
    name: options.maxNameBytes ?? 4096,
    index: options.maxIndexBytes ?? 4194304,
    nodes: options.maxNodes ?? 4096,
    edges: options.maxEdges ?? 100000,
    steps: options.maxSteps ?? 16777216,
    cache: options.maxCacheBytes ?? 4194304,
    entries: options.maxDirectoryEntries ?? 16384,
  };
  const ceilings: PolicyType = {
    block: 8388608,
    links: 65536,
    depth: 128,
    name: 65536,
    index: 16777216,
    nodes: 65536,
    edges: 1000000,
    steps: 67108864,
    cache: 16777216,
    entries: 65536,
  };
  for (const [key, value] of Object.entries(policy)) {
    integer(value, `UnixFS ${key}`);
    if (value > ceilings[key as keyof PolicyType]) throw new RangeError("UnixFS implementation ceiling exceeded.");
  }
  const lifetime = createArchiveLedger(options);
  const parents = [lifetime, ...(options.ledger ? [options.ledger] : [])];
  const context = (
    ancestors: readonly ArchiveLedgerType[],
    call: UnixfsCallOptionsType,
    parentSignal: AbortSignal | undefined,
  ): Work =>
    new Work(
      [...ancestors, createArchiveLedger(call), ...(call.ledger ? [call.ledger] : [])],
      policy,
      signals(openingSignal, parentSignal, call.signal),
    );
  async function load(cid: string, work: Work, depth: number): Promise<NodeType> {
    work.step();
    cap(depth, policy.depth, "depth");
    cap(1, policy.nodes - work.used.nodes, "nodes");
    work.used.nodes++;
    const cached = work.cache.get(cid);
    if (cached) {
      work.used.cacheHits++;
      return cached;
    }
    const parsed = parseCid(cid);
    if (parsed.hashCode !== 0x12 || parsed.digest.length !== 32 || (parsed.codec !== 0x55 && parsed.codec !== 0x70)) {
      unsupported("only SHA2-256 raw and DAG-PB blocks are supported");
    }
    work.charge("requests", 1);
    const incoming = await readBlock(parsed.id, {
      maxBytes: policy.block,
      ...(work.signal ? { signal: work.signal } : {}),
    });
    work.signal?.throwIfAborted();
    if (!isBytes(incoming)) invalid("block reader returned a non-native byte view");
    const view = toView(incoming);
    cap(view.length, policy.block, "serialized block bytes");
    // Callback allocation has already happened. Admit all owned copies and hash work before allocating any of them.
    work.charge("sourceBytes", view.length);
    work.charge("decodedBytes", view.length * 2);
    const bytes = new Uint8Array(view);
    const hash = new Uint8Array(await digest("SHA-256", new Uint8Array(bytes).buffer));
    work.signal?.throwIfAborted();
    if (hash.length !== 32 || hash.some((byte, index) => byte !== parsed.digest[index])) {
      invalid("CID block digest mismatch");
    }
    work.index(128);
    const result = node(parsed.id, bytes, parsed.codec, work, hamt);
    if (bytes.length <= policy.cache - work.used.cacheBytes) {
      work.cache.set(parsed.id, result);
      work.used.cacheBytes += bytes.length;
    }
    return result;
  }
  /** Each edge validates the fetched child's actual logical size, including cached shared children. */
  async function walk(
    current: NodeType,
    offset: number,
    length: number,
    whole: boolean,
    work: Work,
    depth: number,
    output: Uint8Array | undefined,
    destination = 0,
  ): Promise<void> {
    work.step();
    cap(depth, policy.depth, "depth");
    if (current.kind !== "file") invalid("File child is not a raw or DAG-PB File");
    if (!whole && !length) return;
    const end = offset + length, inlineEnd = Math.min(end, current.data.length);
    if (offset < inlineEnd && output) output.set(current.data.subarray(offset, inlineEnd), destination);
    // Logical offsets are computed while validating the complete local header. No child fetch is needed to seek.
    let first = 0, last = current.links.length;
    if (!whole) {
      while (first < last) {
        work.step();
        const middle = Math.floor((first + last) / 2), item = current.links[middle]!;
        if (item.offset! + item.size! <= offset) first = middle + 1;
        else last = middle;
      }
    }
    for (let index = whole ? 0 : first; index < current.links.length; index++) {
      const item = current.links[index]!, at = item.offset!, size = item.size!, next = at + size;
      if (!whole && at >= end) break;
      work.edge();
      if (whole || (size && next > offset)) {
        const child = await load(item.cid, work, depth + 1);
        if (child.kind !== "file" || child.size !== size) {
          invalid("fetched File child type or logical size disagrees with parent blocksizes");
        }
        const start = Math.max(at, offset), stop = Math.min(next, end), count = Math.max(0, stop - start);
        await walk(
          child,
          Math.max(0, start - at),
          count,
          whole,
          work,
          depth + 1,
          output,
          destination + Math.max(0, start - offset),
        );
      }
    }
    work.signal?.throwIfAborted();
  }
  async function read(
    current: NodeType,
    depth: number,
    ancestors: readonly ArchiveLedgerType[],
    parentSignal: AbortSignal | undefined,
    call: UnixfsReadOptionsType,
  ): Promise<UnixfsReadType> {
    call = { ...call };
    const offset = call.offset ?? 0, length = call.length ?? current.size - offset;
    sourceRange(current.size, offset, length);
    cap(length, 16777216, "buffered output bytes");
    const work = context(ancestors, call, parentSignal);
    work.charge("outputBytes", length);
    const bytes = new Uint8Array(length);
    await walk(current, offset, length, false, work, depth, bytes);
    return { bytes, integrity: "sha2-256-blocks", scope: "selected-file-range", work: work.inspect() };
  }
  /** Follow one hash route. A missing unselected shard cannot affect this selected lookup. */
  async function lookup(
    root: NodeType,
    name: string,
    depth: number,
    work: Work,
  ): Promise<{ node: NodeType; depth: number }> {
    const hash = nameHash(name, work), path: number[] = [];
    let current = root;
    while (true) {
      shard(current, path, work);
      const bucket = hash[path.length]!;
      let low = 0, high = current.links.length;
      while (low < high) {
        work.step();
        const middle = low + ((high - low) >> 1);
        if (Number.parseInt(current.links[middle]!.name.slice(0, 2), 16) < bucket) low = middle + 1;
        else high = middle;
      }
      const entry = current.links[low];
      if (!entry || Number.parseInt(entry.name.slice(0, 2), 16) !== bucket) {
        invalid("literal HAMT name is absent on its route");
      }
      if (entry.name.length > 2 && entry.name.slice(2) !== name) invalid("literal HAMT name is absent on its route");
      work.edge();
      const child = await load(entry.cid, work, ++depth);
      if (entry.name.length > 2) {
        if (child.kind === "hamt-directory") shard(child, [], work);
        return { node: child, depth };
      }
      path.push(bucket); // At most seven numbers: shard() refuses an eighth internal edge before I/O.
      current = child;
    }
  }
  /** Materialize only directory entries. Child file blocks are deliberately never acquired. */
  async function listing(current: NodeType, depth: number, work: Work): Promise<UnixfsListingType> {
    const entries: UnixfsLinkType[] = [], names = new Set<string>();
    async function visit(current: NodeType, depth: number, path: readonly number[]): Promise<void> {
      shard(current, path, work);
      for (const entry of current.links) {
        work.edge();
        if (entry.name.length === 2) {
          work.index(64); // Bounded path-array and recursive-frame estimate, before creating either.
          const child = await load(entry.cid, work, depth + 1);
          await visit(child, depth + 1, [...path, Number.parseInt(entry.name, 16)]);
        } else {
          cap(1, policy.entries - entries.length, "directory entries");
          work.index(128 + entry.name.length * 2 + entry.cid.length * 2);
          const name = entry.name.slice(2);
          if (names.has(name)) invalid("duplicate HAMT directory name");
          names.add(name);
          entries.push(
            Object.freeze({ name, cid: entry.cid, ...(entry.tsize === undefined ? {} : { tsize: entry.tsize }) }),
          );
          work.used.directoryEntries++;
        }
      }
    }
    await visit(current, depth, []);
    work.signal?.throwIfAborted();
    return Object.freeze({
      entries: Object.freeze(entries),
      integrity: "sha2-256-blocks",
      scope: "complete-directory-links",
      profile: "kubo-fanout-256",
      work: Object.freeze(work.inspect()),
    });
  }
  function view(
    current: NodeType,
    depth: number,
    ancestors: readonly ArchiveLedgerType[],
    signal: AbortSignal | undefined,
    opened: UnixfsWorkType,
  ): UnixfsNodeType {
    const base = {
      cid: current.cid,
      integrity: "sha2-256-block" as const,
      metadata: current.metadata,
      work: Object.freeze(opened),
    };
    if (current.kind === "symlink") {
      return Object.freeze({ ...base, kind: "symlink", target: new Uint8Array(current.data) });
    }
    if (current.kind === "hamt-directory") {
      return Object.freeze({
        ...base,
        kind: "hamt-directory",
        profile: "kubo-fanout-256",
        async open(name: string, call: UnixfsCallOptionsType = {}): Promise<UnixfsNodeType> {
          call = { ...call };
          if (
            typeof name !== "string" || !name.length || name.length > policy.name - 2 ||
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
          ) {
            throw new TypeError("UnixFS HAMT lookup requires a nonempty bounded well-formed literal name.");
          }
          // A non-ASCII caller name can fit UTF16 admission yet exceed its serialized UTF8 ceiling.
          let nameBytes = 0;
          for (const point of name) {
            const code = point.codePointAt(0)!;
            nameBytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
          }
          cap(nameBytes + 2, policy.name, "HAMT lookup name bytes including prefix");
          const childParents = [...ancestors, createArchiveLedger(call), ...(call.ledger ? [call.ledger] : [])];
          const childSignal = signals(signal, call.signal), work = context(childParents, {}, childSignal);
          const child = await lookup(current, name, depth, work);
          return view(child.node, child.depth, childParents, childSignal, work.inspect());
        },
        list(call: UnixfsCallOptionsType = {}): Promise<UnixfsListingType> {
          call = { ...call };
          return listing(current, depth, context(ancestors, call, signal));
        },
      });
    }
    if (current.kind === "directory") {
      return Object.freeze({
        ...base,
        kind: "directory",
        entries: Object.freeze(
          current.links.map(({ cid, name, tsize }) =>
            Object.freeze({ cid, name, ...(tsize === undefined ? {} : { tsize }) })
          ),
        ),
        async open(name: string, call: UnixfsCallOptionsType = {}): Promise<UnixfsNodeType> {
          call = { ...call };
          if (
            typeof name !== "string" || name.length > policy.name ||
            /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
          ) {
            throw new TypeError("UnixFS lookup requires a bounded well-formed literal name.");
          }
          cap(new TextEncoder().encode(name).length, policy.name, "lookup name bytes");
          const childParents = [...ancestors, createArchiveLedger(call), ...(call.ledger ? [call.ledger] : [])];
          const childSignal = signals(signal, call.signal), work = context(childParents, {}, childSignal);
          let entry: LinkType | undefined;
          for (const item of current.links) {
            work.edge();
            work.step(item.name.length + name.length);
            if (item.name === name) {
              entry = item;
              break;
            }
          }
          if (!entry) invalid("literal directory name is absent");
          const child = await load(entry.cid, work, depth + 1);
          if (child.kind === "hamt-directory") shard(child, [], work);
          return view(child, depth + 1, childParents, childSignal, work.inspect());
        },
      });
    }
    return Object.freeze({
      ...base,
      kind: "file",
      size: current.size,
      read: (call: UnixfsReadOptionsType = {}) => read(current, depth, ancestors, signal, call),
      async verify(call: UnixfsCallOptionsType = {}): Promise<UnixfsVerificationType> {
        call = { ...call };
        const work = context(ancestors, call, signal);
        await walk(current, 0, 0, true, work, depth, undefined);
        return { integrity: "sha2-256-blocks", scope: "complete-file", work: work.inspect() };
      },
      source(call: UnixfsCallOptionsType = {}): ByteSourceType {
        call = { ...call };
        const sourceSignal = signals(signal, call.signal);
        const sourceParents = [...ancestors, createArchiveLedger(call), ...(call.ledger ? [call.ledger] : [])];
        return Object.freeze({
          size: current.size,
          stability: "immutable",
          identity: JSON.stringify([current.cid, "unixfs-file-sha2-256"]),
          async read(offset: number, length: number, next: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
            const result = await read(current, depth, sourceParents, signals(sourceSignal, next.signal), {
              offset,
              length,
            });
            return result.bytes;
          },
        });
      },
    });
  }
  const work = new Work(parents, policy, openingSignal);
  const selected = await load(parseCid(root).id, work, 0);
  if (selected.kind === "hamt-directory") shard(selected, [], work);
  return view(selected, 0, parents, openingSignal, work.inspect());
}
