# Validation strategy

## Purpose

Validation follows the storage layers. A memory test is not evidence for browser OPFS interoperability. A fake HTTP test
is not evidence that an S3-compatible server accepts the request. A facade benchmark is not enough to identify whether
overhead came from the protocol client, driver, adapter, metrics, or provider.

The canonical model is:

```text
node:test + @std/expect
    schemas / paths / driver contracts / adapter translation / facade semantics
    deterministic S3/Azure protocol tests
    record/object/database contract tests

Deno / Node / Bun runtime tests
    actual host filesystem behavior
    Deno KV runtime behavior

Playwright Test
    Chromium / Firefox / WebKit
    Window / Worker / iframe / ServiceWorker / persistence

Testcontainers + node:test
    disposable SeaweedFS and Azurite provider interoperability

Mitata + Playwright benchmarks
    native/client -> driver -> adapter -> facade -> facade+metrics
```

## Repository command authority

Mise owns tool versions and repository commands.

```sh
mise install
mise run check
mise run test
mise run test-node
mise run test-deno
mise run test-bun
mise run test-browser
mise run test-providers
mise run bench
mise run bench-providers
mise run bench-browser
mise run bench-filesystem-clients
mise run quality
```

GitHub Actions owns only GitHub-specific orchestration: triggers, permissions, matrices, secrets, outputs, immutable
release refs, and calls into those mise tasks.

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

tests/ecosystems.test.ts
    unstorage / RxDB / db0 / Drizzle
    integration direction metadata
    real reverse unstorage bridge

tests/object.test.ts
    generic object driver -> object adapter -> facade contract

tests/s3.test.ts
    deterministic S3 REST/SigV4/multipart/copy/retry behavior

tests/azure.test.ts
    deterministic Azure REST/auth/block/copy/retry behavior

tests/deno-kv-partition.test.ts
    partition layout using an in-memory Deno KV contract double

tests/sqlite.test.ts
    direct SQLite row-driver behavior
```

A test should identify the contract it protects. Avoid tests that merely restate private implementation steps.

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
- manifest-last replacement never publishes a partial new generation.

The Deno-native suite uses the real Deno KV API when the runtime is available. It remains the release evidence for
actual serialization/provider behavior; the contract double does not replace it.

## Host filesystem runtime tests

Node, Deno, and Bun each run real host-file tests because a shared structural contract cannot prove runtime I/O
behavior.

The runtime suites cover the applicable routes:

```text
replace / append / update
ranges
native streams
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
instead of encoding a Chromium-only browser assumption.

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
mise run bench-filesystem-clients
```

The external mounts are intentionally not started inside the normal Testcontainers fixture. AWS Mountpoint and Azure
BlobFuse are FUSE/system clients with host privileges, installation, mount, and unmount lifecycle beyond a normal
application container. A dedicated benchmark runner can provision them and then call the same mise task.

Only comparable operations should be measured. Unsupported filesystem operations are capability differences, not
benchmark failures.

## Browser benchmarks

The Playwright benchmark compares raw native OPFS calls against the package's OPFS driver, adapter, and facade where
practical. Each browser result is separate. A result from one browser is not generalized to another engine.

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

`mise run quality` owns the Deno-centric release quality gate:

```text
frozen dependency install
strict check graph
lint
public documentation lint
format check
stress tests
coverage tests
JSR dry-run
npm/deno package dry-run
```

`mise run test`, browser tests, provider tests, and runtime matrix jobs add the environment-specific evidence.

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
