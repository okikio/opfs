/** Bounded read-only Zarr v2 uncompressed numeric arrays over a snapshot store. @module */
import type { ByteSourceType } from "../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  createArchiveLedger,
  integer,
  invalid,
  unsupported,
  view,
} from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Stability covers the whole namespace: object contents AND missing/present keys.
 * Object sources remain borrowed. An immutable per-object ETag is insufficient. */
export interface ZarrStoreType {
  /** Whole-namespace lifetime promise, including absent keys; no live bucket inference. */
  readonly stability: "immutable" | "caller";
  /** Resolves one logical key; undefined means absent. Sources remain borrowed. */
  open(key: string, options?: { readonly signal?: AbortSignal }): Promise<ByteSourceType | undefined>;
}
/** Separate aggregate authority for object lookups, including absent keys. */
export interface ZarrObjectLedgerType {
  reserve(count: number): void;
  inspect(): number;
}
/** Creates a finite explicit lookup owner. No cache, registration or I/O. */
export function createZarrObjectLedger(maxObjects = 4096): ZarrObjectLedgerType {
  integer(maxObjects, "Zarr object limit");
  let used = 0;
  return {
    reserve(count) {
      integer(count, "Zarr object count");
      if (count > maxObjects - used) throw new ArchiveError("budget-exceeded", "Zarr object lookup limit exceeded.");
      used += count;
    },
    inspect: () => used,
  };
}
/** Successful operation byte work plus store lookups, which may have no byte source. */
export interface ZarrWorkType extends ArchiveWorkType {
  readonly objects: number;
}
/** Raw numeric storage values; boolean values are normalized Uint8Array 0 or 1. */
export type ZarrValuesType =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;
/** Finite selection policy; opening owners remain authorities for later reads. */
export interface ZarrLimitsType extends ArchiveLimitsType {
  /** Store lookups per operation, including missing keys. Default 4096. */
  readonly maxObjects?: number;
  /** Optional cross-reader lookup authority, separate from byte ledgers. */
  readonly objectLedger?: ZarrObjectLedgerType;
  /** Composes with the opening signal; neither authority can be replaced by a read. */
  readonly signal?: AbortSignal;
}
/** Uncompressed v2 profile only; compressed/filter/type extensions require another profile. */
export interface ZarrOpenOptionsType extends ZarrLimitsType {
  /** Logical ASCII array path. Normalized by the v2 rules; dot segments refuse. Default root. */
  readonly path?: string;
  /** Complete .zarray bytes. Default 1 MiB, admitted before materialization. */
  readonly maxMetadataBytes?: number;
  /** Number of array axes. Default 32. */
  readonly maxRank?: number;
  /** Maximum declared raw bytes per full chunk, even for a small read. Default 64 MiB. */
  readonly maxChunkBytes?: number;
  /** Returned elements per read. Default 1,048,576. */
  readonly maxElements?: number;
  /** Unique chunk keys per read, including missing keys. Default 4096. */
  readonly maxChunks?: number;
  /** Exact byte-range segments retained per read. Default 4096. */
  readonly maxSegments?: number;
  /** Axis-coordinate decisions per read, checked before planning. Default 16,777,216. */
  readonly maxPlanSteps?: number;
}
/** Flat zero-based selection in C logical order, independently of stored C/F order. */
export interface ZarrReadOptionsType extends ZarrLimitsType {
  /** First flat C-order element, default zero. This is not a byte offset. */
  readonly offset?: number;
  /** Number of elements, default remaining elements; zero still observes cancellation. */
  readonly count?: number;
}
/** fillMask 1 means synthesized from an absent chunk, not a semantic missing-value claim. */
export interface ZarrReadType {
  readonly values: ZarrValuesType;
  readonly fillMask: Uint8Array;
  readonly integrity: "not-provided";
  readonly work: ZarrWorkType;
}
/** One array, no group traversal, metadata consolidation, publication or extraction. */
export interface ZarrArrayType {
  readonly path: string;
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dtype: string;
  readonly order: "C" | "F";
  readonly separator: "." | "/";
  readonly elements: number;
  readonly chunkBytes: number;
  readonly fillValue: number | bigint | null;
  readonly work: ZarrWorkType;
  read(options?: ZarrReadOptionsType): Promise<ZarrReadType>;
}
/** Products and stored coordinates remain BigInt until checked for exact JS indexing. */
function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported("Zarr extent exceeds safe JavaScript indexing.");
  }
  return Number(value);
}
/** A caller can raise a finite policy; NaN, infinities, fractions and negatives refuse. */
function limit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  integer(result, label);
  return result;
}

/** Duplicate-aware lexical preflight preserves integer authority before JSON.parse
 * can round it. Metadata depth32, 100k tokens, scalar128 characters and byte policy
 * bound parser work. Shape/chunk numbers must be unsigned integer lexemes. */
function metadata(text: string): { value: unknown; fillToken: string | undefined } {
  let at = 0, tokens = 0, fillToken: string | undefined;
  const fail = (): never => invalid("Malformed, duplicate or over-budget Zarr metadata JSON.");
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const next = text[at++];
      if (next === "\\") {
        at++;
        continue;
      }
      if (next === '"') {
        const value: unknown = JSON.parse(text.slice(start, at));
        if (typeof value !== "string") return fail();
        return value;
      }
    }
    return fail();
  };
  const value = (depth: number, authority?: string): void => {
    if (++tokens > 100000 || depth > 32) fail();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (true) {
        space();
        if (text[at] !== '"') fail();
        const key = string();
        if (keys.has(key) || key === "__proto__" || key === "constructor" || key === "prototype") fail();
        keys.add(key);
        space();
        if (text[at++] !== ":") fail();
        value(depth + 1, depth === 0 ? key : undefined);
        space();
        const end = text[at++];
        if (end === "}") return;
        if (end !== ",") fail();
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (true) {
        value(depth + 1, authority);
        space();
        const end = text[at++];
        if (end === "]") return;
        if (end !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start >= 128) fail();
      at++;
    }
    const token = text.slice(start, at);
    if (authority === "fill_value") fillToken = token;
    if (["true", "false", "null"].includes(token)) return;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token) || !Number.isFinite(Number(token))) fail();
    if (
      (authority === "shape" || authority === "chunks" || authority === "zarr_format") &&
      (!/^(?:0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token)))
    ) fail();
  };
  try {
    value(0);
    space();
    if (at !== text.length) fail();
    return { value: JSON.parse(text), fillToken };
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    return fail();
  }
}

/** Snapshot one returned descriptor. The store contract supplies cross-key stability;
 * optional per-object identity remains evidence only, never authentication. */
function capture(input: ByteSourceType, stability: "immutable" | "caller"): ByteSourceType {
  const size = input.size, identity = input.identity, declared = input.stability, read = input.read;
  integer(size, "Zarr object size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Invalid Zarr object identity.");
  }
  if (declared !== undefined && declared !== "immutable" && declared !== "provider" && declared !== "caller") {
    throw new TypeError("Invalid Zarr object stability.");
  }
  return { size, stability, ...(identity === undefined ? {} : { identity }), read: read.bind(input) };
}

/** Opens a borrowed whole-store snapshot and validates one .zarray before any chunk lookup. */
export async function openZarr(store: ZarrStoreType, options: ZarrOpenOptionsType = {}): Promise<ZarrArrayType> {
  options = { ...options };
  const stability = store.stability, open = store.open.bind(store);
  if (stability !== "immutable" && stability !== "caller") {
    throw new TypeError("Zarr requires whole-store immutable or caller snapshot stability.");
  }
  let path = options.path ?? "";
  if (typeof path !== "string" || path.length > 1024) {
    throw new TypeError("Zarr path must be ASCII and at most 1024 characters.");
  }
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 32 || code > 126) throw new TypeError("Zarr logical paths use printable ASCII.");
  }
  path = path.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
  if (path.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Zarr dot path segments are forbidden.");
  }
  const prefix = path ? path + "/" : "";
  const maxMetadata = limit(options.maxMetadataBytes, 1024 * 1024, "maxMetadataBytes"),
    maxRank = limit(options.maxRank, 32, "maxRank"),
    maxChunkBytes = limit(options.maxChunkBytes, 64 * 1024 * 1024, "maxChunkBytes"),
    maxElements = limit(options.maxElements, 1024 * 1024, "maxElements"),
    maxChunks = limit(options.maxChunks, 4096, "maxChunks"),
    maxSegments = limit(options.maxSegments, 4096, "maxSegments"),
    maxPlanSteps = limit(options.maxPlanSteps, 16 * 1024 * 1024, "maxPlanSteps");
  const lifetime = createArchiveLedger(options),
    external = options.ledger,
    lifetimeObjects = createZarrObjectLedger(options.maxObjects),
    externalObjects = options.objectLedger;
  /** Known physical byte/request cost is reserved before output. Read credits ensure
   * ArchiveBudget still checks exact extents without charging aggregate owners twice. */
  const operation = (opts: ZarrLimitsType) => {
    opts = { ...opts };
    const signal = options.signal && opts.signal
      ? AbortSignal.any([options.signal, opts.signal])
      : options.signal ?? opts.signal;
    const own = createArchiveLedger(opts),
      objects = createZarrObjectLedger(opts.maxObjects),
      extra = opts.ledger,
      extraObjects = opts.objectLedger;
    let byteCredit = 0, requestCredit = 0;
    const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
      own.reserve(kind, count);
      lifetime.reserve(kind, count);
      external?.reserve(kind, count);
      if (extra && extra !== external) extra.reserve(kind, count);
    };
    const admit = (bytes: number, requests: number): void => {
      reserve("sourceBytes", bytes);
      reserve("requests", requests);
      byteCredit += bytes;
      requestCredit += requests;
    };
    const relay: ArchiveLedgerType = {
      reserve(kind, count) {
        if (kind === "sourceBytes") {
          if (count > byteCredit) throw new Error("Zarr source credit invariant.");
          byteCredit -= count;
        } else if (kind === "requests") {
          if (count > requestCredit) throw new Error("Zarr request credit invariant.");
          requestCredit -= count;
        } else reserve(kind, count);
      },
      inspect: own.inspect,
    };
    return {
      signal,
      reserve,
      admit,
      budget: (source: ByteSourceType) => new ArchiveBudget(source, { ...opts, ledger: relay }, signal),
      inspect: (): ZarrWorkType => ({ ...own.inspect(), objects: objects.inspect() }),
      async lookup(key: string): Promise<ByteSourceType | undefined> {
        signal?.throwIfAborted();
        objects.reserve(1);
        lifetimeObjects.reserve(1);
        externalObjects?.reserve(1);
        if (extraObjects && extraObjects !== externalObjects) extraObjects.reserve(1);
        const source = await open(key, signal ? { signal } : {});
        signal?.throwIfAborted();
        return source === undefined ? undefined : capture(source, stability);
      },
    };
  };
  const opening = operation(options), metaSource = await opening.lookup(prefix + ".zarray");
  if (!metaSource) invalid("Zarr .zarray metadata is missing; groups/v3 metadata are not interpreted.");
  if (metaSource.size > maxMetadata) throw new ArchiveError("budget-exceeded", "Zarr metadata byte limit exceeded.");
  opening.admit(metaSource.size, Math.ceil(metaSource.size / 65536));
  opening.reserve("decodedBytes", metaSource.size);
  opening.signal?.throwIfAborted();
  const metaBytes = new Uint8Array(metaSource.size), metaBudget = opening.budget(metaSource);
  for (let at = 0; at < metaBytes.length; at += 65536) {
    metaBytes.set(await metaBudget.read(at, Math.min(65536, metaBytes.length - at)), at);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(metaBytes);
  } catch {
    invalid("Zarr metadata is not UTF-8.");
  }
  const parsed = metadata(text), data = parsed.value;
  if (!data || typeof data !== "object" || Array.isArray(data)) invalid("Zarr metadata must be a JSON object.");
  const wire = data as Record<string, unknown>;
  for (const key of ["zarr_format", "shape", "chunks", "dtype", "compressor", "filters", "fill_value", "order"]) {
    if (!Object.hasOwn(wire, key)) invalid(`Missing Zarr metadata field ${key}.`);
  }
  if (wire.zarr_format !== 2) unsupported("Only Zarr v2 array metadata is supported.");
  if (
    wire.compressor !== null || (wire.filters !== null && (!Array.isArray(wire.filters) || wire.filters.length !== 0))
  ) unsupported("Only uncompressed, unfiltered Zarr arrays are supported.");
  const dimensions = (input: unknown, chunks: boolean): number[] => {
    if (!Array.isArray(input) || input.length > maxRank) {
      throw new ArchiveError("budget-exceeded", "Zarr shape/chunk rank limit exceeded.");
    }
    return input.map((value: unknown) => {
      if (typeof value !== "number") invalid("Zarr dimensions must be integers.");
      integer(value, "Zarr dimension");
      if (chunks && value === 0) invalid("Zarr chunk dimensions must be positive.");
      return value;
    });
  };
  const shape = dimensions(wire.shape, false), chunks = dimensions(wire.chunks, true);
  if (shape.length !== chunks.length) invalid("Zarr chunk and array ranks differ.");
  const elements = exact(shape.reduce((product, value) => product * BigInt(value), 1n));
  if (typeof wire.dtype !== "string") unsupported("Structured Zarr dtypes are unsupported.");
  const dtype = wire.dtype, match = /^([<>|])([biuf])([1248])$/.exec(dtype);
  if (!match) unsupported("Unsupported Zarr numeric dtype.");
  const endian = match[1]!, kind = match[2]!, width = Number(match[3]);
  if (
    (kind === "b" && width !== 1) || (kind === "f" && width !== 4 && width !== 8) || (endian === "|" && width !== 1)
  ) unsupported("Unsupported Zarr numeric dtype width/byte order.");
  const chunkBytes = exact(chunks.reduce((product, value) => product * BigInt(value), 1n) * BigInt(width));
  if (chunkBytes > maxChunkBytes) throw new ArchiveError("budget-exceeded", "Zarr declared raw chunk limit exceeded.");
  const order = wire.order;
  if (order !== "C" && order !== "F") invalid("Zarr order must be C or F.");
  const separator = wire.dimension_separator ?? ".";
  if (separator !== "." && separator !== "/") invalid("Invalid Zarr dimension separator.");
  let fillValue: number | bigint | null = null;
  const fill = wire.fill_value;
  if (fill !== null) {
    if (kind === "f") {
      if (typeof fill === "number") fillValue = width === 4 ? Math.fround(fill) : fill;
      else if (fill === "NaN") fillValue = NaN;
      else if (fill === "Infinity") fillValue = Infinity;
      else if (fill === "-Infinity") fillValue = -Infinity;
      else invalid("Invalid Zarr floating fill value.");
    } else if (kind === "b") {
      if (fill !== true && fill !== false && fill !== 0 && fill !== 1) invalid("Invalid Zarr boolean fill value.");
      fillValue = fill === true || fill === 1 ? 1 : 0;
    } else {
      if (
        typeof fill !== "number" || !parsed.fillToken || !/^-?(?:0|[1-9]\d*)$/.test(parsed.fillToken) ||
        !Number.isSafeInteger(fill)
      ) unsupported("Zarr integer fill requires an exact safe JSON integer lexeme.");
      const value = BigInt(parsed.fillToken),
        bits = BigInt(width * 8),
        minimum = kind === "i" ? -(1n << (bits - 1n)) : 0n,
        maximum = kind === "i" ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      if (value < minimum || value > maximum) invalid("Zarr fill exceeds its integer dtype.");
      fillValue = width === 8 ? value : Number(value);
    }
  }
  const strides: bigint[] = new Array(chunks.length);
  let stride = 1n;
  for (let step = 0; step < chunks.length; step++) {
    const axis = order === "C" ? chunks.length - step - 1 : step;
    strides[axis] = stride;
    stride *= BigInt(chunks[axis]!);
  }
  opening.signal?.throwIfAborted();
  return {
    path,
    shape: Object.freeze(shape),
    chunks: Object.freeze(chunks),
    dtype,
    order,
    separator,
    elements,
    chunkBytes,
    fillValue,
    work: opening.inspect(),
    async read(opts = {}) {
      opts = { ...opts };
      const offset = opts.offset ?? 0, count = opts.count ?? elements - offset;
      integer(offset, "Zarr element offset");
      integer(count, "Zarr element count");
      if (offset > elements || count > elements - offset) throw new RangeError("Zarr selection exceeds array.");
      if (count > maxElements || BigInt(count) * BigInt(shape.length) > BigInt(maxPlanSteps)) {
        throw new ArchiveError("budget-exceeded", "Zarr selection element/planning limit exceeded.");
      }
      const current = operation(opts);
      current.signal?.throwIfAborted();
      const coordinates: number[] = new Array(shape.length);
      let remainder = BigInt(offset);
      for (let axis = shape.length - 1; axis >= 0; axis--) {
        const length = BigInt(shape[axis]!);
        coordinates[axis] = length ? Number(remainder % length) : 0;
        if (length) remainder /= length;
      }
      // Output order follows logical C coordinates. Stored strides alone encode F
      // layout, so a caller never needs to transpose the returned typed array.
      const keys = new Map<string, ByteSourceType | undefined>(),
        segments: { readonly key: string; readonly offset: number; count: number; readonly output: number }[] = [];
      for (let index = 0; index < count; index++) {
        const keyParts: string[] = [];
        let stored = 0n;
        for (let axis = 0; axis < shape.length; axis++) {
          const coordinate = BigInt(coordinates[axis]!), chunk = BigInt(chunks[axis]!);
          keyParts.push((coordinate / chunk).toString());
          stored += (coordinate % chunk) * strides[axis]!;
        }
        const key = prefix + (keyParts.length ? keyParts.join(separator) : "0"),
          position = exact(stored * BigInt(width));
        if (!keys.has(key)) {
          if (keys.size >= maxChunks) throw new ArchiveError("budget-exceeded", "Zarr selected chunk limit exceeded.");
          keys.set(key, undefined);
        }
        const last = segments.at(-1);
        if (last && last.key === key && last.offset + last.count * width === position && last.count * width < 65536) {
          last.count++;
        } else {
          if (segments.length >= maxSegments) {
            throw new ArchiveError("budget-exceeded", "Zarr selected segment limit exceeded.");
          }
          segments.push({ key, offset: position, count: 1, output: index });
        }
        for (let axis = shape.length - 1; axis >= 0; axis--) {
          coordinates[axis] = coordinates[axis]! + 1;
          if (coordinates[axis]! < shape[axis]!) break;
          coordinates[axis] = 0;
        }
      }
      for (const key of keys.keys()) {
        const source = await current.lookup(key);
        if (source && source.size !== chunkBytes) {
          invalid("Zarr uncompressed chunk size differs from its full declared shape.");
        }
        if (!source && fillValue === null) {
          unsupported("Missing Zarr chunk has null/undefined fill; no numeric values are fabricated.");
        }
        keys.set(key, source);
      }
      let bytes = 0, requests = 0;
      for (const segment of segments) {
        if (keys.get(segment.key)) {
          bytes += segment.count * width;
          requests++;
        }
      }
      current.admit(bytes, requests);
      current.reserve("decodedBytes", exact(BigInt(count) * BigInt(width)));
      current.reserve("outputBytes", exact(BigInt(count) * BigInt(width + 1)));
      current.signal?.throwIfAborted();
      const values: ZarrValuesType = kind === "f"
        ? width === 4 ? new Float32Array(count) : new Float64Array(count)
        : width === 8
        ? kind === "i" ? new BigInt64Array(count) : new BigUint64Array(count)
        : kind === "b" || (kind === "u" && width === 1)
        ? new Uint8Array(count)
        : kind === "i" && width === 1
        ? new Int8Array(count)
        : width === 2
        ? kind === "i" ? new Int16Array(count) : new Uint16Array(count)
        : kind === "i"
        ? new Int32Array(count)
        : new Uint32Array(count);
      const fillMask = new Uint8Array(count), budgets = new Map<string, ArchiveBudget>();
      for (const segment of segments) {
        const source = keys.get(segment.key);
        let data: DataView | undefined;
        if (source) {
          let budget = budgets.get(segment.key);
          if (!budget) {
            budget = current.budget(source);
            budgets.set(segment.key, budget);
          }
          data = view(await budget.read(segment.offset, segment.count * width));
        }
        for (let item = 0; item < segment.count; item++) {
          const output = segment.output + item, at = item * width;
          if (width === 8 && kind !== "f") {
            (values as BigInt64Array | BigUint64Array)[output] = data
              ? kind === "i" ? data.getBigInt64(at, endian === "<") : data.getBigUint64(at, endian === "<")
              : fillValue as bigint;
          } else {
            const value = !data
              ? fillValue as number
              : kind === "b"
              ? data.getUint8(at) ? 1 : 0
              : kind === "f"
              ? width === 4 ? data.getFloat32(at, endian === "<") : data.getFloat64(at, endian === "<")
              : width === 1
              ? kind === "i" ? data.getInt8(at) : data.getUint8(at)
              : width === 2
              ? kind === "i" ? data.getInt16(at, endian === "<") : data.getUint16(at, endian === "<")
              : kind === "i"
              ? data.getInt32(at, endian === "<")
              : data.getUint32(at, endian === "<");
            (values as Exclude<ZarrValuesType, BigInt64Array | BigUint64Array>)[output] = value;
          }
          if (!source) fillMask[output] = 1;
        }
      }
      current.signal?.throwIfAborted();
      return { values, fillMask, integrity: "not-provided", work: current.inspect() };
    },
  };
}
