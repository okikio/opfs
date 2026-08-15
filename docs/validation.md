Validation strategy
===================

The test architecture separates portable filesystem semantics from the runtimes and providers that supply concrete storage.
This is deliberate. A fast memory test should not be the evidence for browser OPFS interoperability, and a browser test should
not be the only evidence for a deterministic path or copy invariant.

The canonical layers are:

```text
node:test + @std/expect
    portable schemas, paths, facade behavior, record/object translations,
    ecosystem bridges, S3/Azure protocol behavior with deterministic fakes

real server runtimes
    Deno host filesystem
    Deno KV
    Node host filesystem + node:sqlite
    Bun host filesystem

Playwright Test
    Chromium / Firefox / WebKit
    Window / Worker / ServiceWorker / iframe / persistence / browser storage

Mitata
    raw backend baseline -> adapter primitive -> filesystem facade
```

A test states the contract it protects. Avoid tests that only mirror the current implementation line by line.

Portable tests protect filesystem semantics
-------------------------------------------

The portable suite uses `node:test` with `describe` and `it`, plus `@std/expect` for expectations. Deno runs these same source
files directly. Node runs the same source. Bun runs the same `node:test` API through `bun test`.

The suite covers:

- schema acceptance/rejection and Standard Schema exposure;
- canonical path normalization and root-escape rejection;
- file and directory handle semantics;
- replace, append, update, truncate, and byte-range behavior;
- staged writable close versus abort;
- stream cancellation after the operation becomes terminal;
- bounded stream materialization for simple record adapters;
- Deno KV partitioned large-file stat/list/range/stream behavior, bounded append/update patching, and manifest-last visibility;
- optimization-disabled differential paths and matching preflight plans;
- filesystem route/peak-buffer metrics;
- copy/move overwrite and source/destination overlap protection;
- file mutation versus structural mutation coordination;
- queued cancellation recovery;
- sync-file lock lifetime and partial-write looping;
- adapter disposal ownership;
- record-store semantics;
- generic object-store directories, ranges, streaming replacement, optimistic read-modify-write, and native copy;
- foreign object layouts where an exact file key and a child prefix coexist;
- unstorage forward and reverse integration;
- the generic reverse key-value driver and collision-safe keys;
- RxDB, db0 dialect, Drizzle, and direct SQLite translation;
- S3 Signature Version 4, XML list/error parsing, multipart commit preconditions, HTTP-200 embedded failures, multipart
  server-side copy, retry/backoff, timeout, manual redirects, one-shot body admission, and non-idempotent multipart lifecycle retry guards;
- Azure list/error parsing, large server-side range copy, bearer/SAS source authorization, provider request identities,
  retry/backoff, and one-shot/explicit no-retry behavior.

Focused commands:

```sh
deno task test:portable
deno task test:node
deno task test:bun
```

The deterministic stress run shuffles and repeats the portable suite so hidden test order does not become a dependency:

```sh
deno task test:stress
```

Runtime suites prove runtime adapters against the real API
----------------------------------------------------------

`tests/deno.test.ts` exercises the real Deno host filesystem adapter. `tests/node.test.ts` exercises real Node host filesystem
operations and runs the SQL bridge against Node's built-in SQLite engine. `tests/bun.test.ts` exercises the Bun adapter against
Bun's actual runtime.

Deno KV has a separate real integration test because current Deno requires the unstable KV flag:

```sh
deno task test:deno-kv
```

The adapter module is still type-checked with the server set. The unstable flag belongs to the real Deno KV execution, not to
unrelated package imports.

The normal server-runtime matrix is:

```sh
deno task test:deno
deno task test:deno-kv
deno task test:node
deno task test:bun
```

The pinned mise task runs these after installing the frozen dependency graph:

```sh
mise run test
```

GitHub Actions does not recreate this runtime setup with separate Node, Deno, and Bun setup actions. `jdx/mise-action` installs
the pinned mise release and only the tools required by the current job. The job then calls the same focused mise task a
maintainer can run locally, such as `mise run test-deno`, `mise run test-node`, or `mise run test-bun`. This keeps tool versions
and test commands in the repository instead of duplicating them in workflow YAML.

Playwright owns browser installation and browser lifecycle
---------------------------------------------------------

The browser suite lives under `tests/browser/`. There is no custom browser-launch loop or custom test-result protocol.
Playwright owns browser installation, contexts, server lifecycle, traces, retries, and test attribution.

Install the compatible browser builds, then run the matrix:

```sh
deno task test:browser:install
deno task test:browser
```

or:

```sh
mise run test-browser
```

The same semantic tests run in Chromium, Firefox, and WebKit. Tests probe runtime capability and then assert the actual result.
They do not encode statements such as "Firefox has no sync OPFS" or "WebKit always rejects this iframe" into the test logic.
Those are exactly the assumptions an interoperability suite is supposed to detect when browser behavior changes.

The browser cases include:

```text
Window
  OPFS probe
  async write/read
  abort before commit

DedicatedWorker
  async OPFS
  synchronous handle probe and open attempt

SharedWorker
  async OPFS through the actual SharedWorker realm

ServiceWorker
  black-box registration + postMessage in all browsers
  deeper serviceWorkers() instrumentation in Chromium only

iframes
  same-origin
  cross-origin
  opaque sandbox

storage lifecycle
  fresh BrowserContext isolation
  persistent profile close/reopen

browser record adapters
  localStorage
  IndexedDB
  Cache Storage
```

The iframe and ServiceWorker tests report unsupported runtime APIs as capability skips. A supported realm whose OPFS root is
rejected is not silently skipped; the test asserts that a normalized root failure is present.

Benchmarks measure overhead against the direct backend
------------------------------------------------------

A benchmark without a raw baseline cannot tell whether the adapter is fast or merely whether one code path is faster than
another OPFS code path. The benchmark layout therefore keeps three layers visible:

```text
raw backend
    |
    v
adapter primitive
    |
    v
FileSystemType
    |
    +-- coordination: none
    `-- coordination: local
```

`bench/memory.bench.ts` measures raw `Map`, direct `RecordStoreType`, direct memory adapter, and facade overhead. This exposes the
cost of record serialization separately from the higher-level filesystem contract.

`bench/node.bench.ts`, `bench/deno.bench.ts`, and `bench/bun.bench.ts` compare raw host filesystem reads/writes and copy with
the direct adapter and facade. Bun measures both Node-compatible `copyFile` and `Bun.write(destination, Bun.file(source))` so a
future adapter change has a runtime baseline instead of an assumption. `bench/deno-kv.bench.ts` does the same for real local Deno
KV, and `bench/sqlite.bench.ts` compares a raw SQLite BLOB row with the direct record adapter and facade. Metrics are disabled for
facade baseline measurements.

```sh
deno task bench:memory
deno task bench:deno
deno task bench:deno-kv
deno task bench:node
deno task bench:sqlite
deno task bench:bun
```

`mise run bench` runs the server/memory set with the pinned runtimes.

The browser benchmark keeps the raw browser API, direct adapter, and facade visible in each real browser. Native OPFS uses 25
replace/read iterations with a 64 KiB payload. localStorage, IndexedDB, and Cache Storage use 20 iterations with a 16 KiB
payload. Each sample records the raw, adapter, and facade durations plus the adapter/raw, facade/raw, and facade/adapter ratios
as a Playwright attachment.

```sh
deno task bench:browser
# or
mise run bench-browser
```

Microbenchmarks are evidence about overhead in the measured operation. They are not universal provider throughput numbers.
Object-store latency, geographical distance, TLS, provider multipart behavior, and connection reuse can dominate the small
client/facade cost.

`mise run bench-providers` uses the pinned SeaweedFS/Azurite fixture to compare official SDK/native runtime baselines with the
direct protocol clients, object adapters, and filesystem facade. S3 includes AWS SDK v3 and a Bun-native `S3Client` run; Azure
uses `@azure/storage-blob`. The small write baseline includes the same follow-up stat/properties request as the direct project
client, and multipart/block cases are separate. `metrics: "none"` versus `metrics: "basic"` makes instrumentation overhead
visible instead of hiding it. Real-cloud performance still requires an opt-in controlled provider benchmark.

Type, lint, format, and documentation gates stay separate
---------------------------------------------------------

`deno task check` type-checks the code in environment-focused groups so unrelated ambient globals do not accidentally make an
invalid target look valid:

```text
check:core
  root/core + provider-neutral adapters/clients + reverse drivers

check:browser
  Window/browser storage adapters + Playwright specs/config

check:workers
  DedicatedWorker / SharedWorker / ServiceWorker fixtures with WebWorker libs

check:server
  Deno / Deno KV / Node / Bun / SQLite adapters and server benchmarks

check:tests
  portable + runtime test source

check:deno-kv
  Deno KV test source with the unstable KV flag
```

The normal quality gates are:

```sh
deno ci
deno task check
deno task lint
deno task doc
deno task fmt:check
```

`deno ci` is important because the committed manifests and lockfile must describe one dependency graph. A changed dependency is
not ready for release until the real lockfile has been regenerated and the frozen install succeeds.

Release validation checks the artifact, not only the source tree
---------------------------------------------------------------

Before publication, the repository runs the complete source-level checks plus registry dry-runs. npm packaging uses Deno's
package output and then adjusts Drizzle from a normal generated dependency to the optional peer relationship authored by this
project.

The artifact gate should verify:

1. the public export map contains every intended subpath and no internal-only file;
2. the generated npm package has JavaScript/declarations that import in Node, Deno, and Bun;
3. browser-safe imports bundle without pulling server-only adapters into the root graph;
4. optional Drizzle remains optional until its subpath is imported;
5. package files exclude tests, benchmarks, coverage, temporary output, and repository-only tooling;
6. the extracted artifact passes the same checks that are meaningful after packaging.

The release command is:

```sh
deno task release:check
```

Browser tests and browser benchmarks remain explicit matrix jobs because downloading three browser engines is a large operation
and should not be hidden inside every local unit-test invocation.

Docker-backed provider tests
----------------------------

`mise run test-providers` starts the pinned SeaweedFS S3 endpoint and Azurite Blob emulator from `tests/provider/compose.yml`,
runs `tests/provider.test.ts`, and always removes the containers and volumes. The suite proves real HTTP/signing/interoperability
for the direct clients. It does not replace deterministic request-shape tests or real-cloud conformance. See
[providers.md](./providers.md) for the exact coverage and limitations. `mise run bench-providers` reuses the same containers for
the official-client/direct-client/adapter/facade benchmark matrix.
