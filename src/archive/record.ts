import type { ByteSourceType } from "../source.ts";
import { isBytes, toView } from "../bytes.ts";

/** Stable failure categories for bounded archive inspection. */
export type ArchiveErrorCodeType = "invalid-archive" | "unsupported-profile" | "budget-exceeded" | "checksum-mismatch";

/** A format or policy failure; original source/codec failures retain their own errors. */
export class ArchiveError extends Error {
  /** Machine-readable refusal category, independent of explanatory message text. */
  readonly code: ArchiveErrorCodeType;

  /** Retain a format, profile, policy or integrity refusal without wrapping source failures. */
  constructor(code: ArchiveErrorCodeType, message: string) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

/** Finite per-operation policy limits. Counts include parser reads and discarded decoded bytes. */
export interface ArchiveLimitsType {
  /** Aggregate admitted input bytes. Defaults to 64 MiB; failed reads remain charged. */
  readonly maxSourceBytes?: number;
  /** Nonempty addressable reads or stream read attempts. Defaults to 4,096. */
  readonly maxRequests?: number;
  /** Interpreted or decoded work bytes, including discarded bytes. Defaults to 64 MiB. */
  readonly maxDecodedBytes?: number;
  /** Returned storage admission. Defaults to 16 MiB; formats can charge conservative allowances. */
  readonly maxOutputBytes?: number;
  /** Share one ledger across nested/open/read operations to prevent per-call budget resets. */
  readonly ledger?: ArchiveLedgerType;
}

/** Observable work from one open, scan or member-read operation. */
export interface ArchiveWorkType {
  /** Admitted input extents, rather than hidden transport costs inside a foreign source. */
  readonly sourceBytes: number;
  /** Charged read operations, including attempts that later fail. */
  readonly requests: number;
  /** Format-defined interpreted or decoded work; a small result can require a large decode. */
  readonly decodedBytes: number;
  /** Admitted output storage; consult the format for conservative text or copy allowances. */
  readonly outputBytes: number;
}

/** Aggregate admission across caller-composed readers. Source bytes count archive-level requested extents. */
export interface ArchiveLedgerType {
  /** Charge before acquisition or allocation; exhausted reservations throw and are never refunded. */
  reserve(kind: keyof ArchiveWorkType, count: number): void;
  /** Return a detached counter snapshot without performing I/O. */
  inspect(): ArchiveWorkType;
}

/** Creates an explicit aggregate owner; no background work or global accounting is installed. */
export function createArchiveLedger(options: Omit<ArchiveLimitsType, "ledger"> = {}): ArchiveLedgerType {
  const limits = resolveLimits(options);
  const used = { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
  const maximum = {
    sourceBytes: limits.maxSourceBytes,
    requests: limits.maxRequests,
    decodedBytes: limits.maxDecodedBytes,
    outputBytes: limits.maxOutputBytes,
  };
  return {
    reserve(kind, count) {
      assertInteger(count, "Aggregate work count");
      if (!Object.hasOwn(used, kind)) throw new TypeError("Unknown archive work dimension.");
      if (count > maximum[kind] - used[kind]) {
        throw new ArchiveError("budget-exceeded", `Aggregate ${kind} limit exceeded.`);
      }
      used[kind] += count;
    },
    inspect: () => ({ ...used }),
  };
}

/**
 * Returns the complete limit set for one operation: caller values where given, defaults otherwise.
 *
 * Call it once at the start of an open or read, before any source request, so every later check uses the same
 * numbers: `const limits = resolveLimits(options);`. Defaults are 64 MiB of source bytes, 4,096 requests,
 * 64 MiB of decoded bytes and 16 MiB of returned bytes. Throws `RangeError` for a value that is not a
 * nonnegative safe integer.
 */
export function resolveLimits(options: Omit<ArchiveLimitsType, "ledger">): Required<Omit<ArchiveLimitsType, "ledger">> {
  const limits = {
    maxSourceBytes: options.maxSourceBytes ?? 64 * 1024 * 1024,
    maxRequests: options.maxRequests ?? 4096,
    maxDecodedBytes: options.maxDecodedBytes ?? 64 * 1024 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(limits)) assertInteger(value, name);
  return limits;
}

/** Separate returned-byte and work limits prevent a small preview from hiding a full decode. */
export class ArchiveBudget {
  readonly #source: ByteSourceType;
  readonly #signal: AbortSignal | undefined;
  readonly #ledger: ArchiveLedgerType | undefined;
  readonly limits: Required<Omit<ArchiveLimitsType, "ledger">>;
  #sourceBytes = 0;
  #requests = 0;
  #decodedBytes = 0;
  #outputBytes = 0;

  constructor(source: ByteSourceType, limits: ArchiveLimitsType = {}, signal?: AbortSignal) {
    assertInteger(source.size, "Source size");
    this.#source = source;
    this.#signal = signal;
    this.limits = resolveLimits(limits);
    this.#ledger = limits.ledger;
  }

  /** Charge before acquisition, so an impossible request never reaches the source. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    assertInteger(offset, "Offset");
    assertInteger(length, "Length");
    this.#signal?.throwIfAborted();
    if (offset > this.#source.size || length > this.#source.size - offset) {
      throw invalid("Archive extent exceeds source.");
    }
    if (length === 0) return new Uint8Array();
    this.#charge(this.#sourceBytes, length, this.limits.maxSourceBytes, "Source byte");
    this.#charge(this.#requests, 1, this.limits.maxRequests, "Request");
    this.#ledger?.reserve("sourceBytes", length);
    this.#ledger?.reserve("requests", 1);
    this.#sourceBytes += length;
    this.#requests += 1;
    const value = await this.#source.read(offset, length, this.#signal ? { signal: this.#signal } : {});
    this.#signal?.throwIfAborted();
    if (!isBytes(value)) throw invalid("Source returned a non-byte extent.");
    const bytes = toView(value);
    if (bytes.byteLength !== length) throw invalid("Source returned an incomplete extent.");
    return bytes;
  }

  decoded(length: number): void {
    this.#charge(this.#decodedBytes, length, this.limits.maxDecodedBytes, "Decoded byte");
    this.#ledger?.reserve("decodedBytes", length);
    this.#decodedBytes += length;
  }

  output(length: number): void {
    this.#charge(this.#outputBytes, length, this.limits.maxOutputBytes, "Output byte");
    this.#ledger?.reserve("outputBytes", length);
    this.#outputBytes += length;
  }

  inspect(): ArchiveWorkType {
    return {
      sourceBytes: this.#sourceBytes,
      requests: this.#requests,
      decodedBytes: this.#decodedBytes,
      outputBytes: this.#outputBytes,
    };
  }

  #charge(current: number, length: number, maximum: number, label: string): void {
    assertInteger(length, `${label} count`);
    if (length > maximum - current) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
  }
}

/**
 * Throws `RangeError` unless `value` is a nonnegative safe integer; `label` names it in the message.
 *
 * Call it as a statement before arithmetic on a size, offset, count or limit:
 * `assertInteger(size, "ZIP central directory size");`. Offsets past `Number.MAX_SAFE_INTEGER` would round
 * silently, so a bound check after the arithmetic could pass on a wrong value. Unlike the private `integer()`
 * helpers in some backends, this returns nothing.
 */
export function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer.`);
}

/**
 * Creates the `invalid-archive` error for bytes that break the format: a truncated header, a bad checksum
 * field, an offset outside the file.
 *
 * Call it with `throw` where parsing must stop, so the exit is visible at the call site:
 *
 * ```ts
 * if (header.length < 30) throw invalid("ZIP local header is truncated.");
 * ```
 *
 * Name the format and the broken rule in `message`; it reaches the caller unchanged.
 */
export function invalid(message: string): ArchiveError {
  return new ArchiveError("invalid-archive", message);
}

/**
 * Creates the `unsupported-profile` error for valid input that this reader does not implement, such as an
 * unknown compression method or a feature outside the selected profile.
 *
 * Call it with `throw`, like {@link invalid}: `throw unsupported("ZIP method 99 is not supported.");`. The
 * distinction tells a caller that another tool may read the file, while `invalid-archive` means no correct
 * reader can.
 */
export function unsupported(message: string): ArchiveError {
  return new ArchiveError("unsupported-profile", message);
}

/**
 * Creates a `DataView` over exactly the bytes of `bytes`, honouring its offset and length in a larger buffer.
 *
 * Call it where a parser reads fixed-width fields: `createView(header).getUint32(4, true)`. A view built from
 * `bytes.buffer` alone would start at the buffer's first byte, not the slice's.
 */
export function createView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Gets the little-endian unsigned 64-bit field at `offset` as an exact `number`.
 *
 * Use it beside `DataView`'s own getters, which have no exact 64-bit form for `number`:
 * `const offset = getUint64(record, 48);`. Values above `Number.MAX_SAFE_INTEGER` throw `unsupported-profile`
 * instead of losing their high bits.
 */
export function getUint64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw unsupported("Archive offset or size exceeds exact JavaScript integers.");
  }
  return Number(value);
}
