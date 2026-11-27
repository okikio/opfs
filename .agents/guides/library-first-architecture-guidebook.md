> **Current standards note (2026-08-19):** Use [Okikio Engineering Standards](engineering-standards.md) for current cross-project naming, schema/type, comments/TSDoc, formatting, testing, logging, dependency, compatibility, validation, and delivery rules. This document remains authoritative for its domain-specific design and dated implementation evidence where it is more specific.

# Library-First Architecture Guidebook

Package names under `@example/` and `analyzer` commands are illustrative, not
published APIs. Adapt the ownership model to the project's actual contracts.

## Composable, tree-shakable, data-oriented TypeScript libraries with a CLI as an optional application interface

**Status:** Architecture guide and refactoring handoff  
**Audience:** Library authors, CLI engineers, platform engineers, and implementation agents  
**Runtime baseline:** Deno v2, strict TypeScript, ESM, explicit file extensions  
**Research reviewed:** July 23, 2026

> **Working definition**  
> A good library is a coherent, selectively adoptable capability. It composes at the value, protocol, policy, lifecycle, ecosystem, package, and operational levels without erasing the semantics of the systems around it. Its public data shapes reflect the real workload. Its resources have visible owners. Its package graph lets consumers pay only for the work, dependencies, data, and lifetimes they choose.

\newpage

# Executive handoff

## Apply the model to current capabilities

The corrective examples address a CLI-shaped extraction; they do not prohibit
verified Context, Task, resource, endpoint, or workflow programming models.
Name what each concept owns and inspect its actual public contract. The public
[okikio/utils source](https://github.com/okikio/utils) separates definitions,
bindings, compilation, runtime lifetime and host transport. Its source package
identities do not prove registry availability. Ownership does not require a
literal `utils/` directory. A coherent local
Task does not become a durable engine, and a compiled service does not need an
application-wide stage registry. Preserve the consumer's actual recovery claim
and use the smallest independently useful level.

## The problem this guide addresses

A CLI was built first. Later, parts of the CLI were extracted into packages and reusable functions. The result became rigid and difficult to reason about.

The likely cause is not simply that the library should have been written before the CLI. The deeper problem is that the extracted abstractions preserved the CLI's execution sequence:

```text
parse -> configure -> acquire -> collect -> verify -> detect -> export -> upload
```

Those are phases in one application workflow. They are not automatically the right ownership boundaries for a reusable library.

A design organized around phases tends to grow generic concepts such as `Runtime`, `Context`, `Stage`, `Handler`, `Executor`, and `run...()`. These abstractions can look reusable while quietly coupling every capability to the same control flow, shared state, lifecycle, and terminology.

The corrective direction is:

```text
use case first
  -> explicit domain request, result, failure, and events
  -> independently useful capabilities
  -> data and resource contracts
  -> application composition root
  -> CLI adapter
```

This follows the information-hiding principle: modules should be organized around design decisions and knowledge that are likely to change, not around a flowchart of the current execution sequence.[^parnas]

## The decision

The architecture should treat the CLI as one application interface over a library ecosystem.

The CLI owns:

- token grammar, commands, aliases, completion, help, and manuals;
- configuration source selection and precedence;
- logging configuration and terminal diagnostics;
- process signals, standard streams, prompts, and exit status;
- application-level dependency selection;
- human and machine rendering.

The libraries own:

- domain values and invariants;
- named use cases;
- independently useful capabilities;
- data transforms and batch kernels;
- resource-producing factories and disposable handles;
- checkpoint and recovery contracts where they are genuinely part of the capability;
- structured results, failures, and domain events.

The CLI may still be implemented first as a user-facing vertical slice. The reusable boundary should be designed from the desired programmatic call site rather than extracted from the command handler after the fact.

## The acceptance standard

A refactored library is not successful merely because code moved into packages. It should satisfy all of the following:

1. A consumer can use one capability without constructing the entire application.
2. A consumer can combine capabilities through explicit values and documented protocols.
3. Importing one adapter does not import or initialize unrelated adapters.
4. Importing a module performs no surprising work.
5. The public API uses the correct shape for its data: value, array, iterable, async iterable, stream, or disposable resource.
6. Concurrency, buffering, and memory growth are bounded.
7. Resources have visible ownership and deterministic cleanup.
8. Configuration and observability ecosystems retain their useful semantics.
9. Restart, checkpoint, resume, and durable execution are named separately and tested according to the claim made.
10. Performance is evaluated against representative workloads, not inferred from aesthetics.

# 1. A better mental model for libraries

## A library is a programming model, not a folder

Moving code from `cli/` to `packages/core/` does not make it a library. A library provides a coherent way to express and perform work in a domain.

A strong API describes the problem:

```ts
import { analyzeDomains } from "@example/analysis";

const result = await analyzeDomains(
  {
    domains: ["example.com"],
  },
  {
    collector,
    detector,
    factRepository,
  },
);
```

A framework-shaped API describes the implementation machinery:

```ts
import { createRuntime, runStages } from "@example/runtime";

const runtime = await createRuntime(options);
const result = await runStages(runtime, stages);
```

The second form can be appropriate when the execution framework itself is the product. It is a poor default when the real product is domain analysis and the framework merely reflects how one CLI currently performs it.

The practical test is clarity at the point of use. Swift's API design guidelines make this the primary goal and recommend evaluating APIs by reading actual use cases, not declarations alone.[^swift-api]

## Use-case first is safer than either extreme

There are three common development orders.

| Approach | Strength | Failure mode |
|---|---|---|
| CLI first, extract later | Real user feedback quickly | Extracts process and terminal assumptions |
| Pure library first | Protects core from application concerns | Speculative abstraction without real consumers |
| Use-case first, library-shaped implementation | Real workflow plus a deliberate programmatic contract | Requires discipline at the composition boundary |

The recommended sequence is:

1. Choose one concrete operation.
2. Write the programmatic call site you wish existed.
3. Define request, result, failure, event, cancellation, and ownership contracts.
4. Implement the operation behind those contracts.
5. Make the CLI translate human and process input into that operation.
6. Add a second consumer before generalizing further.

The second consumer might be a test fixture, API endpoint, worker, scheduled job, desktop app, or another command. It exposes which concerns are truly domain-level and which are still residue from the first application.

## Library depth matters more than exported surface area

A good library often has a small surface backed by substantial implementation depth.

```ts
const analysis = createDomainAnalysis({
  collect,
  detect,
  resolveFacts,
  persist,
});

const result = await analysis.run(request, { signal });
```

That operation may internally perform:

- bounded concurrency;
- browser leasing;
- observation normalization;
- batch formation;
- detector indexing;
- evidence verification;
- fact aggregation;
- checkpoint commits;
- artifact persistence;
- diagnostic emission;
- cancellation and cleanup.

The caller should not need to reconstruct that sequence for the common case. Advanced consumers should still be able to import lower-level capabilities where there is a genuine use case.

This leads to a layered API:

```text
convenience use cases
  analyzeDomains()
  analyzeArchive()
  verifyObservations()

independently useful capabilities
  collectDomains()
  evaluateObservationBatches()
  resolveFactCandidates()
  writeAnalysisArtifacts()

internal mechanisms
  queue implementation
  batch buffers
  detector indexes
  browser lease scheduler
```

# 2. Composability at every scale

## Composability is broader than function pipelines

Connecting functions through values is important, but insufficient. Libraries such as LogTape, c12, defu, Hookable, unstorage, and Optique demonstrate composition across an ecosystem.

A complete model includes at least seven scales.

### Value composition

Functions accept and return ordinary values:

```ts
const compiled = compileDetectionRules(definitions);
const candidates = evaluateBatch(batch, compiled);
const facts = resolveFactCandidates(candidates, policy);
```

### Data-flow composition

Operations connect through arrays, iterables, async iterables, streams, or explicit batches:

```ts
const observations = collectTargets(targets, collector, { signal });
const detections = detectObservationBatches(observations, index, { signal });
await persistDetectionBatches(detections, repository, { signal });
```

### Capability composition

Use cases depend on focused capabilities rather than one universal runtime:

```ts
export interface AnalysisCapabilities {
  readonly collect: CollectTargets;
  readonly detect: DetectObservationBatches;
  readonly persist: PersistAnalysisBatches;
}
```

### Policy composition

The application supplies explicit policies without replacing the entire operation:

```ts
const resolver = createFactResolver({
  confidence: confidencePolicy,
  contradictions: contradictionPolicy,
  freshness: freshnessPolicy,
});
```

### Ecosystem composition

A library participates in a broader contract without owning the whole system. Examples include:

- a library records structured LogTape events but does not configure application sinks;
- c12 owns config discovery and layer evaluation while an application merger owns domain-specific precedence;
- unstorage supplies a common storage API while drivers preserve different durability guarantees;
- Optique owns command grammar and generated surfaces while handlers remain portable.

### Lifecycle composition

Resources can be acquired, borrowed, transferred, and disposed with explicit ownership.

### Operational composition

A capability can participate in checkpoints, queues, workers, observability, and durable workflows without pretending that every in-process operation is durable.

## Do not confuse composability with genericity

This is composable because it exposes a domain sequence:

```ts
export function detectObservationBatches(
  source: AsyncIterable<ObservationBatch>,
  index: DetectionIndex,
  options?: DetectionOptions,
): AsyncIterable<DetectionBatch>;
```

This is generic, but may be less composable in practice:

```ts
export interface Stage<TContext extends RuntimeContext> {
  run(context: TContext): Promise<TContext>;
}
```

Every stage now depends on:

- the stage protocol;
- a shared context shape;
- sequencing rules;
- mutation conventions;
- lifecycle conventions;
- failure propagation;
- the framework's registration model.

The pieces are replaceable only inside the framework. They are not independently useful.

A useful test is:

> Can this capability be called, tested, replaced, or combined without first constructing the rest of the system?

## Preserve ecosystem semantics

A narrow interface can be too narrow.

This abstraction erases most of LogTape:

```ts
export interface Logger {
  log(message: string): void;
}
```

It discards structured records, category hierarchy, contextual properties, filters, redaction, lazy evaluation, sink routing, adapters, and lifecycle disposal.

When a dependency is strategically selected, use it directly at the boundary it genuinely owns:

```ts
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["example", "analysis", "browser"]);
```

LogTape specifically supports library authors recording namespaced logs while the application retains control of sinks, levels, and filters.[^logtape-library] Its adapter model also exists so applications can route those records into established logging systems instead of forcing one isolated logger per library.[^logtape-adapters]

The principle is:

> Abstract to preserve the needed contract, not to maximize theoretical swappability.

## Prefer direct strategic dependencies and domain events together

Diagnostics and domain events serve different purposes.

```ts
export type AnalysisEvent =
  | Readonly<{ type: "analysis.started"; runId: string }>
  | Readonly<{ type: "target.completed"; targetId: string; durationMs: number }>
  | Readonly<{ type: "checkpoint.committed"; checkpointId: string }>
  | Readonly<{ type: "analysis.completed"; summary: AnalysisSummary }>;
```

Domain events are stable, caller-visible operational facts. They can be rendered, streamed, persisted, tested, or translated into LogTape records.

LogTape diagnostics are implementation and support information. They belong to category and sink policy selected by the application.

```text
domain events
  stable progress and outcome semantics

LogTape diagnostics
  implementation details, debugging, support, and telemetry
```

# 3. Tree-shakability and selective adoption

## Tree-shaking begins in the architecture

Tree-shaking is not achieved by adding only:

```json
{
  "sideEffects": false
}
```

Bundlers remove code when they can statically prove that unused modules and exports have no required effects. Esbuild explicitly uses conservative side-effect analysis, which means surprising top-level work blocks elimination.[^esbuild-tree]

A tree-shakable architecture has these properties:

- ESM remains ESM through distribution;
- public exports are statically analyzable;
- importing modules does not initialize application state;
- optional adapters have separate entry points;
- registries do not eagerly import every implementation;
- the package metadata describes side effects truthfully;
- the build preserves useful module boundaries;
- convenience facades do not become mandatory dependency hubs.

## Use explicit subpath exports

Node's package `exports` field allows package authors to expose supported subpaths while encapsulating internal implementation files.[^node-exports]

```json
{
  "name": "@example/analysis",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./browser.js": "./dist/browser.js",
    "./warc.js": "./dist/warc.js",
    "./checkpoints.js": "./dist/checkpoints.js",
    "./testing.js": "./dist/testing.js"
  },
  "sideEffects": false
}
```

A consumer that analyzes WARC files should not import Playwright, browser pools, or Chromium-related code merely because they share a package.

```ts
import { analyzeArchive } from "@example/analysis/warc.js";
```

## Separate integrations physically

LogTape and Optique both demonstrate ecosystem composition through optional packages. Optique describes a dependency-free core and opt-in packages for runtime execution, configuration, environment variables, prompts, LogTape, schemas, Temporal values, completion, and manual generation.[^optique]

A similar package strategy can be used internally:

```text
@example/analysis
@example/analysis-browser
@example/analysis-warc
@example/analysis-commoncrawl
@example/analysis-clickhouse
@example/analysis-checkpoints
@example/analysis-temporal
```

Do not split packages merely to create a large monorepo. Split when a boundary has a distinct dependency graph, runtime target, release concern, or independently useful contract.

## Avoid eager registries

This registry defeats selective adoption:

```ts
import { browserCollector } from "./browser.ts";
import { warcCollector } from "./warc.ts";
import { commonCrawlCollector } from "./common-crawl.ts";

export const collectors = {
  browser: browserCollector,
  warc: warcCollector,
  commonCrawl: commonCrawlCollector,
};
```

Prefer caller-selected static imports:

```ts
import { createBrowserCollector } from "@example/analysis-browser";
```

When runtime selection is necessary, use explicit dynamic import boundaries:

```ts
export const collectorModules = {
  browser: () => import("@example/analysis-browser"),
  warc: () => import("@example/analysis-warc"),
} as const;
```

The runtime selection is now visible and the dependency cost is delayed intentionally.

## Validate tree-shaking as an artifact property

Add fixture applications that import one entry point at a time:

```text
fixtures/
  core-only/
  browser-only/
  warc-only/
  cli-help/
```

For each fixture, assert:

- output bundle size;
- imported package graph;
- absence of forbidden adapters;
- absence of import-time work;
- cold startup time where relevant.

Do not claim tree-shakability based only on source style.

# 4. Choosing the correct data shape

## Data shape is part of the contract

A library should not return `Promise<T[]>` by habit. The type should express the operation's cardinality, timing, ownership, and consumption semantics.

| Shape | Meaning | Best use |
|---|---|---|
| `T` | One immediate value | Compiled index, parsed identifier |
| `Promise<T>` | One eventual value | Transaction result, complete summary |
| `readonly T[]` | Complete bounded reusable collection | Rules, final report rows, small snapshots |
| `Iterable<T>` | Lazy synchronous sequence | In-memory transforms |
| `AsyncIterable<T>` | Incremental asynchronous values | Observations, pages, batches, result records |
| `ReadableStream<T>` | Queueing, cancellation, locking, and backpressure | Transport, bytes, standardized piping |
| `WritableStream<T>` | Incremental sink | Archive output, response body, upload |
| `TransformStream<I, O>` | Backpressured transform | Encoding, decoding, compression, framing |

The Streams Standard defines queueing strategies, cancellation, reader locking, byte streams, BYOB readers, and adaptation from iterables and async iterables.[^whatwg-streams]

## Arrays are deliberate materialization boundaries

Arrays are correct when the consumer needs:

- a bounded snapshot;
- repeated traversal;
- random access;
- sorting or grouping;
- global validation;
- stable ordering;
- a small complete result.

For example, a compiled rule set may reasonably be materialized:

```ts
export interface DetectionIndex {
  readonly rules: readonly CompiledDetectionRule[];
  readonly rulesBySignalType: ReadonlyMap<SignalType, readonly number[]>;
}
```

Large observations should not automatically be collected into one array:

```ts
// Avoid as the only API for large workloads.
export async function collectDomains(
  domains: readonly string[],
): Promise<readonly Observation[]>;
```

The API forces the caller to wait, retains all records, prevents overlap with downstream processing, and makes cancellation discard more completed work.

Prefer a streaming contract, then make materialization explicit:

```ts
export function collectDomains(
  domains: Iterable<string>,
  collector: DomainCollector,
  options?: CollectionOptions,
): AsyncIterable<ObservationBatch>;

const all = await collectToArray(collectDomains(domains, collector));
```

## Expose protocols, not generator implementations

A generator is a useful implementation mechanism. The public contract should normally expose the broader protocol.

```ts
export function normalizeObservations(
  source: Iterable<RawObservation>,
): Iterable<Observation>;
```

The implementation may use `function*`, but callers should not depend on generator-specific methods unless those methods are part of the intended contract.

The same applies to asynchronous generators:

```ts
export function verifyObservationBatches(
  source: AsyncIterable<ObservationBatch>,
  verifier: ObservationVerifier,
  options?: VerifyOptions,
): AsyncIterable<VerifiedObservationBatch>;
```

## Async iterables fit domain records

Async iterables work well for records produced over time:

```ts
export async function* verifyObservationBatches(
  source: AsyncIterable<ObservationBatch>,
  verifier: ObservationVerifier,
  options: VerifyOptions = {},
): AsyncIterable<VerifiedObservationBatch> {
  for await (const batch of source) {
    options.signal?.throwIfAborted();
    yield await verifier.verifyBatch(batch, options);
  }
}
```

They support incremental delivery, ordinary `for await...of`, and generator-based transforms without requiring a stream controller for every domain operation.

## Streams fit transport and pressure-sensitive boundaries

Use Web Streams when the contract needs:

- byte-oriented I/O;
- `pipeTo()` or `pipeThrough()`;
- explicit queueing strategies;
- reader locking;
- standardized cancellation;
- integration with `fetch`;
- compression, decompression, or framing;
- BYOB allocation control.

A useful division is:

```text
domain values
  AsyncIterable<ObservationBatch>
  AsyncIterable<DetectionBatch>

transport and archives
  ReadableStream<Uint8Array>
  WritableStream<Uint8Array>
  TransformStream<Uint8Array, Uint8Array>
```

Adapters should make conversions visible:

```ts
export function encodeObservationBatches(
  source: AsyncIterable<ObservationBatch>,
): ReadableStream<Uint8Array>;

export function decodeObservationBatches(
  source: ReadableStream<Uint8Array>,
): AsyncIterable<ObservationBatch>;
```

## Stream between subsystems, batch within subsystems

One record per `yield` can create excessive overhead:

- generator resumption per record;
- promise and await transitions;
- object allocation per record;
- callback and logging overhead;
- tiny writes to databases and networks;
- weak locality in hot processing loops.

Prefer bounded batches for high-volume paths:

```ts
export interface ObservationBatch {
  readonly sequence: number;
  readonly observations: readonly Observation[];
  readonly estimatedBytes: number;
}
```

For hotter kernels, internal columnar batches may be appropriate:

```ts
export interface ObservationColumns {
  readonly length: number;
  readonly targetIds: Uint32Array;
  readonly signalTypeIds: Uint16Array;
  readonly valueIds: Uint32Array;
  readonly timestamps: Float64Array;
  readonly confidence: Float32Array;
}
```

The public boundary can remain ergonomic while the internal representation is optimized for the transform.

# 5. Data-oriented design

## Correct definition

Data-oriented design is not the same as data-driven design.

Data-driven design represents variable rules or policy as declarative data.

Data-oriented design begins with the actual data, the transformations applied to it, the hardware on which it exists, and the access patterns that dominate the workload. Richard Fabian describes it as designing transformations for well-formed data, where the meaning of well-formed is guided by the target hardware and the transforms that operate on it.[^dod]

The questions are concrete:

- What data exists?
- How much exists at common, large, and pathological scales?
- Which fields are read together?
- Which fields are hot or cold?
- In what order are records processed?
- What must remain resident?
- What can be streamed or spilled?
- Which transformations dominate CPU time?
- Which allocations dominate garbage collection?
- Which boundaries encode, copy, or reshape data?
- Which operations require complete datasets?
- What retry or checkpoint identity belongs to each batch?

## Start from the transformation graph

For a web observation system:

```text
target identifiers
  -> acquisition requests
  -> browser or archive observations
  -> normalized observation batches
  -> detection candidates
  -> evidence groups
  -> facts and aggregates
  -> artifacts and persistence projections
```

For each arrow, record:

- input and output representation;
- expected cardinality ratio;
- ordering requirements;
- CPU complexity;
- allocations and copies;
- concurrency;
- buffer bounds;
- persistence boundary;
- checkpoint boundary;
- failure and retry semantics.

This is more useful than beginning with a class hierarchy.

## Separate hot data from cold metadata

An observation object may contain fields needed on every detector pass and fields needed only for audit output.

```ts
export interface Observation {
  readonly targetId: number;
  readonly signalType: SignalType;
  readonly valueId: number;
  readonly timestamp: number;
  readonly confidence: number;
  readonly evidence?: ObservationEvidence;
  readonly provenance?: ObservationProvenance;
}
```

If `evidence` and `provenance` are large and rarely accessed during detection, keeping them attached to every hot record increases memory pressure and cache traffic.

A more data-oriented representation may separate them:

```ts
export interface ObservationHotColumns {
  readonly targetIds: Uint32Array;
  readonly signalTypeIds: Uint16Array;
  readonly valueIds: Uint32Array;
  readonly timestamps: Float64Array;
  readonly confidence: Float32Array;
}

export interface ObservationColdStore {
  readonly evidenceByObservation: ReadonlyMap<number, ObservationEvidence>;
  readonly provenanceByObservation: ReadonlyMap<number, ObservationProvenance>;
}
```

Do this only where the measured workload justifies the complexity.

## Keep object shapes stable in hot paths

V8 uses hidden classes and specialized element representations. Stable object shapes and dense homogeneous arrays improve the engine's ability to optimize access, while repeated property additions, deletions, sparse arrays, and mixed element kinds can push values into less efficient representations.[^v8-properties][^v8-elements]

Practical TypeScript guidance:

- initialize hot objects with consistent fields and order;
- avoid adding and deleting properties repeatedly;
- avoid sparse arrays in hot loops;
- avoid mixing numbers, objects, and holes in one performance-critical array;
- use typed arrays for dense numeric identifiers or flags when useful;
- use dictionary encoding for repeated strings at large scale;
- reuse bounded buffers where ownership is clear;
- avoid wrapper objects that exist only for one intermediate expression;
- prefer explicit batch transforms over deep per-record virtual dispatch.

## Avoid premature representation complexity

Data-oriented design does not mean converting every collection into typed arrays.

Use ordinary objects and arrays when:

- datasets are small;
- transforms are infrequent;
- developer comprehension dominates;
- serialization or boundary conversion would cost more than the optimization;
- the operation is I/O-bound;
- profiles do not identify the representation as material.

Introduce packed or columnar forms when:

- volumes are large and predictable;
- the same fields are scanned repeatedly;
- allocation pressure is high;
- object metadata is significant;
- cache behavior is material;
- database or columnar storage alignment reduces conversion cost;
- a benchmark demonstrates a meaningful improvement.

# 6. Ecosystem composition

## LogTape: diagnostics without library-owned configuration

A reusable library may obtain category loggers and emit structured records:

```ts
import { getLogger, lazy } from "@logtape/logtape";

const logger = getLogger(["example", "analysis", "detector"]);

logger.debug("processed observation batch", {
  batchSize: batch.length,
  durationMs,
  expensiveDetails: lazy(() => summarizeBatch(batch)),
});
```

The application owns:

- sinks;
- levels and category routing;
- formatting;
- redaction;
- adapters to other logging systems;
- shutdown and disposal.

LogTape supports lazy values to avoid expensive diagnostic computations when records are filtered out.[^logtape-lazy] Its configuration can dispose sinks and filters that implement disposal protocols when configuration is reset or the application exits.[^logtape-config]

Do not use LogTape as the storage owner for durable artifacts or result records. Keep stable results and operational diagnostics separate.

For streaming machine output:

```text
typed result batch
  -> validation
  -> structured redaction
  -> JSONL encoding
  -> backpressured stdout writer

operational progress
  -> LogTape diagnostic categories
  -> stderr, file, OTLP, or selected sinks
```

## c12 and defu: discovery is not domain merge semantics

c12 owns configuration discovery, formats, environment branches, `extends` layers, dynamic factories, and loader concerns. It uses defu by default and allows a custom options merger.[^c12]

Defu recursively applies defaults, gives leftmost arguments priority, concatenates arrays by default, skips nullish values, and supports custom merger construction.[^defu]

Those defaults are useful mechanics, not necessarily the application's public configuration semantics.

Use two distinct merge layers:

```text
c12-aware loader merger
  preserves c12 layer and extension mechanics

application configuration resolver
  defines CLI/env/file precedence, arrays, unions, resets,
  append/prepend/replace operations, defaults, and provenance
```

Do not expose `defu(cli, env, file)` as the specification for configuration behavior unless array concatenation, null handling, and recursive defaults are exactly the intended contract.

Resolve configuration once per invocation:

```ts
const loaded = await loadConfig({ cwd, configFile, envName });
const resolved = resolveApplicationConfig({
  cliPatch,
  environmentPatch,
  loadedConfig: loaded.config,
  layers: loaded.layers,
});

const request = RuntimeConfigSchema.parse(resolved.value);
```

The handler receives the validated request and, where needed, a redacted provenance view. It does not load configuration again.

## unstorage: common API, unequal guarantees

Unstorage provides an asynchronous key-value API, multiple drivers, mounting, snapshots, binary values, metadata, and watching around a small tree-shakable core.[^unstorage]

It is useful for:

- local caches;
- lightweight checkpoints;
- test stores;
- driver-selectable state;
- simple manifests;
- mounted namespaces.

The common API does not make all drivers equivalent.

For every use, state the required guarantees:

```ts
export interface CheckpointStoreRequirements {
  readonly durableAcrossProcessRestart: boolean;
  readonly compareAndSet: boolean;
  readonly atomicBatch: boolean;
  readonly leaseSupport: boolean;
  readonly expectedMaxBytes: number;
}
```

An in-memory driver is not durable because it implements the same methods as Redis or a database-backed driver. A key-value write is not an atomic checkpoint commit unless the driver and protocol prove it.

## Hookable: extension points only when extension is a product requirement

Hookable provides typed awaitable hooks, and `HookableCore` offers a smaller footprint when only basic registration and invocation are needed.[^hookable]

Hooks are useful for third-party or independently deployed extensions. They are not a replacement for ordinary function composition inside one codebase.

Every public hook requires a contract for:

- ordering;
- serial versus parallel invocation;
- error handling;
- cancellation;
- reentrancy;
- mutation rights;
- cleanup and unregistration;
- compatibility across versions.

Do not add hooks merely to avoid making an architectural decision.

## Optique: command grammar as a composable value

Optique models parsers as composable values and derives parsing, types, help, completion, and man pages from the same structure.[^optique]

Use it at the CLI boundary for:

- command grammar;
- structurally exclusive modes;
- aliases and public spelling;
- generated help and completion;
- sparse CLI source values;
- prompt and source adapters where appropriate.

Do not let parser defaults prematurely materialize values that should participate in configuration precedence. Do not pass parser-specific deferred wrappers into domain libraries when the final domain value can be resolved at the composition root.

## Ecosystem selection rule

Use ecosystem packages when they preserve a useful contract and reduce duplicated infrastructure. Avoid importing an entire ecosystem as a lifestyle choice.

For each package, record:

- the capability it owns;
- the semantics it adds;
- the runtime and bundle cost;
- optional dependencies and entry points;
- lifecycle and disposal requirements;
- failure behavior;
- how it is tested in the installed artifact;
- the simpler alternative that was rejected.

# 7. Explicit resource management

## Resources are values with lifetimes

Browsers, pages, database transactions, file handles, stream readers, worker leases, locks, temporary directories, watchers, and logging sinks are not ordinary values. They must be released.

The API should answer:

1. Who acquires the resource?
2. Who owns it?
3. Is it borrowed or transferred?
4. When is it released?
5. Is cleanup synchronous or asynchronous?
6. What happens after partial initialization failure?
7. What happens during cancellation?
8. What happens when cleanup fails?

## Prefer disposable handles

ECMAScript explicit resource management defines `Disposable`, `AsyncDisposable`, `DisposableStack`, `AsyncDisposableStack`, `using`, and `await using`.[^erm-spec] TypeScript supports the syntax and types, and `await using` awaits cleanup as control leaves the scope.[^typescript-erm]

```ts
export interface BrowserLease extends AsyncDisposable {
  readonly browser: Browser;
  readonly leaseId: string;
}

await using lease = await browserPool.acquire({ signal });
const result = await inspectTargets(targets, lease.browser, { signal });
```

The scope makes ownership visible.

## Use disposal stacks for partial construction

Factories often acquire several resources before they can return a usable handle.

```ts
export async function createAnalysisRun(
  dependencies: AnalysisDependencies,
): Promise<AnalysisRun> {
  await using pending = new AsyncDisposableStack();

  const workspace = pending.use(await createTemporaryWorkspace());
  const browserLease = pending.use(
    await dependencies.browserPool.acquire(),
  );
  const transaction = pending.use(
    await dependencies.repository.beginTransaction(),
  );

  return createAnalysisRunHandle({
    workspace,
    browserLease,
    transaction,
    resources: pending.move(),
  });
}
```

`move()` transfers ownership only after successful construction. Earlier failures dispose everything already registered in reverse order.

## Keep lifetimes narrow and distinct

Do not place all resources in one `Runtime` merely because they are disposable.

```text
application lifetime
  database pool
  browser pool
  object store client
  LogTape configuration

analysis-run lifetime
  run row or workflow handle
  temporary workspace
  checkpoint session
  leased workers

single-target lifetime
  browser context
  page
  response readers
  target-local buffers
```

Different lifetimes deserve different owners.

## Make ownership transfer explicit

This is ambiguous:

```ts
export function createArchiveWriter(
  destination: WritableStream<Uint8Array>,
): ArchiveWriter;
```

Does disposal close or abort the destination?

Prefer an explicit policy:

```ts
export type ResourceOwnership = "borrow" | "transfer";

export function createArchiveWriter(
  destination: WritableStream<Uint8Array>,
  options: Readonly<{ ownership: ResourceOwnership }>,
): ArchiveWriter;
```

Document early termination, successful completion, failure, and cancellation separately.

## Cancellation and disposal are complementary

`AbortSignal` requests that active work stop. Disposal guarantees that owned resources are released.

```ts
await using session = await browserPool.acquire({ signal });
return await inspectTargets(targets, session.browser, { signal });
```

On cancellation:

1. the signal reaches active operations;
2. producers stop admitting work;
3. queues reject or drain according to policy;
4. iterators stop producing values;
5. the scope exits;
6. disposers run and are awaited;
7. the operation settles with a stable cancellation outcome.

Verify target runtime support. MDN currently marks some disposal-stack APIs as unavailable in some widely used browsers, so cross-runtime libraries may need explicit fallbacks.[^mdn-erm]

# 8. Performance as an architectural contract

## Performance is workload-specific

A library is not performant in the abstract. It is performant for a workload, environment, and metric.

Measure at least:

| Dimension | Meaning |
|---|---|
| Cold-start latency | Time until the first useful result in a fresh process |
| Warm latency | Repeated operation cost after initialization |
| Throughput | Targets, records, batches, or bytes per second |
| Tail latency | p95, p99, and pathological completion times |
| CPU time | Computation consumed, separate from wall time |
| Peak memory | Maximum live working set |
| Allocation rate | Garbage created per unit of work |
| I/O volume | Reads, writes, requests, and transferred bytes |
| Resource count | Pages, browsers, workers, sockets, files, timers |
| Cleanup latency | Time to stop and release resources |
| Recovery latency | Time to continue useful work after interruption |
| Import and bundle cost | Cost of selecting one capability |

## Model memory before tuning

For a browser analysis pipeline:

```text
peak memory ~=
  fixed process and application state
  + browser processes
  + active concurrency * per-target working set
  + queued input batches
  + queued output batches
  + detector indexes
  + persistence buffers
  + logging buffers
  + retry and checkpoint state
```

An async iterable is not automatically memory-bounded. A producer can still fill an unbounded internal queue.

Expose bounded execution policy:

```ts
export interface ExecutionPolicy {
  readonly concurrency: number;
  readonly batchSize: number;
  readonly maxBatchBytes: number;
  readonly maxBufferedBatches: number;
  readonly maxPendingWrites: number;
}
```

Validate these values together. `concurrency: 100` with `maxBufferedBatches: 1000` may be technically valid and operationally disastrous.

## Separate admission, concurrency, and buffering

These concepts are different:

- **admission:** how much work may enter the system;
- **concurrency:** how many operations run simultaneously;
- **buffering:** how much completed or pending data may wait;
- **backpressure:** how downstream capacity slows upstream production;
- **fairness:** how capacity is distributed across targets or runs.

A queue package may implement these mechanics. The use case should express the policy and semantics it requires without exposing the queue implementation as its public model.

## Optimize fast CLI paths separately

The following should avoid loading browser, database, config, and detector graphs when possible:

```text
--help
--version
completion generation
manual generation
invalid token diagnostics
```

A modular parser ecosystem helps only if the executable preserves early paths. A root file that statically imports every command and adapter can erase the benefit.

Measure installed invocations, not only in-process parser calls:

```text
analyzer --help
analyzer analyze --help
analyzer completion zsh
analyzer analyze example.com
```

## Use lazy diagnostics, but do not hide results

LogTape supports lazy evaluation for expensive context and record fields.[^logtape-lazy]

```ts
logger.debug("detector index details", {
  summary: lazy(() => summarizeIndex(index)),
});
```

Do not make required domain results lazy merely to improve logging. Diagnostics can be skipped. Results must preserve their contract.

## Benchmark representative stories

Deno's benchmark tool reports distributions and supports explicit critical sections and baseline groups.[^deno-bench] The project skills recommend mitata by default where its controls are useful. Whichever harness is selected, benchmark stories should include:

- common input;
- large realistic input;
- pathological input;
- cold startup;
- steady-state hot path;
- cancellation and cleanup;
- checkpoint commit;
- recovery after interruption;
- installed CLI execution;
- bundle and import graph fixtures.

Every benchmark should state:

1. what workload it represents;
2. the baseline;
3. what changed;
4. which cost is expected to move;
5. what regression threshold matters;
6. whether the change is worth any readability cost.

## Performance gates

Use correctness gates before performance gates.

A useful initial policy:

```text
correctness and artifact verification
  -> no unbounded memory growth
  -> no leaked handles after success/failure/cancel
  -> no forbidden dependency in selective bundles
  -> no material cold-start regression
  -> no material throughput regression
  -> no p99 cleanup or recovery regression
```

Set numeric thresholds only after obtaining stable baselines on controlled hardware.

# 9. Resumability and durability

## Name the actual guarantee

Do not use “resumable” or “durable” as vague marketing terms.

### Restartable

The operation can safely run again from the beginning.

Requirements:

- deterministic logical identity;
- idempotent or deduplicated outputs;
- duplicate input handling;
- known partial-output policy.

### Checkpoint-resumable

The operation can continue from committed progress.

Requirements:

- versioned checkpoint schema;
- stable request fingerprint;
- committed cursor or partition identity;
- output identity and reconciliation;
- atomic or recoverable commit protocol;
- compatibility rejection when inputs or engines change.

### Durably orchestrated

The operation survives process or worker loss through a persistent execution engine or control plane.

Requirements may include:

- persisted intent before acknowledgement;
- durable timers and waits;
- leases and fencing;
- durable cancellation;
- replay or recovery semantics;
- operator inspection and repair;
- deployment and version compatibility.

An in-memory promise chain, retry loop, queue, or stage runner is not durable merely because it handles exceptions.

## Checkpoint committed work, not attempted work

```ts
export interface AnalysisCheckpoint {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly requestFingerprint: string;
  readonly engineVersion: string;
  readonly ruleSetVersion: string;
  readonly committedCursor: TargetCursor;
  readonly committedArtifacts: readonly ArtifactReference[];
  readonly updatedAt: string;
}
```

Safe ordering:

```text
process batch
  -> persist required outputs
  -> verify or reconcile persistence result
  -> atomically advance checkpoint
  -> publish committed progress
```

Unsafe ordering:

```text
advance checkpoint
  -> attempt output persistence
  -> crash
```

The unsafe order can skip uncommitted output after resume.

## Separate logical identity from attempts

Record:

- logical operation ID;
- run or history ID;
- execution attempt;
- batch or partition ID;
- external effect key;
- request fingerprint;
- artifact identity;
- checkpoint identity.

A retry of the same business operation should preserve the logical ID while receiving a new attempt ID.

## Design effects for at-least-once execution

Assume retryable work can execute more than once unless a stronger guarantee is proven at the effect boundary.

For external effects, capture:

```ts
export interface EffectIntent {
  readonly operationKey: string;
  readonly inputFingerprint: string;
  readonly status: "pending" | "committed" | "ambiguous" | "failed";
  readonly providerRequestId?: string;
  readonly providerResultId?: string;
}
```

Handle ambiguous timeouts through idempotency keys or provider lookup. Do not blindly retry payments, messages, provisioning, or irreversible uploads.

## Select a durable engine proportionally

| Mechanism | Prefer when | Additional proof required |
|---|---|---|
| Synchronous call | Short work, caller owns retry | Timeout, cancellation, transaction |
| Scheduled command | Periodic stateless or reconcilable work | Overlap, missed runs, locks, audit |
| Database job table | Moderate jobs and existing database operations | Atomic claim, lease, retry, poison state |
| Broker queue | High-throughput delivery and consumer decoupling | Durable state, dedupe, replay, visibility |
| Custom control plane | Product-specific admission and operator model | Persistence, atomic gaps, recovery, UI |
| Temporal | Long-lived workflows, durable timers/messages, replay | Deterministic workflow code and deployment policy |

Temporal resumes workflow execution through replay against persisted event history, and activity heartbeat payloads can carry checkpoint data across retries.[^temporal-workflow][^temporal-heartbeat]

The CLI becomes a client when work outlives it:

```text
analyzer analysis start
analyzer analysis inspect <run-id>
analyzer analysis attach <run-id>
analyzer analysis cancel <run-id>
analyzer analysis retry <run-id>
analyzer analysis repair <run-id>
```

# 10. Recommended architecture

## Package and ownership map

```text
@example/analysis-kernel
  pure or controlled data transforms
  detector compilation and indexes
  batch evaluation
  fact aggregation
  no config discovery
  no process globals
  no terminal output

@example/analysis
  named use cases
  request/result/failure/event contracts
  bounded async batch pipelines
  cancellation
  checkpoint protocol

@example/browser
  browser acquisition and pooling
  disposable leases
  browser-specific collection and verification
  observation batch production

@example/warc
  WARC/WACZ reading and writing
  byte streams
  archive-specific resources
  normalized observation production

@example/config
  c12 loading
  application-specific defu merger
  schemas, defaults, and transforms
  provenance and explanation

@example/checkpoints
  checkpoint schemas and compatibility
  unstorage adapters for suitable use cases
  database adapters for stronger guarantees

@example/observability
  LogTape category conventions
  domain-event-to-log adapters
  redaction helpers
  no global sink configuration

@example/cli
  Optique grammar
  early help/version/completion paths
  config source composition
  LogTape configuration
  terminal and machine renderers
  root cancellation
  exit mapping
```

Architectural boundaries may begin as modules. Promote them to packages when dependency graph, runtime target, release cadence, or independent consumption justifies it.

## The composition root

The executable is allowed to be explicit and somewhat boring.

```ts
import { configure, getLogger } from "@logtape/logtape";
import { runProgram } from "@optique/run";

import { createDomainAnalysis } from "@example/analysis";
import { createBrowserCollector } from "@example/browser";
import { resolveCliConfiguration } from "@example/config";

const exitCode = await runProgram(parser, {
  async run(parsed) {
    const config = await resolveCliConfiguration(parsed);
    const logging = await configureApplicationLogging(config.logging);

    await using resources = new AsyncDisposableStack();
    resources.defer(() => logging.dispose());

    const browserCollector = resources.use(
      await createBrowserCollector(config.browser),
    );

    const analysis = createDomainAnalysis({
      collect: browserCollector.collect,
      detect: detectionEngine.detect,
      persist: analysisRepository.persist,
    });

    const controller = installRootCancellation();
    resources.defer(() => controller.dispose());

    try {
      const result = await analysis.run(config.request, {
        signal: controller.signal,
      });

      await renderResult(result, config.output);
      return 0;
    } catch (error) {
      return await renderFailure(error, getLogger(["example", "cli"]));
    }
  },
});

Deno.exit(exitCode);
```

The precise APIs will differ. The ownership should not.

## Named use-case contract

```ts
export interface AnalyzeDomainsRequest {
  readonly domains: readonly string[];
  readonly policy: AnalysisPolicy;
}

export interface AnalyzeDomainsOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AnalysisEvent) => void | Promise<void>;
}

export interface AnalyzeDomainsResult {
  readonly runId: string;
  readonly summary: AnalysisSummary;
  readonly artifacts: readonly ArtifactReference[];
}

export function createDomainAnalysis(
  capabilities: AnalysisCapabilities,
): Readonly<{
  run(
    request: AnalyzeDomainsRequest,
    options?: AnalyzeDomainsOptions,
  ): Promise<AnalyzeDomainsResult>;
}>;
```

Lower-level batch APIs remain separately importable where needed.

## Demote stages to observable state

Stages can remain useful as:

- progress event names;
- checkpoint identifiers;
- audit timeline entries;
- operator status;
- performance measurement spans;
- artifact metadata.

They should not automatically be the package decomposition or universal execution interface.

```ts
export type AnalysisStage =
  | "acquire"
  | "collect"
  | "verify"
  | "detect"
  | "resolve"
  | "persist";
```

```text
better
  domain operations drive execution
  stage events describe execution

worse
  generic stage objects own all execution
```

## Avoid a universal runtime package

A broad runtime tends to accumulate:

- configuration;
- logging;
- signals;
- queues;
- browser pools;
- workers;
- repositories;
- artifact writers;
- metrics;
- cleanup;
- stage state.

Every function then accepts the whole world:

```ts
runBrowserAnalysis(runtime, input);
resolveFacts(runtime, input);
writeArchive(runtime, input);
```

This increases mental cost, dependency retention, and temporal coupling.

Use focused resource scopes and capability records instead. A runtime package is justified only when the runtime protocol itself is an independently useful product with a precise contract.

# 11. Refactoring handoff

## Phase 0: establish evidence

Before changing architecture:

- inventory packages, entry points, exports, and runtime targets;
- trace every command from parser to domain side effect;
- identify import-time effects;
- record configuration loading and precedence;
- trace LogTape configuration and disposal;
- identify every resource and owner;
- identify all arrays that can grow with workload;
- identify queues and their bounds;
- identify restart, checkpoint, and durability claims;
- capture installed CLI behavior;
- create cold-start, throughput, memory, and cancellation baselines.

Produce a dependency graph for representative entry points:

```text
core import
browser import
WARC import
CLI --help
full browser analysis
```

## Phase 1: preserve one representative command

Choose a command that exercises the most important path. Add characterization tests around:

- inputs and source precedence;
- output bytes and artifacts;
- structured failures and exit classes;
- cancellation;
- cleanup;
- partial result behavior;
- checkpoint behavior if present.

Do not refactor every command simultaneously.

## Phase 2: write the desired consumer first

Create a failing integration test that expresses the target library API:

```ts
Deno.test("analyzes domains without the CLI", async () => {
  await using fixture = await createAnalysisFixture();

  const analysis = createDomainAnalysis(fixture.capabilities);
  const result = await analysis.run({
    domains: ["example.com"],
    policy: fixture.policy,
  });

  assertEquals(result.summary.targetCount, 1);
});
```

The test should not construct an application runtime, parse arguments, configure sinks, or write terminal output.

## Phase 3: define four stable contracts

Define only what the programmatic consumer needs:

1. request;
2. result;
3. structured failures;
4. domain events.

Do not export the internal queue, stage objects, mutable context, or concrete runtime.

## Phase 4: classify the existing context

For every field in a large context object, classify it as one of:

| Classification | Destination |
|---|---|
| Domain input | Request or domain value |
| Execution policy | Options or policy value |
| Required capability | Focused capability contract |
| Resource | Disposable handle with owner |
| Diagnostic context | LogTape context or event metadata |
| Application concern | CLI composition root |
| Internal implementation | Private module state |

Delete fields that merely duplicate information available from another owner.

## Phase 5: extract the use-case orchestration

Move the meaningful domain sequence behind the named use case. Keep existing stage implementations internally if necessary, but stop exposing them as the public integration contract.

```text
before
  CLI handler -> runtime -> stage registry -> stages -> shared context

after
  CLI handler -> analyzeDomains(request, capabilities)
                  -> private orchestration
                  -> focused capabilities and batches
```

## Phase 6: introduce explicit resource scopes

For each resource:

- define acquisition;
- define ownership;
- implement `Disposable` or `AsyncDisposable` where supported;
- add `try/finally` fallback where required;
- verify partial construction cleanup;
- verify cancellation cleanup;
- add leak checks.

Begin with high-cost resources:

- browsers;
- contexts and pages;
- workers;
- database clients and transactions;
- stream readers and writers;
- temporary directories;
- LogTape configuration and sinks;
- c12 watchers.

## Phase 7: replace accidental materialization

Find APIs returning large `Promise<T[]>` results.

For each, decide:

- bounded final array;
- `Iterable<T>`;
- `AsyncIterable<T>`;
- `AsyncIterable<Batch<T>>`;
- byte stream;
- external artifact reference.

Introduce bounds before increasing concurrency.

## Phase 8: establish data-oriented kernels

Profile and identify hot transforms. For each:

1. document input volume and layout;
2. document field access patterns;
3. measure allocations and copies;
4. create a representative benchmark;
5. compare object, batched, and columnar representations where justified;
6. retain the simplest representation that meets the target.

Do not optimize command parsing while browser memory dominates the workload.

## Phase 9: isolate ecosystem owners

- Optique owns CLI grammar and generated surfaces.
- c12 owns config discovery and layer evaluation.
- The application resolver owns final precedence and provenance.
- LogTape records diagnostics; the executable configures and disposes it.
- unstorage is used only where its selected driver meets the checkpoint guarantee.
- Hookable is used only for supported extension surfaces.
- Temporal or another engine is used only when durable execution requirements justify it.

## Phase 10: add the second consumer

Add one of:

- an HTTP API endpoint;
- a worker entry point;
- a direct library example;
- a scheduled process;
- a test harness that substitutes all I/O.

The second consumer must use the same use-case contract without importing the CLI.

## Phase 11: validate selective adoption

For each public entry point:

- bundle a fixture;
- inspect retained dependencies;
- run it in its target runtime;
- verify no import-time I/O;
- record startup and memory;
- assert excluded adapters are absent.

## Phase 12: remove compatibility scaffolding deliberately

After all consumers use the new contract:

- remove generic `run...` aliases that retain CLI terminology;
- remove the shared mutable runtime context;
- remove stage registration surfaces that are no longer extensions;
- remove duplicate configuration loading;
- remove library-owned sink setup;
- remove eager adapter registries;
- update TSDoc, examples, and package exports;
- run installed-artifact and clean-environment verification.

# 12. Verification matrix

## API and composition

- Core use case runs without CLI imports.
- Each low-level capability is independently testable.
- A second consumer composes the same use case.
- Strategic ecosystem semantics are preserved.
- No public type exposes a private implementation type.

## Packaging and tree-shaking

- ESM output remains static and analyzable.
- `sideEffects` metadata is accurate.
- Subpath exports are explicit.
- Core-only fixture excludes browser and storage adapters.
- Browser-only fixture excludes WARC-only code.
- CLI help path avoids heavy command imports where practical.

## Data flow

- Large operations do not require complete in-memory materialization.
- Batch count and byte size are bounded.
- Early consumer termination cancels or closes upstream work.
- Stream writers await backpressure.
- Partial-failure behavior is documented and tested.

## Resources

- Success disposes every owned resource.
- Failure during construction disposes earlier resources.
- Cancellation disposes browsers, workers, streams, and transactions.
- Cleanup has a deadline and stable outcome.
- No test leaves handles, timers, watchers, or subprocesses alive.

## Performance

- Cold-start and installed `--help` baseline recorded.
- Common and large workloads benchmarked.
- p95 and p99 reported where meaningful.
- Peak memory and allocation behavior measured separately.
- Throughput is measured with the real batch and persistence path.
- Cleanup and recovery latency are measured.
- Performance claims identify hardware and runtime versions.

## Recovery

- Checkpoint records committed output only.
- Changed inputs reject incompatible resume.
- Duplicate delivery does not create duplicate logical effects.
- Crash after output commit but before checkpoint is reconciled.
- Crash after checkpoint but before acknowledgement is safe.
- Operator can inspect and repair non-terminal runs.
- Durable claims survive process and worker termination tests.

# 13. Anti-patterns

## The library-shaped CLI

Symptoms:

- exported options mirror command flags;
- functions read environment variables or current working directory;
- output format is selected inside domain code;
- errors are terminal strings;
- handlers call `Deno.exit()`;
- a browser package exports `runBrowserPackage...()`.

Correction: move process interaction to the CLI and expose domain requests and results.

## The universal runtime

Symptoms:

- one object contains every dependency and state value;
- every package imports runtime types;
- tests construct dozens of irrelevant fields;
- importing one capability reaches every adapter;
- lifecycle ordering is implicit.

Correction: focused capabilities and resource scopes.

## The stage framework for code you control

Symptoms:

- every operation implements the same stage interface;
- shared context mutates across phases;
- order is known only by registry configuration;
- domain values are hidden inside context fields;
- extension hooks exist without external extensions.

Correction: named use cases, explicit data flow, and stage events for observation only.

## The lowest-common-denominator adapter

Symptoms:

- LogTape reduced to `log(string)`;
- storage reduced to methods that cannot express required atomicity;
- streams reduced to arrays;
- configuration layers flattened before provenance is captured;
- durable engines hidden behind an interface that omits replay and operator controls.

Correction: preserve strategic semantics or define a richer minimally sufficient contract.

## Streaming in name only

Symptoms:

- source buffers everything before yielding;
- internal queue is unbounded;
- downstream persistence collects all records;
- logs serialize full batches eagerly;
- cancellation does not reach producers.

Correction: trace the pipeline end to end and bound every queue and materialization point.

## Data-oriented cargo culting

Symptoms:

- typed arrays introduced without a profile;
- ergonomic APIs replaced with packed structures everywhere;
- conversion costs ignored;
- I/O-bound paths optimized for CPU cache;
- benchmark inputs are tiny and synthetic.

Correction: start with transformations, volumes, access patterns, and measured bottlenecks.

## Fake resumability

Symptoms:

- an index is saved before output commits;
- retry starts a new logical operation;
- changed input is accepted under the same checkpoint;
- memory queue state is called durable;
- external effects have no idempotency key.

Correction: versioned identity, committed checkpoints, reconciliation, and proportional durable infrastructure.

# 14. Decision checklist

Before introducing an abstraction, answer:

1. What concrete use case needs it?
2. What knowledge or design decision does it hide?
3. Is it a domain capability, application concern, ecosystem adapter, or internal mechanism?
4. Can it be used independently?
5. What data shape reflects its workload?
6. Who owns every resource it creates?
7. What are its concurrency and buffer bounds?
8. What does cancellation do?
9. What happens after early termination?
10. What restart or durability claim does it make?
11. Which ecosystem semantics must be preserved?
12. Which dependencies are retained when only this capability is imported?
13. How will performance be measured?
14. What evidence would justify a more complex representation?
15. What is the simplest design that still meets the contract?

# 15. Final architecture principles

1. **Use-case first, not flowchart first.** Start from the programmatic operation and the caller's desired code.
2. **Organize around hidden decisions.** Modules own knowledge likely to change, not merely phases of one workflow.
3. **Compose at every scale.** Values, data flows, capabilities, policies, ecosystems, lifecycles, packages, and operations all matter.
4. **Preserve semantics.** Do not reduce strong ecosystems to weak generic interfaces.
5. **Make selective adoption physical.** Module and package graphs should match conceptual boundaries.
6. **Choose truthful data shapes.** Arrays, iterables, async iterables, streams, and artifacts express different contracts.
7. **Stream between systems and batch within systems.** Preserve incrementality while controlling per-record overhead.
8. **Design around actual data.** Volumes, layouts, transforms, access patterns, and hardware determine hot-path representation.
9. **Make ownership lexical where possible.** Acquire, use, transfer, and dispose resources explicitly.
10. **Bound everything that can grow.** Concurrency, queues, bytes, retries, logs, and cleanup time all need limits.
11. **Measure the workload users run.** Cold start, throughput, memory, tail latency, cleanup, and recovery are separate metrics.
12. **Name recovery guarantees precisely.** Restartable, checkpoint-resumable, and durably orchestrated are different systems.
13. **Keep the CLI thin but capable.** It owns interaction and process lifecycle, not domain semantics.
14. **Provide convenience without captivity.** Common use cases should be easy, lower-level capabilities should remain available, and neither should force a universal framework.

> **Final standard**  
> A good library composes without erasing semantics, performs without hiding costs, owns resources without leaking them, and resumes without pretending that in-memory progress is durable.

# Sources and research notes

[^parnas]: D. L. Parnas, “On the Criteria To Be Used in Decomposing Systems into Modules,” *Communications of the ACM*, 1972. https://wstomv.win.tue.nl/edu/2ip30/references/criteria_for_modularization.pdf

[^swift-api]: Swift.org, “API Design Guidelines,” especially “clarity at the point of use.” https://swift.org/documentation/api-design-guidelines/

[^esbuild-tree]: Esbuild API documentation, “Tree shaking” and conservative side-effect detection. https://esbuild.github.io/api/#tree-shaking

[^node-exports]: Node.js documentation, “Modules: Packages,” package `exports` and subpath exports. https://nodejs.org/api/packages.html#exports

[^logtape-library]: LogTape documentation, “Using in libraries.” https://logtape.org/manual/library

[^logtape-adapters]: LogTape documentation, “Adapters.” https://logtape.org/manual/adaptors

[^logtape-lazy]: LogTape documentation, “Lazy evaluation.” https://logtape.org/manual/lazy

[^logtape-config]: LogTape documentation, “Configuration,” including disposal of sink and filter resources. https://logtape.org/manual/config

[^optique]: Optique documentation, composable parsers, generated surfaces, and opt-in ecosystem packages. https://optique.dev/

[^whatwg-streams]: WHATWG, “Streams Standard.” https://streams.spec.whatwg.org/

[^dod]: Richard Fabian, *Data-Oriented Design*, definition and hardware-guided transforms. https://www.dataorienteddesign.com/dodbook/node2.html

[^v8-properties]: V8, “Fast properties in V8.” https://v8.dev/blog/fast-properties

[^v8-elements]: V8, “Elements kinds in V8.” https://v8.dev/blog/elements-kinds

[^c12]: UnJS c12 repository and README. https://github.com/unjs/c12

[^defu]: UnJS defu repository and README. https://github.com/unjs/defu

[^unstorage]: UnJS unstorage documentation and repository. https://unstorage.unjs.io/ and https://github.com/unjs/unstorage

[^hookable]: UnJS Hookable repository and README, including `HookableCore`. https://github.com/unjs/hookable

[^erm-spec]: TC39, “ECMAScript Explicit Resource Management.” https://tc39.es/proposal-explicit-resource-management/

[^typescript-erm]: TypeScript 5.2 release notes, explicit resource management. https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html

[^mdn-erm]: MDN, “JavaScript resource management” and compatibility notes. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Resource_management

[^deno-bench]: Deno documentation, `deno bench`, distributions, baselines, and critical sections. https://docs.deno.com/runtime/reference/cli/bench/

[^temporal-workflow]: Temporal documentation, Workflow Execution and replay. https://docs.temporal.io/workflow-execution

[^temporal-heartbeat]: Temporal documentation, Tasks and activity heartbeat payloads across retries. https://docs.temporal.io/tasks
