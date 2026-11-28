# Composition at every scale

Use this reference when a library must combine functions, policies, adapters,
configuration systems, observability, extension points, or operational
capabilities without becoming a universal framework.

## Composition model

Evaluate composition at all of these scales:

| Scale | Contract |
| --- | --- |
| Value | Functions accept and return ordinary domain values. |
| Data flow | Arrays, iterables, async iterables, streams, or batches connect operations. |
| Capability | Use cases depend on focused behavior contracts. |
| Policy | Callers select bounded policy without replacing the operation. |
| Ecosystem | The library participates in established systems without owning them. |
| Lifecycle | Resources can be acquired, borrowed, transferred, and disposed. |
| Package | Consumers import only selected capabilities and adapters. |
| Operational | Work can participate in logging, storage, checkpoints, and workers. |

A library that composes only at the function level can still integrate poorly
with configuration, observability, storage, packaging, or recovery.

## Compose through semantic contracts

Prefer focused capabilities:

```ts
export interface AnalyzeCapabilities {
  readonly collect: CollectTargets;
  readonly detect: DetectBatches;
  readonly persist: PersistBatches;
}
```

Avoid one giant runtime:

```ts
export interface RuntimeContext {
  readonly config: unknown;
  readonly logger: unknown;
  readonly browser: unknown;
  readonly queue: unknown;
  readonly storage: unknown;
  readonly metrics: unknown;
  readonly terminal: unknown;
}
```

A narrow contract is not automatically good. It must preserve the semantics the
consumer needs. `log(message: string)` is smaller than LogTape, but it erases
structured properties, categories, contexts, filters, lazy evaluation,
redaction, sink routing, testing, and disposal.

## Strategic dependencies versus adapters

Use a dependency directly when:

- its semantics are intentionally part of the library ecosystem;
- hiding it would require a weaker duplicate abstraction;
- consumers already benefit from the shared contract;
- the dependency is stable enough for the intended compatibility policy;
- application and library ownership remain distinct.

Define a project-owned interface when:

- several implementations genuinely satisfy the same required semantics;
- the project owns additional invariants;
- the dependency would leak host-specific concerns into the domain;
- testing needs a focused fake or in-memory implementation;
- replacement is a real scenario rather than speculative optionality.

Do not wrap every dependency reflexively. Do not expose every dependency
reflexively. State the compatibility and ownership decision.

## LogTape composition

Library code may use hierarchical LogTape categories and structured properties:

```ts
import { getLogger, lazy } from "@logtape/logtape";

const logger = getLogger(["project", "analysis"]);

logger.debug("Compiled {ruleCount} rules", {
  ruleCount,
  indexStats: lazy(() => inspectIndex(index)),
});
```

Library code must not call `configure()` or select application sinks. The
application owns categories, filters, formatters, redaction, file or telemetry
routes, context-local storage, flushing, and disposal.

Keep domain events separate from diagnostics:

```ts
export type AnalysisEvent =
  | { readonly type: "analysis.started"; readonly runId: string }
  | { readonly type: "batch.committed"; readonly batchId: string }
  | { readonly type: "analysis.completed"; readonly runId: string };
```

Domain events are a stable operational contract. LogTape records are support and
observability information. The application may route domain events into LogTape,
a terminal renderer, a socket, or durable storage.

## c12 and defu composition

c12 may own application configuration discovery, formats, environment branches,
`extends`, factories, layer metadata, and watching. defu may assist recursive
merge mechanics. Neither should become the domain library's configuration
language by accident.

Preferred interface:

```text
application composition root
  c12 discovery and layer loading
  -> application-owned merge algebra
  -> authored/resolved/runtime schema validation
  -> focused resolved options passed into library
```

The library receives values such as `AnalysisPolicy`, not a c12 result, current
working directory, or defu callback. Preserve source provenance in the
application when operators need `config explain`.

Array replacement, append/prepend operations, atomic discriminated unions,
null/reset semantics, and default timing are application domain decisions.
Generic deep merge is not a substitute for a public configuration contract.

## unstorage composition

Unstorage is useful for runtime-neutral key-value adapters, mounts, metadata,
snapshots, watches, and many separately imported drivers. Preserve driver
capability differences.

A common API does not imply common guarantees:

- memory is not durable;
- filesystem and remote stores have different atomicity and visibility;
- watch support varies;
- transactions, compare-and-set, leases, TTL, and metadata may be optional or
  driver-specific;
- disposal is part of the selected driver lifecycle.

If the library requires atomic checkpoint advancement, leases, or fencing, make
those semantics explicit in a stronger project-owned contract. Do not claim
that any `Storage` implementation satisfies them.

## Hookable and extension points

Hookable can provide typed registration, removal, serial or parallel invocation,
error handling, and a smaller core. Use hooks when third-party extension or
runtime registration is a real product requirement.

Before exposing a hook, define:

- invocation order and whether it is stable;
- serial versus parallel execution;
- error aggregation and cancellation;
- input mutability and output combination;
- reentrancy;
- registration and disposal;
- compatibility and deprecation policy;
- performance cost on hot paths.

Prefer ordinary function composition for code controlled by one repository.
Hidden callback graphs are harder to reason about than explicit calls.

## Optique and application adapters

Optique can express command grammar, source terms, help, completion, manuals,
and runners as composable values. It belongs at the CLI composition layer. A reusable
library should receive validated domain requests rather than Optique parser
values, `DeferredValue`, or process runner state.

The CLI may be one first-party adapter:

```text
Optique parser + c12 resolution + LogTape configuration
  -> AnalyzeDomainsRequest
  -> @example/analysis
  -> result/failure/events
  -> CLI renderer and exit mapping
```

## Optional integrations

Separate optional integrations physically and semantically:

```text
@scope/library
@scope/library/browser.js
@scope/library/unstorage.js
@scope/library/logtape.js
@scope/library/temporal.js
```

Do not import all integrations into a root registry. Let the application select
and compose them. Dynamic loading is appropriate when selection is genuinely
runtime-driven; static imports are preferable when maximum build-time selection
and tree-shaking matter.

## Extension versus ecosystem checklist

Ask:

1. Is this an established ecosystem contract or a project-specific capability?
2. Who configures it, and who merely emits or consumes values?
3. Which semantics would a generic wrapper erase?
4. Are implementations actually substitutable under the required guarantees?
5. Is runtime extension a product requirement?
6. What is the cleanup and unregistration contract?
7. Can consumers import the integration separately?
8. Does the integration add hot-path or startup cost when unused?

## Failure signatures

- every dependency is hidden behind interfaces that preserve only method names;
- the library configures LogTape or installs global sinks;
- c12 and defu objects leak into domain APIs;
- any unstorage driver is described as a durable transactional checkpoint store;
- hooks organize internal code despite no third-party extension requirement;
- optional adapters are imported by the root module;
- two parsers, loggers, config loaders, or storage owners are stacked without a
  coexistence contract;
- ecosystem composition is measured by number of installed sibling packages.

## Verification

- run the library with no LogTape application configuration and with multiple
  application sink configurations;
- prove domain events remain usable independently of diagnostics;
- resolve configuration once in the application and call the library with plain
  validated values;
- test required storage capabilities against each supported driver;
- register, invoke, remove, and dispose hooks when hooks are public;
- inspect bundle graphs to ensure optional integrations are absent when unused;
- test a second application adapter without changing the domain use case.

## Sources and freshness

- LogTape library-author guidance and configuration manual, reviewed
  2026-07-23.
- c12, defu, unstorage, and Hookable published source and documentation,
  reviewed 2026-07-23.
- Optique official documentation, reviewed 2026-07-23.
- Library-first guidebook, reviewed 2026-07-23.
