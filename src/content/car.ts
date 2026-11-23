/** CAR v1 block locations and independently verified block reads; no DAG traversal. @module */
import { budgetSource, createSourceBudget } from "../source.ts";
import type { ByteSourceType, SourceBudgetType, SourceReadOptionsType } from "../source.ts";
import { MAX_CID_BYTES, parseCid, readCid, readUnsigned, verifyBlock } from "./cid.ts";

/** An unchecked location is not evidence that its declared CID matches its bytes. */
export interface CarEntryType {
  readonly cid: string;
  readonly offset: number;
  readonly size: number;
  readonly integrity: "unchecked";
}

/** Whole serialized block whose SHA2-256 digest was checked before return. */
export interface CarBlockType {
  readonly cid: string;
  readonly bytes: Uint8Array;
  readonly integrity: "sha2-256";
}

/** Implementation/policy bounds. These are not CAR format limits. */
export interface CarOptionsType extends SourceReadOptionsType {
  readonly maxArchiveBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly maxBlockBytes?: number;
  readonly maxBlocks?: number;
  readonly maxRoots?: number;
  /** Shared physical read ledger; includes index requests and every later block read. */
  readonly budget?: SourceBudgetType;
}

/** The injected source remains borrowed. Roots are untrusted declarations, not proof of a complete DAG. */
export interface CarReaderType {
  readonly roots: readonly string[];
  readonly entries: readonly CarEntryType[];
  readonly budget: SourceBudgetType;
  read(cid: string | Uint8Array, options?: SourceReadOptionsType): Promise<CarBlockType>;
  /** Single-pass pull iterator. Early return starts no further reads and closes no borrowed source. */
  blocks(options?: SourceReadOptionsType): AsyncIterable<CarBlockType>;
}

/** Rejects unsafe user policy before reading or allocating. */
function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid CAR ${name} limit.`);
  return value;
}

/** Minimal definite-length DAG-CBOR header reader, deliberately not a general CBOR decoder.
 * Only the CAR map, roots array, CID tag 42, byte strings, and version integer
 * are admitted. All lengths are bounded by the already admitted header buffer.
 */
function header(bytes: Uint8Array, maxRoots: number): readonly string[] {
  let offset = 0;
  const item = (major: number): number => {
    const first = bytes[offset++];
    if (first === undefined || first >>> 5 !== major) throw new TypeError("Malformed CAR header CBOR type.");
    const additional = first & 31;
    if (additional < 24) return additional;
    const count = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
    if (count === 0 || count > bytes.length - offset) throw new TypeError("Unsupported or truncated CAR header CBOR.");
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + bytes[offset++]!;
    const minimum = count === 1 ? 24 : count === 2 ? 256 : 65536;
    if (value < minimum) throw new TypeError("Non-minimal CAR header CBOR.");
    return value;
  };
  const text = (): string => {
    const length = item(3);
    if (length > bytes.length - offset) throw new TypeError("Truncated CAR header key.");
    const result = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length));
    offset += length;
    return result;
  };
  if (item(5) !== 2 || text() !== "roots") {
    throw new TypeError("CAR header must contain canonical roots and version fields.");
  }
  const count = item(4);
  if (count > maxRoots) throw new RangeError("CAR root count exceeds its limit.");
  const roots: string[] = [];
  for (let i = 0; i < count; i++) {
    if (item(6) !== 42) throw new TypeError("CAR root requires a CID tag.");
    const length = item(2);
    if (length < 2 || length > MAX_CID_BYTES + 1 || length > bytes.length - offset || bytes[offset] !== 0) {
      throw new TypeError("Malformed CAR root CID byte string.");
    }
    roots.push(parseCid(bytes.subarray(offset + 1, offset + length)).id);
    offset += length;
  }
  if (text() !== "version" || item(0) !== 1 || offset !== bytes.length) {
    throw new TypeError("Only canonical CAR v1 headers are supported.");
  }
  return Object.freeze(roots);
}

/** Indexes a known-size CAR v1 source without materializing all payloads.
 * Defaults: archive 1 GiB, header 64 KiB, block 8 MiB, 100,000 sections and
 * 1,024 roots. The default shared ledger permits 64 MiB/300,000 physical reads.
 * CID parsing accepts opaque codecs, but every section must declare full SHA2-256.
 * Duplicate CIDs and zero-length sections are rejected by this reader profile.
 * Empty/missing declared roots are preserved, so this operation never asserts DAG completeness.
 */
export async function openCar(source: ByteSourceType, options: CarOptionsType = {}): Promise<CarReaderType> {
  const { signal } = options;
  signal?.throwIfAborted();
  const maxArchiveBytes = limit(options.maxArchiveBytes ?? 1024 * 1024 * 1024, "archive bytes");
  const maxHeaderBytes = limit(options.maxHeaderBytes ?? 65536, "header bytes");
  const maxBlockBytes = limit(options.maxBlockBytes ?? 8 * 1024 * 1024, "block bytes");
  const maxBlocks = limit(options.maxBlocks ?? 100000, "block count");
  const maxRoots = limit(options.maxRoots ?? 1024, "root count");
  if (!Number.isSafeInteger(source.size) || source.size < 1 || source.size > maxArchiveBytes) {
    throw new RangeError("CAR source size exceeds its archive limit or is empty.");
  }
  const budget = options.budget ?? createSourceBudget({ maxBytes: 64 * 1024 * 1024, maxRequests: 300000 });
  const input = budgetSource(source, budget);
  const readOptions = signal === undefined ? {} : { signal };
  const prefix = async (offset: number): Promise<{ readonly value: number; readonly length: number }> =>
    readUnsigned(await input.read(offset, Math.min(8, input.size - offset), readOptions));
  const first = await prefix(0);
  if (first.value > maxHeaderBytes || first.value > input.size - first.length) {
    throw new RangeError("CAR header exceeds its byte extent or limit.");
  }
  const roots = header(await input.read(first.length, first.value, readOptions), maxRoots);
  let offset = first.length + first.value;
  const entries: CarEntryType[] = [];
  const index = new Map<string, CarEntryType>();
  while (offset < input.size) {
    signal?.throwIfAborted();
    if (entries.length >= maxBlocks) throw new RangeError("CAR block count exceeds its limit.");
    const frame = await prefix(offset);
    offset += frame.length;
    if (frame.value === 0 || frame.value > input.size - offset || frame.value - MAX_CID_BYTES > maxBlockBytes) {
      throw new RangeError("CAR block section exceeds its byte extent or limit.");
    }
    const parsed = readCid(await input.read(offset, Math.min(frame.value, MAX_CID_BYTES), readOptions));
    if (parsed.cid.hashCode !== 0x12 || parsed.cid.digest.length !== 32) {
      throw new TypeError("Unsupported CAR block multihash.");
    }
    const size = frame.value - parsed.length;
    if (size > maxBlockBytes) throw new RangeError("CAR block exceeds its byte limit.");
    if (index.has(parsed.cid.id)) throw new TypeError("Duplicate CAR block CID is unsupported by this reader profile.");
    const entry: CarEntryType = Object.freeze({
      cid: parsed.cid.id,
      offset: offset + parsed.length,
      size,
      integrity: "unchecked",
    });
    entries.push(entry);
    index.set(entry.cid, entry);
    offset += frame.value;
  }
  const read = async (
    cid: string | Uint8Array,
    { signal: readSignal }: SourceReadOptionsType = {},
  ): Promise<CarBlockType> => {
    readSignal?.throwIfAborted();
    const parsed = parseCid(cid);
    if (parsed.hashCode !== 0x12 || parsed.digest.length !== 32) {
      throw new TypeError("Unsupported CAR block multihash.");
    }
    const entry = index.get(parsed.id);
    if (entry === undefined) throw new TypeError("Requested CID is absent from this CAR index.");
    const admitted = readSignal === undefined ? {} : { signal: readSignal };
    const bytes = new Uint8Array(await input.read(entry.offset, entry.size, admitted));
    await verifyBlock(parsed.bytes, bytes, { ...admitted, maxBytes: maxBlockBytes });
    return Object.freeze({ cid: parsed.id, bytes, integrity: "sha2-256" });
  };
  return Object.freeze({
    roots,
    entries: Object.freeze(entries),
    budget,
    read,
    async *blocks(readOptions: SourceReadOptionsType = {}): AsyncIterable<CarBlockType> {
      const { signal } = readOptions;
      for (const entry of entries) yield await read(entry.cid, signal === undefined ? {} : { signal });
    },
  });
}
