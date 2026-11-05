/** Bounded classic HDF5 root links and selected contiguous numeric values. @module */
import { isBytes, toView } from "../bytes.ts";
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Stored numeric values. Integer64 stays BigInt rather than losing precision in Number. */
export type Hdf5ValuesType =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | BigUint64Array
  | BigInt64Array
  | Float32Array
  | Float64Array;
/** One standard, full-precision scalar layout; this is not an arbitrary HDF5 datatype interpreter. */
export interface Hdf5DatatypeType {
  readonly kind: "signed" | "unsigned" | "float";
  readonly bytes: 1 | 2 | 4 | 8;
  readonly endian: "little" | "big";
}
/** Literal direct root link. Link targets remain metadata, never traversal instructions. */
export interface Hdf5LinkType {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly kind: "hard" | "soft";
  readonly objectAddress?: number;
  readonly target?: string;
}
/** Counts reserved work, including failed attempts. Metadata visits count replayed work, not unique objects. */
export interface Hdf5WorkType extends ArchiveWorkType {
  readonly metadataBytes: number;
  readonly nodes: number;
  readonly messages: number;
  readonly links: number;
}
/** Generic byte owners and ancestor cancellation remain authoritative for all derived views. */
export interface Hdf5CallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** A deliberately selected legacy writer grammar, not complete HDF5/netCDF-4 support. */
export interface Hdf5OpenOptionsType extends Hdf5CallOptionsType {
  readonly profile: "classic-contiguous";
  /** Total metadata bytes visited during this file lifetime: default 4 MiB, hard 16 MiB. */ readonly maxMetadataBytes?:
    number;
  /** Root links retained: default 4096, hard 65536. */ readonly maxLinks?: number;
  /** Metadata node visits: default 4096, hard 16384. */ readonly maxNodes?: number;
  /** Object messages visited: default 16384, hard 65536. */ readonly maxMessages?: number;
  /** Continuation depth: default 16, hard 64. */ readonly maxDepth?: number;
  /** Array rank: default 16, hard 32. */ readonly maxRank?: number;
  /** Literal name/soft-target UTF8 bytes: default 4096, hard 65536. */ readonly maxNameBytes?: number;
  /** Selected elements per operation: default 1,048,576, hard 4,194,304. */ readonly maxElements?: number;
  /** Selected bytes per operation: default 8 MiB, hard 32 MiB. */ readonly maxReadBytes?: number;
  /** Explicitly accept a source without snapshot stability evidence. Default false. */ readonly allowUnverifiedSource?:
    boolean;
}
/** Flat C-order element selection, with the last dataset dimension varying fastest. */
export interface Hdf5ReadOptionsType extends Hdf5CallOptionsType {
  readonly offset?: number;
  readonly count?: number;
}
/** Payload checksum/authentication is not provided by this contiguous profile. */
export interface Hdf5ReadType {
  readonly values: Hdf5ValuesType;
  readonly integrity: "not-provided";
  readonly work: Hdf5WorkType;
}
/** One allocated numeric extent. Source views retain the borrowed source's evidence and ownership. */
export interface Hdf5DatasetType {
  readonly name: string;
  readonly objectAddress: number;
  readonly shape: readonly number[];
  readonly elements: number;
  readonly datatype: Hdf5DatatypeType;
  readonly dataAddress: number | undefined;
  readonly byteLength: number;
  readonly integrity: "not-provided";
  readonly work: Hdf5WorkType;
  read(options?: Hdf5ReadOptionsType): Promise<Hdf5ReadType>;
  /** Raw stored bytes retain file byte order; no value conversion, checksum or ownership transfer occurs. */
  source(options?: Hdf5CallOptionsType): ByteSourceType;
}
/** Complete direct root links only within the admitted classic tree profile; no recursive graph claim. */
export interface Hdf5FileType {
  readonly profile: "classic-contiguous";
  readonly scope: "root-links";
  readonly integrity: "not-provided";
  readonly work: Hdf5WorkType;
  list(options?: Hdf5CallOptionsType): readonly Hdf5LinkType[];
  dataset(name: string, options?: Hdf5CallOptionsType): Promise<Hdf5DatasetType>;
}
function cap(n: number, max: number, label: string): void {
  if (n > max) throw new ArchiveError("budget-exceeded", `${label} exceeded.`);
}
function limit(n: number | undefined, fallback: number, hard: number, label: string): number {
  const value = n ?? fallback;
  integer(value, label);
  cap(value, hard, label);
  return value;
}
function exact(n: bigint, label: string): number {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) unsupported(`${label} exceeds safe address arithmetic.`);
  return Number(n);
}
function combined(...items: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = [...new Set(items.filter((s): s is AbortSignal => s !== undefined))];
  return list.length === 0 ? undefined : list.length === 1 ? list[0] : AbortSignal.any(list);
}
interface OwnerType {
  readonly identity: ArchiveLedgerType;
  readonly reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  readonly owners: readonly OwnerType[];
  readonly signal: AbortSignal | undefined;
}
/** Bind each newly admitted capability once while deduplicating its actual identity across ancestors. */
function authority(options: Hdf5CallOptionsType, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (!owners.some((owner) => owner.identity === ledger)) {
      const reserve = ledger.reserve, inspect = ledger.inspect;
      if (typeof reserve !== "function" || typeof inspect !== "function") {
        throw new TypeError("HDF5 ledger requires reserve and inspect.");
      }
      owners.push({ identity: ledger, reserve: reserve.bind(ledger) });
    }
  }
  cap(owners.length, 16, "HDF5 inherited ledger owners");
  return { owners, signal: combined(parent?.signal, options.signal) };
}
interface WorkType {
  sourceBytes: number;
  requests: number;
  decodedBytes: number;
  outputBytes: number;
  metadataBytes: number;
  nodes: number;
  messages: number;
  links: number;
}
function fresh(): WorkType {
  return {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    metadataBytes: 0,
    nodes: 0,
    messages: 0,
    links: 0,
  };
}
function charge(auth: AuthorityType, work: WorkType, kind: keyof ArchiveWorkType, count: number): void {
  integer(count, "HDF5 work");
  for (const owner of auth.owners) owner.reserve(kind, count);
  work[kind] += count;
}
function zero(bytes: Uint8Array, label: string): void {
  if (bytes.some((byte) => byte !== 0)) invalid(`Nonzero ${label} reserved bytes.`);
}
function signature(bytes: Uint8Array, text: string): boolean {
  return bytes.length >= text.length && [...text].every((c, i) => bytes[i] === c.charCodeAt(0));
}
const missing = 0xffffffffffffffffn;
/** A physical address may be undefined; lengths never silently inherit that meaning. */
function address(data: DataView, at: number): number | undefined {
  const n = data.getBigUint64(at, true);
  return n === missing ? undefined : exact(n, "HDF5 address");
}
function required(data: DataView, at: number): number {
  const n = address(data, at);
  if (n === undefined) invalid("HDF5 required address is undefined.");
  return n;
}
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Open finite legacy metadata without following links or acquiring host resources. */
export async function openHdf5(input: ByteSourceType, inputOptions: Hdf5OpenOptionsType): Promise<Hdf5FileType> {
  const options = { ...inputOptions };
  if (options.profile !== "classic-contiguous") {
    throw new TypeError("Select the classic-contiguous HDF5 profile explicitly.");
  }
  const { size, identity, stability } = input;
  const read = input.read.bind(input);
  integer(size, "HDF5 source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length === 0)) {
    throw new TypeError("HDF5 source identity must be nonempty.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown HDF5 source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    unsupported("HDF5 metadata/range composition requires stable source evidence or explicit allowUnverifiedSource.");
  }
  const policy = {
    metadata: limit(options.maxMetadataBytes, 4 * 1024 * 1024, 16 * 1024 * 1024, "HDF5 metadata bytes"),
    links: limit(options.maxLinks, 4096, 65536, "HDF5 links"),
    nodes: limit(options.maxNodes, 4096, 16384, "HDF5 nodes"),
    messages: limit(options.maxMessages, 16384, 65536, "HDF5 messages"),
    depth: limit(options.maxDepth, 16, 64, "HDF5 continuation depth"),
    rank: limit(options.maxRank, 16, 32, "HDF5 rank"),
    name: limit(options.maxNameBytes, 4096, 65536, "HDF5 name bytes"),
    elements: limit(options.maxElements, 1048576, 4194304, "HDF5 selected elements"),
    read: limit(options.maxReadBytes, 8 * 1024 * 1024, 32 * 1024 * 1024, "HDF5 selected bytes"),
  };
  const opening = authority(options);
  const lifetime = fresh();
  let end = size;
  function inspect(): Hdf5WorkType {
    return Object.freeze({ ...lifetime });
  }
  function count(work: WorkType, key: "metadataBytes" | "nodes" | "messages" | "links", n: number, max: number): void {
    cap(lifetime[key] + n, max, `HDF5 ${key}`);
    lifetime[key] += n;
    if (work !== lifetime) work[key] += n;
  }
  function reserve(auth: AuthorityType, work: WorkType, kind: keyof ArchiveWorkType, n: number): void {
    charge(auth, work, kind, n);
    if (work !== lifetime) lifetime[kind] += n;
  }
  /** Admission precedes buffers and provider callbacks. Callbacks can allocate internally; that is borrowed authority. */
  function plan(
    auth: AuthorityType,
    work: WorkType,
    offset: number,
    length: number,
    decoded: boolean,
    output: boolean,
  ): void {
    auth.signal?.throwIfAborted();
    sourceRange(end, offset, length);
    reserve(auth, work, "sourceBytes", length);
    reserve(auth, work, "requests", Math.ceil(length / 65536));
    if (decoded) reserve(auth, work, "decodedBytes", length);
    if (output) reserve(auth, work, "outputBytes", length);
    auth.signal?.throwIfAborted();
  }
  async function collect(auth: AuthorityType, offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at += 65536) {
      auth.signal?.throwIfAborted();
      const n = Math.min(65536, length - at);
      const next = await read(offset + at, n, auth.signal ? { signal: auth.signal } : {});
      auth.signal?.throwIfAborted();
      if (!isBytes(next)) invalid("HDF5 source returned non-bytes.");
      const bytes = toView(next);
      if (bytes.byteLength !== n) invalid("HDF5 source did not return the exact requested extent.");
      out.set(bytes, at);
    }
    return out;
  }
  async function meta(auth: AuthorityType, work: WorkType, offset: number, length: number): Promise<Uint8Array> {
    count(work, "metadataBytes", length, policy.metadata);
    plan(auth, work, offset, length, true, false);
    return await collect(auth, offset, length);
  }
  function node(work: WorkType): void {
    count(work, "nodes", 1, policy.nodes);
  }
  const header = await meta(opening, lifetime, 0, 96);
  const hd = view(header);
  if (![137, 72, 68, 70, 13, 10, 26, 10].every((n, i) => header[i] === n)) {
    invalid("HDF5 signature is absent at byte zero; user blocks are outside this profile.");
  }
  if (header[8] !== 0) unsupported("HDF5 profile requires superblock version zero.");
  if (header[9] !== 0 || header[10] !== 0 || header[12] !== 0 || header[13] !== 8 || header[14] !== 8) {
    unsupported("HDF5 profile requires classic metadata versions and eight-byte addresses/lengths.");
  }
  zero(header.subarray(11, 12), "superblock");
  zero(header.subarray(15, 16), "superblock");
  if (required(hd, 24) !== 0 || address(hd, 48) !== undefined) {
    unsupported("HDF5 rebased files and driver information are outside this profile.");
  }
  end = required(hd, 40);
  if (end < 96 || end > size) invalid("HDF5 declared end of allocation exceeds source or header.");
  if (hd.getUint32(20, true) !== 0) unsupported("HDF5 live/consistency flags are outside this snapshot profile.");
  const leafK = hd.getUint16(16, true), internalK = hd.getUint16(18, true);
  if (!leafK || !internalK) invalid("HDF5 group fanout must be nonzero.");
  const root = required(hd, 64);
  interface MessageType {
    readonly type: number;
    readonly bytes: Uint8Array;
  }
  /** Continuation extents are globally unique within one object; recursion is bounded before reads. */
  async function messages(auth: AuthorityType, work: WorkType, at: number): Promise<readonly MessageType[]> {
    node(work);
    const prefix = await meta(auth, work, at, 16);
    const p = view(prefix);
    if (prefix[0] !== 1) unsupported("HDF5 profile requires object-header version one.");
    zero(prefix.subarray(1, 2), "object header");
    zero(prefix.subarray(12, 16), "object header");
    const expected = p.getUint16(2, true), length = p.getUint32(8, true);
    if (length % 8) invalid("HDF5 object header size is not aligned.");
    const todo = [{ at: at + 16, length, depth: 0 }];
    const visited: [number, number][] = [[at, 16]];
    const result: MessageType[] = [];
    let total = 0;
    while (todo.length) {
      const next = todo.pop()!;
      cap(next.depth, policy.depth, "HDF5 continuation depth");
      sourceRange(end, next.at, next.length);
      let low = 0, high = visited.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (visited[middle]![0] < next.at) low = middle + 1;
        else high = middle;
      }
      const before = visited[low - 1], after = visited[low];
      if ((before && before[0] + before[1] > next.at) || (after && next.at + next.length > after[0])) {
        invalid("HDF5 object continuation extents overlap or cycle.");
      }
      visited.splice(low, 0, [next.at, next.length]);
      if (next.depth !== 0) node(work);
      const bytes = await meta(auth, work, next.at, next.length);
      let pos = 0;
      while (pos < bytes.length) {
        if (bytes.length - pos < 8) invalid("Truncated HDF5 object message.");
        const d = view(bytes.subarray(pos));
        const type = d.getUint16(0, true), n = d.getUint16(2, true), flags = bytes[pos + 4]!;
        zero(bytes.subarray(pos + 5, pos + 8), "message");
        if (n % 8 || n > bytes.length - pos - 8) invalid("HDF5 message size is invalid.");
        if (flags & 0xfe) unsupported("HDF5 shared/conditional message flags are outside this profile.");
        count(work, "messages", 1, policy.messages);
        total++;
        const body = bytes.subarray(pos + 8, pos + 8 + n);
        pos += 8 + n;
        if (type === 16) {
          if (n !== 16) invalid("HDF5 continuation message size is invalid.");
          const c = view(body);
          const offset = required(c, 0), size = exact(c.getBigUint64(8, true), "HDF5 continuation size");
          if (size % 8 || size === 0) invalid("HDF5 continuation size is invalid.");
          todo.push({ at: offset, length: size, depth: next.depth + 1 });
        } else result.push({ type, bytes: body });
      }
    }
    if (total !== expected) invalid("HDF5 object message count disagrees with its header.");
    return result;
  }
  function single(items: readonly MessageType[], type: number, needed = true): Uint8Array | undefined {
    const found = items.filter((x) => x.type === type);
    if (found.length > 1) invalid("Duplicate HDF5 authority message.");
    if (needed && !found.length) invalid("Missing HDF5 authority message.");
    return found[0]?.bytes;
  }
  const rootMessages = await messages(opening, lifetime, root);
  const symbol = single(rootMessages, 17)!;
  if (symbol.length !== 16) invalid("HDF5 symbol-table message size is invalid.");
  const symbolView = view(symbol), treeAddress = required(symbolView, 0), heapAddress = required(symbolView, 8);
  zero(header.subarray(76, 80), "root symbol entry");
  if (hd.getBigUint64(56, true) !== 0n) invalid("HDF5 root symbol name offset is not zero.");
  const rootCache = hd.getUint32(72, true);
  if (rootCache !== 0 && rootCache !== 1) unsupported("HDF5 root symbol cache type is outside this group profile.");
  if (rootCache === 1 && (required(hd, 80) !== treeAddress || required(hd, 88) !== heapAddress)) {
    invalid("HDF5 cached root tree/heap disagrees with its symbol-table message.");
  }
  node(lifetime);
  const heapPrefix = await meta(opening, lifetime, heapAddress, 32), hp = view(heapPrefix);
  if (!signature(heapPrefix, "HEAP") || heapPrefix[4] !== 0) {
    unsupported("HDF5 profile requires version-zero local heaps.");
  }
  zero(heapPrefix.subarray(5, 8), "local heap");
  const heapSize = exact(hp.getBigUint64(8, true), "HDF5 heap size");
  const heap = await meta(opening, lifetime, required(hp, 24), heapSize);
  function text(offset: number, literal: boolean): { name: string; bytes: Uint8Array } {
    if (offset >= heap.length) invalid("HDF5 heap string offset is outside heap.");
    let stop = offset;
    while (stop < heap.length && heap[stop] !== 0) {
      cap(stop - offset + 1, policy.name, "HDF5 name bytes");
      stop++;
    }
    if (stop === heap.length) invalid("HDF5 heap string is unterminated.");
    const bytes = heap.subarray(offset, stop);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("HDF5 name is not valid UTF-8.");
    }
    if (literal && (!name || name === "." || name === ".." || name.includes("/"))) {
      unsupported("HDF5 root name is outside the literal direct-link profile.");
    }
    return { name, bytes };
  }
  node(lifetime);
  const treePrefix = await meta(opening, lifetime, treeAddress, 24), tp = view(treePrefix);
  if (!signature(treePrefix, "TREE") || treePrefix[4] !== 0) {
    unsupported("HDF5 profile requires a classic group B-tree.");
  }
  if (treePrefix[5] !== 0) unsupported("HDF5 profile supports only a level-zero root B-tree.");
  if (address(tp, 8) !== undefined || address(tp, 16) !== undefined) invalid("HDF5 root B-tree cannot have siblings.");
  const children = tp.getUint16(6, true);
  if (children > 2 * internalK) invalid("HDF5 root B-tree child count exceeds fanout.");
  cap(children, policy.nodes, "HDF5 root children");
  const tree = await meta(opening, lifetime, treeAddress + 24, 8 + children * 16), tv = view(tree);
  const links: Hdf5LinkType[] = [];
  let retained = 0;
  function retain(nameBytes: number, targetBytes = 0): void {
    retained += 128 + nameBytes * 3 + targetBytes * 2;
    cap(retained, policy.metadata, "HDF5 retained link metadata bytes");
  }
  const childSeen = new Set<number>();
  let previous: Uint8Array | undefined;
  for (let child = 0; child < children; child++) {
    const lower = text(exact(tv.getBigUint64(child * 16, true), "HDF5 B-tree key"), false).bytes;
    const upper = text(exact(tv.getBigUint64(child * 16 + 16, true), "HDF5 B-tree key"), false).bytes;
    if ((child === 0 && lower.length !== 0) || (previous && compare(previous, lower) !== 0)) {
      invalid("HDF5 root B-tree boundary keys disagree.");
    }
    const offset = required(tv, child * 16 + 8);
    if (childSeen.has(offset)) invalid("Duplicate HDF5 root child pointer.");
    childSeen.add(offset);
    node(lifetime);
    const prefix = await meta(opening, lifetime, offset, 8), pv = view(prefix);
    if (!signature(prefix, "SNOD") || prefix[4] !== 1) unsupported("HDF5 profile requires version-one symbol nodes.");
    zero(prefix.subarray(5, 6), "symbol node");
    const n = pv.getUint16(6, true);
    if (n === 0 || n > 2 * leafK) invalid("HDF5 symbol-node count exceeds fanout or is zero.");
    count(lifetime, "links", n, policy.links);
    const entries = await meta(opening, lifetime, offset + 8, n * 40);
    let last = lower;
    for (let i = 0; i < n; i++) {
      const entry = entries.subarray(i * 40, (i + 1) * 40), v = view(entry);
      const named = text(exact(v.getBigUint64(0, true), "HDF5 name offset"), true);
      if (compare(last, named.bytes) >= 0) invalid("HDF5 root links are duplicate or unsorted.");
      last = named.bytes;
      zero(entry.subarray(20, 24), "symbol entry");
      const cache = v.getUint32(16, true), objectAddress = address(v, 8);
      if (cache === 2) {
        if (objectAddress !== undefined) invalid("HDF5 soft link has an object address.");
        const targetText = text(v.getUint32(24, true), false);
        retain(named.bytes.length, targetText.bytes.length);
        const target = targetText.name;
        links.push(Object.freeze({ name: named.name, nameBytes: new Uint8Array(named.bytes), kind: "soft", target }));
      } else if (cache === 0 || cache === 1) {
        retain(named.bytes.length);
        if (objectAddress === undefined) invalid("HDF5 hard link lacks an object address.");
        links.push(
          Object.freeze({ name: named.name, nameBytes: new Uint8Array(named.bytes), kind: "hard", objectAddress }),
        );
      } else unsupported("HDF5 symbol cache type is outside this profile.");
    }
    if (compare(last, upper) !== 0) invalid("HDF5 root B-tree upper key differs from its last link.");
    previous = upper;
  }
  opening.signal?.throwIfAborted();
  function datatype(bytes: Uint8Array): Hdf5DatatypeType {
    if (bytes.length < 16) invalid("Truncated HDF5 datatype.");
    const d = view(bytes),
      version = bytes[0]! >>> 4,
      kind = bytes[0]! & 15,
      flags = d.getUint32(0, true) >>> 8,
      width = d.getUint32(4, true);
    if (version !== 1 || ![1, 2, 4, 8].includes(width)) {
      unsupported("HDF5 datatype version/width is outside this numeric profile.");
    }
    if (d.getUint16(8, true) !== 0 || d.getUint16(10, true) !== width * 8) {
      unsupported("HDF5 datatype must have full precision and zero bit offset.");
    }
    const endian = flags & 1 ? "big" : "little";
    if (kind === 0) {
      if (bytes.length !== 16) invalid("HDF5 integer datatype extent is invalid.");
      zero(bytes.subarray(12), "integer datatype");
      if (flags & ~9) unsupported("HDF5 integer padding/bitfields are outside this profile.");
      return Object.freeze({ kind: flags & 8 ? "signed" : "unsigned", bytes: width as 1 | 2 | 4 | 8, endian });
    }
    if (kind !== 1 || (width !== 4 && width !== 8) || bytes.length < 24) {
      unsupported("HDF5 datatype is not a supported integer or IEEE float.");
    }
    if (bytes.length !== 24) invalid("HDF5 float datatype extent is invalid.");
    zero(bytes.subarray(20), "float datatype");
    const small = width === 4;
    if (
      flags !== ((small ? 0x1f20 : 0x3f20) | (flags & 1)) || bytes[12] !== (small ? 23 : 52) ||
      bytes[13] !== (small ? 8 : 11) || bytes[14] !== 0 || bytes[15] !== (small ? 23 : 52) ||
      d.getUint32(16, true) !== (small ? 127 : 1023)
    ) unsupported("HDF5 floating datatype is not standard IEEE binary32/binary64.");
    return Object.freeze({ kind: "float", bytes: width, endian });
  }
  function values(length: number, type: Hdf5DatatypeType): Hdf5ValuesType {
    if (type.kind === "float") return type.bytes === 4 ? new Float32Array(length) : new Float64Array(length);
    if (type.kind === "signed") {
      return type.bytes === 1
        ? new Int8Array(length)
        : type.bytes === 2
        ? new Int16Array(length)
        : type.bytes === 4
        ? new Int32Array(length)
        : new BigInt64Array(length);
    }
    return type.bytes === 1
      ? new Uint8Array(length)
      : type.bytes === 2
      ? new Uint16Array(length)
      : type.bytes === 4
      ? new Uint32Array(length)
      : new BigUint64Array(length);
  }
  async function dataset(name: string, call: Hdf5CallOptionsType = {}): Promise<Hdf5DatasetType> {
    const auth = authority({ ...call }, opening), work = fresh();
    auth.signal?.throwIfAborted();
    if (typeof name !== "string" || name.length > policy.name) throw new TypeError("HDF5 dataset name exceeds policy.");
    const link = links.find((link) => link.name === name);
    if (!link || link.kind !== "hard") {
      unsupported("Select an existing direct hard link; soft links are never followed.");
    }
    const objectAddress = link.objectAddress!;
    const items = await messages(auth, work, objectAddress);
    if (single(items, 17, false)) unsupported("Selected HDF5 link is a group, not a dataset.");
    if (single(items, 7, false) || single(items, 11, false)) {
      unsupported("External storage and filter pipelines are outside this profile.");
    }
    const type = datatype(single(items, 3)!);
    const space = single(items, 1)!;
    if (space.length < 8 || space[0] !== 1) unsupported("HDF5 profile requires dataspace version one.");
    const rank = space[1]!, flags = space[2]!;
    cap(rank, policy.rank, "HDF5 rank");
    if (flags & ~1) unsupported("HDF5 dataspace flags are outside this profile.");
    zero(space.subarray(3, 8), "dataspace");
    const expected = 8 + rank * 8 * (flags & 1 ? 2 : 1);
    if (space.length !== expected) invalid("HDF5 dataspace extent is invalid.");
    const sv = view(space);
    let product = 1n;
    const shape: number[] = [];
    for (let i = 0; i < rank; i++) {
      const dim = sv.getBigUint64(8 + i * 8, true);
      shape.push(exact(dim, "HDF5 dimension"));
      product *= dim;
      if (flags & 1) {
        const max = sv.getBigUint64(8 + rank * 8 + i * 8, true);
        if (max !== missing && max < dim) invalid("HDF5 maximum dimension is smaller than current dimension.");
      }
    }
    const elements = exact(product, "HDF5 element count"),
      byteLength = exact(product * BigInt(type.bytes), "HDF5 dataset bytes");
    const layout = single(items, 8)!;
    if (layout.length < 2 || layout[0] !== 3 || layout[1] !== 1) {
      unsupported("HDF5 profile requires version-three contiguous layout.");
    }
    if (layout.length !== 24) invalid("HDF5 contiguous layout extent is invalid.");
    const lv = view(layout),
      dataAddress = address(lv, 2),
      stored = exact(lv.getBigUint64(10, true), "HDF5 stored size");
    zero(layout.subarray(18), "contiguous layout");
    if (stored !== byteLength) unsupported("HDF5 unallocated or mismatched contiguous storage is not synthesized.");
    if (dataAddress === undefined && byteLength !== 0) {
      unsupported("HDF5 nonempty unallocated data has no stored values.");
    }
    if (dataAddress !== undefined) sourceRange(end, dataAddress, byteLength);
    const descriptor = {
      name,
      objectAddress,
      shape: Object.freeze(shape),
      elements,
      datatype: type,
      dataAddress,
      byteLength,
      integrity: "not-provided" as const,
    };
    function selection(next: Hdf5ReadOptionsType): { offset: number; count: number; bytes: number } {
      const offset = next.offset ?? 0;
      integer(offset, "HDF5 element offset");
      if (offset > elements) throw new RangeError("HDF5 element offset exceeds dataset.");
      const count = next.count ?? elements - offset;
      integer(count, "HDF5 element count");
      if (count > elements - offset) throw new RangeError("HDF5 element interval exceeds dataset.");
      cap(count, policy.elements, "HDF5 selected elements");
      const bytes = count * type.bytes;
      cap(bytes, policy.read, "HDF5 selected bytes");
      return { offset, count, bytes };
    }
    return Object.freeze({
      ...descriptor,
      get work() {
        return Object.freeze({ ...work });
      },
      async read(input: Hdf5ReadOptionsType = {}): Promise<Hdf5ReadType> {
        const next = { ...input };
        const a = authority(next, auth), w = fresh();
        a.signal?.throwIfAborted();
        const pick = selection(next);
        plan(a, w, (dataAddress ?? 0) + pick.offset * type.bytes, pick.bytes, true, true);
        const out = values(pick.count, type);
        const little = type.endian === "little";
        for (let pos = 0; pos < pick.bytes; pos += 65536) {
          const length = Math.min(65536, pick.bytes - pos),
            packed = await collect(a, dataAddress! + pick.offset * type.bytes + pos, length),
            d = view(packed);
          for (let j = 0; j < length; j += type.bytes) {
            const i = (pos + j) / type.bytes;
            if (out instanceof BigInt64Array) out[i] = d.getBigInt64(j, little);
            else if (out instanceof BigUint64Array) out[i] = d.getBigUint64(j, little);
            else {out[i] = type.kind === "float"
                ? (type.bytes === 4 ? d.getFloat32(j, little) : d.getFloat64(j, little))
                : type.kind === "signed"
                ? (type.bytes === 1 ? d.getInt8(j) : type.bytes === 2 ? d.getInt16(j, little) : d.getInt32(j, little))
                : (type.bytes === 1
                  ? d.getUint8(j)
                  : type.bytes === 2
                  ? d.getUint16(j, little)
                  : d.getUint32(j, little));}
          }
        }
        a.signal?.throwIfAborted();
        return { values: out, integrity: "not-provided", work: Object.freeze({ ...w }) };
      },
      source(input: Hdf5CallOptionsType = {}): ByteSourceType {
        const a = authority({ ...input }, auth);
        a.signal?.throwIfAborted();
        return Object.freeze({
          size: byteLength,
          ...(identity === undefined
            ? {}
            : { identity: JSON.stringify(["hdf5-contiguous", identity, objectAddress, dataAddress, byteLength]) }),
          ...(stability === undefined ? {} : { stability }),
          async read(
            offset: number,
            length: number,
            call: { readonly signal?: AbortSignal } = {},
          ): Promise<Uint8Array> {
            const signal = combined(a.signal, call.signal), borrowed = { ...a, signal };
            signal?.throwIfAborted();
            sourceRange(byteLength, offset, length);
            cap(length, policy.read, "HDF5 raw selected bytes");
            const w = fresh();
            plan(borrowed, w, (dataAddress ?? 0) + offset, length, true, true);
            return await collect(borrowed, (dataAddress ?? 0) + offset, length);
          },
        });
      },
    });
  }
  return Object.freeze({
    profile: "classic-contiguous",
    scope: "root-links",
    integrity: "not-provided",
    get work() {
      return inspect();
    },
    list(call: Hdf5CallOptionsType = {}): readonly Hdf5LinkType[] {
      const a = authority({ ...call }, opening);
      a.signal?.throwIfAborted();
      const bytes = links.reduce(
        (n, link) =>
          n + link.nameBytes.length + (link.target === undefined ? 0 : new TextEncoder().encode(link.target).length),
        0,
      );
      reserve(a, fresh(), "outputBytes", bytes);
      a.signal?.throwIfAborted();
      return Object.freeze(links.map((link) => Object.freeze({ ...link, nameBytes: new Uint8Array(link.nameBytes) })));
    },
    dataset,
  });
}
