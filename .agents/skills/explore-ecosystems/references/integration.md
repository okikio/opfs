# Ecosystem integration procedure

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Preflight](#preflight)
- [Integration contract](#integration-contract)
- [Implementation sequence](#implementation-sequence)
- [Configuration and provenance](#configuration-and-provenance)
- [Lifecycle, errors, and observability](#lifecycle-errors-and-observability)
- [Data, generated artifacts, and packaging](#data-generated-artifacts-and-packaging)
- [Verification matrix](#verification-matrix)
- [Migration, rollback, and removal](#migration-rollback-and-removal)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference once component selection is evidence-backed and the task
authorizes implementation or a detailed implementation plan. It applies to
package adoption, replacement, adapter/plugin addition, framework integration,
service/database connection, or ecosystem migration.

## Outcome

Integrate a capability through every connected surface while preserving one
authority, explicit lifecycle, observable failures, package/deployment validity,
and rollback. A working import is the first checkpoint, not completion.

## Preflight

Before edits:

- confirm requested mutation scope and prohibited external actions;
- capture Git status and preserve user changes;
- locate nearest owning manifest, workspace root, package-manager/lock authority,
  runtime config, and repository instructions;
- record exact selected package/adapter versions, peers, integrity, and status;
- inspect existing imports/wrappers/adapters/config/schema/tests/generators;
- identify public API/config/data/deployment/package consumers;
- capture current passing/failing behavior and verification commands;
- write capability ownership before/after and rollback point.

Do not change lock/package manager, format Markdown, regenerate unrelated files,
or upgrade sibling packages simply because the integration touches a manifest.
If the selected exact versions cannot coexist, stop and revisit selection.

## Integration contract

Trace the full path:

```text
manifest + lock + integrity
  -> public import/export and local adapter
  -> authored config/source layers
  -> sparse merge/provenance
  -> schema validation/defaults
  -> runtime lifecycle owner
  -> domain/service call
  -> success/error/cancel/retry/recovery
  -> LogTape/metrics/traces or other observability owner
  -> generated/data/package/build/deploy surfaces
  -> clean consumer and operational verification
```

Write a local adapter when it owns project policy or isolates volatility:

```ts
export interface ArtifactStore {
  put(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  get(key: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  close(): Promise<void>;
}
```

The interface is not proof of any package API. Implement it from exact source
and translate upstream errors/status/lifecycle deliberately. Avoid speculative
methods for private or experimental adapters.

Define ownership:

- schema validates external/config/data shapes;
- adapter translates library/host mechanics;
- service/domain owns business policy;
- composition root creates/configures resources;
- lifecycle coordinator disposes/flushes;
- executable/deployment maps outcomes to host behavior.

## Implementation sequence

### 1. Add exact dependencies at the owning package

Use repository package-manager policy and frozen lock semantics. Classify runtime,
peer, optional, development, platform/native, and build-only dependencies. Do not
add a dependency to the root when only one workspace package imports it. Review
install scripts and package contents before execution when material.

### 2. Establish imports and local adapter

Import only public subpaths verified for the selected version. Prefer a narrow
adapter over upstream types throughout domain code when configuration, error,
lifecycle, or experimental status needs isolation. Reexport only intentional
public contracts.

### 3. Implement one vertical success slice

Connect config -> validation -> resource -> service -> output for the smallest
representative workflow. Use real observable behavior, not only mocks. This
exposes missing siblings/adapters before broad migration.

### 4. Implement failure/lifecycle slice

Add invalid config, unavailable dependency, timeout, cancellation, retry limit,
partial result, cleanup, and shutdown. Translate errors without discarding cause,
code, retryability, or provenance. Await asynchronous sink/client/worker disposal.

### 5. Update all connected surfaces

Types, tests, generated files, tasks, permissions, manifests, build/export maps,
docs examples, completion/config inspection, database migrations, deploy config,
health/readiness, observability, package contents, and release checks.

### 6. Remove duplicate owner only after cutover

Keep compatibility paths only for a bounded migration. Prove no consumers remain
before removing dependencies/config/tasks/data. Update lockfile and generated
artifacts through authoritative commands.

## Configuration and provenance

Keep source adapters sparse: CLI/env/config layers return only explicitly present
values. Merge using a documented order and field policy, then validate/apply
defaults exactly once. Track origin for diagnostics and `config show` behavior.

Example ownership:

```text
CLI patch > environment patch > project config > user config > defaults
```

This is an example; c12's exact source/layer order and custom merger orientation
must come from the selected version. Arrays often require explicit replace,
append, and prepend authoring objects rather than defu's generic concatenation.
No `$append`/`$replace` operation should reach runtime services.

For plugins/adapters:

- configuration belongs to the application owner, not process-global import
  side effects;
- secret values come from named secret providers/environment and are redacted;
- optional features have explicit enablement, capability check, and fallback;
- watchers/reload define atomicity, validation, previous-good-state, and disposal;
- effective config/provenance is inspectable without exposing secrets.

Do not add two configuration packages for the same concern merely because an
ecosystem offers its own config helper.

## Lifecycle, errors, and observability

Construct long-lived clients/sinks/workers in the composition root. Share or
scope according to upstream contract. Define startup ordering, readiness,
shutdown deadline, cancellation propagation, flush/dispose, and behavior after
partial startup.

Error table:

| Upstream condition | Local contract | Retry/recovery | Observable fields |
|---|---|---|---|
| invalid config/input | typed validation error before resource use | no retry | path/source/issues |
| auth/permission | typed authorization/dependency error | refresh/escalate by policy | target/status/correlation, redacted |
| transient network/service | typed unavailable/timeout | bounded idempotent retry | attempt/deadline/target |
| cancellation | cancelled outcome preserving reason | cleanup only | operation/duration |
| partial publish/write | partial-state result | reconcile/resume/compensate | completed/pending IDs |
| incompatible version/protocol | startup/preflight failure | upgrade/downgrade | exact versions |

Use one observability transport owner. Bridges/adapters should map upstream logs
into categories/properties without configuring a second global logger. Stable CLI
results remain isolated from diagnostics. Instrument retries, queue depth,
backpressure, recovery, and disposal where operationally meaningful. Do not log
credentials, cookies, tokens, raw personal data, or full config.

## Data, generated artifacts, and packaging

### Data and services

Define system of record, schema/migration owner, transaction scope, idempotency,
delivery, ordering, cursor/checkpoint, retention, backup/restore, reconciliation,
and destructive-operation authorization. An analytics projection is not a
transactional backup. A workflow service does not make arbitrary side effects
durable unless activities/idempotency/recovery are designed.

Test fresh schema, upgrade, rollback/forward-fix, concurrent operations, failure
after each durable commit point, and recovery from persisted state.

### Generated code/config/docs

Record source/generator/output ownership, exact version, check/write command,
provenance, and consumer test. Integrating Automd/Magicast/Giget or another
generator must not format unrelated Markdown or execute untrusted config.
Regenerate only owned outputs and inspect semantic diffs.

### Build/package/deployment

Update export maps, declarations, externals/peers, assets, permissions, engine
requirements, native/platform packages, container images, server adapters,
environment/secret declarations, health/readiness, and release manifests. Verify
from clean packed artifacts and actual target host. Workspace resolution can hide
missing dependencies and files.

## Verification matrix

| Level | Required proof |
|---|---|
| Static | exact imports, types, schemas, manifests, lock, exports, generated metadata |
| Unit/contract | adapter translations, config merge, errors, lifecycle, invariants |
| Targeted integration | selected exact components in a real fixture |
| Connected workflow | actual command/request/job/data path end to end |
| Consumer | clean pack/install/import/build/execute outside workspace |
| Operational | unavailable/timeout/cancel/retry/shutdown/recovery/rollback |
| Compatibility | supported runtime/renderer/driver/platform/version matrix |
| Security | permissions, trust, redaction, secret and destructive commit points |

Use representative assertions, not package keywords. Verify output/protocol/data
semantics. Record commands/results and distinguish passed, failed, blocked, and
not run. A registry delay, unavailable service credential, or absent target
platform is blocked evidence, not success.

Composition tests matter. When multiple skills/tools activate, assert one
repository discovery, one plan, one lifecycle/report owner, targeted reference
loading, and specialist verification. When multiple libraries compose, test the
seam, not only each in isolation.

## Migration, rollback, and removal

Define before cutover:

- compatibility window and public/data/config translation;
- primary authority during coexistence;
- backfill/dual-read/dual-write policy and reconciliation;
- feature flag/channel and stop condition;
- rollback revision/artifact/config/data and time limit;
- irreversible steps and required backup/authorization;
- removal inventory across code, deps, lock, config, secrets, tasks, docs, CI,
  data, deploy, alerts, and packages.

Rollback can mean restoring the previous application while leaving a forward-
compatible schema, not reversing every migration. Test the declared action. For
published packages, recovery normally means deprecate/supersede rather than
overwriting an immutable version.

## Failure signatures

| Signature | Likely integration gap | Next inspection |
|---|---|---|
| Import works, production fails | host/deploy/lifecycle not connected | exact target matrix |
| Config differs from expectation | layer order/array/default authority | sparse layers and provenance |
| Tests pass only in monorepo | undeclared dep/file/workspace alias | packed clean consumer |
| Logs duplicate or JSON corrupts | two transports/sink inheritance | observability/result ownership |
| Shutdown loses events/work | async dispose/flush not awaited | lifecycle coordinator |
| Adapter throws untyped library errors | translation layer missing | upstream failure contract |
| Analytics diverges from OLTP | delivery/checkpoint/reconciliation absent | authority and repair workflow |
| Generated diff rewrites docs | generator/formatter scope too broad | owned markers and check mode |
| Old dependency remains after cutover | connected surfaces not inventoried | full removal search/lifecycle |
| Rollback plan cannot restore state | irreversible commit point discovered late | migration backup/forward-fix |

## Deliberate exclusions

- Do not stop after installing/importing.
- Do not bypass existing wrappers/config owners without migration evidence.
- Do not call types or mocks an integration test.
- Do not run broad Markdown formatting or unrelated generation.
- Do not use duplicate log/config/data/migration/workflow owners indefinitely.
- Do not infer a private/experimental adapter API from a similar library.
- Do not mutate production, publish, rotate secrets, or destroy data without
  explicit authorization.
- Do not remove the old path before connected consumers and rollback are proven.

## Sources and freshness

- Attached production CLI guidebook v1.1 and config-resolution handoff, normative
  portable contract, sparse source, provenance, lifecycle, output, package, and
  verification patterns; verified 2026-07-13.
- Retained uploaded CLI, application, site, data, workflow, Better Auth, Undent and
  Wikitext codebases, observed connected integration/failure/generator/release
  behavior; verified 2026-07-17.
- Current exact-version primary source records for deep ecosystem references;
  verified 2026-07-17.

Recheck installed packages and target deployment/runtime before implementation.
Examples encode ownership patterns, not universal package APIs.
