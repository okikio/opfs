# Lifetime, state, tasks and recorded work

## Choose by the required lifetime

| Need | Owner | Guarantee to verify |
| --- | --- | --- |
| Reverse-order owned cleanup | `@okikio/dispose` | All cleanup attempts and preserved failures |
| One close receipt shared by callers | `@okikio/dispose/once` | One callback and the same retained completion |
| Cancellation, deadline and clock | `@okikio/context` | Cooperative stop plus explicitly owned cleanup |
| A local current value and observations | `@okikio/context/state` | One writer; disposable read-only subscriptions |
| Save and reopen that value | `@okikio/context/state` with `@okikio/storage/state` adapters | Conditional save, conflict and uncertain-commit handling |
| Pause/resume/cancel one local operation | `@okikio/task` | Cooperative checkpoints; `done` after cleanup |
| Named checked work with resources and placement | `@okikio/activity` | Selected engine and its acceptance contract |
| Recorded steps and recovery | `@okikio/workflow` | Compatible history plus selected dispatch/storage |
| Bounded active work | `@okikio/scheduler` | Admission, cancellation and joining |
| Optional diagnostics | `@okikio/telemetry` | Observation without control of accepted results |

Use exact public paths from the [package map](packages.md). A package name,
Observable or local task receipt does not imply durable acceptance.

## Give cleanup one owner

`DisposableStack` and `AsyncDisposableStack` release in reverse registration
order. Repeated `disposeAsync()` calls return immediately once disposal has
started; use `once()` if callers must wait on the same pending cleanup.

```ts
import { once } from '@okikio/dispose/once';

let closes = 0;
const owner = once(async () => { closes += 1; });
const first = owner.close();
const second = owner.close();
console.log(first === second); // true
await first;
console.log(closes); // 1
```

This is a source-checkout example; [adoption](adoption.md) explains resolver
verification. Root and `/ponyfill` imports do not install globals. Explicit
`/polyfill` imports belong to hosts that need missing globals; they cannot add
`using` syntax to an older parser. `dispose.run()` bounds waiting per callback,
not the callback's actual execution.

An owned Context joins its cleanup. Its disposal Promise preserves cleanup
failure; `closed` signals that every registered cleanup was attempted. Borrowed
views carry values without granting ownership. Pass cancellation to cooperating
operations and join their actual work; stopping observation is not stopping I/O.

## Lend state without write authority

`state.create(initial)` returns a local cell with `set`, `update`, `batch` and
`reader`. Give consumers the reader, which exposes `get`, `revision`, `subscribe`
and an Observable of changes. Keep disposal and mutation with the cell's owner.

```ts
import * as state from '@okikio/context/state';

using progress = state.create({ completed: 0, total: 4 });
using percent = state.select(progress.reader, ({ completed, total }) => completed / total);
using display = percent.subscribe(({ value }) => console.log(value));
progress.update((value) => ({ ...value, completed: 2 })); // 0.5
```

Payloads are borrowed, not recursively frozen or proxied. Equality defaults to
`Object.is`; `batch` coalesces notifications without rollback. A projection owns
its subscriptions and must be disposed separately. Reuse the external
`@okikio/observables` operators for composition instead of creating a second
operator system. `@okikio/context/events` similarly observes borrowed event targets
without owning the socket, Worker or producer.

For saved state, use `state.open()` with an explicit store. `@okikio/storage/state`
provides memory storage; `/state/web` and `/state/postgres` provide other
adapters. Successful writes publish after storage acknowledgement. Reconcile
`ConflictError` and `CommitError` before retrying; Web Storage's single-writer
contract is not cross-tab atomicity. The stored cell borrows its store.

## Keep Task local and recovery explicit

`task.start(work)` returns a live handle. `pause()` takes effect at cooperative
checkpoints, `resume()` releases them, and `cancel()` acts through the lifetime
signal. `done` settles after Task cleanup. Injected resources remain borrowed.
A task cannot recover after process loss merely because it can be retried.

A Workflow definition declares ID, version, input/result contracts, activities
and dependencies. Its generator yields requests such as
`yield* activity.request(Definition, input, { key })`. The scheduler matches
requests against history, reuses compatible completions and admits new attempts
to dispatch. The selected executor/engine runs those attempts and records results.
The generator's JavaScript stack is not persisted.

Verify request keys, path identity, versions, input compatibility, bounded
parallelism, cancellation, failure and compensation rules. In-memory history
and dispatch survive only while their process lives. PostgreSQL adapters under
`@okikio/storage/workflow/postgres` support durable storage; actual integration
must still prove claims, fencing and replay-safe effects.

## Trace acceptance and crash windows

A memory callback, durable queue and transactional outbox make different promises.
Reuse a stable logical effect key across retries; an attempt number is not the
identity of the consequence. Verify each handoff from business mutation to
acceptance, claim to external effect, and effect to recorded completion.
An arbitrary external sink does not become exactly-once through a queue alone.

Test local cancellation and cleanup with explicit signals. For recovery claims,
exercise replay, changed inputs/versions, duplicate and stale claims, provider
failure, the relevant crash window and a fresh process owner. Use the actual
storage adapter for transaction/fencing claims. Detailed recovery design belongs
to [build-workflows](../../build-workflows/SKILL.md).

## Sources and freshness

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[disposal](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/dispose/ponyfill.ts),
[joined close](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/dispose/once.ts),
[Context](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/context/types.ts), [state](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/context/state.ts),
[Task](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/task/mod.ts), [Workflow](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts), and
[storage](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/package.json). Source exports were inspected;
this reference does not claim registry publication or a database recovery test.
