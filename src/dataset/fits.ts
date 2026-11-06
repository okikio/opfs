/** Bounded FITS 4.0 primary/image HDU inspection and numeric previews. @module */
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

/** FITS storage types. All input values use big-endian byte order. */
export type FitsBitpixType = 8 | 16 | 32 | 64 | -32 | -64;
/** Raw values preserve the stored precision; physical values use Float64Array. */
export type FitsValuesType = Uint8Array | Int16Array | Int32Array | BigInt64Array | Float32Array | Float64Array;
/** One physical HDU. Axis 1 changes fastest; dimensions retain FITS order. */
export interface FitsHduType {
  readonly id: number;
  readonly kind: "primary" | "image";
  readonly bitpix: FitsBitpixType;
  readonly axes: readonly number[];
  readonly elements: number;
  readonly headerOffset: number;
  readonly headerBytes: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly paddedDataBytes: number;
  readonly cards: readonly string[];
  readonly bscale: number;
  readonly bzero: number;
  readonly blank?: bigint;
  readonly unit?: string;
  readonly datasum?: number;
  readonly checksum?: string;
}
/** Limits are finite; opening byte/work policies also bound the lifetime of the returned reader. */
export interface FitsOpenOptionsType extends ArchiveLimitsType {
  readonly maxHdus?: number;
  readonly maxHeaderBytes?: number;
  readonly maxAxes?: number;
  readonly maxElements?: number;
  readonly allowUnverifiedSource?: boolean;
  readonly signal?: AbortSignal;
}
/** Offset/count are zero-based elements, not bytes or multidimensional coordinates. */
export interface FitsReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly count?: number;
  readonly scale?: "raw" | "physical";
  readonly signal?: AbortSignal;
}
/** Mask 1 denotes a source BLANK or NaN, independently of scaling-induced IEEE results. */
export interface FitsReadType {
  readonly values: FitsValuesType;
  readonly undefinedMask: Uint8Array;
  readonly bitpix: FitsBitpixType;
  readonly scale: "raw" | "physical";
  readonly integrity: "pending" | "not-provided";
  readonly work: ArchiveWorkType;
}
/** Verification concerns one complete padded HDU at this operation, never publisher authentication. */
export interface FitsVerificationType {
  readonly datasum: "verified" | "not-provided";
  readonly checksum: "verified" | "not-provided";
  readonly work: ArchiveWorkType;
}
/** A borrowed stable byte source. No host mounting, extraction, global registry, or resource acquisition. */
export interface FitsDatasetType {
  readonly hdus: readonly FitsHduType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: FitsReadOptionsType): Promise<FitsReadType>;
  verify(id: number, options?: ArchiveLimitsType & { readonly signal?: AbortSignal }): Promise<FitsVerificationType>;
}

function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported("FITS extent exceeds exact JavaScript indexing.");
  }
  return Number(value);
}
function policy(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  integer(result, label);
  return result;
}
/** Parse a value without treating a slash inside a quoted string as a comment. */
function valueOf(card: string): string | bigint | number | boolean {
  if (card.slice(8, 10) !== "= ") invalid("FITS interpreted keyword lacks '= ' value indicator.");
  const text = card.slice(10).trimStart();
  if (text.startsWith("'")) {
    let result = "";
    for (let i = 1; i < text.length; i++) {
      if (text[i] !== "'") {
        result += text[i];
        continue;
      }
      if (text[i + 1] === "'") {
        result += "'";
        i++;
        continue;
      }
      const rest = text.slice(i + 1).trim();
      if (rest && !rest.startsWith("/")) invalid("FITS string has trailing non-comment data.");
      return result.trimEnd();
    }
    invalid("Unterminated FITS string.");
  }
  const token = text.split("/")[0]!.trim();
  if (token === "T" || token === "F") return token === "T";
  if (/^[+-]?\d+$/.test(token)) return BigInt(token);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[ED][+-]?\d+)?$/.test(token)) {
    const result = Number(token.replace("D", "E"));
    if (!Number.isFinite(result)) invalid("Non-finite FITS header number.");
    return result;
  }
  invalid("Unsupported FITS interpreted keyword value.");
}
function integerValue(card: string): bigint {
  const value = valueOf(card);
  if (typeof value !== "bigint") invalid("FITS integer keyword requires decimal integer syntax.");
  return value;
}
/** FITS checksums use big-endian 32-bit one's-complement addition, including padding. */
function sum32(bytes: Uint8Array, state: number): number {
  const data = view(bytes);
  for (let i = 0; i < bytes.length; i += 4) {
    const sum = state + data.getUint32(i, false);
    state = (sum >>> 0) + Math.floor(sum / 0x100000000);
  }
  return state >>> 0;
}

/** Indexes primary and IMAGE HDUs only. Unsupported extension kinds refuse the complete open. */
export async function openFits(input: ByteSourceType, options: FitsOpenOptionsType = {}): Promise<FitsDatasetType> {
  options = { ...options };
  const size = input.size, identity = input.identity, stability = input.stability;
  integer(size, "FITS source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Invalid FITS source identity.");
  }
  if (stability !== undefined && stability !== "immutable" && stability !== "provider" && stability !== "caller") {
    throw new TypeError("Invalid FITS source stability.");
  }
  if (!stability && options.allowUnverifiedSource !== true) {
    unsupported("FITS requires stable source evidence or allowUnverifiedSource: true.");
  }
  const source: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability ? { stability } : {}),
    read: input.read.bind(input),
  };
  const own = createArchiveLedger(options), opening = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      own.reserve(kind, count);
      opening?.reserve(kind, count);
    },
    inspect: () => own.inspect(),
  };
  const maxHdus = policy(options.maxHdus, 1024, "maxHdus");
  const maxHeaderBytes = policy(options.maxHeaderBytes, 8 * 1024 * 1024, "maxHeaderBytes");
  const maxAxes = policy(options.maxAxes, 16, "maxAxes");
  const maxElements = policy(options.maxElements, 1024 * 1024, "maxElements");
  const budget = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal);
  if (!size || size % 2880) invalid("FITS source must contain complete 2880-byte records.");
  const hdus: FitsHduType[] = [];
  let position = 0, headerTotal = 0;
  while (position < size) {
    if (hdus.length >= maxHdus) throw new ArchiveError("budget-exceeded", "FITS HDU count limit exceeded.");
    const headerOffset = position;
    const cards: string[] = [];
    let ended = false;
    while (!ended) {
      if (2880 > maxHeaderBytes - headerTotal) {
        throw new ArchiveError("budget-exceeded", "FITS aggregate header limit exceeded.");
      }
      budget.decoded(2880);
      const block = await budget.read(position, 2880);
      position += 2880;
      headerTotal += 2880;
      for (let offset = 0; offset < block.length; offset += 80) {
        const bytes = block.subarray(offset, offset + 80);
        for (const byte of bytes) if (byte < 32 || byte > 126) invalid("FITS header is not printable ASCII.");
        const card = String.fromCharCode(...bytes);
        if (card.slice(0, 8) === "END     ") {
          if (card.slice(8).trim()) invalid("FITS END card must be blank after its keyword.");
          for (const byte of block.subarray(offset + 80)) if (byte !== 32) invalid("FITS header fill must use spaces.");
          ended = true;
          break;
        }
        cards.push(card);
      }
    }
    const keys = cards.map((card) => card.slice(0, 8).trimEnd());
    const get = (key: string): string | undefined => {
      const index = keys.indexOf(key);
      if (index !== -1 && keys.indexOf(key, index + 1) !== -1) invalid(`Duplicate FITS interpretation keyword ${key}.`);
      return index === -1 ? undefined : cards[index];
    };
    const required = (key: string, index: number): string => {
      const card = get(key);
      if (!card || keys[index] !== key) invalid(`FITS mandatory keyword ${key} is missing or out of order.`);
      // Mandatory numeric/logical cards occupy the fixed 20-column value field.
      if (
        key !== "XTENSION" &&
        (card[29] === " " || (card.slice(30).trim() && !card.slice(30).trimStart().startsWith("/")))
      ) invalid(`FITS mandatory ${key} is not fixed-format.`);
      if (key === "SIMPLE" && !/^ {19}[TF]$/.test(card.slice(10, 30))) {
        invalid("FITS SIMPLE must be fixed-format logical.");
      }
      if (key !== "SIMPLE" && key !== "XTENSION" && !/^ *[+-]?\d+$/.test(card.slice(10, 30))) {
        invalid(`FITS ${key} must be a fixed-format integer.`);
      }
      return card;
    };
    const primary = hdus.length === 0;
    if (primary) {
      if (valueOf(required("SIMPLE", 0)) !== true) unsupported("FITS primary SIMPLE must be T.");
    } else if (valueOf(required("XTENSION", 0)) !== "IMAGE") {
      unsupported("Only FITS IMAGE extensions are supported; table sizing/semantics are not implemented.");
    }
    if (!primary && cards[0]!.slice(10, 20) !== "'IMAGE   '") {
      invalid("FITS IMAGE XTENSION must be an eight-character fixed-format string.");
    }
    const bitpixNumber = Number(integerValue(required("BITPIX", 1)));
    if (![8, 16, 32, 64, -32, -64].includes(bitpixNumber)) unsupported("Unsupported FITS BITPIX.");
    const bitpix = bitpixNumber as FitsBitpixType;
    const axesCount = exact(integerValue(required("NAXIS", 2)));
    if (axesCount > 999) invalid("FITS NAXIS exceeds 999.");
    if (axesCount > maxAxes) throw new ArchiveError("budget-exceeded", "FITS axis count limit exceeded.");
    const axes: number[] = [];
    let elementsBig = axesCount ? 1n : 0n;
    for (let i = 0; i < axesCount; i++) {
      const axis = exact(integerValue(required(`NAXIS${i + 1}`, i + 3)));
      axes.push(axis);
      elementsBig *= BigInt(axis);
    }
    if (!primary) {
      if (
        integerValue(required("PCOUNT", axesCount + 3)) !== 0n || integerValue(required("GCOUNT", axesCount + 4)) !== 1n
      ) unsupported("FITS IMAGE requires PCOUNT=0 and GCOUNT=1.");
    }
    const groups = get("GROUPS"), inherit = get("INHERIT");
    if (groups && valueOf(groups) !== false) unsupported("FITS random groups are not supported.");
    if (inherit && valueOf(inherit) !== false) unsupported("FITS inherited headers are not supported.");
    const numberOf = (key: string, fallback: number): number => {
      const card = get(key);
      if (!card) return fallback;
      const value = valueOf(card);
      if (typeof value !== "number" && typeof value !== "bigint") invalid(`FITS ${key} must be numeric.`);
      const result = Number(value);
      if (!Number.isFinite(result)) invalid(`FITS ${key} must be finite.`);
      return result;
    };
    const blankCard = get("BLANK");
    let blank: bigint | undefined;
    if (blankCard) {
      if (bitpix < 0) invalid("FITS BLANK is not defined for floating-point arrays.");
      blank = integerValue(blankCard);
      const min = bitpix === 8 ? 0n : -(1n << BigInt(bitpix - 1));
      const max = bitpix === 8 ? 255n : (1n << BigInt(bitpix - 1)) - 1n;
      if (blank < min || blank > max) invalid("FITS BLANK exceeds the stored integer type.");
    }
    const stringOf = (key: string): string | undefined => {
      const card = get(key);
      if (!card) return undefined;
      const value = valueOf(card);
      if (typeof value !== "string") invalid(`FITS ${key} must be a string.`);
      if (value.endsWith("&")) unsupported(`FITS long-string ${key} is not interpreted.`);
      return value;
    };
    const unit = stringOf("BUNIT"), sum = stringOf("DATASUM")?.trim(), checksum = stringOf("CHECKSUM");
    let datasum: number | undefined;
    if (sum) {
      if (!/^\d+$/.test(sum) || BigInt(sum) > 0xffffffffn) invalid("Invalid FITS DATASUM value.");
      datasum = Number(sum);
    }
    const elements = exact(elementsBig), dataBytes = exact(elementsBig * BigInt(Math.abs(bitpix) / 8));
    const paddedDataBytes = exact(((BigInt(dataBytes) + 2879n) / 2880n) * 2880n);
    if (paddedDataBytes > size - position) invalid("FITS data extent exceeds source.");
    hdus.push(
      Object.freeze({
        id: hdus.length,
        kind: primary ? "primary" : "image",
        bitpix,
        axes: Object.freeze(axes),
        elements,
        headerOffset,
        headerBytes: position - headerOffset,
        dataOffset: position,
        dataBytes,
        paddedDataBytes,
        cards: Object.freeze(cards),
        bscale: numberOf("BSCALE", 1),
        bzero: numberOf("BZERO", 0),
        ...(blank === undefined ? {} : { blank }),
        ...(unit === undefined ? {} : { unit }),
        ...(datasum === undefined ? {} : { datasum }),
        ...(checksum ? { checksum } : {}),
      }),
    );
    position += paddedDataBytes;
  }
  const find = (id: number): FitsHduType => {
    integer(id, "FITS HDU id");
    const hdu = hdus[id];
    if (!hdu) throw new RangeError("Unknown FITS HDU id.");
    return hdu;
  };
  /** Reserve the complete known physical cost before allocating selected output. Read credits
   * preserve actual per-operation counters without charging aggregate owners twice. */
  const operation = (
    opts: ArchiveLimitsType & { readonly signal?: AbortSignal },
    bytes: number,
    requests: number,
  ): { budget: ArchiveBudget; signal: AbortSignal | undefined } => {
    const signal = options.signal && opts.signal
      ? AbortSignal.any([options.signal, opts.signal])
      : options.signal ?? opts.signal;
    signal?.throwIfAborted();
    const limits = limitsOf(opts);
    if (bytes > limits.maxSourceBytes || requests > limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "FITS known source cost exceeds operation policy.");
    }
    const extra = opts.ledger;
    const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
      lifetime.reserve(kind, count);
      if (extra && extra !== opening) extra.reserve(kind, count);
    };
    reserve("sourceBytes", bytes);
    reserve("requests", requests);
    let byteCredit = bytes, requestCredit = requests;
    const ledger: ArchiveLedgerType = {
      reserve(kind, count) {
        if (kind === "sourceBytes") {
          if (count > byteCredit) throw new Error("FITS source credit invariant.");
          byteCredit -= count;
        } else if (kind === "requests") {
          if (count > requestCredit) throw new Error("FITS request credit invariant.");
          requestCredit -= count;
        } else reserve(kind, count);
      },
      inspect: lifetime.inspect,
    };
    return { budget: new ArchiveBudget(source, { ...opts, ledger }, signal), signal };
  };
  options.signal?.throwIfAborted();
  return {
    hdus: Object.freeze(hdus),
    work: budget.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    async read(id, opts = {}) {
      opts = { ...opts };
      const hdu = find(id),
        offset = opts.offset ?? 0,
        count = opts.count ?? hdu.elements - offset,
        scale = opts.scale ?? "raw";
      integer(offset, "FITS element offset");
      integer(count, "FITS element count");
      if (offset > hdu.elements || count > hdu.elements - offset) {
        throw new RangeError("FITS selected elements exceed array.");
      }
      if (count > maxElements) throw new ArchiveError("budget-exceeded", "FITS selected element limit exceeded.");
      if (scale !== "raw" && scale !== "physical") throw new TypeError("Invalid FITS scaling mode.");
      if (scale === "physical" && hdu.bitpix === 64) {
        unsupported("Physical scaling of FITS 64-bit integers is not supported; read exact raw BigInt values.");
      }
      const width = Math.abs(hdu.bitpix) / 8, bytes = count * width;
      const { budget: work, signal } = operation(opts, bytes, Math.ceil(bytes / 65536));
      const outputWidth = scale === "physical" ? 8 : width;
      work.decoded(bytes);
      work.output(count * (outputWidth + 1));
      signal?.throwIfAborted();
      const values: FitsValuesType = scale === "physical" || hdu.bitpix === -64
        ? new Float64Array(count)
        : hdu.bitpix === 8
        ? new Uint8Array(count)
        : hdu.bitpix === 16
        ? new Int16Array(count)
        : hdu.bitpix === 32
        ? new Int32Array(count)
        : hdu.bitpix === 64
        ? new BigInt64Array(count)
        : new Float32Array(count);
      const undefinedMask = new Uint8Array(count);
      for (let at = 0; at < bytes; at += 65536) {
        const chunk = await work.read(hdu.dataOffset + offset * width + at, Math.min(65536, bytes - at));
        const data = view(chunk);
        for (let i = 0; i < chunk.length; i += width) {
          const index = (at + i) / width;
          if (hdu.bitpix === 64) {
            const value = data.getBigInt64(i, false);
            (values as BigInt64Array)[index] = value;
            undefinedMask[index] = value === hdu.blank ? 1 : 0;
          } else {
            const value = hdu.bitpix === 8
              ? data.getUint8(i)
              : hdu.bitpix === 16
              ? data.getInt16(i, false)
              : hdu.bitpix === 32
              ? data.getInt32(i, false)
              : hdu.bitpix === -32
              ? data.getFloat32(i, false)
              : data.getFloat64(i, false);
            const missing = Number.isNaN(value) || (hdu.blank !== undefined && BigInt(value) === hdu.blank);
            undefinedMask[index] = missing ? 1 : 0;
            (values as Exclude<FitsValuesType, BigInt64Array>)[index] = scale === "physical"
              ? value * hdu.bscale + hdu.bzero
              : value;
          }
        }
      }
      signal?.throwIfAborted();
      return {
        values,
        undefinedMask,
        bitpix: hdu.bitpix,
        scale,
        integrity: hdu.datasum === undefined && hdu.checksum === undefined ? "not-provided" : "pending",
        work: work.inspect(),
      };
    },
    async verify(id, opts = {}) {
      opts = { ...opts };
      const hdu = find(id), bytes = hdu.headerBytes + hdu.paddedDataBytes;
      const { budget: work, signal } = operation(
        opts,
        bytes,
        Math.ceil(hdu.headerBytes / 65536) + Math.ceil(hdu.paddedDataBytes / 65536),
      );
      work.decoded(bytes);
      let headerSum = 0, dataSum = 0;
      for (let at = 0; at < hdu.headerBytes; at += 65536) {
        headerSum = sum32(await work.read(hdu.headerOffset + at, Math.min(65536, hdu.headerBytes - at)), headerSum);
      }
      for (let at = 0; at < hdu.paddedDataBytes; at += 65536) {
        dataSum = sum32(await work.read(hdu.dataOffset + at, Math.min(65536, hdu.paddedDataBytes - at)), dataSum);
      }
      if (hdu.datasum !== undefined && dataSum !== hdu.datasum) {
        throw new ArchiveError("checksum-mismatch", "FITS DATASUM does not match padded data.");
      }
      const total = headerSum + dataSum, folded = ((total >>> 0) + Math.floor(total / 0x100000000)) >>> 0;
      if (hdu.checksum !== undefined && folded !== 0xffffffff) {
        throw new ArchiveError("checksum-mismatch", "FITS CHECKSUM does not match padded HDU.");
      }
      signal?.throwIfAborted();
      return {
        datasum: hdu.datasum === undefined ? "not-provided" : "verified",
        checksum: hdu.checksum === undefined ? "not-provided" : "verified",
        work: work.inspect(),
      };
    },
  };
}
