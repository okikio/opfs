# Data-oriented design for TypeScript libraries

Use this reference when performance depends on data volume, layout, access
patterns, allocations, locality, serialization, or hot transformation kernels.
Data-oriented design is not the same as data-driven design.

## Correct definition

Data-oriented design starts from the data and the transformations applied to it:

- what values exist;
- how many exist;
- how they arrive and leave;
- which fields are read or written together;
- which fields are hot or cold;
- how long values live;
- how often they are copied, allocated, compared, indexed, or serialized;
- what CPU, memory, cache, GC, I/O, and runtime constraints matter.

Data-driven design represents variable policy or definitions as data. A rule set
can be data-driven while its compiled index and evaluation batches are
data-oriented.

## Start with the transformation graph

Document the actual data path before selecting classes or package APIs:

```text
TargetDefinition[]
  -> normalized target IDs
  -> observation batches
  -> detector index probes
  -> fact candidates
  -> aggregation state
  -> persisted fact batches
```

For each transform record:

- expected and maximum cardinality;
- average and maximum encoded size;
- fields read and written;
- allocation and copy behavior;
- ordering requirement;
- concurrency and batch policy;
- lifetime and retention;
- error and rejection path;
- materialization and persistence points.

Optimize the dominant transform, not the most visually complex type.

## Separate public and internal representations

Public APIs should remain understandable and stable:

```ts
export interface Observation {
  readonly target: string;
  readonly signalType: string;
  readonly value: string;
  readonly observedAt: Temporal.Instant;
  readonly evidence?: EvidenceReference;
}
```

A hot internal batch may use encoded identifiers or columnar arrays:

```ts
interface ObservationColumns {
  readonly targetIds: Uint32Array;
  readonly signalTypeIds: Uint16Array;
  readonly valueIds: Uint32Array;
  readonly timestamps: Float64Array;
}
```

Keep conversion at explicit ownership points. Do not expose an internal packed layout
unless consumers need and can support that compatibility contract.

## Hot and cold data

Hot data is read or written in the dominant loop. Cold metadata is retained for
explanation, provenance, errors, or final output.

Instead of attaching large evidence objects to every hot record:

```ts
interface HotCandidate {
  readonly targetId: number;
  readonly ruleId: number;
  readonly confidence: number;
  readonly evidenceId: number;
}

interface EvidenceStore {
  readonly entries: readonly EvidenceReference[];
}
```

This may reduce repeated traversal and retention. It also adds indirection and
conversion cost. Measure both.

## Representation options

### Stable objects

Use ordinary objects for small or irregular data, public APIs, rich
metadata, and code where clarity dominates. Keep hot object shapes stable:

- create properties in consistent order;
- avoid repeatedly adding and deleting fields;
- avoid polymorphic property meanings;
- avoid sparse arrays in hot loops;
- avoid mixing unrelated element types in the same hot array.

### Struct-of-arrays or typed arrays

Consider columnar or typed-array layouts when:

- millions of homogeneous records are scanned repeatedly;
- fields have bounded numeric encodings;
- only a subset of fields is used in each kernel;
- allocation and GC dominate;
- serialization or native/Wasm interop benefits;
- benchmarks show a meaningful end-to-end gain.

Account for:

- encoding dictionaries and lookup cost;
- growth and resizing;
- null or optional values;
- precision and overflow;
- endianness for serialized formats;
- conversion at public APIs;
- debug and diagnostic ergonomics;
- worker transfer and ownership.

### Array-of-structs

A `readonly Observation[]` can remain the best batch representation when records
are modest, commonly consumed together, and object allocation is not the
bottleneck. Do not cargo-cult a columnar layout.

### Maps and indexes

Choose indexes from query patterns. A map keyed by domain may help point lookup
but increase memory and build time. Precompiled detector indexes may improve
matching while increasing startup and invalidation cost. Record who builds,
owns, shares, and disposes the index.

## Allocation and pooling

Measure allocation rate and retained memory separately. Pooling can reduce
allocation but introduce stale state, larger retention, contention, and
lifecycle complexity.

Use pooling only when:

- profiles show allocation or GC as material;
- reset semantics are complete and tested;
- maximum pool size is bounded;
- borrowed values cannot escape their lifetime;
- the pool improves representative workloads.

Do not pool public objects that consumers may retain.

## Batching and locality

A batch can improve locality and amortize dispatch, serialization, logging, and
I/O. A batch can also increase latency and peak memory.

Define a batch policy:

```ts
export interface BatchPolicy {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly maxDelayMs: number;
}
```

Measure small, typical, and large batches against:

- throughput;
- first-result latency;
- p95/p99 latency;
- peak and retained memory;
- allocation rate;
- destination write behavior;
- cancellation waste;
- checkpoint frequency.

## Data lifetime

Classify values:

```text
request lifetime
batch lifetime
run lifetime
application lifetime
persistent lifetime
```

Long-lived references to short-lived batches create retention. Closures,
listeners, caches, diagnostics, and retry state can keep entire object graphs
alive. Inspect heap retainers when memory does not plateau.

## Data-oriented API review

Ask:

1. What is the dominant data transformation?
2. What are the real input distributions and maxima?
3. Which fields are hot together?
4. Which values need stable public meaning?
5. Where do allocation and copying occur?
6. Which values are retained across batches or runs?
7. Is an index worth its build and memory cost?
8. Does the representation help the full workflow or only a microbenchmark?
9. Can the representation remain private?
10. What semantic oracle proves optimized output is equivalent?

## Failure signatures

- data-oriented design is described as replacing objects with typed arrays;
- public APIs expose numeric IDs with no stable semantic layer;
- a packed representation is chosen before measuring cardinality or access;
- optimization improves a hot loop but worsens parse, conversion, startup, or
  persistence time;
- object pools retain unbounded data or leak borrowed values;
- indexes are rebuilt for every request;
- cold metadata is copied through every hot transform;
- sparse or polymorphic arrays appear in measured kernels;
- benchmarks omit conversion and output costs paid by real consumers.

## Verification

- profile representative end-to-end workloads before changing representation;
- retain semantic output digests or property tests;
- measure allocation, GC, peak RSS, retained heap, CPU, and wall time;
- test small inputs where conversion overhead may dominate;
- test maximum cardinality and skew;
- verify no borrowed or pooled value escapes its lifetime;
- compare public API behavior before and after internal representation changes;
- reject complexity when gains do not clear the predeclared threshold.

## Sources and freshness

- Richard Fabian, Data-Oriented Design, transform and hardware-oriented model.
- V8 documentation on object properties, element kinds, allocation, and garbage
  collection, reviewed 2026-07-23.
- Library-first guidebook, reviewed 2026-07-23.
