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
  const limits = limitsOf(options);
  const used = { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
  const maximum = {
    sourceBytes: limits.maxSourceBytes,
    requests: limits.maxRequests,
    decodedBytes: limits.maxDecodedBytes,
    outputBytes: limits.maxOutputBytes,
  };
  return {
    reserve(kind, count) {
      integer(count, "Aggregate work count");
      if (!Object.hasOwn(used, kind)) throw new TypeError("Unknown archive work dimension.");
      if (count > maximum[kind] - used[kind]) {
        throw new ArchiveError("budget-exceeded", `Aggregate ${kind} limit exceeded.`);
      }
      used[kind] += count;
    },
    inspect: () => ({ ...used }),
  };
}

/** Resolve and validate finite policies once, before any resource is acquired. */
export function limitsOf(options: Omit<ArchiveLimitsType, "ledger">): Required<Omit<ArchiveLimitsType, "ledger">> {
  const limits = {
    maxSourceBytes: options.maxSourceBytes ?? 64 * 1024 * 1024,
    maxRequests: options.maxRequests ?? 4096,
    maxDecodedBytes: options.maxDecodedBytes ?? 64 * 1024 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(limits)) integer(value, name);
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
    integer(source.size, "Source size");
    this.#source = source;
    this.#signal = signal;
    this.limits = limitsOf(limits);
    this.#ledger = limits.ledger;
  }

  /** Charge before acquisition, so an impossible request never reaches the source. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    integer(offset, "Offset");
    integer(length, "Length");
    this.#signal?.throwIfAborted();
    if (offset > this.#source.size || length > this.#source.size - offset) invalid("Archive extent exceeds source.");
    if (length === 0) return new Uint8Array();
    this.#charge(this.#sourceBytes, length, this.limits.maxSourceBytes, "Source byte");
    this.#charge(this.#requests, 1, this.limits.maxRequests, "Request");
    this.#ledger?.reserve("sourceBytes", length);
    this.#ledger?.reserve("requests", 1);
    this.#sourceBytes += length;
    this.#requests += 1;
    const value = await this.#source.read(offset, length, this.#signal ? { signal: this.#signal } : {});
    this.#signal?.throwIfAborted();
    if (!isBytes(value)) invalid("Source returned a non-byte extent.");
    const bytes = toView(value);
    if (bytes.byteLength !== length) invalid("Source returned an incomplete extent.");
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
    integer(length, `${label} count`);
    if (length > maximum - current) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
  }
}

/** Binary offsets and user policy must remain exact in JavaScript arithmetic. */
export function integer(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer.`);
}

export function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", message);
}

export function unsupported(message: string): never {
  throw new ArchiveError("unsupported-profile", message);
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Read little-endian ZIP64 values without losing high bits. */
export function uint64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("Archive offset or size exceeds exact JavaScript integers.");
  return Number(value);
}

/** Incremental CRC state is private to one read; no mutable table or global registry is needed. */
export function crc32(bytes: Uint8Array, state = 0xffffffff): number {
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = (state >>> 1) ^ (0xedb88320 & -(state & 1));
  }
  return state >>> 0;
}
