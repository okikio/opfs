# Compare provider publication workloads

Run the owned SeaweedFS and Azurite fixture with the repository's selected Node and Bun runtimes:

```sh
deno task bench:providers
```

For correctness and request-contract verification without timing, run:

```sh
deno task bench:providers:verify
```

This task owns the same disposable providers and executes both runtime programs' preflights. Each prints an explicit
untimed completion marker after its acknowledgement, request-work and byte checks. Mitata callbacks are registered but
never run, so verification produces no latency distributions or native Mitata JSON timing report. Verification ignores
`OPFS_BENCH_REPORT_DIR`, including an inherited setting. The completion markers are correctness evidence, not a
performance result.

Both verification and timed orchestration write `provider-inputs.json` using the shared maintained input catalog before
provider acquisition and after owned cleanup. Standalone evidence is under `.tmp/reports/provider-verify/` or
`.tmp/reports/provider-bench/`; parent-collected timing uses the parent report directory. Missing required inputs or
changed support invalidate that receipt and fail the command. An `unchanged` input receipt is separate from successful
byte/request preflight and valid timing distributions. See [validation](validation.md) for catalog exclusions and the
limits of before/after source observations.

`bench/providers.ts` starts the providers before the benchmark programs and releases them after both runtimes finish.
Each program first validates independent deterministic bytes, publication acknowledgements, and physical HTTP calls. It
then times requests directly against the provider endpoints. The preflight observer is closed before timing; there is no
extra proxy hop in the latency measurements. These are warmed clients and repeated replacements of existing objects.
Startup, the first absent-file creation, and cold connection costs are separate questions.

## Read each comparison as an operation contract

The 256 KiB primitive SDK, direct client, and driver write cases measure one acknowledged replacement. AWS returns its
PutObject response, Azure returns its upload response, and the project returns an own-operation receipt. Bun returns the
accepted byte count. Results are consumed by Mitata's `do_not_optimize`. None adds an explicit metadata request after
publication. These response shapes have different richness; the common capability is awaited publication
acknowledgement, not an equally rich receipt API.

Adapter and facade cases say `projected replace acknowledged`. They provide file/directory conflict admission in
addition to publication. Their pre-write metadata calls are part of the measured behavior. They are a capability and
cost staircase, not interchangeable implementations with identical guarantees. Do not call the difference pure wrapper
overhead or add arbitrary SDK HEAD requests to manufacture matching totals.

| Warm replacement lane                                    | Physical HTTP work admitted by preflight |
| -------------------------------------------------------- | ---------------------------------------- |
| S3 SDK, Bun native, project client, project driver       | 1 object PUT                             |
| Azure SDK, project client, project driver                | 1 object PUT                             |
| Object adapter                                           | 2 HEAD + 1 prefix LIST + 1 object PUT    |
| Filesystem facade, metrics none or basic, default policy | 4 HEAD + 2 prefix LIST + 1 object PUT    |
| Filesystem facade, `writeAdmission: true`, binary input  | 2 HEAD + 1 prefix LIST + 1 object PUT    |
| S3 6 MiB multipart, SDK, Bun native or project client    | 1 initiate + 2 parts + 1 complete        |
| Azure 6 MiB blocks, SDK or project client                | 6 block PUT + 1 block-list commit        |

The S3 multipart cases use 5 MiB parts and concurrency four. The Azure cases force six 1 MiB blocks and concurrency
four; the SDK's single-shot threshold is explicitly disabled for that scenario. Bun's streaming writer is flushed to
publication with `end()`. Counts describe the pinned fixture and configured routes, not every compatible provider or
runtime. A route or request-count change stops the preflight for review rather than silently changing the workload.

The facade and adapter both validate by default. The benchmark includes an explicit `writeAdmission: true` comparison,
which delegates replacement admission only when the adapter declares `validatesReplacement` and the input is an
ArrayBuffer or view. The object adapter still checks the file, directory marker, and prefix immediately before PUT and
keeps the fresh ETag precondition. There is no cross-operation metadata cache. The opt-in comparison must be identified
separately from default-policy timings. String, Blob, streamed, append, and update inputs keep facade admission,
including validation before source consumption. Parent checks remain on both routes.

Read cases consume the complete response body. Adapter/facade reads also retain their namespace checks, so their
semantic cost should be interpreted separately from primitive SDK/client reads. No measured `write + stat` scenario is
currently registered. A future scenario with that name must explicitly obtain current metadata in every relevant lane
and validate that additional physical work.

## Separate acknowledgement from current state

The preflight transport records bounded method/role histograms and checks that namespace HEAD/LIST reads precede
publication. A post-publication stat cannot identify which concurrent writer published the bytes and cannot repair a
lost acknowledgement. The project receipt checks observed input length and publication ETag; SDK responses check their
own ETags; Bun's materialized write checks its acknowledged byte count. A separate read validates exact fixture bytes
without using the candidate response to construct the expected payload. Bun's multipart end exposes no comparable ETag
receipt, so that lane proves its awaited commit route and the independent body rather than inventing metadata.

The observer pins the owned provider authority while preserving the literal request target and signed Host headers. It
forwards both stream directions with explicit backpressure, retaining no document-sized payload copy. It records at most
64 method/role entries per operation and admits at most 64 simultaneous exchanges. Its 30-second observation/request
watchdog is an operational bound, not a latency target. Tests inject a benchmark-only watchdog authority and fire expiry
after actual request admission; real runs use native timers. It owns both socket sides and awaits forwarding cleanup.
After a failure it refuses reuse and late requests: a native SDK operation can remain unsettled without a cancellation
API. Partial method/role evidence is retained on failure. An unexpected route, acknowledgement, byte result, timeout, or
cleanup failure prevents timing. Preflight records go to stderr, leaving the existing native Mitata JSON report on
stdout. No throughput, latency, RSS, or regression budget is claimed until actual measured receipts exist.

`tests/provider-observer.test.ts` exercises large request and response bytes, literal paths and Host headers, consumer
cancellation, provider disconnection, forced expiry, poisoned reuse, terminal close during idle/request/response work
and admission overflow in the canonical Node and Bun suites. The separate `deno task test:provider-transport` permits
only the owned loopback network; the portable suite gains no network permission.
