/** Bounded LAS 1.2 uncompressed point-column preview over a borrowed snapshot. @module */
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

/** Finite policies retained across the opened snapshot's lifetime. */
export interface LasOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Selected points per read. Default: 1,048,576; does not limit declared total points. */
  readonly maxPoints?: number;
  /** Indexed variable-length record count. Default: 4096. */
  readonly maxVlrs?: number;
  /** Entire pre-point header/VLR/gap extent, including opaque payloads. Default: 8 MiB. */
  readonly maxMetadataBytes?: number;
}
/** Per-operation policies compose with opening ledgers and cancellation. */
export interface LasReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** First point index, default 0. This is not a byte offset. */
  readonly offset?: number;
  /** Selected point count, default remaining points. */
  readonly count?: number;
  /** Physical adds Float64 XYZ using raw*scale+offset. Default raw. No CRS transform. */
  readonly scale?: "raw" | "physical";
}
/** Byte ranges inside opaque VLR payloads. */
export interface LasVlrReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Payload-relative byte offset, default 0. */
  readonly offset?: number;
  /** Returned bytes, default remaining payload. */
  readonly length?: number;
}
/** Header declarations are metadata, not verified point statistics or CRS meaning. */
export interface LasVlrType {
  readonly id: number;
  readonly userId: string;
  readonly recordId: number;
  readonly description: string;
  readonly offset: number;
  readonly size: number;
  readonly reserved: number;
}
/** Owned column arrays in input point order. Encoded bit fields remain inspectable. */
export interface LasReadType {
  readonly X: Int32Array;
  readonly Y: Int32Array;
  readonly Z: Int32Array;
  readonly intensity: Uint16Array;
  readonly returnNumber: Uint8Array;
  readonly returnCount: Uint8Array;
  readonly scanDirection: Uint8Array;
  readonly edgeOfFlightLine: Uint8Array;
  readonly classificationByte: Uint8Array;
  readonly classification: Uint8Array;
  /** Bits 0/1/2 represent synthetic/key-point/withheld, respectively. */
  readonly classificationFlags: Uint8Array;
  readonly scanAngleByte: Uint8Array;
  /** Signed two's-complement interpretation, independently checked against laspy. */
  readonly scanAngleRank: Int8Array;
  readonly userData: Uint8Array;
  readonly sourceId: Uint16Array;
  readonly gpsTime?: Float64Array;
  readonly red?: Uint16Array;
  readonly green?: Uint16Array;
  readonly blue?: Uint16Array;
  readonly physical?: { readonly x: Float64Array; readonly y: Float64Array; readonly z: Float64Array };
  /** Concatenated uninterpreted suffix per point; width is extraBytesPerPoint. */
  readonly extra: Uint8Array;
  readonly integrity: "not-provided";
  readonly work: ArchiveWorkType;
}
/** One stable point cloud; this is neither a live LAS writer nor a full conformance validator. */
export interface LasDatasetType {
  readonly version: "1.2";
  readonly format: 0 | 1 | 2 | 3;
  readonly points: number;
  readonly recordBytes: number;
  readonly pointOffset: number;
  readonly extraBytesPerPoint: number;
  readonly headerExtension: { readonly offset: number; readonly size: number };
  readonly metadataGap: { readonly offset: number; readonly size: number };
  readonly trailingBytes: number;
  readonly scale: readonly number[];
  readonly offset: readonly number[];
  /** Declared min/max XYZ; no full point scan has verified these values. */
  readonly bounds: readonly { readonly min: number; readonly max: number }[];
  readonly pointsByReturn: readonly number[];
  readonly gpsTimeType: "week" | "adjusted-standard";
  /** Opaque VLR presence does not establish a valid coordinate reference system. */
  readonly georeferencing: "none" | "opaque-vlr";
  readonly vlrs: readonly LasVlrType[];
  readonly work: ArchiveWorkType;
  read(options?: LasReadOptionsType): Promise<LasReadType>;
  readVlr(
    id: number,
    options?: LasVlrReadOptionsType,
  ): Promise<{ readonly bytes: Uint8Array; readonly integrity: "not-provided"; readonly work: ArchiveWorkType }>;
}

/** Arithmetic stays exact before converting to source offsets or allocation lengths. */
function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("LAS extent exceeds safe indexing.");
  return Number(value);
}
/** LAS fixed strings are ASCII with zero padding, not a Unicode/host path contract. */
function ascii(bytes: Uint8Array): string {
  let result = "", ended = false;
  for (const byte of bytes) {
    if (byte === 0) {
      ended = true;
      continue;
    }
    if (ended || byte > 127) invalid("Malformed LAS fixed ASCII string.");
    result += String.fromCharCode(byte);
  }
  return result;
}

/** Captures source authority before I/O and indexes bounded LAS 1.2 metadata.
 * Only uncompressed point formats 0–3 are decoded. Unknown VLR bodies and record
 * suffixes remain inert bytes; their presence grants no codec/CRS capability. */
export async function openLas(input: ByteSourceType, options: LasOpenOptionsType = {}): Promise<LasDatasetType> {
  options = { ...options };
  const size = input.size, stability = input.stability, identity = input.identity, read = input.read.bind(input);
  integer(size, "LAS source size");
  if (stability !== "immutable" && stability !== "provider" && stability !== "caller") {
    throw new TypeError("LAS requires snapshot source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Invalid LAS source identity.");
  }
  const source: ByteSourceType = { size, stability, ...(identity === undefined ? {} : { identity }), read };
  const maxPoints = options.maxPoints ?? 1048576,
    maxVlrs = options.maxVlrs ?? 4096,
    maxMetadata = options.maxMetadataBytes ?? 8 * 1024 * 1024;
  integer(maxPoints, "LAS point limit");
  integer(maxVlrs, "LAS VLR limit");
  integer(maxMetadata, "LAS metadata limit");
  const lifetime = createArchiveLedger(options), external = options.ledger;
  /** Reserve physical cost before selected allocation. Credits let exact range
   * admission remain local without charging lifetime/external owners twice. */
  const operation = (
    opts: ArchiveLimitsType & { readonly signal?: AbortSignal },
    bytes?: number,
    requests?: number,
  ) => {
    opts = { ...opts };
    const own = createArchiveLedger(opts), extra = opts.ledger;
    const signal = options.signal && opts.signal
      ? AbortSignal.any([options.signal, opts.signal])
      : options.signal ?? opts.signal;
    const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
      own.reserve(kind, count);
      lifetime.reserve(kind, count);
      external?.reserve(kind, count);
      if (extra && extra !== external) extra.reserve(kind, count);
    };
    let byteCredit = bytes ?? 0, requestCredit = requests ?? 0;
    if (bytes !== undefined) {
      reserve("sourceBytes", bytes);
      reserve("requests", requests ?? 0);
    }
    const ledger: ArchiveLedgerType = {
      reserve(kind, count) {
        if (bytes !== undefined && kind === "sourceBytes") {
          if (count > byteCredit) throw new Error("LAS source credit invariant.");
          byteCredit -= count;
        } else if (bytes !== undefined && kind === "requests") {
          if (count > requestCredit) throw new Error("LAS request credit invariant.");
          requestCredit -= count;
        } else reserve(kind, count);
      },
      inspect: own.inspect,
    };
    return { budget: new ArchiveBudget(source, { ...opts, ledger }, signal), signal, reserve, inspect: own.inspect };
  };
  const opening = operation(options), budget = opening.budget;
  if (size < 227) invalid("Truncated LAS1.2 header.");
  if (maxMetadata < 227) throw new ArchiveError("budget-exceeded", "LAS metadata limit exceeded.");
  opening.reserve("decodedBytes", 227);
  const header = await budget.read(0, 227), data = view(header);
  if (ascii(header.subarray(0, 4)) !== "LASF") invalid("Invalid LAS signature.");
  if (data.getUint8(24) !== 1 || data.getUint8(25) !== 2) unsupported("Only LAS1.2 is supported.");
  const global = data.getUint16(6, true);
  if (global & 0xfffe) unsupported("Unknown LAS1.2 global encoding bits.");
  const format = data.getUint8(104);
  if (format > 3) unsupported("Compressed/unknown LAS point formats are unsupported.");
  const base = [20, 28, 26, 34][format]!,
    headerBytes = data.getUint16(94, true),
    pointOffset = data.getUint32(96, true),
    vlrCount = data.getUint32(100, true),
    recordBytes = data.getUint16(105, true),
    points = data.getUint32(107, true);
  if (headerBytes < 227 || pointOffset < headerBytes || pointOffset > size || recordBytes < base) {
    invalid("Invalid LAS header/record extent.");
  }
  if (pointOffset > maxMetadata || vlrCount > maxVlrs) {
    throw new ArchiveError("budget-exceeded", "LAS metadata extent/count limit exceeded.");
  }
  const pointBytes = exact(BigInt(points) * BigInt(recordBytes));
  if (pointBytes > size - pointOffset) invalid("LAS point records exceed source.");
  const scale = Object.freeze([131, 139, 147].map((at) => data.getFloat64(at, true))),
    offset = Object.freeze([155, 163, 171].map((at) => data.getFloat64(at, true)));
  if ([...scale, ...offset].some((value) => !Number.isFinite(value))) invalid("LAS scale/offset must be finite.");
  const bounds = Object.freeze(
    [179, 195, 211].map((at) => Object.freeze({ max: data.getFloat64(at, true), min: data.getFloat64(at + 8, true) })),
  );
  if (bounds.some((value) => !Number.isFinite(value.min) || !Number.isFinite(value.max) || value.min > value.max)) {
    invalid("LAS declared bounds must be finite and ordered.");
  }
  ascii(header.subarray(26, 58));
  ascii(header.subarray(58, 90));
  // A borrowed source may reuse its returned buffer on the next read. Capture
  // every retained header value before traversing any foreign VLR read.
  const pointsByReturn = Object.freeze([111, 115, 119, 123, 127].map((at) => data.getUint32(at, true)));
  const vlrs: LasVlrType[] = [];
  let position = headerBytes;
  for (let id = 0; id < vlrCount; id++) {
    if (pointOffset - position < 54) invalid("LAS VLR header overlaps point data.");
    opening.reserve("decodedBytes", 54);
    const raw = await budget.read(position, 54), wire = view(raw);
    const length = wire.getUint16(20, true);
    if (length > pointOffset - position - 54) invalid("LAS VLR body overlaps point data.");
    vlrs.push(
      Object.freeze({
        id,
        reserved: wire.getUint16(0, true),
        userId: ascii(raw.subarray(2, 18)),
        recordId: wire.getUint16(18, true),
        description: ascii(raw.subarray(22, 54)),
        offset: position + 54,
        size: length,
      }),
    );
    position += 54 + length;
  }
  const extraBytesPerPoint = recordBytes - base,
    gps = format === 1 || format === 3,
    color = format === 2 || format === 3,
    rowsPerRequest = Math.floor(65536 / recordBytes);
  opening.signal?.throwIfAborted();
  return {
    version: "1.2",
    format: format as 0 | 1 | 2 | 3,
    points,
    recordBytes,
    pointOffset,
    extraBytesPerPoint,
    headerExtension: Object.freeze({ offset: 227, size: headerBytes - 227 }),
    metadataGap: Object.freeze({ offset: position, size: pointOffset - position }),
    trailingBytes: size - pointOffset - pointBytes,
    scale,
    offset,
    bounds,
    pointsByReturn,
    gpsTimeType: global & 1 ? "adjusted-standard" : "week",
    georeferencing: vlrs.some((v) => v.userId === "LASF_Projection") ? "opaque-vlr" : "none",
    vlrs: Object.freeze(vlrs),
    work: opening.inspect(),
    async read(opts = {}): Promise<LasReadType> {
      opts = { ...opts };
      const start = opts.offset ?? 0, count = opts.count ?? points - start, mode = opts.scale ?? "raw";
      integer(start, "LAS point offset");
      integer(count, "LAS point count");
      if (start > points || count > points - start) throw new RangeError("LAS selection exceeds point count.");
      if (count > maxPoints) throw new ArchiveError("budget-exceeded", "LAS selected point limit exceeded.");
      if (mode !== "raw" && mode !== "physical") throw new TypeError("Unknown LAS coordinate mode.");
      const bytes = exact(BigInt(count) * BigInt(recordBytes)),
        requests = Math.ceil(count / rowsPerRequest),
        current = operation(opts, bytes, requests);
      current.reserve("decodedBytes", bytes);
      current.reserve(
        "outputBytes",
        exact(
          BigInt(count) *
            BigInt(26 + (gps ? 8 : 0) + (color ? 6 : 0) + (mode === "physical" ? 24 : 0) + extraBytesPerPoint),
        ),
      );
      current.signal?.throwIfAborted();
      const X = new Int32Array(count),
        Y = new Int32Array(count),
        Z = new Int32Array(count),
        intensity = new Uint16Array(count),
        returnNumber = new Uint8Array(count),
        returnCount = new Uint8Array(count),
        scanDirection = new Uint8Array(count),
        edgeOfFlightLine = new Uint8Array(count),
        classificationByte = new Uint8Array(count),
        classification = new Uint8Array(count),
        classificationFlags = new Uint8Array(count),
        scanAngleByte = new Uint8Array(count),
        scanAngleRank = new Int8Array(count),
        userData = new Uint8Array(count),
        sourceId = new Uint16Array(count),
        extra = new Uint8Array(exact(BigInt(count) * BigInt(extraBytesPerPoint)));
      const gpsTime = gps ? new Float64Array(count) : undefined,
        red = color ? new Uint16Array(count) : undefined,
        green = color ? new Uint16Array(count) : undefined,
        blue = color ? new Uint16Array(count) : undefined;
      const physical = mode === "physical"
        ? { x: new Float64Array(count), y: new Float64Array(count), z: new Float64Array(count) }
        : undefined;
      for (let row = 0; row < count; row += rowsPerRequest) {
        const take = Math.min(rowsPerRequest, count - row),
          raw = await current.budget.read(
            exact(BigInt(pointOffset) + BigInt(start + row) * BigInt(recordBytes)),
            take * recordBytes,
          ),
          wire = view(raw);
        for (let local = 0; local < take; local++) {
          const at = local * recordBytes, index = row + local;
          X[index] = wire.getInt32(at, true);
          Y[index] = wire.getInt32(at + 4, true);
          Z[index] = wire.getInt32(at + 8, true);
          intensity[index] = wire.getUint16(at + 12, true);
          const returns = wire.getUint8(at + 14), cls = wire.getUint8(at + 15);
          returnNumber[index] = returns & 7;
          returnCount[index] = (returns >>> 3) & 7;
          scanDirection[index] = (returns >>> 6) & 1;
          edgeOfFlightLine[index] = returns >>> 7;
          classificationByte[index] = cls;
          classification[index] = cls & 31;
          classificationFlags[index] = cls >>> 5;
          scanAngleByte[index] = wire.getUint8(at + 16);
          scanAngleRank[index] = wire.getInt8(at + 16);
          userData[index] = wire.getUint8(at + 17);
          sourceId[index] = wire.getUint16(at + 18, true);
          if (gpsTime) gpsTime[index] = wire.getFloat64(at + 20, true);
          if (red && green && blue) {
            const rgb = at + (gps ? 28 : 20);
            red[index] = wire.getUint16(rgb, true);
            green[index] = wire.getUint16(rgb + 2, true);
            blue[index] = wire.getUint16(rgb + 4, true);
          }
          if (physical) {
            physical.x[index] = X[index]! * scale[0]! + offset[0]!;
            physical.y[index] = Y[index]! * scale[1]! + offset[1]!;
            physical.z[index] = Z[index]! * scale[2]! + offset[2]!;
          }
          extra.set(raw.subarray(at + base, at + recordBytes), index * extraBytesPerPoint);
        }
      }
      current.signal?.throwIfAborted();
      return {
        X,
        Y,
        Z,
        intensity,
        returnNumber,
        returnCount,
        scanDirection,
        edgeOfFlightLine,
        classificationByte,
        classification,
        classificationFlags,
        scanAngleByte,
        scanAngleRank,
        userData,
        sourceId,
        extra,
        ...(gpsTime ? { gpsTime } : {}),
        ...(red && green && blue ? { red, green, blue } : {}),
        ...(physical ? { physical } : {}),
        integrity: "not-provided",
        work: current.inspect(),
      };
    },
    async readVlr(id, opts = {}) {
      opts = { ...opts };
      integer(id, "LAS VLR id");
      const vlr = vlrs[id];
      if (!vlr) throw new RangeError("Unknown LAS VLR id.");
      const start = opts.offset ?? 0, length = opts.length ?? vlr.size - start;
      integer(start, "LAS VLR offset");
      integer(length, "LAS VLR length");
      if (start > vlr.size || length > vlr.size - start) throw new RangeError("LAS VLR selection exceeds payload.");
      const current = operation(opts, length, length ? 1 : 0);
      current.reserve("decodedBytes", length);
      current.reserve("outputBytes", length);
      current.signal?.throwIfAborted();
      const bytes = length ? new Uint8Array(await current.budget.read(vlr.offset + start, length)) : new Uint8Array();
      current.signal?.throwIfAborted();
      return { bytes, integrity: "not-provided", work: current.inspect() };
    },
  };
}
