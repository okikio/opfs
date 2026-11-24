/**
 * Work budgets for archive reads: per-operation limits, a shared ledger, and the budget that charges each read.
 *
 * A reader charges work before it acquires bytes, so an impossible request never reaches the source. A ledger
 * shares one aggregate limit across several readers that a caller composes.
 *
 * @module
 */
import type { ByteSourceType } from "../source.ts";
import { isBytes, toView } from "../bytes.ts";
import { ArchiveError, invalid, unsupported } from "./error.ts";
import { assertInteger } from "../check.ts";
export { assertInteger } from "../check.ts";

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

/**
 * Charges one archive operation's work against its limits, and its optional ledger, before the work happens.
 *
 * Separate returned-byte and work limits prevent a small preview from hiding a full decode. A reader creates one
 * budget per open or read, then reads every extent through it:
 *
 * ```ts
 * const budget = new ArchiveBudget(source, { maxSourceBytes: 1024 * 1024, ledger }, signal);
 * const header = await budget.read(0, 512);
 * budget.decoded(512);
 * console.log(budget.inspect().sourceBytes); // 512
 * ```
 */
export class ArchiveBudget {
  readonly #source: ByteSourceType;
  readonly #signal: AbortSignal | undefined;
  readonly #ledger: ArchiveLedgerType | undefined;
  /** The resolved limits for this operation: caller values where given, defaults otherwise. */
  readonly limits: Required<Omit<ArchiveLimitsType, "ledger">>;
  #sourceBytes = 0;
  #requests = 0;
  #decodedBytes = 0;
  #outputBytes = 0;

  /**
   * Borrows `source` for this operation. `limits.ledger`, when given, is charged for the same work, so several
   * budgets can share one aggregate limit. `signal` is checked before and after each source read.
   */
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

  /** Charges `length` interpreted or decoded bytes, including bytes the reader later discards. */
  decoded(length: number): void {
    this.#charge(this.#decodedBytes, length, this.limits.maxDecodedBytes, "Decoded byte");
    this.#ledger?.reserve("decodedBytes", length);
    this.#decodedBytes += length;
  }

  /** Charges `length` bytes of returned output before the reader allocates them. */
  output(length: number): void {
    this.#charge(this.#outputBytes, length, this.limits.maxOutputBytes, "Output byte");
    this.#ledger?.reserve("outputBytes", length);
    this.#outputBytes += length;
  }

  /** Returns a detached snapshot of the work charged so far. Performs no I/O. */
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
 * Throws `budget-exceeded` when a count or size passes its limit.
 *
 * Archive and dataset readers call this as they count entries, header bytes or
 * decoded bytes: `assertAtMost(entries.length + 1, limits.maxEntries, "WARC record count")`
 * throws `ArchiveError` with the message `WARC record count limit exceeded.`
 */
export function assertAtMost(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}

/**
 * Converts a 64-bit field read from a file to a JavaScript number, refusing
 * values it cannot hold exactly.
 *
 * A negative value is `invalid-archive`: the field is unsigned in every format
 * that uses this. A value above `Number.MAX_SAFE_INTEGER` is
 * `unsupported-profile`: the file may be valid, but offsets past 2^53 - 1 would
 * round. `label` names the field: `toSafeInteger(view.getBigUint64(8, true), "7z header offset")`.
 */
export function toSafeInteger(value: bigint, label: string): number {
  if (value < 0n) throw invalid(`${label} is negative.`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported(`${label} exceeds exact JavaScript integers.`);
  return Number(value);
}

/**
 * Creates a ledger for one nested reader that also charges the caller's ledger.
 *
 * A reader that opens other readers, such as an OCFL object reading its
 * inventory, keeps its own counts for `inspect()` while every charge still
 * reaches `options.ledger`, so the caller's aggregate limit holds across all of
 * them: `const ledger = createChildLedger(options)`.
 */
export function createChildLedger(options: ArchiveLimitsType): ArchiveLedgerType {
  const local = createArchiveLedger(options);
  const outer = options.ledger;
  return {
    reserve(kind, count) {
      local.reserve(kind, count);
      outer?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
}
