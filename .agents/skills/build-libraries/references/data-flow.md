# Data-flow contracts: arrays, iterables, async iterables, streams, and batches

Use this reference when choosing an API's collection shape, removing accidental
materialization, designing incremental processing, or connecting domain records
to byte-oriented transport.

## Choose the narrowest truthful shape

| Shape | Contract | Typical use |
| --- | --- | --- |
| `T` | One immediate value | compiled rule, parsed definition |
| `Promise<T>` | One eventual value | transaction result, remote metadata |
| `readonly T[]` | Complete bounded reusable collection | rule set, final summary |
| `Iterable<T>` | Lazy synchronous sequence | filtering or mapping existing data |
| `AsyncIterable<T>` | Incremental asynchronous records | observations, pages, detections |
| `ReadableStream<T>` | queued readable source with cancellation and backpressure | bytes, transport, standard pipelines |
| `WritableStream<T>` | incremental sink | archive, upload, encoder destination |
| `TransformStream<I, O>` | backpressured transform | compression, framing, decoding |
| `AsyncIterable<readonly T[]>` | incremental batches | high-volume domain pipeline |

Do not expose a union of every sequence type unless the operation genuinely
accepts all of them with defined semantics. A universal sequence type pushes
replayability, ownership, cancellation, cardinality, and backpressure questions
to every caller.

## Arrays are explicit materialization points

Use an array when the operation needs a complete snapshot, repeated traversal,
random access, sorting, grouping, global aggregation, atomic validation, or a
known small bound.

```ts
export interface DetectionRuleSet {
  readonly version: string;
  readonly rules: readonly DetectionRule[];
}
```

Avoid returning `Promise<readonly T[]>` for a large or live source merely
because it is easy to implement. Materialization delays first output, retains all
records, prevents pipeline overlap, and increases loss when cancellation occurs.

Provide explicit collectors when callers need an array:

```ts
export async function collectToArray<T>(
  source: AsyncIterable<T>,
  options: { readonly limit?: number } = {},
): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of source) {
    if (options.limit !== undefined && values.length >= options.limit) {
      throw new RangeError("Collection limit exceeded");
    }
    values.push(value);
  }
  return values;
}
```

The call site now makes buffering visible.

## Iterables and generators

Use `Iterable<T>` for lazy synchronous transforms:

```ts
export function* normalizeObservations(
  source: Iterable<RawObservation>,
): Iterable<Observation> {
  for (const value of source) {
    const normalized = normalizeObservation(value);
    if (normalized !== undefined) yield normalized;
  }
}
```

Expose the protocol, not the implementation:

```ts
export function normalizeObservations(
  source: Iterable<RawObservation>,
): Iterable<Observation>;
```

Do not promise `Generator<T>` unless callers require generator-specific
`return()`, `throw()`, or return-value semantics.

Document whether an iterable is reusable or single-pass. A generator object is
single-pass. A container that creates a new iterator may be replayable.

## Async iterables and async generators

Use `AsyncIterable<T>` for domain values produced over time:

```ts
export async function* verifyObservations(
  source: AsyncIterable<Observation>,
  verifier: ObservationVerifier,
  options: { readonly signal?: AbortSignal } = {},
): AsyncIterable<VerifiedObservation> {
  for await (const observation of source) {
    options.signal?.throwIfAborted();
    const result = await verifier.verify(observation, options);
    if (result.accepted) yield result.observation;
  }
}
```

Expose `AsyncIterable<T>` rather than `AsyncGenerator<T>` unless consumers need
the generator's implementation-specific methods or return type.

An async iterable is pull-shaped at the consumer handoff. It does not guarantee
that the producer is bounded. Inspect internal queues, promises, worker pools,
and retained buffers.

## Early termination

Consumers can stop:

```ts
for await (const detection of detections) {
  if (isDesiredDetection(detection)) break;
}
```

Define what happens to:

- pending network and browser work;
- queued items and worker leases;
- stream readers and locks;
- partial batches;
- output writers;
- temporary files;
- resource handles;
- checkpoint state.

Async generators should clean up in `finally`. Streams cancel by default when
an async iterator returns early unless cancellation is prevented. Custom
iterators must implement `return()` when early close owns cleanup.

Test early break, consumer error, source error, abort, and normal exhaustion.

## Streams

Use web streams when queueing strategy, backpressure, locking, piping,
cancellation, byte transport, or platform integration is part of the contract.

```ts
export function encodeObservations(
  source: AsyncIterable<ObservationBatch>,
): ReadableStream<Uint8Array>;

export function decodeObservations(
  source: ReadableStream<Uint8Array>,
): AsyncIterable<ObservationBatch>;
```

Do not call an async iterable a stream when the API does not offer stream
backpressure or stream operations. Do not wrap domain objects in a stream merely
for terminology when `AsyncIterable<T>` is simpler and sufficient.

## Backpressure and bounded buffers

A pipeline is bounded only when every producer/consumer handoff has a limit:

```text
source admission
  -> queue capacity Q
  -> workers C
  -> output batches B
  -> destination in-flight limit W
```

Separate:

- admission: how much work enters the system;
- concurrency: how many operations execute;
- buffering: how many completed or pending values are retained;
- ordering: whether results can be emitted as completed;
- destination pressure: how slow sinks propagate upstream.

An async iterator over an unbounded promise set is still unbounded.

## Stream between subsystems, batch within subsystems

Per-record iteration can create one suspension, object allocation, callback,
log record, database write, or network frame per item. Use explicit batches to
amortize overhead:

```ts
export interface ObservationBatch {
  readonly values: readonly Observation[];
  readonly encodedBytes: number;
}

export function collectObservationBatches(
  targets: Iterable<Target>,
  options: CollectionOptions,
): AsyncIterable<ObservationBatch>;
```

Bound batches by one or more of:

- record count;
- encoded bytes;
- elapsed time;
- destination limits;
- memory budget;
- checkpoint frequency.

Do not choose one global batch size for every stage. Network collection,
detection kernels, database inserts, and archive writes can have different
optimal bounds.

## Ordering and concurrency

State ordering explicitly:

```ts
export type ResultOrdering = "input" | "completion";
```

Input ordering may require buffering slow gaps. Completion ordering reduces
latency and memory but changes observable order. Preserve deterministic identity
when order is not guaranteed.

Bound concurrent mapping rather than creating all promises:

```ts
export interface ConcurrentMapOptions {
  readonly concurrency: number;
  readonly maxBuffered: number;
  readonly ordering: ResultOrdering;
  readonly signal?: AbortSignal;
}
```

## Materialization audit

Trace each interface:

```text
source
  -> decode
  -> normalize
  -> verify
  -> detect
  -> resolve
  -> persist
```

For each arrow record:

- input and output shape;
- maximum cardinality and bytes;
- replayability;
- ownership;
- concurrency and buffer bound;
- early-termination behavior;
- checkpoint commit point;
- reason for any full materialization.

One hidden `await Array.fromAsync(...)`, `Promise.all(...)`, global accumulator,
or writer that buffers the full source can collapse an otherwise incremental
pipeline.

## Failure signatures

- large operations return `Promise<T[]>` with no explicit bound;
- generator implementation types leak into the public contract unnecessarily;
- an async iterable starts all work eagerly;
- early break leaves pages, readers, workers, or temporary files open;
- `Promise.all()` scales with total input cardinality;
- queues grow while throughput metrics appear healthy;
- every record is logged or persisted independently on a hot path;
- one batch size is applied to unrelated subsystems;
- input ordering is promised without accounting for gap buffering;
- a byte stream is converted to one giant `Uint8Array` before processing.

## Verification

- assert first-item latency separately from completion latency;
- run a large input under a peak-memory limit;
- instrument maximum queue depth, in-flight work, and buffered bytes;
- break after a small number of items and assert upstream cleanup;
- inject a slow destination and prove source production slows;
- compare per-record and batched throughput with identical outputs;
- verify ordering under skewed task durations;
- assert a deliberate materialization limit and failure behavior.

## Sources and freshness

- WHATWG Streams Standard, reviewed 2026-07-23.
- TypeScript async iterator and generator documentation, reviewed 2026-07-23.
- Library-first guidebook, reviewed 2026-07-23.
