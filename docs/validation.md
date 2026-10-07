# Validation strategy

## Purpose

Validation follows the storage layers. A memory test is not evidence for browser OPFS interoperability. A fake HTTP test
is not evidence that an S3-compatible server accepts the request. A facade benchmark is not enough to identify whether
overhead came from the protocol client, driver, adapter, metrics, or provider.

Deno is the primary project runtime and the primary release authority. Portable tests still use `node:test` and
`@std/expect` because Deno can run those test contracts directly. Node and Bun are compatibility targets; a Node- or
Bun-specific type extension must not redefine the public core contract that Deno checks.

The canonical model is:

```text
Deno check + Deno test
    primary type and runtime authority
    schemas / paths / driver contracts / adapter translation / facade semantics
    deterministic S3/Azure protocol tests
    record/object/database contract tests
    Deno filesystem and Deno KV behavior

Node / Bun compatibility tests
    same portable contracts where supported
    actual runtime-specific host filesystem behavior

Playwright Test
    Chromium / Firefox / WebKit
    Window / Worker / iframe / ServiceWorker / persistence

Testcontainers + node:test
    disposable SeaweedFS and Azurite provider interoperability

Mitata + Playwright benchmarks
    native/client -> driver -> adapter -> facade -> facade+metrics
```

## Repository command authority

Deno tasks own repository commands. Install the required runtimes directly, or use Mise for optional provisioning.

```sh
deno task deps:ci
deno task check:ci
deno task test:all
deno task test:node
deno task test
deno task test:bun
deno task test:browser:install && deno task test:browser
deno task test:providers
deno task bench:all
deno task bench:providers
deno task test:browser:install && deno task bench:browser
deno task bench:filesystem-clients
deno task quality
```

GitHub Actions owns only GitHub-specific orchestration: triggers, permissions, matrices, secrets, outputs, immutable
release refs, and calls those same Deno tasks. Mise can provision runtimes and delegates to the Deno graph.

## Portable tests

Portable tests use `node:test` with `describe`/`it` and `@std/expect`. Deno and Node consume the same TypeScript source.
Bun uses the same test contracts where its runner/runtime supports them.

Important portable suites:

```text
tests/path.test.ts
    canonical path parsing / root escape / names

tests/driver.test.ts
    driver definition validation
    requirement/limit provenance
    behavior-changing optimization disableability
    direct third-party driver planning

tests/memory.test.ts
    deterministic record driver/adapter/facade behavior

tests/filesystem.test.ts
    locks / staged writes / copy / move / cancellation / lifecycle
    queued Web Locks abort normalization / cross-realm package errors
    authoritative stream failure when reader cleanup also rejects

tests/request.test.ts
    shared HTTP retry / zero-delay policy / single-attempt bypass
    deterministic preparation failures / transport retry / attempt timeout

tests/chunk.test.ts
    exact byte chunking / early consumer return / stalled-source cancellation
    admitted provider work drains before source failure; independent rejection values remain intact

tests/benchmark.test.ts
    native sample/statistic validity / complete declared lifecycle observations
    all owned releases run; cleanup preserves primary and independent failures

tests/ecosystems.test.ts
    unstorage / RxDB / db0 / Drizzle
    integration direction metadata
    real reverse unstorage bridge
    real Drizzle SQLite-proxy query builder over a deterministic test transport

tests/object.test.ts
    generic object driver -> object adapter -> facade contract
    provider-safe private directory-marker metadata

tests/s3.test.ts
    deterministic S3 REST/SigV4/multipart/copy/retry behavior

tests/azure.test.ts
    deterministic Azure REST/auth/block/copy/retry behavior
    metadata contract validation before provider I/O

tests/deno-kv-partition.test.ts
    partition layout using an in-memory Deno KV contract double
    in-flight generation reads / optimistic stale-writer rejection / bounded collection

tests/host.ts
    shared Deno / Node / Bun range and directory-mutation conformance scenario
    real host APIs rather than memory-record behavior

tests/sqlite.test.ts
    direct SQLite row-driver behavior
```

A test should identify the contract it protects. Avoid tests that merely restate private implementation steps.

Use exact assertions for public bytes, canonical paths, protocol signing, complete result sets, and stable machine error
fields. Prefer those fields over human-readable error prose. Generated annotations, private counters, and incidental
completion order should not decide whether a consumer behavior works.

Register cleanup as soon as the fixture acquires a resource. `try/finally`, asynchronous disposal, and `node:test`
lifecycle hooks keep assertion failures from leaking a filesystem, stream, mock, or database. Test-scoped mocks restore
their patched methods automatically; shared global trackers require explicit reset. Use explicit source pull/open
signals to coordinate active cancellation, rather than guessing that one microtask or a short sleep reached the desired
state.

Portable filesystem fixtures use `withFileSystem()` from `tests/reliability.ts` to await public `close()` after the test
body. It preserves an original rejection, including `undefined`, beside any independent close failure. This keeps the
same ownership contract on Node 22, whose direct TypeScript runner cannot parse `await using`; newer-runtime syntax must
not prevent a supported runtime from reaching its behavior assertions.

The [Node test documentation](https://nodejs.org/api/test.html) and
[standard-library expectations](https://jsr.io/@std/expect/doc) describe the available lifecycle and structural
assertion tools. Use them where they clarify the contract; a protocol double remains appropriate when its counters and
bytes are the independent oracle across runtimes.

## Permanent fixtures and local evidence

| Input                                     | Owner and repeatable lane                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tests/reliability.ts`, `tests/host.ts`   | Shared behavioral scenarios imported by the memory and native filesystem suites.                                                    |
| `tests/browser/fixtures/`                 | Actual realms and storage operations driven by Playwright specs through `deno task test:browser:install && deno task test:browser`. |
| `tests/ecosystem/live.mjs`                | Pinned upstream database/unstorage consumers through `deno task test:ecosystems`.                                                   |
| `tests/provider/fixture.ts`               | Testcontainers resources borrowed by provider tests and benchmarks.                                                                 |
| `tests/provider/fuse*`, `Dockerfile.fuse` | Mountpoint/BlobFuse correctness and measurement through `deno task test:filesystem-clients`, in isolated Linux containers.          |
| `tests/package/verify.mjs`                | Clean installed archive consumers through `deno task verify:npm`.                                                                   |
| `.mise/tasks/linux.mjs`                   | Named, bounded containers for `deno task test:linux`; failed lanes retain diagnostics and clean up independently.                   |
| `bench/`                                  | Durable workload definitions; each result needs its semantic oracle and measurement conditions.                                     |

Slower provider, browser, ecosystem, FUSE, package, and Linux lanes remain reusable tests even though they are not run
by every portable-suite invocation. Keep their definitions visible. Generated configurations, reports, timings, and
dated investigations belong under ignored `.tmp/`, package output under `.release/`, and assistant-only support under
`.agents/`. The npm task uses `--no-lock` for its separate build-tool configuration; `scripts/deno.lock` is local
resolver output rather than a second dependency authority. The repository's `deno.lock` remains visible.

## Driver tests

A driver is a public extension seam and therefore receives direct tests before an adapter exists.

The generic suite proves:

- structured requirements are retained;
- provider, implementation, user, and probe limits keep their provenance;
- an optimization with `changesBehavior: true` cannot declare `disableable: false`;
- driver planning can reject a known impossible input without storage I/O;
- structured problems/actions are stable machine data.

Backend-specific driver tests then protect physical rules. Deno KV is the most important reference because byte size,
path/key size, partition policy, and provider ceilings all affect admission.

## Deno KV validation

The portable Deno KV partition suite uses a deterministic contract double. It proves:

- no stored test value crosses the documented serialized value ceiling enforced by the double;
- conservative `partBytes`/`inlineBytes` safety budgets reject unsafe configuration;
- a long physical key is rejected during driver preflight before provider I/O;
- `partition: "never"` returns structured `change-policy`/`select-driver` actions for oversized input;
- large logical files reconstruct exactly;
- directory listing does not load file body parts;
- range reads touch only overlapping parts;
- streamed replacement uses bounded partition writes without facade buffering;
- disabling the facade stream-write optimization forces the bounded facade fallback;
- append/update preserve untouched bytes;
- an in-flight reader can finish against the immutable generation it resolved before an overwrite;
- a versionstamp check rejects a stale writer after another writer changes the logical entry;
- failed stale publication removes its unpublished physical generation;
- manifest-last replacement never publishes a partial new generation.

The Deno-native suite uses the real Deno KV API when the runtime is available. It remains the release evidence for
actual serialization/provider behavior; the contract double does not replace it.

## Host filesystem runtime tests

Node, Deno, and Bun each run real host-file tests because a shared structural contract cannot prove runtime I/O
behavior.

The runtime suites cover the applicable routes:

```text
replace / append / update
ranges, including zero-length and multi-chunk ranged streams
native streams
empty and recursive directory removal
emptyDir with nested directories
overwrite copy/move onto directory destinations
native copy
native move
asynchronous positional files
sync random access
flush
close/disposal
cancellation
```

Bun tests also verify the Bun-specific read/replace route rather than only the Node-compatible fallback.

## Browser tests use Playwright

Playwright owns browser lifecycle and cross-browser orchestration. The matrix covers Chromium, Firefox, and WebKit
instead of encoding a Chromium-only browser assumption. Playwright starts a web-server command from the configuration
directory by default, so each Vite command explicitly serves the repository root. `webServer.url` then probes concrete
fixture HTML that returns a readiness status instead of probing a root with no `index.html`.

Browser cases include:

```text
Window async OPFS
DedicatedWorker
SharedWorker
ServiceWorker observable behavior
same-origin iframe
cross-origin iframe
opaque sandbox iframe
persistent/reopen behavior
browser record adapters
locking/cancellation where the browser exposes the capability
```

Synchronous OPFS access is probed from the actual realm/handle. A test does not infer support from browser name or
worker type.

Playwright's deeper ServiceWorker instrumentation is browser-specific, so cross-browser service-worker tests use a
page-owned registration/message path when direct runner instrumentation is unavailable.

## Provider tests use Testcontainers

`tests/provider/fixture.ts` owns disposable provider services through Testcontainers.

```text
ProviderFixture
  |
  +-- SeaweedFS S3-compatible endpoint
  `-- Azurite Blob endpoint
```

Testcontainers selects mapped host ports and owns readiness/disposal. The repository does not keep a parallel Docker
Compose, fixed-port, curl-polling lifecycle.

Provider tests exercise:

```text
protocol client
  -> provider

driver
  -> client/provider

adapter
  -> driver

FileSystemType
  -> adapter
```

The provider suite proves interoperability with SeaweedFS/Azurite. It does not redefine Amazon S3 or Azure Blob
specifications. Deterministic protocol tests continue to protect exact signing, conditions, limits, and error parsing.

## Stress and lifecycle tests

`test:stress` runs the portable suite repeatedly with a fixed shuffle seed. Its purpose is to expose ordering, lock,
cleanup, and state-sharing defects that one deterministic order can hide.

Lifecycle-sensitive code must test:

- successful cleanup;
- cleanup after failure;
- caller cancellation;
- post-open stream cancellation;
- close exactly once;
- abort exactly once;
- use after close/abort;
- ownership transfer versus borrowed resources;
- cleanup with a separate signal when the caller signal is already aborted.

## Coverage

Coverage is useful evidence, not architectural proof. The coverage task exists to find unexecuted branches in portable
code. A high line percentage does not prove that provider limits, cancellation, or resource ownership are correct.

The portable coverage report does not execute every runtime-only Node, Deno, or Bun driver branch. Read its percentages
together with the separate host runtime suites. This distinction is important for operations whose native APIs differ
from the memory model, such as empty-directory removal and ranged-stream resource ownership.

## Benchmarks measure each layer

Every benchmark should identify the cost added by one layer.

For an object protocol:

```text
official/native SDK baseline
          |
project protocol client
          |
project object driver
          |
project object adapter
          |
FileSystemType metrics:none
          |
FileSystemType metrics:basic
```

For a host/native filesystem:

```text
raw runtime filesystem API
          |
project file driver
          |
project file adapter
          |
FileSystemType
```

For memory/record storage:

```text
raw Map/value structure
          |
record driver
          |
record adapter
          |
FileSystemType
```

The benchmark result should include throughput/latency plus semantic context. A faster route is not a valid substitute
if it has different supported operations, consistency, atomicity, or caching semantics.

Each workload needs a consumer question, an independent output oracle, and a declared baseline. Native byte storage and
encoded record storage expose different physical work; their layer comparison measures that extra contract rather than
claiming identical representations. Keep setup outside timing and consume the complete result inside it. Microbenchmarks
can locate primitive costs, while composed replace/read, query, and cancellation scenarios show their practical impact.

The Node and Deno benchmark tasks expose the collector so Mitata's requested GC policy is effective on each runtime.
Retain raw distributions, sample counts, runtime and dependency identities, fixture sizes, concurrency, GC policy and
cache conditions. Shared-host measurements are observations, not hard performance gates. `bench/report.ts` saves running
and failed results under ignored `.tmp/reports/bench/`, rejects empty or invalid samples, and hashes its source and
fixture inputs before and after collection. Changed inputs invalidate the report.

Mitata 1.0.34 records nonnegative heap deltas observed across batches and normalizes them by batch size. These are not
total allocations, retained memory or RSS. A zero observation count with null aggregates means that heap data is
unavailable; it does not mean zero bytes were allocated. Optional heap and GC fields must have the pinned shape, finite
nonnegative values and consistent bounds when present. Missing optional fields remain valid.

The default GC policy collects once after warmup. Inner GC collects before and after each batch; its reported GC time
measures the explicit collection after the batch in nanoseconds per collection, without per-operation normalization.
That observation is separate from operation latency. Natural collection inside timed operations remains part of their
measured cost.

The lifecycle workload samples RSS during source pulls. Its timings include that instrumentation, and its
active-resource observations are not an open-file census. These finite runs can expose growth or failed reuse; they
cannot establish unbounded leak freedom or crash durability.

### Operational costs and budgets

Choose budgets for the application workload, then compare the same payload, operation, layer and environment. The
measurements below have different ownership and observation scopes:

| Observation                                                    | What it measures                                                                               | What it does not measure                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Facade `operations.*.bytes`                                    | Payload bytes attributed to logical operations at the facade.                                  | HTTP headers, retries, TLS traffic or provider-internal copy traffic.                                         |
| Facade `bufferedBytes` / `peakBufferedBytes`                   | Temporary stream materialization owned by facade fallbacks.                                    | Client multipart buffers, source buffers, runtime heap or RSS.                                                |
| S3/Azure driver `requests`, `retries`, `responses`, `failures` | Concrete Fetch attempts, additional attempts, responses and terminal logical request failures. | Network byte volume or cloud billing totals.                                                                  |
| S3/Azure timing `durationMs`                                   | Time inside Fetch until a response or rejection is received.                                   | Later response-body consumption, the full logical operation, CPU utilization or service-only processing time. |
| Lifecycle RSS / active-resource samples                        | Process memory at declared sampling points and runtime-reported active resource kinds.         | A continuous memory maximum, exact open descriptors or every provider resource.                               |
| Mitata timing / optional heap and GC samples                   | Operation latency and the pinned collector observations described above.                       | Full allocation accounting, CPU time or network traffic.                                                      |

The optional driver fields `logicalBytes`, `physicalBytes`, `parts` and `peakActive` are not currently populated by the
first-party S3/Azure drivers. Missing observations remain absent; they must not be reported as zero or inferred from
logical payload size. Current OPFS benchmark reports record CPU model and runtime identity, rather than process CPU
time. Provider and mounted-client throughput comparisons therefore answer elapsed-time questions for their measured
operations; they do not establish CPU, traffic or billing budgets.

`maxBufferedWriteBytes` bounds the facade fallback that materializes a stream. Provider part/block sizes and upload
concurrency control a different layer's work admission and buffering. Record all three with a workload before choosing a
deployment memory budget. Exact-byte checks, caller cancellation, drained cleanup and successful reuse remain
correctness requirements even when an application accepts a slower or larger operation. Latency, RSS and request-count
targets belong to that workload and deployment; this package does not invent a universal provider-health threshold.

## Provider benchmarks

`bench/provider.bench.ts` uses the Testcontainers provider fixture and compares:

S3:

```text
AWS SDK
project S3 client
project S3 driver
project object adapter
facade metrics:none
facade metrics:basic
```

Azure:

```text
Azure SDK
project Azure client
project Azure driver
project object adapter
facade metrics:none
facade metrics:basic
```

`bench/bun-provider.bench.ts` also compares Bun's native S3 client against the same project layers when Bun is
available.

Provider container startup/readiness happens before measured samples. Container pull/start time is not benchmark data.
Large-upload comparisons align part size, concurrency, retries and body consumption with the official SDK. Varied bytes
must survive the complete round trip before timing starts. Loopback SeaweedFS/Azurite measurements isolate protocol and
layer costs; cloud network latency and service policy require their own workload.

## Filesystem-client baselines

`bench/filesystem-provider.bench.ts` compares already-mounted provider filesystem clients through the same local-file
staircase:

```text
raw mounted path
  -> Node file driver
  -> file adapter
  -> FileSystemType
```

Environment variables select mounted roots:

```sh
OPFS_MOUNTPOINT_S3_ROOT=/mnt/s3 \
OPFS_BLOBFUSE_ROOT=/mnt/azure \
deno task bench:filesystem-clients
```

The external mounts are intentionally not started inside the normal Testcontainers fixture. AWS Mountpoint and Azure
BlobFuse are FUSE/system clients with host privileges, installation, mount, and unmount lifecycle beyond a normal
application container. A dedicated benchmark runner can provision them and then call the same Deno task.
`deno task test:filesystem-clients` builds the checked-in client image and acquires both disposable mounts;
`deno task bench:filesystem-clients:container` uses that same acquisition for measurement.

Only comparable operations should be measured. Unsupported filesystem operations are capability differences, not
benchmark failures.

The isolated filesystem-client lane requires both mounts. Correctness uses local coordination and explicit admission
signals; performance disables that coordination to expose the mounted-path layer costs. Timed creates use bounded
namespaces, and cleanup suppresses only declared unsupported operations. Filesystem caches and write acknowledgement
remain distinct from remote durability.

## Browser benchmarks

The Playwright benchmark compares raw native OPFS calls against the package's OPFS driver, adapter, and facade where
practical. Each browser result is separate. A result from one browser is not generalized to another engine.

The reports retain nine rotated batches per layer, both batch totals and averages per operation, and the iteration count
used to convert them. These batch averages are not individual-request tail latency. Native OPFS retains a file handle
while the higher layers resolve a path, so that comparison includes path lookup. Unsupported storage is reported as a
capability skip.

## Metrics cost is measurable

Facade metrics support:

```text
none
basic
timing
```

`none` is the instrumentation baseline. `basic` records counters without per-operation timing. `timing` adds monotonic
clock work. Benchmarks keep those modes separate so metrics overhead cannot hide inside the main facade result.

Driver physical metrics are also distinct from facade metrics. S3/Azure request/retry/part work should not be inferred
from one logical filesystem write.

## Quality gate

`deno task quality` owns the Deno-centric release quality gate:

```text
frozen dependency install
strict check graph
lint
public documentation lint
format check
stress tests
coverage tests
JSR dry-run
npm package build and local tarball
```

`deno task test:all`, browser tests, provider tests, and runtime matrix jobs add the environment-specific evidence.

### Browser platform type conformance

OPFS uses structural source types so Node, Deno, and Bun do not need browser File System Access globals merely to import
the package. That makes browser type conformance an explicit validation responsibility rather than an ambient compiler
assumption.

`tests/browser/opfs-types.ts` is checked with the Window browser graph. It proves TypeScript's native
`FileSystemDirectoryHandle`, `FileSystemFileHandle`, `FileSystemWritableFileStream`, and the return type of
`StorageManager.getDirectory()` satisfy the package contracts. It also proves `nativeRoot` preserves the caller's exact
native handle type.

`tests/browser/fixtures/opfs-worker-types.ts` performs the worker-side proof. It covers the worker-only
`createSyncAccessHandle()` route and the synchronous access-handle contract.

`deno task check:typescript:opfs` runs both files through the project's installed `typescript` package with separate DOM
and WebWorker `tsconfig` files. The normal `deno check` browser graphs still run as well. This intentionally gives the
project two independent declaration checks: Deno's runtime checker and the TypeScript version pinned in `deno.lock`.

These files are compile-only checks. Playwright remains responsible for proving the corresponding APIs behave correctly
in real Chromium, Firefox, and WebKit environments.

## Agent validation

A ChatGPT/agent host can lack Deno, Bun, Docker, mise, package registry access, or Playwright browsers. Temporary
validation support belongs under `.agents/` and never becomes production code.

Allowed fallback rules:

1. Keep production source Deno/browser/server-native.
2. Use the installed Node.js/TypeScript toolchain for supplemental strict checks.
3. Add narrow `.agents/` declarations/stubs only for dependencies unavailable in the host.
4. Do not change production imports merely to satisfy the agent host.
5. Report missing canonical runtime gates explicitly.

A validation-only type stub can prove project TypeScript structure. It cannot prove the external dependency's real
runtime or full type contract. Release CI must run against the actual dependency graph.

## Artifact verification

Before delivering a modified ZIP:

1. run every available strict/type/behavior/configuration check on the working tree;
2. inspect stale exports/imports and documentation terminology;
3. inspect package exports and publish payload;
4. remove generated validation/build dependency state;
5. create the ZIP;
6. extract that exact ZIP to a clean directory;
7. recreate only validation-side host declarations if needed;
8. rerun the available checks against the extracted artifact;
9. compare source/extracted file lists;
10. record SHA-256.

The extracted artifact is the final thing that must pass the claimed checks. A green mutable working tree is not enough.

## Release evidence

A release-ready claim requires all applicable canonical gates, including Deno, Node, Bun, Playwright, provider
containers, package dry-runs, and lockfile validation. If the current host cannot run one of those environments, the
result is recorded as unverified rather than passed.

## Publication type and package gates

Schema-derived public contracts are checked before the ordinary type graph:

```sh
deno task schema:check
deno task check
```

Release validation keeps JSR and npm independent:

```sh
deno publish --dry-run
RELEASE_VERSION=0.0.0-test deno task pack:npm
node tests/package/verify.mjs .release/npm/*.tgz
```

The npm consumer test installs the produced tarball with ordinary npm and rejects `@jsr/*` dependencies, raw `.ts`
implementation files, missing declarations, or a non-optional Drizzle peer.
