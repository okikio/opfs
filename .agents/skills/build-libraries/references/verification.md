# Library verification matrix

Use this reference when planning tests, reviewing completion, validating a
published package, or evaluating claims about composition, streaming,
performance, cleanup, tree-shaking, or recovery.

## Evidence hierarchy

Different claims require different evidence:

| Claim | Minimum useful evidence |
| --- | --- |
| Type relationship | type test or clean consumer type check |
| Runtime behavior | executable public-entrypoint test |
| Import safety | fresh-process import observation |
| Tree-shaking | built clean consumer plus module graph or marker absence |
| Streaming | first-item, peak-memory, and slow-sink behavior |
| Resource safety | normal/error/abort/early-return lifecycle checks |
| Performance | representative benchmark against recorded baseline |
| Resume | kill/restart at controlled commit windows |
| Compatibility | previous consumer and artifact contract suite |
| Publication | packed artifact installed in clean consumers |

Source review can diagnose a design. It cannot prove built-artifact behavior or
recovery after process death.

## API and composition tests

Test:

- common facade call;
- each independently supported lower-level capability;
- a second application adapter;
- focused capability fakes;
- structured failures and cancellation;
- domain event ordering and identity;
- absence of application globals;
- replacement of one adapter without unrelated changes;
- unsupported composition rejected clearly.

Use compile-time assertions for inference, readonly contracts, discriminated
unions, and public subpaths. Use runtime tests for semantics.

## Import safety tests

Run each public entrypoint in a fresh process. Observe:

- stdout and stderr;
- environment and global mutations;
- files and network;
- timers, workers, sockets, and open handles;
- configuration discovery;
- optional dependency resolution;
- import duration and memory where important.

A library entrypoint should normally expose values only. Effectful registration
entrypoints must be named and declared in side-effect metadata.

## Packaging and tree-shaking tests

1. Build or pack the exact publishable artifact.
2. Install it in an empty consumer.
3. Import every public subpath.
4. reject private subpaths;
5. type-check declarations;
6. bundle one-function, one-adapter, and root-facade consumers;
7. inspect metafiles or module graphs;
8. assert known unused adapter markers and dependency names are absent;
9. execute each bundle and compare semantic output;
10. inspect package contents against an allowlist.

Run supported runtime and condition branches separately.

## Data-flow tests

For incremental APIs test:

- first value before complete source exhaustion;
- empty, one-item, typical, and large inputs;
- slow source and slow destination;
- bounded queue and buffered bytes;
- skewed task durations and ordering;
- early break;
- consumer throw;
- source throw;
- abort at admission, active work, and write;
- deliberate materialization limit;
- batch-count and byte limits;
- no duplicate or lost records.

A test that only uses ten records cannot establish bounded behavior.

## Resource tests

Instrument acquisition and disposal. Assert:

- every successful acquisition is released exactly once;
- partial construction releases prior resources;
- borrowed resources remain open;
- transferred resources close according to contract;
- disposal order respects dependencies;
- cleanup occurs after iterator return and stream cancellation;
- pool maximum and idle eviction hold;
- repeated cycles plateau;
- cleanup failures retain the primary failure and remain observable.

Use Deno resource and operation sanitizers where available. Use platform handle
inspection or fresh-process exit behavior elsewhere.

## Performance tests

Keep correctness as a gate. Define:

- baseline and candidate revision;
- representative workload and distribution;
- target and protected stories;
- primary metric and practical threshold;
- tail, memory, resource, and error guardrails;
- environment, runtime, flags, warmup, order, repetitions, and seed;
- raw artifact location;
- decision rule.

Measure cold import and first call separately from warm throughput. Measure peak
and retained memory separately. For concurrent work, bound arrival, concurrency,
and queue capacity.

Do not claim a win from one fastest run, a microbenchmark alone, or a benchmark
that omits conversion, output, cleanup, or error behavior paid by consumers.

## Recovery tests

For restartable operations:

- run twice;
- duplicate inputs;
- partially existing outputs;
- stale attempts;
- reconciliation.

For checkpoint resume:

- crash before output;
- crash after output and before checkpoint;
- crash after checkpoint;
- corrupt or missing receipt;
- incompatible request, schema, source, engine, and policy;
- cancellation and manual retry;
- final reconciliation.

For durable orchestration compose with `build-workflows` and test worker loss,
lease expiry, duplicate task delivery, timer/signal behavior, deployment
versioning, and operator controls.

## Compatibility tests

Inventory real consumers and frozen examples. Test:

- public import paths;
- type-level source compatibility where promised;
- runtime results, errors, ordering, and event shapes;
- serialized formats and checkpoint schemas;
- deep imports scheduled for removal;
- deprecation messages and migration path;
- old artifacts against new consumers where supported;
- new artifacts against old consumers where supported.

Do not keep accidental behavior merely because it is observable. Decide whether
to support, deprecate, or break it with an explicit release policy.

## Cross-skill verification

### With build-clis

Prove the CLI calls the public library API, resolves configuration once, owns
LogTape configuration and process lifecycle, and preserves stdout, stderr, exit,
help, completion, and cancellation contracts.

### With explore-ecosystems

Prove selected companions and adapters are first-party or intentionally
interoperable, version-compatible, and smaller than alternative package sets.

### With build-devtools

Prove build tasks, generated exports, package contents, release provenance, and
clean-consumer commands.

### With build-workflows

Prove the line between library resume contracts and durable execution authority.

### With build-data

Prove persistence guarantees, query behavior, migrations, and projection
rebuilds rather than assuming them from an interface.

## Completion report

Report:

- public surfaces added, changed, and removed;
- consumer stories exercised;
- package entrypoints and optional integrations;
- data-flow and resource bounds;
- benchmark and memory evidence;
- recovery guarantee and crash windows tested;
- compatibility decisions;
- checks passed, failed, or blocked;
- claims intentionally not made.

## Failure signatures

- tests import source aliases instead of the package artifact;
- bundle size is the only tree-shaking oracle;
- streaming tests never slow the destination or break early;
- resource tests cover only normal completion;
- performance output lacks baseline, variability, or semantic oracle;
- resumability is tested by calling the same function twice in one process;
- type tests pass while runtime exports are missing;
- a clean consumer is never created;
- blocked checks are described as passed.

## Sources and freshness

- Repository evaluation model and executable fixture conventions.
- Library-first guidebook verification matrix, reviewed 2026-07-23.
- Deno testing and benchmarking guidance, reviewed 2026-07-23.
- esbuild analysis and package-consumer verification guidance, reviewed
  2026-07-23.
