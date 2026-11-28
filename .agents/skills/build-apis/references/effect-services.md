# Effect services and Layers

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [When to load this reference](#when-to-load-this-reference)
- [The three-channel model](#the-three-channel-model)
- [Service contracts with Context.Tag](#service-contracts-with-contexttag)
- [Layer construction](#layer-construction)
- [Composition rules](#composition-rules)
- [Typed domain errors](#typed-domain-errors)
- [Scope and finalizers](#scope-and-finalizers)
- [Configuration](#configuration)
- [Observability](#observability)
- [Hono integration](#hono-integration)
- [Testing](#testing)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions and version line](#deliberate-exclusions-and-version-line)

## When to load this reference

Load this reference when a service uses Effect or would materially benefit from
typed failures, explicit requirements, resource lifetime, interruption,
concurrency, retries, or replaceable implementations. Do not rewrite ordinary
pure helpers into Effect solely for stylistic uniformity.

## The three-channel model

Read `Effect.Effect<Success, Error, Requirements>` as three independent facts:

| Channel | Question | Example |
|---|---|---|
| Success | What value can this operation produce? | `Family` |
| Error | Which expected failures must a caller handle? | `FamilyNotFound | StoreUnavailable` |
| Requirements | Which capabilities must be provided? | `FamiliesStore | Tracer` |

Defects, invariant violations, and process-fatal conditions are not automatically
domain errors. Model expected recovery decisions in the error channel; preserve
unexpected defects as causes and handle them at an owned component.

## Service contracts with Context.Tag

Define a service around domain capabilities, not a concrete library:

```ts
import { Context, Effect } from "effect"

export interface FamilyServiceShape {
  readonly get: (
    scope: FamilyScope,
  ) => Effect.Effect<Family, FamilyNotFound | FamilyStoreUnavailable>
  readonly updatePreferences: (
    scope: FamilyScope,
    patch: PreferencesPatch,
  ) => Effect.Effect<Family, FamilyNotFound | PreferencesConflict>
}

export class FamilyService extends Context.Tag("app/FamilyService")<
  FamilyService,
  FamilyServiceShape
>() {}
```

Use stable globally distinctive tag identifiers. Keep the interface small enough
to fake in tests but coherent enough that callers do not assemble business
transactions from low-level store operations.

An implementation can depend on other services in its Layer construction:

```ts
export const FamilyServiceLive = Layer.effect(
  FamilyService,
  Effect.gen(function* () {
    const store = yield* FamilyStore
    const audit = yield* AuditService

    return FamilyService.of({
      get: (scope) => store.get(scope),
      updatePreferences: (scope, patch) =>
        store.updatePreferences(scope, patch).pipe(
          Effect.tap((family) => audit.record({
            actorId: scope.actorId,
            action: "family.preferences.updated",
            resourceId: family.id,
          })),
        ),
    })
  }),
)
```

The example is structural. Confirm the exact Effect version's `Context.Tag`,
`Layer.effect`, and service helper APIs before copying syntax.

## Layer construction

Select the constructor from the implementation's behavior:

| Need | Typical constructor | Lifetime |
|---|---|---|
| Constant fake/config | `Layer.succeed` | No acquisition |
| Effectful initialization without finalizer | `Layer.effect` | Layer build |
| Resource with cleanup | `Layer.scoped` | Scope-bound |
| Map one dependency into another | `Layer.effect`/service transformation | Layer build |
| Combine independent services | `Layer.merge` or `Layer.mergeAll` | Shared graph |
| Supply dependencies to a Layer | `Layer.provide`/`provideMerge` as appropriate | Build graph |

Do not construct a Layer inside a request handler. Layer memoization applies
within a build graph; rebuilding the graph per request can recreate pools,
clients, and background fibers.

```ts
export const DatabaseLive = Layer.scoped(
  Database,
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openDatabase(config.databaseUrl),
      catch: (cause) => new DatabaseStartError({ cause }),
    }),
    (database) => Effect.promise(() => database.close()),
  ),
)
```

If finalization can fail, decide whether shutdown records the failure, retries
within a bound, or fails the host. Do not silently discard cleanup errors.

## Composition rules

Compose from leaves toward the host:

```text
Config
  -> Log/trace exporters
  -> Database and external clients
  -> Stores/gateways
  -> Domain services
  -> Workflow clients
  -> HTTP handlers
  -> Host runtime
```

At every Layer construction point, answer:

- Which tags does it provide?
- Which tags does it require?
- Is it shared or request-scoped?
- What does it acquire and release?
- Which configuration has already been parsed?
- Can it start fibers, and who supervises them?

Use a single application Layer exported from the service's runtime module:

```ts
export const AccountsLive = Layer.mergeAll(
  FamilyServiceLive,
  PreferencesServiceLive,
  ImportClientLive,
).pipe(
  Layer.provideMerge(StoreLive),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(ObservabilityLive),
)
```

The exact dependency direction can differ. Typecheck the final graph and inspect
it for duplicate resource Layers rather than adding `provide` calls until the
type error disappears.

## Typed domain errors

Give expected errors stable discriminants and safe fields:

```ts
import { Data } from "effect"

export class FamilyNotFound extends Data.TaggedError("FamilyNotFound")<{
  readonly familyId: string
}> {}

export class PreferencesConflict extends Data.TaggedError("PreferencesConflict")<{
  readonly familyId: string
  readonly expectedRevision: number
}> {}
```

Translate errors once at the transport handoff:

```ts
const program = FamilyService.pipe(
  Effect.flatMap((service) => service.updatePreferences(scope, patch)),
  Effect.catchTags({
    FamilyNotFound: () => Effect.succeed(notFoundProblem),
    PreferencesConflict: (error) => Effect.succeed(conflictProblem(error)),
  }),
)
```

Do not collapse every failure into `Error`, stringify a `Cause`, or expose a raw
database/provider message. Preserve structured causes in redacted diagnostics.
Use retry schedules only for failures classified as transient; invalid input,
authorization denial, conflicts requiring user decisions, and deterministic
bugs should not retry blindly.

## Scope and finalizers

Use Scope when an operation owns a resource whose lifetime is smaller than the
whole process: transaction, temporary file, stream subscription, lease,
connection, or child fiber group.

```ts
export const withExportFile = <A, E, R>(
  use: (file: ExportFile) => Effect.Effect<A, E, R>,
) => Effect.scoped(
  Effect.acquireRelease(
    createExportFile,
    (file) => removeExportFile(file).pipe(Effect.orDie),
  ).pipe(Effect.flatMap(use)),
)
```

Finalizers run on success, typed failure, defect, and interruption. Still test
the actual host/runtime adapter: a hard process kill cannot execute in-process
finalizers, so durable leases and reconciliation must cover abandoned work.

Distinguish:

- host scope: pools, sinks, clients, worker supervisors;
- request scope: disconnect signal, request span, temporary resources;
- transaction scope: one atomic database unit;
- workflow activity scope: activity-local clients/temporary artifacts;
- stream scope: subscription, heartbeat, encoder, and cancellation listener.

## Configuration

Resolve config once at the host composition root. A Layer may consume a validated config
service, but should not independently reload `.env`, c12 files, or process env.

```ts
export class AccountsConfig extends Context.Tag("app/AccountsConfig")<
  AccountsConfig,
  z.output<typeof AccountsConfigSchema>
>() {}

export const AccountsConfigLayer = (input: unknown) =>
  Layer.succeed(AccountsConfig, AccountsConfigSchema.parse(input))
```

Keep secrets redacted. Record config provenance when operators need to explain a
resolved value, but never attach secret values to logs or traces. If c12/defu own
authoring and merging, they run before the Effect config value is provided; do
not create a second precedence system inside Layers.

## Observability

Effect provides logging, tracing, metrics, and OpenTelemetry integration. The
repository may use LogTape as its runtime transport. Integrate them through one
owned bridge or sink policy rather than emitting duplicate records through both.

Preserve these fields across HTTP, services, activities, and stores:

- trace/span and correlation IDs;
- actor, organization/tenant, and request IDs where policy permits;
- service/module/operation name;
- workflow/run/activity/attempt IDs when present;
- error tag and safe cause class;
- duration, retry count, outcome, and cancellation status.

Do not log the same failure in every layer. A lower layer should add structured
context to the error/cause; the owned component emits one diagnostic unless an
intermediate retry/compensation event is operationally meaningful.

## Hono integration

Choose one integration model:

| Model | Use when | Risk |
|---|---|---|
| Host `ManagedRuntime` | Many handlers execute Effects against one graph | Must dispose at shutdown |
| Explicit capability object in Hono context | Small service or gradual migration | Loses compile-time requirement graph at handler entrypoint |
| Effect-native HTTP platform | Whole host is designed for it | Larger framework change; do not mix casually with Hono |

For Hono with a host runtime:

```ts
const runtime = ManagedRuntime.make(AccountsLive)

app.use("*", async (c, next) => {
  c.set("runEffect", (effect) => runtime.runPromise(effect))
  await next()
})

const close = async () => {
  stopAdmission()
  await drainRequests()
  await runtime.dispose()
}
```

Connect request cancellation to Effect interruption when the runtime adapter
supports it. Do not let a disconnected upload, query, or SSE consumer continue
indefinitely by default.

## Testing

Provide small deterministic Layers:

```ts
export const FamilyServiceTest = Layer.succeed(FamilyService, {
  get: (scope) => Effect.succeed(familyFixture(scope.familyId)),
  updatePreferences: (_scope, patch) => Effect.succeed(updatedFamily(patch)),
})
```

Test:

- every typed error branch;
- missing Layer requirements as a compile-time or construction failure;
- resource acquisition exactly once;
- finalization on success, failure, and interruption;
- request cancellation interrupts owned work;
- retry policy excludes permanent errors;
- log/trace fields and redaction;
- a composed request through the production Layer graph with test resources.

## Failure signatures

| Signature | Likely cause | Correction |
|---|---|---|
| Pool count grows per request | Layer/runtime rebuilt in middleware | Build once at host root |
| `Effect<_, never, _>` around fallible I/O | Errors converted to defects or swallowed | Model expected failure channel |
| Every error becomes HTTP 500 | No tagged error mapping | Map expected tags to stable problems |
| Duplicate logs for one exception | Every Layer logs and rethrows | One diagnostic emission owner plus structured cause |
| Shutdown hangs | Unscoped fiber or missing finalizer | Supervise and bound drain |
| Test needs production env | Config/resource acquisition at import | Parameterized Layer/factory |
| `Layer.provide` maze compiles but creates duplicates | Graph assembled by trial and error | Inventory provides/requires and inspect sharing |
| Request abort has no effect | AbortSignal not connected to interruption | Add scoped cancellation bridge |

## Deliberate exclusions and version line

- Do not present Effect as durable persistence by itself. Ordinary fibers and
  retries disappear with the process.
- Do not put Hono `Context` into domain service interfaces.
- Do not use `Effect.catchAll` to turn every failure into success.
- Do not wrap an already managed pool with a finalizer that closes it per call.
- Do not mix multiple logging transports without an explicit routing owner.

The code examples follow the Effect 3 API family. Resolve the exact installed
Effect and integration package versions before copying signatures. Pin a tested
compatibility set for production use; a major-range import is not an exact pin.
The architecture applies across implementations, but the API syntax needs the
consumer's typecheck and lifecycle tests.

## Sources and freshness

- [Effect documentation](https://effect.website/docs/) and [Effect source](https://github.com/Effect-TS/effect) are the primary API references.
- [`@effect/workflow` 0.18.2 metadata](https://registry.npmjs.org/@effect/workflow/0.18.2) was rechecked 2026-11-26 for the versioned workflow example. Its Effect peer range is `^3.21.2`; it also declares RPC, Platform and Experimental peer dependencies.

This reference does not assert the latest release or a durable adapter. `Context.Tag`,
`Layer`, `ManagedRuntime`, Scope and workflow integration signatures are
version-sensitive. Verify the actual lockfile and public artifact.
