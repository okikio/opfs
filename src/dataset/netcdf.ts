/** Bounded CDF-1/CDF-2 metadata and selected raw numeric ranges. @module */
import type { ByteSourceType } from "../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  createArchiveLedger,
  integer,
  invalid,
  limitsOf,
  unsupported,
  view,
} from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Classic external types; CDF-2 extends offsets, not these value types. */
export type NetcdfStorageType = "byte" | "char" | "short" | "int" | "float" | "double";
/** CHAR remains uninterpreted bytes, not an assumed UTF-8 string. */
export type NetcdfValuesType = Int8Array | Uint8Array | Int16Array | Int32Array | Float32Array | Float64Array;
/** Attribute values are immutable scalar numbers; CHAR values are unsigned bytes. */
export interface NetcdfAttributeType {
  readonly name: string;
  readonly type: NetcdfStorageType;
  readonly values: readonly number[];
}
/** A zero encoded dimension is unlimited; length is this snapshot's finite record count. */
export interface NetcdfDimensionType {
  readonly id: number;
  readonly name: string;
  readonly length: number;
  readonly unlimited: boolean;
}
/** Variable shape is row-major: the last axis varies fastest. */
export interface NetcdfVariableType {
  readonly id: number;
  readonly name: string;
  readonly type: NetcdfStorageType;
  readonly dimensions: readonly number[];
  readonly shape: readonly number[];
  readonly elements: number;
  readonly attributes: readonly NetcdfAttributeType[];
  readonly offset: number;
  readonly vsize: number;
  readonly record: boolean;
  readonly recordElements: number;
}
/** Index and selection limits supplement the byte/work ledger, which persists for the dataset lifetime. */
export interface NetcdfOpenOptionsType extends ArchiveLimitsType {
  /** Parsed header bytes, excluding bounded readahead. Default 8 MiB. */
  readonly maxHeaderBytes?: number;
  /** Number of declared dimensions retained. Default 4096. */
  readonly maxDimensions?: number;
  /** Number of declared variables retained. Default 4096. */
  readonly maxVariables?: number;
  /** Aggregate global and variable attribute count. Default 16384. */
  readonly maxAttributes?: number;
  /** Aggregate attribute scalar values retained as frozen numbers. Default 1,048,576. */
  readonly maxAttributeValues?: number;
  /** Dimension references per variable, including the unlimited axis. Default 32. */
  readonly maxRank?: number;
  /** Returned elements per read, independently of byte/output policies. Default 1,048,576. */
  readonly maxElements?: number;
  /** At most this many selected slabs/chunks may be planned before I/O. Default 4096. */
  readonly maxSegments?: number;
  /** Packed sentinel values admitted into an operation-owned Set. Default 4096. */
  readonly maxMissingValues?: number;
  /** Strict by default. Opt in only to observed sole BYTE/CHAR/SHORT vsize deviations. */
  readonly recordVsize?: "validate" | "allow-unpadded";
  /** Explicitly accept a source with no declared stable-snapshot contract. Default false. */
  readonly allowUnverifiedSource?: boolean;
  /** Opening owner cancellation remains active for all later reads. */
  readonly signal?: AbortSignal;
}
/** Flat element selection; missing-value interpretation is explicit and never replaces stored values. */
export interface NetcdfReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly count?: number;
  readonly scale?: "raw" | "physical";
  readonly missing?: "none" | "attributes" | "fill";
  readonly signal?: AbortSignal;
}
/** Mask concerns packed source values, not IEEE values introduced by physical scaling. */
export interface NetcdfReadType {
  readonly values: NetcdfValuesType;
  readonly undefinedMask: Uint8Array;
  readonly type: NetcdfStorageType;
  readonly scale: "raw" | "physical";
  readonly missing: "none" | "attributes" | "fill";
  readonly integrity: "not-provided";
  readonly work: ArchiveWorkType;
}
/** Borrowed stable snapshot with no extraction or host resources. */
export interface NetcdfDatasetType {
  readonly version: 1 | 2;
  readonly records: number;
  readonly recordStride: number;
  readonly headerBytes: number;
  readonly recordVsize: "validate" | "allow-unpadded";
  readonly deviations: readonly {
    readonly id: number;
    readonly declaredVsize: number;
    readonly expectedVsize: number;
  }[];
  readonly dimensions: readonly NetcdfDimensionType[];
  readonly attributes: readonly NetcdfAttributeType[];
  readonly variables: readonly NetcdfVariableType[];
  readonly work: ArchiveWorkType;
  read(id: number, options?: NetcdfReadOptionsType): Promise<NetcdfReadType>;
}
function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported("netCDF extent exceeds exact JavaScript indexing.");
  }
  return Number(value);
}
function policy(value: number | undefined, fallback: number, label: string): number {
  const count = value ?? fallback;
  integer(count, label);
  return count;
}
function widthOf(type: NetcdfStorageType): number {
  return type === "double" ? 8 : type === "float" || type === "int" ? 4 : type === "short" ? 2 : 1;
}
function typeOf(code: number): NetcdfStorageType {
  switch (code) {
    case 1:
      return "byte";
    case 2:
      return "char";
    case 3:
      return "short";
    case 4:
      return "int";
    case 5:
      return "float";
    case 6:
      return "double";
    default:
      return unsupported("Unknown classic netCDF storage type.");
  }
}
function numberAt(data: DataView, offset: number, type: NetcdfStorageType): number {
  switch (type) {
    case "byte":
      return data.getInt8(offset);
    case "char":
      return data.getUint8(offset);
    case "short":
      return data.getInt16(offset, false);
    case "int":
      return data.getInt32(offset, false);
    case "float":
      return data.getFloat32(offset, false);
    case "double":
      return data.getFloat64(offset, false);
  }
}
/** One bounded readahead extent avoids one provider call per header integer. Any bytes
 * fetched beyond the logical header are still charged to source work. */
class Header {
  at = 0;
  #buffer: Uint8Array = new Uint8Array();
  #start = 0;
  readonly budget: ArchiveBudget;
  readonly size: number;
  readonly maximum: number;
  constructor(budget: ArchiveBudget, size: number, maximum: number) {
    this.budget = budget;
    this.size = size;
    this.maximum = maximum;
  }
  async take(length: number): Promise<Uint8Array> {
    integer(length, "netCDF header field bytes");
    if (length > this.maximum - this.at) {
      throw new ArchiveError("budget-exceeded", "netCDF header byte limit exceeded.");
    }
    this.budget.decoded(length);
    if (length > this.size - this.at) invalid("Truncated netCDF header.");
    const result = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      if (this.at < this.#start || this.at >= this.#start + this.#buffer.length) {
        this.#start = this.at;
        this.#buffer = await this.budget.read(this.at, Math.min(4096, this.size - this.at, this.maximum - this.at));
      }
      const available = Math.min(length - copied, this.#start + this.#buffer.length - this.at);
      result.set(this.#buffer.subarray(this.at - this.#start, this.at - this.#start + available), copied);
      this.at += available;
      copied += available;
    }
    return result;
  }
  async uint(): Promise<number> {
    return view(await this.take(4)).getUint32(0, false);
  }
  async count(): Promise<number> {
    const value = await this.uint();
    if (value > 0x7fffffff) unsupported("netCDF signed metadata count exceeds supported range.");
    return value;
  }
  async padding(length: number): Promise<void> {
    for (const value of await this.take((4 - length % 4) % 4)) {
      if (value) invalid("netCDF header padding must be zero.");
    }
  }
  async name(): Promise<string> {
    const length = await this.count();
    const bytes = await this.take(length);
    await this.padding(length);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("Invalid netCDF UTF-8 name.");
    }
    let forbidden = false;
    for (const character of name) {
      const code = character.codePointAt(0)!;
      if (code < 32 || code === 127 || code === 47) forbidden = true;
    }
    if (
      !name || name !== name.normalize("NFC") || !/^[A-Za-z0-9_\u0080-\u{10ffff}]/u.test(name) ||
      forbidden || name.endsWith(" ")
    ) invalid("Unsupported netCDF name spelling.");
    return name;
  }
  async list(tag: number, maximum: number): Promise<number> {
    const actual = await this.uint(), count = await this.count();
    if (actual === 0 && count === 0) return 0;
    if (actual !== tag) invalid("Invalid netCDF list tag.");
    if (count > maximum) throw new ArchiveError("budget-exceeded", "netCDF list count limit exceeded.");
    return count;
  }
}

/** Opens ordinary finite CDF-1/CDF-2 layouts. Streaming record counts and overflow
 * vsize declarations are unsupported; HDF5/netCDF-4 and CDF-5 are separate formats. */
export async function openNetcdf(
  input: ByteSourceType,
  options: NetcdfOpenOptionsType = {},
): Promise<NetcdfDatasetType> {
  options = { ...options };
  const size = input.size, identity = input.identity, stability = input.stability;
  integer(size, "netCDF source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Invalid netCDF source identity.");
  }
  if (stability !== undefined && stability !== "immutable" && stability !== "provider" && stability !== "caller") {
    throw new TypeError("Invalid netCDF source stability.");
  }
  if (!stability && options.allowUnverifiedSource !== true) {
    unsupported("netCDF requires stable source evidence or allowUnverifiedSource: true.");
  }
  const source: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability ? { stability } : {}),
    read: input.read.bind(input),
  };
  const local = createArchiveLedger(options), opening = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      opening?.reserve(kind, count);
    },
    inspect: local.inspect,
  };
  const maxHeader = policy(options.maxHeaderBytes, 8 * 1024 * 1024, "maxHeaderBytes"),
    maxDimensions = policy(options.maxDimensions, 4096, "maxDimensions"),
    maxVariables = policy(options.maxVariables, 4096, "maxVariables"),
    maxAttributes = policy(options.maxAttributes, 16384, "maxAttributes"),
    maxValues = policy(options.maxAttributeValues, 1024 * 1024, "maxAttributeValues"),
    maxRank = policy(options.maxRank, 32, "maxRank"),
    maxElements = policy(options.maxElements, 1024 * 1024, "maxElements"),
    maxSegments = policy(options.maxSegments, 4096, "maxSegments");
  const maxMissingValues = policy(options.maxMissingValues, 4096, "maxMissingValues");
  const recordVsize = options.recordVsize ?? "validate";
  if (recordVsize !== "validate" && recordVsize !== "allow-unpadded") {
    throw new TypeError("Invalid netCDF record vsize policy.");
  }
  const work = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal),
    header = new Header(work, size, maxHeader);
  const magic = await header.take(4);
  if (magic[0] !== 67 || magic[1] !== 68 || magic[2] !== 70) unsupported("Not a classic netCDF CDF file.");
  const version = magic[3];
  if (version !== 1 && version !== 2) unsupported("Only netCDF CDF-1/CDF-2 are supported.");
  const records = await header.uint();
  if (records === 0xffffffff) unsupported("Streaming netCDF record counts are not supported.");
  const dimensions: NetcdfDimensionType[] = [], dimensionNames = new Set<string>();
  let unlimited = -1;
  const dimensionCount = await header.list(10, maxDimensions);
  for (let i = 0; i < dimensionCount; i++) {
    const name = await header.name(), encoded = await header.count();
    if (dimensionNames.has(name)) invalid("Duplicate netCDF dimension name.");
    dimensionNames.add(name);
    if (encoded === 0) {
      if (unlimited !== -1) invalid("Multiple netCDF unlimited dimensions.");
      unlimited = i;
    }
    dimensions.push(Object.freeze({ id: i, name, length: encoded || records, unlimited: encoded === 0 }));
  }
  let attributeCount = 0, attributeValues = 0;
  const attributes = async (): Promise<readonly NetcdfAttributeType[]> => {
    const count = await header.list(12, maxAttributes - attributeCount);
    attributeCount += count;
    const result: NetcdfAttributeType[] = [], names = new Set<string>();
    for (let i = 0; i < count; i++) {
      const name = await header.name();
      if (names.has(name)) invalid("Duplicate netCDF attribute name.");
      names.add(name);
      const type = typeOf(await header.uint()), count = await header.count();
      if (count > maxValues - attributeValues) {
        throw new ArchiveError("budget-exceeded", "netCDF aggregate attribute value limit exceeded.");
      }
      attributeValues += count;
      const length = exact(BigInt(count) * BigInt(widthOf(type))), bytes = await header.take(length);
      await header.padding(length);
      // Frozen number arrays keep caller mutation from changing interpretation later.
      work.decoded(count * 8);
      const values: number[] = [], data = view(bytes);
      for (let index = 0; index < count; index++) values.push(numberAt(data, index * widthOf(type), type));
      result.push(Object.freeze({ name, type, values: Object.freeze(values) }));
    }
    return Object.freeze(result);
  };
  const global = await attributes(), variables: NetcdfVariableType[] = [], names = new Set<string>();
  const deviations: { readonly id: number; readonly declaredVsize: number; readonly expectedVsize: number }[] = [];
  const variableCount = await header.list(11, maxVariables);
  for (let id = 0; id < variableCount; id++) {
    const name = await header.name();
    if (names.has(name)) invalid("Duplicate netCDF variable name.");
    names.add(name);
    const rank = await header.count();
    if (rank > maxRank) throw new ArchiveError("budget-exceeded", "netCDF variable rank limit exceeded.");
    const ids: number[] = [], shape: number[] = [];
    let record = false, elementCount = 1n, slabCount = 1n;
    for (let axis = 0; axis < rank; axis++) {
      const dimid = await header.count(), dimension = dimensions[dimid];
      if (!dimension) invalid("Unknown netCDF dimension reference.");
      if (dimension.unlimited) {
        if (axis !== 0) invalid("netCDF unlimited dimension must be the first variable axis.");
        record = true;
      }
      ids.push(dimid);
      shape.push(dimension.length);
      elementCount *= BigInt(dimension.length);
      if (!dimension.unlimited) slabCount *= BigInt(dimension.length);
    }
    const attrs = await attributes(), type = typeOf(await header.uint()), vsize = await header.uint();
    if (vsize === 0xffffffff) unsupported("netCDF overflow vsize declarations are not supported.");
    const encodedOffset = version === 1
      ? BigInt(view(await header.take(4)).getInt32(0, false))
      : view(await header.take(8)).getBigInt64(0, false);
    const offset = exact(encodedOffset),
      slabBytes = slabCount * BigInt(widthOf(type)),
      padded = exact((slabBytes + 3n) / 4n * 4n);
    if (padded !== vsize) deviations.push(Object.freeze({ id, declaredVsize: vsize, expectedVsize: padded }));
    if (offset % 4) invalid("netCDF variable start is not four-byte aligned.");
    variables.push(
      Object.freeze({
        id,
        name,
        type,
        dimensions: Object.freeze(ids),
        shape: Object.freeze(shape),
        elements: exact(elementCount),
        attributes: attrs,
        offset,
        vsize,
        record,
        recordElements: exact(slabCount),
      }),
    );
  }
  let fixedEnd = header.at;
  for (const variable of variables.filter((variable) => !variable.record)) {
    if (variable.offset < fixedEnd) invalid("netCDF fixed variables overlap metadata or previous data.");
    fixedEnd = exact(BigInt(variable.offset) + BigInt(variable.vsize));
    if (fixedEnd > size) invalid("Truncated netCDF fixed variable.");
  }
  const recordVariables = variables.filter((variable) => variable.record);
  for (const deviation of deviations) {
    const variable = variables[deviation.id]!;
    if (
      recordVsize !== "allow-unpadded" || recordVariables.length !== 1 || !variable.record ||
      (variable.type !== "byte" && variable.type !== "char" && variable.type !== "short") ||
      (variable.vsize !== variable.recordElements * widthOf(variable.type) && !(records === 0 && variable.vsize === 0))
    ) {
      invalid("netCDF vsize disagrees with dimensions and storage type.");
    }
  }
  const recordBase = recordVariables[0]?.offset ?? fixedEnd;
  let paddedStride = 0n;
  for (const variable of recordVariables) {
    if (variable.offset < fixedEnd || BigInt(variable.offset) !== BigInt(recordBase) + paddedStride) {
      invalid("Invalid netCDF interleaved record slab layout.");
    }
    paddedStride += BigInt(variable.vsize);
  }
  // The one-record-variable exception drops inter-slab padding, but never changes vsize.
  const single = recordVariables.length === 1 ? recordVariables[0] : undefined;
  const recordStride = exact(single ? BigInt(single.recordElements) * BigInt(widthOf(single.type)) : paddedStride);
  if (records && recordVariables.length && BigInt(recordBase) + BigInt(records) * BigInt(recordStride) > BigInt(size)) {
    invalid("Truncated netCDF record data.");
  }
  options.signal?.throwIfAborted();
  return {
    version,
    records,
    recordStride,
    headerBytes: header.at,
    recordVsize,
    deviations: Object.freeze(deviations),
    dimensions: Object.freeze(dimensions),
    attributes: global,
    variables: Object.freeze(variables),
    work: work.inspect(),
    async read(id, opts = {}) {
      opts = { ...opts };
      integer(id, "netCDF variable id");
      const variable = variables[id];
      if (!variable) throw new RangeError("Unknown netCDF variable id.");
      const offset = opts.offset ?? 0,
        count = opts.count ?? variable.elements - offset,
        scale = opts.scale ?? "raw",
        missing = opts.missing ?? "attributes";
      integer(offset, "netCDF element offset");
      integer(count, "netCDF element count");
      if (offset > variable.elements || count > variable.elements - offset) {
        throw new RangeError("netCDF selection exceeds variable.");
      }
      if (count > maxElements) throw new ArchiveError("budget-exceeded", "netCDF selected element limit exceeded.");
      if (scale !== "raw" && scale !== "physical") throw new TypeError("Invalid netCDF scaling policy.");
      if (missing !== "none" && missing !== "attributes" && missing !== "fill") {
        throw new TypeError("Invalid netCDF missing-value policy.");
      }
      if (scale === "physical" && variable.type === "char") unsupported("netCDF CHAR has no numeric physical scaling.");
      const signal = options.signal && opts.signal
        ? AbortSignal.any([options.signal, opts.signal])
        : options.signal ?? opts.signal;
      signal?.throwIfAborted();
      const get = (name: string): NetcdfAttributeType | undefined =>
        variable.attributes.find((attribute) => attribute.name === name);
      const scalar = (name: string, fallback: number): number => {
        const attribute = get(name);
        if (!attribute) return fallback;
        if (attribute.type === "char" || attribute.values.length !== 1 || !Number.isFinite(attribute.values[0])) {
          unsupported(`netCDF ${name} requires a finite numeric scalar.`);
        }
        return attribute.values[0]!;
      };
      let factor = 1, addition = 0;
      if (scale === "physical") {
        const unsigned = get("_Unsigned");
        if (
          unsigned &&
          (unsigned.type !== "char" || unsigned.values.length !== 5 ||
            String.fromCharCode(...unsigned.values).toLowerCase() !== "false")
        ) unsupported("netCDF unsigned interpretation is not implemented for physical scaling.");
        factor = scalar("scale_factor", 1);
        addition = scalar("add_offset", 0);
      }
      const sentinelArrays: (readonly number[])[] = [];
      let sentinelCount = 0;
      if (missing !== "none" && variable.type !== "char") {
        for (const name of ["_FillValue", "missing_value"]) {
          const attribute = get(name);
          if (!attribute) continue;
          if (attribute.type !== variable.type || (name === "_FillValue" && attribute.values.length !== 1)) {
            unsupported(`netCDF ${name} requires stored-type ${name === "_FillValue" ? "scalar" : "values"}.`);
          }
          if (attribute.values.length > maxMissingValues - sentinelCount) {
            throw new ArchiveError("budget-exceeded", "netCDF interpreted missing-value count limit exceeded.");
          }
          sentinelCount += attribute.values.length;
          sentinelArrays.push(attribute.values);
        }
        if (missing === "fill" && !get("_FillValue")) {
          if (sentinelCount >= maxMissingValues) {
            throw new ArchiveError("budget-exceeded", "netCDF interpreted missing-value count limit exceeded.");
          }
          sentinelCount++;
          sentinelArrays.push([
            variable.type === "byte"
              ? -127
              : variable.type === "short"
              ? -32767
              : variable.type === "int"
              ? -2147483647
              : 9.969209968386869e36,
          ]);
        }
      }
      const width = widthOf(variable.type), bytes = exact(BigInt(count) * BigInt(width));
      const segments: { offset: number; elements: number }[] = [];
      let remaining = count, element = offset;
      while (remaining) {
        if (segments.length >= maxSegments) {
          throw new ArchiveError("budget-exceeded", "netCDF selected segment limit exceeded.");
        }
        const slab = variable.record ? Math.floor(element / variable.recordElements) : 0,
          inner = variable.record ? element % variable.recordElements : element;
        const elements = Math.min(
          remaining,
          variable.record ? variable.recordElements - inner : remaining,
          65536 / width,
        );
        segments.push({
          offset: exact(BigInt(variable.offset) + BigInt(slab) * BigInt(recordStride) + BigInt(inner) * BigInt(width)),
          elements,
        });
        remaining -= elements;
        element += elements;
      }
      const limits = limitsOf(opts);
      if (bytes > limits.maxSourceBytes || segments.length > limits.maxRequests) {
        throw new ArchiveError("budget-exceeded", "netCDF known source cost exceeds operation policy.");
      }
      const extra = opts.ledger;
      const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
        lifetime.reserve(kind, count);
        if (extra && extra !== opening) extra.reserve(kind, count);
      };
      reserve("sourceBytes", bytes);
      reserve("requests", segments.length);
      let sourceCredit = bytes, requestCredit = segments.length;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          if (kind === "sourceBytes") {
            if (count > sourceCredit) throw new Error("netCDF source credit invariant.");
            sourceCredit -= count;
          } else if (kind === "requests") {
            if (count > requestCredit) throw new Error("netCDF request credit invariant.");
            requestCredit -= count;
          } else reserve(kind, count);
        },
        inspect: local.inspect,
      };
      const budget = new ArchiveBudget(source, { ...opts, ledger }, signal);
      budget.decoded(exact(BigInt(bytes) + BigInt(sentinelCount) * 8n));
      budget.output(exact(BigInt(count) * BigInt((scale === "physical" ? 8 : width) + 1)));
      signal?.throwIfAborted();
      const sentinels = new Set<number>();
      for (const array of sentinelArrays) for (const value of array) sentinels.add(value);
      const values: NetcdfValuesType = scale === "physical" || variable.type === "double"
        ? new Float64Array(count)
        : variable.type === "byte"
        ? new Int8Array(count)
        : variable.type === "char"
        ? new Uint8Array(count)
        : variable.type === "short"
        ? new Int16Array(count)
        : variable.type === "int"
        ? new Int32Array(count)
        : new Float32Array(count);
      const undefinedMask = new Uint8Array(count);
      let output = 0;
      for (const segment of segments) {
        const data = view(await budget.read(segment.offset, segment.elements * width));
        for (let index = 0; index < segment.elements; index++) {
          const value = numberAt(data, index * width, variable.type);
          undefinedMask[output] =
            missing !== "none" && variable.type !== "char" && (Number.isNaN(value) || sentinels.has(value)) ? 1 : 0;
          values[output++] = scale === "physical" ? value * factor + addition : value;
        }
      }
      signal?.throwIfAborted();
      return {
        values,
        undefinedMask,
        type: variable.type,
        scale,
        missing,
        integrity: "not-provided",
        work: budget.inspect(),
      };
    },
  };
}
