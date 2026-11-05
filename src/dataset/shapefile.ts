/** Bounded 2D Shapefile geometry and explicitly supplied raw DBF rows. @module */
import { isBytes, toView } from "../bytes.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Each supplied component is borrowed; names do not trigger sibling discovery. */
export interface ShapefileSourcesType {
  readonly shp: ByteSourceType;
  readonly shx?: ByteSourceType;
  readonly dbf?: ByteSourceType;
}
/** Literal stored geometry kinds; no coordinate projection or topology repair is implied. */
export type ShapefileKindType = "null" | "point" | "polyline" | "polygon" | "multipoint";
/** Generic quotas and parent cancellation remain authoritative through derived payload sources. */
export interface ShapefileCallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Local safety policies are independent of the format's signed 32-bit management fields. */
export interface ShapefileOpenOptionsType extends ShapefileCallOptionsType {
  readonly profile: "shp2d-dbf3";
  readonly allowUnverifiedSource?: boolean;
  /** Features retained: default 100,000; hard 1,000,000. */ readonly maxFeatures?: number;
  /** SHP record headers visited: default 1,000,000; hard 4,000,000. */ readonly maxRecords?: number;
  /** Retained descriptors/field metadata: default 8 MiB; hard 64 MiB. */ readonly maxMetadataBytes?: number;
  /** Points in one complete selected feature: default 65,536; hard 1,048,576. */ readonly maxPoints?: number;
  /** Parts in one selected feature: default 4096; hard 65,536. */ readonly maxParts?: number;
  /** Stored selected geometry bytes: default 16 MiB; hard 64 MiB. */ readonly maxFeatureBytes?: number;
  /** Raw DBF fields: default 128; hard 1024. */ readonly maxFields?: number;
  /** One raw DBF row: default 16 KiB; hard 64 KiB. */ readonly maxRowBytes?: number;
}
/** Counts repeated materialization, not only distinct physical bytes. */
export interface ShapefileWorkType extends ArchiveWorkType {
  readonly metadataBytes: number;
  readonly records: number;
  readonly points: number;
  readonly parts: number;
  readonly indexChecks: number;
}
/** Physical feature identity preserves Null rows and the writer's one-based record number. */
export interface ShapefileFeatureType {
  readonly id: number;
  readonly recordNumber: number;
  readonly kind: ShapefileKindType;
  readonly size: number;
  readonly pointCount: number;
  readonly partCount: number;
  readonly bounds?: readonly [number, number, number, number];
}
/** Paging has independent result and descriptor-scan limits; no hidden geometry decode occurs. */
export interface ShapefilePageOptionsType extends ShapefileCallOptionsType {
  readonly cursor?: number;
  readonly limit?: number;
  readonly maxScanned?: number;
  readonly kind?: ShapefileKindType;
}
/** Empty filtered pages can retain a continuing cursor. */
export interface ShapefilePageType {
  readonly features: readonly ShapefileFeatureType[];
  readonly scanned: number;
  readonly cursor?: number;
}
/** Raw field authority; names are unambiguous ASCII in this selected DBF3 profile. */
export interface ShapefileFieldType {
  readonly name: string;
  readonly type: "C" | "N" | "F" | "L" | "D";
  readonly width: number;
  readonly decimals: number;
}
/** Owned fixed-width row. Field views alias this result's owned bytes, never the supplied source. */
export interface ShapefileAttributesType {
  readonly id: number;
  readonly deleted: boolean;
  readonly bytes: Uint8Array;
  readonly fields: readonly { readonly field: ShapefileFieldType; readonly bytes: Uint8Array }[];
  readonly integrity: "not-provided";
  readonly work: ShapefileWorkType;
}
/** Whole selected 2D feature; polygon rings retain stored order and winding. */
export interface ShapefileReadType {
  readonly id: number;
  readonly kind: ShapefileKindType;
  readonly xy: Float64Array;
  readonly parts: Uint32Array;
  readonly integrity: "not-provided";
  readonly work: ShapefileWorkType;
}
/** Physical enumeration is complete within this profile; attributes and indexes have separate scopes. */
export interface ShapefileType {
  readonly profile: "shp2d-dbf3";
  readonly scope: "geometry" | "geometry-and-raw-attributes";
  readonly featureCount: number;
  readonly kind: ShapefileKindType;
  readonly bounds: readonly [number, number, number, number];
  readonly index: "absent" | "cross-checked";
  readonly fields: readonly ShapefileFieldType[];
  readonly work: ShapefileWorkType;
  readonly integrity: "not-provided";
  readonly diagnostics: readonly string[];
  features(options?: ShapefilePageOptionsType): ShapefilePageType;
  read(id: number, options?: ShapefileCallOptionsType): Promise<ShapefileReadType>;
  /** Absence of a supplied DBF returns undefined, not an invented attribute row. */ attributes(
    id: number,
    options?: ShapefileCallOptionsType,
  ): Promise<ShapefileAttributesType | undefined>;
  /** Stored geometry body, including its shape-type word. No implicit coordinate validation or checksum. */ source(
    id: number,
    options?: ShapefileCallOptionsType,
  ): ByteSourceType;
}
interface SourceType {
  size: number;
  read: ByteSourceType["read"];
  identity: string | undefined;
  stability: ByteSourceType["stability"];
}
interface OwnerType {
  identity: ArchiveLedgerType;
  reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  owners: readonly OwnerType[];
  signal: AbortSignal | undefined;
}
interface WorkType {
  sourceBytes: number;
  requests: number;
  decodedBytes: number;
  outputBytes: number;
  metadataBytes: number;
  records: number;
  points: number;
  parts: number;
  indexChecks: number;
}
interface ColumnsType {
  offset: Float64Array;
  length: Float64Array;
  type: Uint8Array;
  points: Uint32Array;
  parts: Uint32Array;
  bounds: Float64Array;
}
function fresh(): WorkType {
  return {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    metadataBytes: 0,
    records: 0,
    points: 0,
    parts: 0,
    indexChecks: 0,
  };
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
function kind(type: number): ShapefileKindType {
  switch (type) {
    case 0:
      return "null";
    case 1:
      return "point";
    case 3:
      return "polyline";
    case 5:
      return "polygon";
    case 8:
      return "multipoint";
    default:
      unsupported("Only Null, Point, PolyLine, Polygon and MultiPoint 2D Shapefile types are supported.");
  }
}
function combined(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  return a && b && a !== b ? AbortSignal.any([a, b]) : a ?? b;
}
/** Each distinct borrowed ledger is bound once; local ancestor quotas cannot be reset by children. */
function authority(options: ShapefileCallOptionsType, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (owners.some((o) => o.identity === ledger)) continue;
    const { reserve, inspect } = ledger;
    if (typeof reserve !== "function" || typeof inspect !== "function") {
      throw new TypeError("Shapefile ledger requires reserve and inspect.");
    }
    owners.push({ identity: ledger, reserve: reserve.bind(ledger) });
  }
  cap(owners.length, 16, "Shapefile inherited budget owners");
  return { owners, signal: combined(parent?.signal, options.signal) };
}
function charge(auth: AuthorityType, work: WorkType, key: keyof ArchiveWorkType, n: number): void {
  integer(n, "Shapefile work");
  auth.signal?.throwIfAborted();
  for (const owner of auth.owners) {
    owner.reserve(key, n);
    auth.signal?.throwIfAborted();
  }
  work[key] += n;
}
function capture(source: ByteSourceType, allow: boolean): SourceType {
  const { size, identity, stability } = source, read = source.read.bind(source);
  integer(size, "Shapefile component size");
  if (identity !== undefined && (typeof identity !== "string" || !identity.length || identity.length > 8192)) {
    throw new TypeError("Shapefile component identity must contain 1–8192 UTF-16 code units.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown Shapefile source stability.");
  }
  if (stability === undefined && !allow) {
    unsupported("Shapefile composition requires source stability evidence or allowUnverifiedSource.");
  }
  return { size, identity, stability, read };
}
function finite(n: number): number {
  if (!Number.isFinite(n)) invalid("Shapefile coordinates/bounds must be finite.");
  return n;
}
function box(data: DataView, at: number): [number, number, number, number] {
  const b: [number, number, number, number] = [
    finite(data.getFloat64(at, true)),
    finite(data.getFloat64(at + 8, true)),
    finite(data.getFloat64(at + 16, true)),
    finite(data.getFloat64(at + 24, true)),
  ];
  if (b[0] > b[2] || b[1] > b[3]) invalid("Shapefile bounds are reversed.");
  return b;
}
/** Signed 32-bit management fields count 16-bit words, unlike geometry's little-endian fields. */
function words(data: DataView, at: number): number {
  const n = data.getInt32(at, false);
  if (n < 0) invalid("Negative Shapefile word extent.");
  return n * 2;
}
function zeros(bytes: Uint8Array, label: string): void {
  if (bytes.some((n) => n !== 0)) unsupported(`Nonzero ${label} is outside the selected writer profile.`);
}

/** Index supplied components without following paths, converting CRS or silently decoding DBF values. */
export async function openShapefile(
  input: ShapefileSourcesType,
  inputOptions: ShapefileOpenOptionsType,
): Promise<ShapefileType> {
  const options = { ...inputOptions };
  if (options.profile !== "shp2d-dbf3") throw new TypeError("Select shp2d-dbf3 explicitly.");
  // Capture every component before the first asynchronous source callback.
  const supplied = { ...input },
    shp = capture(supplied.shp, options.allowUnverifiedSource === true),
    shx = supplied.shx ? capture(supplied.shx, options.allowUnverifiedSource === true) : undefined,
    dbf = supplied.dbf ? capture(supplied.dbf, options.allowUnverifiedSource === true) : undefined;
  const policy = {
    features: limit(options.maxFeatures, 100000, 1000000, "Shapefile features"),
    records: limit(options.maxRecords, 1000000, 4000000, "Shapefile record visits"),
    metadata: limit(options.maxMetadataBytes, 8 << 20, 64 << 20, "Shapefile retained metadata"),
    points: limit(options.maxPoints, 65536, 1048576, "Shapefile selected points"),
    parts: limit(options.maxParts, 4096, 65536, "Shapefile selected parts"),
    feature: limit(options.maxFeatureBytes, 16 << 20, 64 << 20, "Shapefile selected geometry bytes"),
    fields: limit(options.maxFields, 128, 1024, "Shapefile DBF fields"),
    row: limit(options.maxRowBytes, 16 << 10, 64 << 10, "Shapefile DBF row"),
  };
  const opening = authority(options), opened = fresh();
  function meta(n: number): void {
    integer(n, "Shapefile metadata");
    cap(n, policy.metadata - opened.metadataBytes, "Shapefile retained metadata");
    opened.metadataBytes += n;
  }
  /** Reserve full work before callbacks or output allocation, including raw stored bytes materialized by parsing. */
  function plan(
    auth: AuthorityType,
    work: WorkType,
    source: SourceType,
    offset: number,
    length: number,
    output = 0,
  ): void {
    integer(offset, "Shapefile offset");
    integer(length, "Shapefile length");
    if (offset > source.size || length > source.size - offset) invalid("Shapefile extent exceeds supplied component.");
    charge(auth, work, "sourceBytes", length);
    charge(auth, work, "requests", Math.ceil(length / 65536));
    charge(auth, work, "decodedBytes", length);
    charge(auth, work, "outputBytes", output);
    auth.signal?.throwIfAborted();
  }
  async function extent(auth: AuthorityType, source: SourceType, offset: number, length: number): Promise<Uint8Array> {
    auth.signal?.throwIfAborted();
    const value = await source.read(offset, length, auth.signal ? { signal: auth.signal } : {});
    auth.signal?.throwIfAborted();
    if (!isBytes(value)) invalid("Shapefile source returned non-bytes.");
    const bytes = toView(value);
    if (bytes.byteLength !== length) invalid("Shapefile source returned an incomplete extent.");
    return bytes;
  }
  /** The destination is allocated only after all source/decoded/output owners admitted its complete cost. */
  async function collect(auth: AuthorityType, source: SourceType, offset: number, length: number): Promise<Uint8Array> {
    auth.signal?.throwIfAborted();
    const out = new Uint8Array(length);
    for (let n = 0; n < length; n += 65536) {
      const b = await extent(auth, source, offset + n, Math.min(65536, length - n));
      out.set(b, n);
    }
    auth.signal?.throwIfAborted();
    return out;
  }
  async function metadata(source: SourceType, offset: number, length: number): Promise<Uint8Array> {
    plan(opening, opened, source, offset, length);
    return await collect(opening, source, offset, length);
  }
  async function header(source: SourceType): Promise<Uint8Array> {
    if (source.size < 100) invalid("Shapefile component header is shorter than 100 bytes.");
    const raw = await metadata(source, 0, 100), d = view(raw);
    if (d.getInt32(0, false) !== 9994 || d.getInt32(28, true) !== 1000) invalid("Shapefile code/version mismatch.");
    zeros(raw.subarray(4, 24), "Shapefile reserved header words");
    if (words(d, 24) !== source.size) invalid("Shapefile declared file length does not match supplied component.");
    kind(d.getInt32(32, true));
    box(d, 36);
    for (let at = 68; at < 100; at += 8) {
      if (d.getFloat64(at, true) !== 0) unsupported("Measured/Z header bounds are outside the 2D profile.");
    }
    return raw;
  }
  const head = await header(shp), hd = view(head), type = hd.getInt32(32, true), bounds = Object.freeze(box(hd, 36));
  const columns: ColumnsType[] = [];
  let count = 0;
  function physical(
    id: number,
  ): {
    offset: number;
    length: number;
    type: number;
    points: number;
    parts: number;
    bounds: [number, number, number, number];
  } {
    integer(id, "Shapefile feature id");
    if (id >= count) throw new RangeError("Unknown Shapefile feature id.");
    const c = columns[Math.floor(id / 256)]!, i = id % 256;
    return {
      offset: c.offset[i]!,
      length: c.length[i]!,
      type: c.type[i]!,
      points: c.points[i]!,
      parts: c.parts[i]!,
      bounds: [c.bounds[i * 4]!, c.bounds[i * 4 + 1]!, c.bounds[i * 4 + 2]!, c.bounds[i * 4 + 3]!],
    };
  }
  function descriptor(id: number): ShapefileFeatureType {
    const p = physical(id);
    return Object.freeze({
      id,
      recordNumber: id + 1,
      kind: kind(p.type),
      size: p.length,
      pointCount: p.points,
      partCount: p.parts,
      ...(p.type === 0 ? {} : { bounds: Object.freeze(p.bounds) }),
    });
  }
  let at = 100;
  while (at < shp.size) {
    cap(++opened.records, policy.records, "Shapefile record visits");
    cap(count + 1, policy.features, "Shapefile feature count");
    if (shp.size - at < 12) invalid("Truncated Shapefile record header/body.");
    const r = view(await metadata(shp, at, 8));
    if (r.getInt32(0, false) !== count + 1) invalid("Shapefile record numbers must begin at 1 and increase by 1.");
    const length = words(r, 4), offset = at + 8;
    if (length < 4 || length > shp.size - offset) invalid("Shapefile record extent exceeds main file.");
    const prefix = view(await metadata(shp, offset, Math.min(length, type === 8 ? 40 : 44))),
      t = prefix.getInt32(0, true);
    kind(t);
    if (t !== 0 && t !== type) invalid("Non-null Shapefile record type differs from main header.");
    let points = 0, parts = 0, b: [number, number, number, number] = [0, 0, 0, 0], expected = 4;
    if (t === 1) {
      if (length !== 20) invalid("Shapefile Point body must be exactly 20 bytes.");
      const x = finite(prefix.getFloat64(4, true)), y = finite(prefix.getFloat64(12, true));
      points = 1;
      b = [x, y, x, y];
      expected = 20;
    } else if (t === 8 || t === 3 || t === 5) {
      if (length < (t === 8 ? 40 : 44)) invalid("Truncated Shapefile geometry counts.");
      b = box(prefix, 4);
      if (t === 8) {
        points = prefix.getInt32(36, true);
        expected = 40 + points * 16;
      } else {
        parts = prefix.getInt32(36, true);
        points = prefix.getInt32(40, true);
        expected = 44 + parts * 4 + points * 16;
      }
      if (points <= 0 || parts < 0 || (t !== 8 && parts === 0)) invalid("Shapefile geometry counts must be positive.");
    }
    if (length !== expected) invalid("Shapefile geometry count/body extent mismatch.");
    if (count % 256 === 0) {
      const n = Math.min(256, policy.features - count);
      meta(n * 64);
      columns.push({
        offset: new Float64Array(n),
        length: new Float64Array(n),
        type: new Uint8Array(n),
        points: new Uint32Array(n),
        parts: new Uint32Array(n),
        bounds: new Float64Array(n * 4),
      });
    }
    const c = columns[Math.floor(count / 256)]!, i = count % 256;
    c.offset[i] = offset;
    c.length[i] = length;
    c.type[i] = t;
    c.points[i] = points;
    c.parts[i] = parts;
    c.bounds.set(b, i * 4);
    count++;
    at = offset + length;
  }
  if (shx) {
    const indexHeader = await header(shx);
    for (let i = 0; i < 100; i++) {
      if ((i < 24 || i >= 28) && indexHeader[i] !== head[i]) {
        invalid("Shapefile index header differs from main header.");
      }
    }
    if (shx.size !== 100 + count * 8) invalid("Shapefile index entry count differs from physical main records.");
    plan(opening, opened, shx, 100, count * 8);
    for (let n = 0; n < count; n += 8192) {
      const raw = await collect(opening, shx, 100 + n * 8, Math.min(8192, count - n) * 8), d = view(raw);
      for (let j = 0; j < raw.length / 8; j++) {
        const p = physical(n + j);
        if (words(d, j * 8) !== p.offset - 8 || words(d, j * 8 + 4) !== p.length) {
          invalid("Shapefile index tuple differs from main record.");
        }
        opened.indexChecks++;
      }
    }
  }
  const fields: ShapefileFieldType[] = [];
  let rowLength = 0, rowStart = 0;
  if (dbf) {
    if (dbf.size < 33) invalid("DBF3 component is shorter than its header.");
    const raw = await metadata(dbf, 0, 32), d = view(raw);
    if (raw[0] !== 3) unsupported("Only the inspected DBF version 03 writer profile is supported.");
    zeros(raw.subarray(12, 32), "DBF3 header flags/reserved bytes");
    if (d.getUint32(4, true) !== count) invalid("DBF physical row count differs from SHP feature count.");
    rowStart = d.getUint16(8, true);
    rowLength = d.getUint16(10, true);
    if (rowStart < 33 || (rowStart - 33) % 32 !== 0 || !rowLength) invalid("Invalid DBF3 header/row extent.");
    const n = (rowStart - 33) / 32;
    cap(n, policy.fields, "Shapefile DBF fields");
    cap(rowLength, policy.row, "Shapefile DBF row bytes");
    if (!n) unsupported("DBF3 profile requires at least one field.");
    if (rowStart > dbf.size || count * rowLength > dbf.size - rowStart) invalid("DBF3 rows exceed component.");
    const tail = dbf.size - rowStart - count * rowLength;
    if (tail > 1) invalid("Unexpected DBF3 trailing bytes.");
    if (tail && (await metadata(dbf, dbf.size - 1, 1))[0] !== 0x1a) invalid("Unexpected DBF3 EOF marker.");
    meta(n * 96);
    const table = await metadata(dbf, 32, rowStart - 32);
    if (table[table.length - 1] !== 13) invalid("DBF3 field header lacks 0x0d terminator.");
    const names = new Set<string>();
    let width = 1;
    for (let i = 0; i < n; i++) {
      const f = table.subarray(i * 32, i * 32 + 32), end = f.subarray(0, 11).indexOf(0);
      if (end < 1 || end > 10) unsupported("DBF3 field names require 1–10 ASCII bytes and NUL padding.");
      zeros(f.subarray(end, 11), "DBF3 name padding");
      if (f.subarray(0, end).some((c) => c < 33 || c > 126)) {
        unsupported("Non-ASCII/control DBF3 field names are outside this profile.");
      }
      const name = String.fromCharCode(...f.subarray(0, end));
      if (names.has(name)) invalid("Duplicate DBF3 field name.");
      names.add(name);
      const fieldType = String.fromCharCode(f[11]!);
      if (!["C", "N", "F", "L", "D"].includes(fieldType)) {
        unsupported("Memo or other DBF field types are outside this raw-row profile.");
      }
      zeros(f.subarray(12, 16), "DBF3 field address");
      zeros(f.subarray(18, 32), "DBF3 field reserved bytes");
      if (!f[16]) invalid("DBF3 field width is zero.");
      const field = Object.freeze({
        name,
        type: fieldType as ShapefileFieldType["type"],
        width: f[16]!,
        decimals: f[17]!,
      });
      fields.push(field);
      width += field.width;
      meta(name.length * 2);
    }
    if (width !== rowLength) invalid("DBF3 field widths do not sum to its row length.");
  }
  const fieldList = Object.freeze(fields);
  /** Admit complete stored geometry and returned typed columns before any selected payload allocation. */
  async function selected(id: number, call: ShapefileCallOptionsType): Promise<ShapefileReadType> {
    const auth = authority({ ...call }, opening), work = fresh(), p = physical(id);
    cap(p.length, policy.feature, "Shapefile selected geometry bytes");
    cap(p.points, policy.points, "Shapefile selected points");
    cap(p.parts, policy.parts, "Shapefile selected parts");
    plan(auth, work, shp, p.offset, p.length, p.points * 16 + p.parts * 4);
    const bytes = await collect(auth, shp, p.offset, p.length), d = view(bytes);
    if (d.getInt32(0, true) !== p.type) invalid("Shapefile selected record type changed.");
    const xy = new Float64Array(p.points * 2),
      parts = new Uint32Array(p.parts),
      pointAt = p.type === 1 ? 4 : p.type === 8 ? 40 : 44 + p.parts * 4;
    for (let i = 0; i < p.parts; i++) {
      auth.signal?.throwIfAborted();
      const start = d.getInt32(44 + i * 4, true);
      if (start < 0 || start >= p.points || i === 0 && start !== 0 || i > 0 && start <= parts[i - 1]!) {
        invalid("Shapefile part starts are not strictly increasing from zero.");
      }
      parts[i] = start;
      work.parts++;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.points; i++) {
      auth.signal?.throwIfAborted();
      const x = finite(d.getFloat64(pointAt + i * 16, true)), y = finite(d.getFloat64(pointAt + i * 16 + 8, true));
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      work.points++;
    }
    if (p.points && [minX, minY, maxX, maxY].some((v, i) => v !== p.bounds[i])) {
      invalid("Shapefile selected bounds do not match complete coordinates.");
    }
    for (let i = 0; i < p.parts; i++) {
      const start = parts[i]!, stop = parts[i + 1] ?? p.points;
      if (stop - start < (p.type === 5 ? 4 : 2)) invalid("Shapefile line/ring has too few points.");
      if (p.type === 5 && (xy[start * 2] !== xy[(stop - 1) * 2] || xy[start * 2 + 1] !== xy[(stop - 1) * 2 + 1])) {
        invalid("Shapefile polygon ring is not closed.");
      }
    }
    auth.signal?.throwIfAborted();
    return { id, kind: kind(p.type), xy, parts, integrity: "not-provided", work: { ...work } };
  }
  opening.signal?.throwIfAborted();
  const result: ShapefileType = {
    profile: "shp2d-dbf3",
    scope: dbf ? "geometry-and-raw-attributes" : "geometry",
    featureCount: count,
    kind: kind(type),
    bounds,
    index: shx ? "cross-checked" : "absent",
    fields: fieldList,
    work: Object.freeze({ ...opened }),
    integrity: "not-provided",
    diagnostics: Object.freeze([
      "CRS and DBF text encoding are unknown; no sidecars are discovered or interpreted.",
      "Main header bounds and polygon topology are not recomputed/validated across the complete dataset.",
      "Component byte/row consistency is not proof of an atomic publication or common owner.",
    ]),
    features(inputCall: ShapefilePageOptionsType = {}) {
      const call = { ...inputCall }, auth = authority(call, opening);
      auth.signal?.throwIfAborted();
      let at = call.cursor ?? 0;
      integer(at, "Shapefile cursor");
      if (at > count) throw new RangeError("Shapefile cursor exceeds features.");
      const take = limit(call.limit, 256, 4096, "Shapefile page results"),
        scan = limit(call.maxScanned, 8192, 65536, "Shapefile page scans");
      if (!take || !scan) throw new RangeError("Shapefile page bounds must be positive.");
      if (call.kind !== undefined && !["null", "point", "polyline", "polygon", "multipoint"].includes(call.kind)) {
        throw new TypeError("Unknown Shapefile kind filter.");
      }
      const features: ShapefileFeatureType[] = [];
      let scanned = 0;
      while (at < count && features.length < take && scanned < scan) {
        auth.signal?.throwIfAborted();
        const f = descriptor(at++);
        scanned++;
        if (call.kind !== undefined && f.kind !== call.kind) continue;
        features.push(f);
      }
      return Object.freeze({ features: Object.freeze(features), scanned, ...(at < count ? { cursor: at } : {}) });
    },
    read(id, call = {}) {
      return selected(id, { ...call });
    },
    async attributes(id, inputCall = {}) {
      const auth = authority({ ...inputCall }, opening), work = fresh();
      physical(id);
      auth.signal?.throwIfAborted();
      if (!dbf) return undefined;
      plan(auth, work, dbf, rowStart + id * rowLength, rowLength, rowLength);
      const bytes = await collect(auth, dbf, rowStart + id * rowLength, rowLength);
      if (bytes[0] !== 0x20 && bytes[0] !== 0x2a) invalid("DBF3 row deletion flag is neither active nor deleted.");
      let at = 1;
      const values = fieldList.map((field) => {
        const value = { field, bytes: bytes.subarray(at, at + field.width) };
        at += field.width;
        return Object.freeze(value);
      });
      auth.signal?.throwIfAborted();
      return {
        id,
        deleted: bytes[0] === 0x2a,
        bytes,
        fields: Object.freeze(values),
        integrity: "not-provided",
        work: { ...work },
      };
    },
    source(id, call = {}) {
      const auth = authority({ ...call }, opening);
      auth.signal?.throwIfAborted();
      const p = physical(id);
      return {
        size: p.length,
        ...(shp.identity === undefined
          ? {}
          : { identity: JSON.stringify(["shapefile", shp.identity, "geometry-record", p.offset, p.length]) }),
        ...(shp.stability === undefined ? {} : { stability: shp.stability }),
        async read(offset, length, inputRead = {}) {
          const child = authority({ ...inputRead }, auth), work = fresh();
          integer(offset, "Shapefile stored interval offset");
          integer(length, "Shapefile stored interval length");
          if (offset > p.length || length > p.length - offset) {
            throw new RangeError("Shapefile stored interval exceeds record.");
          }
          cap(length, policy.feature, "Shapefile source interval bytes");
          plan(child, work, shp, p.offset + offset, length, length);
          return await collect(child, shp, p.offset + offset, length);
        },
      };
    },
  };
  return Object.freeze(result);
}
