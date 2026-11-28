# Resource ownership and performance contracts

Use this reference when a library acquires files, streams, browsers, database
sessions, workers, locks, temporary directories, timers, watchers, or other
resources, or when latency, CPU, memory, startup, throughput, cleanup, or
resource use affects the design.

## Resources are values with lifetimes

For every resource answer:

1. Who acquires it?
2. Who owns it?
3. Is it borrowed or transferred?
4. What is its lifetime?
5. Is cleanup synchronous or asynchronous?
6. What happens after partial construction failure?
7. What happens on abort, early iterator return, and consumer error?
8. What happens when cleanup fails?

A dependency is not necessarily a resource. A repository interface may be
long-lived and externally owned. A transaction, leased browser context, reader,
watcher, or temporary workspace has a specific cleanup obligation.

## Explicit resource management

Prefer disposable handles:

```ts
export interface BrowserLease extends AsyncDisposable {
  readonly browser: Browser;
  readonly leaseId: string;
}
```

Where the target runtime supports explicit resource management:

```ts
await using lease = await browserPool.acquire({ signal });
const result = await inspectDomains(domains, lease.browser, { signal });
```

For synchronous resources use `using` and `Disposable`. For several fallible
acquisitions use `DisposableStack` or `AsyncDisposableStack`, then transfer the
stack with `move()` only when ownership is transferred deliberately.

Cross-runtime libraries may need a compatibility layer or `try/finally` until
all supported runtimes parse and implement the syntax. Preserve the same public
ownership contract in the fallback.

## Narrow and nested lifetimes

Do not put every resource into one application-wide runtime:

```text
application lifetime
  database pool
  browser pool
  shared rule index

analysis-run lifetime
  run record
  temporary workspace
  checkpoint session

batch lifetime
  browser context or page
  stream reader
  write transaction
```

Dispose in reverse dependency order. Do not retain a page for an entire run when
it can be scoped to one target or batch. Do not repeatedly construct an
application resource for every item.

## Borrowing and transfer

Make destination ownership explicit. A writer that receives a
`WritableStream<Uint8Array>` must document whether it closes, aborts, or merely
releases its writer lock.

Prefer distinct APIs or an explicit option:

```ts
export type Ownership = "borrow" | "transfer";

export function createArchiveWriter(
  destination: WritableStream<Uint8Array>,
  options: { readonly ownership: Ownership },
): ArchiveWriter;
```

Borrowed resources remain the caller's cleanup responsibility. Transferred
resources become the callee's responsibility after successful transfer.

## Cancellation and disposal

`AbortSignal` asks work to stop. Disposal releases owned resources. Use both.

A cancellation path should:

```text
abort signal observed
  -> stop admitting work
  -> cancel or drain bounded in-flight work
  -> close iterator/stream cleanup points
  -> settle or abort writes according to contract
  -> dispose owned resources
  -> flush bounded diagnostics
  -> return stable cancellation failure
```

Do not equate calling `abort()` with completed cleanup. Measure cleanup latency
and assert no handles remain.

## Workload-specific performance

Define the workload before claiming performance:

- command help or import-only cold path;
- one short request;
- repeated warm requests;
- high-volume batch pipeline;
- long-lived server or worker;
- cancellation and shutdown;
- restart or resume.

Track relevant dimensions:

| Dimension | Measure |
| --- | --- |
| Cold start | process or import to first useful result |
| Warm latency | repeated operation distribution |
| Throughput | records, targets, requests, or bytes per second |
| Tail latency | p95 and p99 under defined load |
| CPU | process CPU time and utilization |
| Allocation | bytes or objects allocated per operation |
| Peak memory | RSS, heap, external, and buffer peaks |
| Retained memory | live state after controlled lifecycle cycles |
| I/O | operations and bytes by destination |
| Resource count | files, sockets, pages, workers, timers, readers |
| Cleanup | time and residual resources after normal/error/abort |
| Recovery | restart or resume time and duplicate work |
| Package cost | import time, bundle bytes, dependency graph |

## Model budgets before tuning

For a browser pipeline:

```text
peak memory = fixed process state
            + browser processes
            + active targets x per-target working set
            + queued inputs
            + completed output buffers
            + persistence buffers
            + diagnostics and retry state
```

Define explicit policy:

```ts
export interface ExecutionBudget {
  readonly concurrency: number;
  readonly maxQueued: number;
  readonly maxBufferedBatches: number;
  readonly maxBatchBytes: number;
  readonly maxOpenResources: number;
  readonly cleanupTimeoutMs: number;
}
```

Admission, concurrency, and buffering are separate. Throughput achieved while a
queue grows without bound is not sustainable throughput.

## Resource reuse

Reuse can reduce startup and acquisition cost while increasing memory, stale
state, contention, and recovery complexity.

For a pool define:

```ts
export interface PoolPolicy {
  readonly maximum: number;
  readonly maximumIdle: number;
  readonly idleTimeoutMs: number;
  readonly maximumUses: number;
  readonly acquireTimeoutMs: number;
}
```

Test reuse, eviction, invalidation, partial failure, cancellation while waiting,
and disposal of idle and leased resources.

## Diagnostics on hot paths

Use structured, lazy, aggregated diagnostics. Avoid per-record info logs.

```ts
logger.debug("Processed observation batch", {
  records: batch.values.length,
  encodedBytes: batch.encodedBytes,
  durationMs,
});
```

Measure disabled logging, filter dispatch, structured record creation, lazy
property evaluation, redaction, formatting, sink buffering, and flush. Do not
optimize by disabling required security or diagnostics without a product policy.

## Benchmark protocol

Before running:

1. state question and mechanism;
2. name target and protected workflows;
3. define semantic oracle;
4. set practical threshold and regression guardrails;
5. record baseline source, harness, fixtures, runtime, and environment;
6. choose cold/warm, process isolation, warmup, order, repetitions, and seeds;
7. define treatment of failures, timeouts, and OOM;
8. preserve raw samples.

Use representative end-to-end stories as decision gates. Microbenchmarks may
explain mechanism but cannot override a protected workflow regression.

For async work, hold arrival rate, concurrency, queue capacity, and destination
behavior constant. Report latency distributions under fixed load or sustainable
throughput under a latency and error objective.

## Memory and leak tests

Distinguish allocation, peak, and retained memory. Run repeated lifecycle cycles
and require a plateau. Exercise:

- normal completion;
- source and destination errors;
- early iterator return;
- cancellation;
- failed partial construction;
- pool eviction;
- watcher or listener removal;
- worker termination;
- cache invalidation;
- explicit disposal.

A before/after heap subtraction without lifecycle repetition is not a leak test.

## Failure signatures

- a resource-producing factory returns a handle with no cleanup contract;
- one universal runtime owns resources with unrelated lifetimes;
- cancellation returns before owned resources settle;
- cleanup exceptions hide the primary failure or disappear silently;
- a pool has no maximum, idle policy, or invalidation;
- a throughput test allows queue growth;
- only mean latency is reported;
- memory claims use one ambiguous metric;
- microbenchmark results justify an API redesign without end-to-end evidence;
- debug property construction occurs even when no sink accepts the record;
- performance improvements change semantics or error handling.

## Verification

- use runtime resource and operation sanitizers where available;
- instrument acquisition, active count, queue depth, and disposal count;
- force partial-construction failures at every resource acquisition point;
- cancel while waiting, active, writing, and cleaning up;
- run repeated lifecycle cycles and inspect plateau behavior;
- benchmark cold and warm paths separately;
- preserve raw samples and correctness digests;
- compare absolute, relative, variability, and guardrail results;
- test under realistic CPU, memory, network, and destination constraints.

## Sources and freshness

- TypeScript explicit resource management documentation, reviewed 2026-07-23.
- ECMAScript Explicit Resource Management proposal and current runtime support,
  reviewed 2026-07-23.
- V8 memory and garbage collection documentation, reviewed 2026-07-23.
- Deno benchmark and resource-sanitizer guidance, reviewed 2026-07-23.
- Library-first guidebook, reviewed 2026-07-23.
