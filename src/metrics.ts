import { MetricsModeSchema, type MetricsModeType, type SupportModeType } from "./schema.ts";

/** Storage operations tracked by the low-cost metrics book. */
export type MetricOperationType =
  | "stat"
  | "read"
  | "read-stream"
  | "write"
  | "copy"
  | "move"
  | "remove"
  | "list"
  | "walk"
  | "writable"
  | "sync";

/** Immutable counters for one operation family. */
export interface MetricEntryType {
  /** Completed and failed attempts. */
  readonly count: number;
  /** Attempts that threw before successful completion. */
  readonly failures: number;
  /** Bytes observed by this layer for the operation family. */
  readonly bytes: number;
  /** Calls that used an immediate backend-native route. */
  readonly native: number;
  /** Calls composed from weaker primitives by the facade. */
  readonly emulated: number;
  /** Calls whose adapter reported a partitioned physical layout. */
  readonly partitioned: number;
  /** Total measured wall-clock duration when timing metrics are enabled. */
  readonly durationMs: number;
  /** Longest measured call when timing metrics are enabled. */
  readonly maxDurationMs: number;
}

/** Immutable metrics snapshot returned to callers. */
export interface MetricsType {
  /** Configured instrumentation cost. */
  readonly mode: MetricsModeType;
  /** Wall-clock epoch when this metrics book was created. */
  readonly startedAt: number;
  /** Bytes currently being materialized by facade-owned stream fallbacks. */
  readonly bufferedBytes: number;
  /** Largest simultaneous facade-owned materialization observed so far. */
  readonly peakBufferedBytes: number;
  /** Per-operation counters. Missing keys have never been observed. */
  readonly operations: Readonly<Partial<Record<MetricOperationType, MetricEntryType>>>;
}

/** Mutable form retained privately so snapshots cannot mutate live counters. */
interface MutableMetricType {
  /** Completed attempts, including failures. */
  count: number;
  /** Attempts that reached a terminal failure. */
  failures: number;
  /** Logical bytes attributed to this operation at this layer. */
  bytes: number;
  /** Attempts routed through a backend-native operation. */
  native: number;
  /** Attempts routed through a portable facade fallback. */
  emulated: number;
  /** Attempts whose logical value used a partitioned physical representation. */
  partitioned: number;
  /** Accumulated measured duration when timing mode is enabled. */
  durationMs: number;
  /** Longest measured attempt when timing mode is enabled. */
  maxDurationMs: number;
}

/** Data required to record one completed attempt. */
export interface MetricRecordType {
  /** Native, emulated, or partitioned route used by the operation. */
  readonly support?: SupportModeType;
  /** Bytes observed by this layer. */
  readonly bytes?: number;
  /** Start timestamp from {@link Metrics.start}; zero means timing was disabled. */
  readonly started?: number;
  /** Whether the attempt failed. */
  readonly failed?: boolean;
}

/**
 * Low-allocation metrics collector used by the filesystem and protocol clients.
 *
 * `basic` mode only increments numbers and does not call the monotonic clock.
 * `timing` adds one `performance.now()` read at start and one at completion.
 * `none` makes every hot-path method return immediately. This lets the benchmark
 * matrix measure instrumentation overhead explicitly rather than hiding it.
 */
export class Metrics {
  /** Selected collection cost. */
  readonly mode: MetricsModeType;
  /** Creation wall-clock time retained in snapshots. */
  readonly #startedAt = Date.now();
  /** Mutable counters keyed by operation. */
  readonly #operations = new Map<MetricOperationType, MutableMetricType>();
  /** Current materialized byte count. */
  #bufferedBytes = 0;
  /** Maximum materialized byte count observed. */
  #peakBufferedBytes = 0;

  /** Validates and stores the requested metrics mode. */
  constructor(mode: MetricsModeType = "basic") {
    this.mode = MetricsModeSchema.parse(mode);
  }

  /** Returns a monotonic start timestamp only when timing is enabled. */
  start(): number {
    return this.mode === "timing" ? performance.now() : 0;
  }

  /** Adds or removes bytes from facade-owned temporary materialization. */
  buffer(delta: number): void {
    if (this.mode === "none" || delta === 0) return;
    this.#bufferedBytes = Math.max(0, this.#bufferedBytes + delta);
    this.#peakBufferedBytes = Math.max(this.#peakBufferedBytes, this.#bufferedBytes);
  }

  /** Records one operation without allocating a public snapshot. */
  record(operation: MetricOperationType, record: MetricRecordType = {}): void {
    if (this.mode === "none") return;
    let entry = this.#operations.get(operation);
    if (entry === undefined) {
      entry = {
        count: 0,
        failures: 0,
        bytes: 0,
        native: 0,
        emulated: 0,
        partitioned: 0,
        durationMs: 0,
        maxDurationMs: 0,
      };
      this.#operations.set(operation, entry);
    }

    entry.count += 1;
    if (record.failed) entry.failures += 1;
    if (record.bytes !== undefined) entry.bytes += record.bytes;
    if (record.support === "native") entry.native += 1;
    if (record.support === "emulated") entry.emulated += 1;
    if (record.support === "partitioned") entry.partitioned += 1;

    if (this.mode === "timing" && record.started !== undefined && record.started !== 0) {
      const duration = Math.max(0, performance.now() - record.started);
      entry.durationMs += duration;
      entry.maxDurationMs = Math.max(entry.maxDurationMs, duration);
    }
  }

  /** Returns a detached immutable view suitable for diagnostics or JSON output. */
  snapshot(): MetricsType {
    const operations: Partial<Record<MetricOperationType, MetricEntryType>> = {};
    for (const [name, entry] of this.#operations) operations[name] = { ...entry };
    return {
      mode: this.mode,
      startedAt: this.#startedAt,
      bufferedBytes: this.#bufferedBytes,
      peakBufferedBytes: this.#peakBufferedBytes,
      operations,
    };
  }
}
