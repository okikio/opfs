/** Bounded classic GeoTIFF metadata and uncompressed raw raster windows. @module */
import { isBytes, toView } from "../bytes.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Opening limits remain lifetime owners through selected reads and derived block sources. */
export interface GeotiffCallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Local policy ceilings are separate from classic TIFF's unsigned 32-bit fields. */
export interface GeotiffOpenOptionsType extends GeotiffCallOptionsType {
  readonly profile: "classic-geotiff-raw";
  readonly allowUnverifiedSource?: boolean;
  /** Main-chain images: default 64; hard 1024. */ readonly maxImages?: number;
  /** Entries in one IFD: default 1024; hard 8192. */ readonly maxEntries?: number;
  /** Total stored chunk descriptors: default 65,536; hard 1,048,576. */ readonly maxChunks?: number;
  /** Retained metadata policy: default 8 MiB; hard 64 MiB. */ readonly maxMetadataBytes?: number;
  /** One admitted known-tag value: default 1 MiB; hard 16 MiB. */ readonly maxTagBytes?: number;
  /** GeoKeys per image: default 1024; hard 8192. */ readonly maxKeys?: number;
  /** Pixels in one window: default 1,048,576; hard 16,777,216. */ readonly maxPixels?: number;
  /** Returned window or raw block interval bytes: default 16 MiB; hard 64 MiB. */ readonly maxWindowBytes?: number;
  /** Planned row spans: default 65,536; hard 1,048,576. */ readonly maxSpans?: number;
}
/** No projection registry is consulted. Numeric codes remain declarations. */
export interface GeotiffKeyType {
  readonly id: number;
  readonly location: number;
  readonly count: number;
  readonly offset: number;
  readonly values: readonly number[] | string;
}
/** Raw geospatial authority, not resolved CRS or transformed world bounds. */
export interface GeotiffGeoType {
  readonly scope: "unresolved-declarations" | "absent-reduced-image";
  readonly revision?: 0 | 1;
  readonly keys: readonly GeotiffKeyType[];
  readonly pixelScale: readonly number[];
  readonly tiepoints: readonly number[];
  readonly transformation: readonly number[];
  readonly ascii: readonly number[];
}
/** Numeric sample values retain NaN and negative-zero semantics; raw blocks retain exact payload bits. */
export type GeotiffValuesType =
  | Uint8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;
export type GeotiffSampleType = "u8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";
/** Frozen public descriptor; nested arrays cannot alter the private chunk index. */
export interface GeotiffImageType {
  readonly id: number;
  readonly ifdOffset: number;
  readonly width: number;
  readonly height: number;
  readonly samplesPerPixel: 1 | 3;
  readonly sample: GeotiffSampleType;
  /** 0=WhiteIsZero, 1=BlackIsZero, 2=RGB. Samples are never inverted or rendered. */ readonly photometric: 0 | 1 | 2;
  readonly reduced: boolean;
  readonly layout: "strips" | "tiles";
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blocks: number;
  readonly geo: GeotiffGeoType;
  readonly unknownTags: readonly number[];
}
/** Coordinates are stored pixel indexes; no reprojection, orientation change or resampling occurs. */
export interface GeotiffWindowType {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** Exact planned work for the fixed row-span strategy; no I/O or ledger reservation occurs in plan(). */
export interface GeotiffPlanType extends ArchiveWorkType {
  readonly pixels: number;
  readonly spans: number;
  readonly chunks: number;
}
export interface GeotiffWorkType extends ArchiveWorkType {
  readonly images: number;
  readonly entries: number;
  readonly chunks: number;
  readonly spans: number;
  readonly metadataBytes: number;
}
/** Owned row-major pixel-interleaved samples, all stored bands. No native checksum exists in this profile. */
export interface GeotiffReadType {
  readonly values: GeotiffValuesType;
  readonly width: number;
  readonly height: number;
  readonly samplesPerPixel: number;
  readonly integrity: "not-provided";
  readonly work: GeotiffWorkType;
}
/** Borrows the source without closing it. Main-chain inspection is not full TIFF/GeoTIFF/COG conformance. */
export interface GeotiffType {
  readonly images: readonly GeotiffImageType[];
  readonly cog: "not-evaluated";
  readonly work: GeotiffWorkType;
  plan(image: number, window: GeotiffWindowType): GeotiffPlanType;
  read(image: number, window: GeotiffWindowType, options?: GeotiffCallOptionsType): Promise<GeotiffReadType>;
  /** Exact physical strip or padded tile bytes, with inherited source provenance and cancellation authority. */
  source(image: number, block: number, options?: GeotiffCallOptionsType): ByteSourceType;
}
interface WorkType {
  sourceBytes: number;
  requests: number;
  decodedBytes: number;
  outputBytes: number;
  images: number;
  entries: number;
  chunks: number;
  spans: number;
  metadataBytes: number;
}
interface OwnerType {
  identity: ArchiveLedgerType;
  reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  owners: readonly OwnerType[];
  signal: AbortSignal | undefined;
}
interface FieldType {
  tag: number;
  type: number;
  count: number;
  offset: number;
  length: number;
}
interface ImageType {
  public: GeotiffImageType;
  offsets: Float64Array;
  lengths: Float64Array;
  bytes: number;
  across: number;
}
interface SpanType {
  offset: number;
  length: number;
  output: number;
}
function fresh(): WorkType {
  return {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    images: 0,
    entries: 0,
    chunks: 0,
    spans: 0,
    metadataBytes: 0,
  };
}
function cap(n: number, max: number, label: string): void {
  if (n > max) throw new ArchiveError("budget-exceeded", `${label} exceeded.`);
}
function limit(n: number | undefined, d: number, h: number, label: string): number {
  const v = n ?? d;
  integer(v, label);
  cap(v, h, label);
  return v;
}
/** Reject unsafe products before they become an offset, table size or typed-array allocation. */
function product(...values: number[]): number {
  let n = 1;
  for (const v of values) {
    integer(v, "GeoTIFF extent");
    if (v && n > Number.MAX_SAFE_INTEGER / v) invalid("GeoTIFF extent exceeds safe integer range.");
    n *= v;
  }
  return n;
}
function combined(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  return a && b && a !== b ? AbortSignal.any([a, b]) : a ?? b;
}
/** Bind each foreign callback once and retain every ancestor's finite budget. */
function authority(options: GeotiffCallOptionsType, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (owners.some((o) => o.identity === ledger)) continue;
    const { reserve, inspect } = ledger;
    if (typeof reserve !== "function" || typeof inspect !== "function") {
      throw new TypeError("GeoTIFF ledger requires reserve and inspect.");
    }
    owners.push({ identity: ledger, reserve: reserve.bind(ledger) });
  }
  cap(owners.length, 16, "GeoTIFF inherited budget owners");
  return { owners, signal: combined(parent?.signal, options.signal) };
}
function charge(auth: AuthorityType, work: WorkType, key: keyof ArchiveWorkType, n: number): void {
  integer(n, "GeoTIFF work");
  auth.signal?.throwIfAborted();
  for (const owner of auth.owners) {
    owner.reserve(key, n);
    auth.signal?.throwIfAborted();
  }
  work[key] += n;
}
function valuesOf(kind: GeotiffSampleType, count: number): GeotiffValuesType {
  switch (kind) {
    case "u8":
      return new Uint8Array(count);
    case "u16":
      return new Uint16Array(count);
    case "i16":
      return new Int16Array(count);
    case "u32":
      return new Uint32Array(count);
    case "i32":
      return new Int32Array(count);
    case "f32":
      return new Float32Array(count);
    case "f64":
      return new Float64Array(count);
  }
}
/** Keep TIFF sample representation separate from photometric rendering and nodata policy. */
function sampleOf(bits: number, format: number): GeotiffSampleType {
  if (format === 1 && [8, 16, 32].includes(bits)) return bits === 8 ? "u8" : bits === 16 ? "u16" : "u32";
  if (format === 2 && [16, 32].includes(bits)) return bits === 16 ? "i16" : "i32";
  if (format === 3 && [32, 64].includes(bits)) return bits === 32 ? "f32" : "f64";
  unsupported("Unsupported GeoTIFF sample width or format.");
}
function numberAt(v: DataView, offset: number, sample: GeotiffSampleType, little: boolean): number {
  switch (sample) {
    case "u8":
      return v.getUint8(offset);
    case "u16":
      return v.getUint16(offset, little);
    case "i16":
      return v.getInt16(offset, little);
    case "u32":
      return v.getUint32(offset, little);
    case "i32":
      return v.getInt32(offset, little);
    case "f32":
      return v.getFloat32(offset, little);
    case "f64":
      return v.getFloat64(offset, little);
  }
}
/** Inspect only explicitly admitted classic, uncompressed geospatial raster storage. */
export async function openGeotiff(input: ByteSourceType, inputOptions: GeotiffOpenOptionsType): Promise<GeotiffType> {
  const options = { ...inputOptions };
  if (options.profile !== "classic-geotiff-raw") throw new TypeError("Select classic-geotiff-raw explicitly.");
  const { size, identity, stability } = input, read = input.read.bind(input);
  integer(size, "GeoTIFF source size");
  if (identity !== undefined && (typeof identity !== "string" || !identity.length || identity.length > 8192)) {
    throw new TypeError("GeoTIFF identity must contain 1–8192 UTF-16 code units.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown GeoTIFF source stability.");
  }
  if (stability === undefined && options.allowUnverifiedSource !== true) {
    unsupported("GeoTIFF requires source stability evidence or explicit allowUnverifiedSource.");
  }
  const policy = {
    images: limit(options.maxImages, 64, 1024, "GeoTIFF images"),
    entries: limit(options.maxEntries, 1024, 8192, "GeoTIFF IFD entries"),
    chunks: limit(options.maxChunks, 65536, 1048576, "GeoTIFF chunks"),
    metadata: limit(options.maxMetadataBytes, 8 << 20, 64 << 20, "GeoTIFF metadata"),
    tag: limit(options.maxTagBytes, 1 << 20, 16 << 20, "GeoTIFF tag bytes"),
    keys: limit(options.maxKeys, 1024, 8192, "GeoTIFF keys"),
    pixels: limit(options.maxPixels, 1048576, 16777216, "GeoTIFF pixels"),
    output: limit(options.maxWindowBytes, 16 << 20, 64 << 20, "GeoTIFF window bytes"),
    spans: limit(options.maxSpans, 65536, 1048576, "GeoTIFF spans"),
  };
  const ifdExtents: { offset: number; end: number }[] = [];
  const opening = authority(options),
    opened = fresh(),
    images: ImageType[] = [],
    seen = new Set<number>(),
    protectedExtents: { offset: number; end: number }[] = [{ offset: 0, end: 8 }];
  function extent(offset: number, length: number): void {
    integer(offset, "GeoTIFF offset");
    integer(length, "GeoTIFF length");
    if (offset > size || length > size - offset) invalid("GeoTIFF extent exceeds source.");
  }
  function meta(n: number): void {
    integer(n, "GeoTIFF metadata");
    cap(n, policy.metadata - opened.metadataBytes, "GeoTIFF retained metadata");
    opened.metadataBytes += n;
  }
  function reserve(auth: AuthorityType, work: WorkType, sourceBytes: number, requests: number, output = 0): void {
    charge(auth, work, "sourceBytes", sourceBytes);
    charge(auth, work, "requests", requests);
    charge(auth, work, "decodedBytes", sourceBytes);
    charge(auth, work, "outputBytes", output);
    auth.signal?.throwIfAborted();
  }
  /** Copy before the next callback can reuse a provider's scratch view. Reservations precede allocation. */
  async function collect(offset: number, length: number, auth: AuthorityType): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at += 65536) {
      auth.signal?.throwIfAborted();
      const n = Math.min(65536, length - at),
        value = await read(offset + at, n, auth.signal ? { signal: auth.signal } : {});
      auth.signal?.throwIfAborted();
      if (!isBytes(value)) invalid("GeoTIFF source returned non-bytes.");
      const bytes = toView(value);
      if (bytes.byteLength !== n) invalid("GeoTIFF source returned an incomplete extent.");
      out.set(bytes, at);
    }
    return out;
  }
  async function fetch(offset: number, length: number): Promise<Uint8Array> {
    extent(offset, length);
    reserve(opening, opened, length, Math.ceil(length / 65536));
    return await collect(offset, length, opening);
  }
  const header = await fetch(0, 8);
  const little = header[0] === 73 && header[1] === 73;
  if (!little && !(header[0] === 77 && header[1] === 77)) invalid("Invalid TIFF byte-order marker.");
  const hd = view(header), magic = hd.getUint16(2, little);
  if (magic !== 42) unsupported("Only classic TIFF identifier 42 is supported; BigTIFF is separate.");
  const widths = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  let next = hd.getUint32(4, little);
  while (next !== 0) {
    opening.signal?.throwIfAborted();
    cap(images.length + 1, policy.images, "GeoTIFF images");
    if (next < 8 || next % 2 || seen.has(next)) invalid("Invalid or cyclic TIFF IFD pointer.");
    seen.add(next);
    meta(256);
    const count = view(await fetch(next, 2)).getUint16(0, little);
    if (!count) invalid("Empty TIFF IFD.");
    cap(count, policy.entries, "GeoTIFF IFD entries");
    meta(product(count, 64));
    const ifdEnd = next + 2 + product(count, 12) + 4;
    if (ifdExtents.some((range) => next < range.end && ifdEnd > range.offset)) invalid("TIFF IFD tables overlap.");
    ifdExtents.push({ offset: next, end: ifdEnd });
    protectedExtents.push({ offset: next, end: ifdEnd });
    const table = await fetch(next + 2, product(count, 12) + 4),
      tv = view(table),
      fields = new Map<number, FieldType>();
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const at = i * 12,
        tag = tv.getUint16(at, little),
        type = tv.getUint16(at + 2, little),
        n = tv.getUint32(at + 4, little);
      if (tag <= previous) invalid("TIFF tags must be increasing and unique.");
      previous = tag;
      const width = widths[type];
      if (!width) unsupported("Unknown TIFF field type.");
      const length = product(n, width), offset = length <= 4 ? next + 2 + at + 8 : tv.getUint32(at + 8, little);
      extent(offset, length);
      if (length > 4 && (offset < 8 || offset % 2)) invalid("Unaligned TIFF field extent.");
      if (length > 4) protectedExtents.push({ offset, end: offset + length });
      fields.set(tag, { tag, type, count: n, offset, length });
      opened.entries++;
    }
    const cache = new Map<number, Uint8Array>();
    const bytes = async (tag: number): Promise<Uint8Array | undefined> => {
      const f = fields.get(tag);
      if (!f) return undefined;
      let b = cache.get(tag);
      if (b) return b;
      cap(f.length, policy.tag, "GeoTIFF known-tag bytes");
      meta(f.length);
      b = await fetch(f.offset, f.length);
      cache.set(tag, b);
      return b;
    };
    const numbers = async (tag: number, types: readonly number[]): Promise<number[] | undefined> => {
      const f = fields.get(tag);
      if (!f) return undefined;
      if (!types.includes(f.type)) invalid(`Unexpected TIFF type for tag ${tag}.`);
      const b = (await bytes(tag))!, v = view(b), out: number[] = [];
      meta(product(f.count, 8));
      for (let i = 0; i < f.count; i++) {
        const at = i * widths[f.type]!;
        out.push(
          f.type === 1
            ? v.getUint8(at)
            : f.type === 3
            ? v.getUint16(at, little)
            : f.type === 4
            ? v.getUint32(at, little)
            : v.getFloat64(at, little),
        );
      }
      return out;
    };
    const scalar = async (tag: number, fallback?: number): Promise<number> => {
      const n = await numbers(tag, [1, 3, 4]);
      if (!n) {
        if (fallback !== undefined) return fallback;
        invalid(`Missing required TIFF tag ${tag}.`);
      }
      if (n.length !== 1) invalid(`TIFF tag ${tag} requires one value.`);
      return n[0]!;
    };
    const width = await scalar(256), height = await scalar(257);
    if (!width || !height) invalid("TIFF image dimensions must be positive.");
    const samples = await scalar(277, 1);
    if (samples !== 1 && samples !== 3) unsupported("Only one or three raw sample bands are supported.");
    const photo = await scalar(262);
    if (![0, 1, 2].includes(photo) || (samples === 3) !== (photo === 2)) {
      unsupported("Only raw grayscale or three-band RGB is supported.");
    }
    for (const [tag, defaultValue] of [[259, 1], [266, 1], [274, 1], [284, 1], [317, 1]] as const) {
      if (await scalar(tag, defaultValue) !== 1) {
        unsupported(`TIFF tag ${tag} requires the selected uncompressed, untransformed profile.`);
      }
    }
    if (fields.has(330) || fields.has(338) || fields.has(32997) || fields.has(32998)) {
      unsupported("SubIFDs, extra samples and depth layouts are outside this profile.");
    }
    const flags = await scalar(254, 0);
    if (flags & ~1) unsupported("Mask and page subfiles are outside this profile.");
    const bits = await numbers(258, [3]) ?? [1], formats = await numbers(339, [3]) ?? Array<number>(samples).fill(1);
    if (
      bits.length !== samples || formats.length !== samples || bits.some((n) => n !== bits[0]) ||
      formats.some((n) => n !== formats[0])
    ) unsupported("Uniform explicit byte-aligned samples are required.");
    const sample = sampleOf(bits[0]!, formats[0]!),
      sampleBytes = bits[0]! / 8,
      bpp = product(samples, sampleBytes),
      tiled = [322, 323, 324, 325].some((tag) => fields.has(tag));
    if (tiled && [273, 278, 279].some((tag) => fields.has(tag))) invalid("TIFF mixes strip and tile authority.");
    const blockWidth = tiled ? await scalar(322) : width,
      blockHeight = tiled ? await scalar(323) : await scalar(278, 4294967295);
    if (!blockWidth || !blockHeight) invalid("TIFF block dimensions must be positive.");
    if (tiled && (blockWidth % 16 || blockHeight % 16)) invalid("TIFF tile dimensions must be multiples of 16.");
    const across = tiled ? Math.ceil(width / blockWidth) : 1,
      down = Math.ceil(height / blockHeight),
      chunks = product(across, down);
    cap(chunks, policy.chunks - opened.chunks, "GeoTIFF total chunks");
    meta(product(chunks, 24));
    const offsets = await numbers(tiled ? 324 : 273, tiled ? [4] : [3, 4]),
      lengths = await numbers(tiled ? 325 : 279, [3, 4]);
    if (!offsets || !lengths || offsets.length !== chunks || lengths.length !== chunks) {
      invalid("TIFF block table cardinality mismatch.");
    }
    for (let i = 0; i < chunks; i++) {
      const expected = product(blockWidth, tiled ? blockHeight : Math.min(blockHeight, height - i * blockHeight), bpp);
      if (!offsets[i] || lengths[i] !== expected) {
        unsupported("Sparse or non-exact uncompressed TIFF blocks are outside this profile.");
      }
      extent(offsets[i]!, expected);
    }
    // Sorting a bounded copied index detects ambiguous reuse without changing physical block order.
    const order = Uint32Array.from({ length: offsets.length }, (_, i) => i);
    order.sort((a, b) => offsets[a]! - offsets[b]!);
    for (let i = 1; i < order.length; i++) {
      const previous = order[i - 1]!, current = order[i]!;
      if (offsets[current]! < offsets[previous]! + lengths[previous]!) {
        unsupported("Overlapping TIFF blocks are outside this profile.");
      }
    }

    const directory = await numbers(34735, [3]);
    let geo: GeotiffGeoType;
    if (!directory) {
      if (!(flags & 1)) unsupported("Full-resolution image lacks GeoKeyDirectory metadata.");
      geo = Object.freeze({
        scope: "absent-reduced-image",
        keys: Object.freeze([]),
        pixelScale: Object.freeze([]),
        tiepoints: Object.freeze([]),
        transformation: Object.freeze([]),
        ascii: Object.freeze([]),
      });
    } else {
      if (directory.length < 4 || directory[0] !== 1 || directory[1] !== 1 || ![0, 1].includes(directory[2]!)) {
        unsupported("Only GeoTIFF directory version 1/revision 1/minor 0 or 1 is supported.");
      }
      const keyCount = directory[3]!;
      cap(keyCount, policy.keys, "GeoTIFF keys");
      const tail = 4 + product(keyCount, 4);
      if (tail > directory.length) invalid("Truncated GeoKeyDirectory.");
      meta(product(keyCount, 64));
      const doubles = await numbers(34736, [12]) ?? [],
        ascii = await bytes(34737) ?? new Uint8Array(),
        asciiField = fields.get(34737);
      if (
        asciiField &&
        (asciiField.type !== 2 || !ascii.length || ascii[ascii.length - 1] !== 0 ||
          ascii.subarray(0, -1).some((n) => n === 0 || n > 127))
      ) invalid("Invalid GeoASCII parameter storage.");
      const keys: GeotiffKeyType[] = [];
      let last = -1;
      for (let i = 0; i < keyCount; i++) {
        const at = 4 + i * 4,
          id = directory[at]!,
          location = directory[at + 1]!,
          count = directory[at + 2]!,
          offset = directory[at + 3]!;
        if (id <= last || !count) invalid("GeoKeys must be unique, increasing and nonempty.");
        last = id;
        let values: readonly number[] | string;
        if (location === 0) {
          if (count !== 1) invalid("Inline GeoKey requires one value.");
          meta(8);
          values = Object.freeze([offset]);
        } else if (location === 34735 || location === 34736) {
          const from = location === 34735 ? directory : doubles;
          if (offset > from.length || count > from.length - offset || (location === 34735 && offset < tail)) {
            invalid("GeoKey numeric parameters exceed their admitted storage.");
          }
          meta(product(count, 8));
          values = Object.freeze(from.slice(offset, offset + count));
        } else if (location === 34737) {
          if (offset > ascii.length - 1 || count > ascii.length - 1 - offset || ascii[offset + count - 1] !== 124) {
            invalid("GeoKey ASCII parameters lack an exact pipe-terminated extent.");
          }
          meta(product(count, 2));
          let text = "";
          for (let at = offset; at < offset + count; at += 4096) {
            text += String.fromCharCode(...ascii.subarray(at, Math.min(offset + count, at + 4096)));
          }
          values = text;
        } else unsupported("Unsupported GeoKey parameter tag.");
        keys.push(Object.freeze({ id, location, count, offset, values }));
      }
      const pixelScale = await numbers(33550, [12]) ?? [],
        tiepoints = await numbers(33922, [12]) ?? [],
        transformation = await numbers(34264, [12]) ?? [];
      if (
        (fields.has(33550) && pixelScale.length !== 3) ||
        (fields.has(33922) && (!tiepoints.length || tiepoints.length % 6)) ||
        (fields.has(34264) && transformation.length !== 16) ||
        [...pixelScale, ...tiepoints, ...transformation].some((n) => !Number.isFinite(n))
      ) invalid("Malformed GeoTIFF coordinate declarations.");
      if (transformation.length && (pixelScale.length || tiepoints.length)) {
        invalid("Conflicting GeoTIFF coordinate authorities.");
      }
      if (!(flags & 1) && (!transformation.length && (!pixelScale.length || !tiepoints.length))) {
        unsupported("Selected full-resolution georeferencing needs scale/tiepoint or model matrix.");
      }
      meta(product(ascii.length, 8));
      geo = Object.freeze({
        scope: "unresolved-declarations",
        revision: directory[2] as 0 | 1,
        keys: Object.freeze(keys),
        pixelScale: Object.freeze(pixelScale),
        tiepoints: Object.freeze(tiepoints),
        transformation: Object.freeze(transformation),
        ascii: Object.freeze(Array.from(ascii)),
      });
    }
    const known = new Set([
      254,
      256,
      257,
      258,
      259,
      262,
      266,
      273,
      274,
      277,
      278,
      279,
      284,
      317,
      322,
      323,
      324,
      325,
      33550,
      33922,
      339,
      34264,
      34735,
      34736,
      34737,
    ]);
    const descriptor: GeotiffImageType = Object.freeze({
      id: images.length,
      ifdOffset: next,
      width,
      height,
      samplesPerPixel: samples,
      sample,
      photometric: photo as 0 | 1 | 2,
      reduced: !!(flags & 1),
      layout: tiled ? "tiles" : "strips",
      blockWidth,
      blockHeight,
      blocks: chunks,
      geo,
      unknownTags: Object.freeze([...fields.keys()].filter((tag) => !known.has(tag))),
    });
    images.push({
      public: descriptor,
      offsets: Float64Array.from(offsets),
      lengths: Float64Array.from(lengths),
      bytes: sampleBytes,
      across,
    });
    opened.images++;
    opened.chunks += chunks;
    next = tv.getUint32(count * 12, little);
  }
  if (!images.length) invalid("TIFF has no image directory.");
  // A conservative profile prevents raster bytes from doubling as admitted structural authority.
  protectedExtents.sort((a, b) => a.offset - b.offset);
  const merged: { offset: number; end: number }[] = [];
  for (const range of protectedExtents) {
    const last = merged.at(-1);
    if (last && range.offset <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  for (const img of images) {
    for (let i = 0; i < img.public.blocks; i++) {
      const start = img.offsets[i]!, end = start + img.lengths[i]!;
      let lo = 0, hi = merged.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (merged[mid]!.end <= start) lo = mid + 1;
        else hi = mid;
      }
      if (lo < merged.length && merged[lo]!.offset < end) {
        unsupported("TIFF raster storage overlaps structural metadata in this conservative profile.");
      }
    }
  }

  function image(id: number): ImageType {
    integer(id, "GeoTIFF image ID");
    const result = images[id];
    if (!result) throw new RangeError("Unknown GeoTIFF image.");
    return result;
  }
  /** Fixed per-row spans keep plan and read costs identical, even across padded boundary tiles. */
  function spansOf(
    img: ImageType,
    input: GeotiffWindowType,
  ): { window: GeotiffWindowType; spans: SpanType[]; plan: GeotiffPlanType } {
    const window = { ...input };
    for (const [key, n] of Object.entries(window)) integer(n, `GeoTIFF window ${key}`);
    const { x, y, width, height } = window, d = img.public;
    if (
      ![x, y, width, height].every((n) => Number.isSafeInteger(n) && n >= 0) || x > d.width || y > d.height ||
      width > d.width - x || height > d.height - y
    ) throw new RangeError("GeoTIFF window exceeds image.");
    const pixels = product(width, height), output = product(pixels, d.samplesPerPixel, img.bytes);
    cap(pixels, policy.pixels, "GeoTIFF selected pixels");
    cap(output, policy.output, "GeoTIFF window output");
    const spans: SpanType[] = [];
    let sourceBytes = 0, requests = 0;
    const chunks = new Set<number>();
    if (width && height) {
      for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width;) {
          cap(spans.length + 1, policy.spans, "GeoTIFF planned row spans");
          const bx = Math.floor(col / d.blockWidth),
            by = Math.floor(row / d.blockHeight),
            block = by * img.across + bx,
            n = Math.min(x + width - col, d.blockWidth - col % d.blockWidth),
            length = product(n, d.samplesPerPixel, img.bytes),
            offset = img.offsets[block]! +
              product((row % d.blockHeight) * d.blockWidth + col % d.blockWidth, d.samplesPerPixel, img.bytes),
            out = product((row - y) * width + col - x, d.samplesPerPixel);
          extent(offset, length);
          spans.push({ offset, length, output: out });
          sourceBytes += length;
          requests += Math.ceil(length / 65536);
          chunks.add(block);
          col += n;
        }
      }
    }
    return {
      window,
      spans,
      plan: Object.freeze({
        sourceBytes,
        requests,
        decodedBytes: sourceBytes,
        outputBytes: output,
        pixels,
        spans: spans.length,
        chunks: chunks.size,
      }),
    };
  }
  return Object.freeze({
    images: Object.freeze(images.map((i) => i.public)),
    cog: "not-evaluated",
    work: Object.freeze({ ...opened }),
    plan(id: number, window: GeotiffWindowType): GeotiffPlanType {
      opening.signal?.throwIfAborted();
      const result = spansOf(image(id), window).plan;
      opening.signal?.throwIfAborted();
      return result;
    },
    async read(id: number, window: GeotiffWindowType, call: GeotiffCallOptionsType = {}): Promise<GeotiffReadType> {
      const auth = authority({ ...call }, opening);
      auth.signal?.throwIfAborted();
      const img = image(id), selected = spansOf(img, window), work = fresh(), cost = selected.plan;
      reserve(auth, work, cost.sourceBytes, cost.requests, cost.outputBytes);
      const result = valuesOf(img.public.sample, cost.outputBytes / img.bytes);
      for (const span of selected.spans) {
        const bytes = await collect(span.offset, span.length, auth), v = view(bytes);
        for (let i = 0; i < span.length / img.bytes; i++) {
          result[span.output + i] = numberAt(v, i * img.bytes, img.public.sample, little);
        }
        auth.signal?.throwIfAborted();
      }
      work.spans = cost.spans;
      work.chunks = cost.chunks;
      return Object.freeze({
        values: result,
        width: selected.window.width,
        height: selected.window.height,
        samplesPerPixel: img.public.samplesPerPixel,
        integrity: "not-provided",
        work: Object.freeze(work),
      });
    },
    source(id: number, block: number, call: GeotiffCallOptionsType = {}): ByteSourceType {
      const auth = authority({ ...call }, opening);
      auth.signal?.throwIfAborted();
      const img = image(id);
      integer(block, "GeoTIFF block ID");
      if (block >= img.public.blocks) {
        throw new RangeError("Unknown GeoTIFF block.");
      }
      const offset = img.offsets[block]!, length = img.lengths[block]!;
      const provenance = identity === undefined
        ? undefined
        : JSON.stringify(["geotiff", identity, "physical-block", offset, length]);
      if (provenance !== undefined && provenance.length > 8192) {
        throw new TypeError("GeoTIFF composed block identity exceeds 8192 UTF-16 code units.");
      }
      return Object.freeze({
        size: length,
        ...(provenance !== undefined ? { identity: provenance } : {}),
        ...(stability !== undefined ? { stability } : {}),
        async read(at: number, n: number, next: GeotiffCallOptionsType = {}): Promise<Uint8Array> {
          const child = authority({ ...next }, auth), work = fresh();
          child.signal?.throwIfAborted();
          integer(at, "GeoTIFF block offset");
          integer(n, "GeoTIFF block length");
          if (at > length || n > length - at) {
            throw new RangeError("GeoTIFF block range exceeds stored extent.");
          }
          cap(n, policy.output, "GeoTIFF raw source interval bytes");
          reserve(child, work, n, Math.ceil(n / 65536), n);
          return await collect(offset + at, n, child);
        },
      });
    },
  });
}
