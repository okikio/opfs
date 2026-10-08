/** Native Mitata reports are evidence only when every registered run has real samples. */
export function validateMitata(value: unknown): void {
  if (
    typeof value !== "object" || value === null || !("benchmarks" in value) || !Array.isArray(value.benchmarks) ||
    value.benchmarks.length === 0
  ) {
    throw new Error("Expected a nonempty native Mitata benchmark report.");
  }
  for (const entry of value.benchmarks as unknown[]) {
    const benchmark = record(entry);
    if (
      typeof benchmark !== "object" || benchmark === null || !Array.isArray(benchmark.runs) ||
      benchmark.runs.length === 0
    ) {
      throw new Error("A Mitata benchmark has no measured runs.");
    }
    for (const entry of benchmark.runs as unknown[]) {
      const run = record(entry), stats = record(run.stats);
      const { min, max, p25, p50, p75, p99, p999, avg } = stats;
      if (
        run.error != null || !Array.isArray(stats.samples) || stats.samples.length === 0 ||
        stats.samples.some((sample: unknown) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) ||
        !finite(min) || !finite(max) || !finite(p25) || !finite(p50) || p50 <= 0 ||
        !finite(p75) || !finite(p99) || !finite(p999) || !finite(avg) ||
        min > p25 || p25 > p50 || p50 > p75 || p75 > p99 || p99 > p999 || p999 > max ||
        !meanWithin(avg, min, max, stats.samples.length) ||
        stats.samples.some((sample: number) => sample < min || sample > max)
      ) {
        throw new Error("A Mitata run failed or has invalid/empty timing samples.");
      }
      for (const name of ["heap", "gc"] as const) {
        if (name in stats) validateResource(stats[name], name, stats.samples.length + 4);
      }
    }
  }
}

/** Heap records nonnegative batch-normalized deltas; GC records post-batch collection nanoseconds. */
function validateResource(value: unknown, kind: "heap" | "gc", timingCount: number): void {
  const row = record(value);
  if (kind === "heap" && row._ === 0) {
    if (row.total === 0 && row.min === null && row.max === null && row.avg === null) return;
    throw new Error("Invalid unavailable Mitata heap observation.");
  }
  const { min, max, avg, total } = row;
  const count = kind === "heap" ? row._ : timingCount;
  if (
    (kind === "heap" && (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)) ||
    !finite(min) || !finite(max) || !finite(avg) || !finite(total) || min > max || total < max ||
    !meanWithin(avg, min, max, typeof count === "number" ? count : timingCount) ||
    (kind === "heap" && typeof count === "number" && !meanWithin(total / count, min, max, count))
  ) throw new Error(`Invalid or incomplete Mitata ${kind} observations.`);
}

/** The pinned mean sums samples; permit only its bounded floating-point summation error at extrema. */
function meanWithin(mean: number, min: number, max: number, count: number): boolean {
  const tolerance = Math.max(Number.MIN_VALUE, max * Number.EPSILON * count);
  return mean + tolerance >= min && mean - tolerance <= max;
}

/** Narrows report data without trusting JSON parsing to validate its structure. */
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) throw new Error("Malformed Mitata report object.");
  return value as Readonly<Record<string, unknown>>;
}

/** Lifecycle reports declare their scales and retain finite observations for every completed cycle/transfer. */
export function validateLifecycle(value: unknown): void {
  const item = record(value), workload = record(item.workload);
  if (
    item.platform !== "node native files" || !bytes(item.chunkBytes) || item.chunkBytes === 0 ||
    typeof workload.cycles !== "number" || !Number.isSafeInteger(workload.cycles) || workload.cycles <= 0 ||
    typeof workload.observeEvery !== "number" || !Number.isSafeInteger(workload.observeEvery) ||
    workload.observeEvery <= 0 ||
    !Array.isArray(workload.transferBytes) || workload.transferBytes.length === 0 ||
    workload.transferBytes.some((value: unknown) => !bytes(value) || value === 0) || !Array.isArray(item.samples) ||
    item.samples.length === 0 || !Array.isArray(item.cancellationMs) ||
    item.cancellationMs.length !== workload.cycles || item.cancellationMs.some((value: unknown) => !finite(value)) ||
    !Array.isArray(item.transfers) || item.transfers.length !== workload.transferBytes.length
  ) throw new Error("Incomplete lifecycle workload report.");
  const observeEvery = workload.observeEvery;
  const cycles = Array.from(
    { length: Math.ceil(workload.cycles / observeEvery) },
    (_, index) => index * observeEvery,
  );
  cycles.push(workload.cycles);
  if (item.samples.length !== cycles.length) throw new Error("Incomplete lifecycle observation cadence.");
  for (const [index, sample] of (item.samples as unknown[]).entries()) {
    const row = record(sample), memory = record(row.memory);
    if (
      row.cycle !== cycles[index] || !validMemory(memory) || !Array.isArray(row.resources) ||
      row.resources.some((value) => typeof value !== "string")
    ) {
      throw new Error("Invalid lifecycle resource observation.");
    }
  }
  for (let index = 0; index < item.transfers.length; index++) {
    const row = record(item.transfers[index]), peak = record(row.peak);
    if (
      !bytes(row.bytes) || row.bytes === 0 || row.bytes !== workload.transferBytes[index] || !finite(row.elapsedMs) ||
      row.elapsedMs === 0 || !validMemory(peak) || !bytes(row.facadeBufferedBytes)
    ) throw new Error("Invalid lifecycle transfer observation.");
  }
}
/** Node's reported byte counters are all part of the retained memory observation. */
function validMemory(value: Readonly<Record<string, unknown>>): boolean {
  return ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"].every((name) => bytes(value[name]));
}
/** Physical byte counters cannot contain fractional, infinite, negative, or unsafe-integer values. */
function bytes(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value);
}
/** Timing and byte observations cannot use NaN, infinity or negative sentinels. */
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
