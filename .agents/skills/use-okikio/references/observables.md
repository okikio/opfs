# `@okikio/observables` 1.4.0

## Contents

- Status and runtime support
- Core Observable contract
- Creation and consumption
- Operator families
- Error model
- EventBus and EventDispatcher
- Backpressure and pull consumption
- Resource lifetime and cancellation
- Custom operators and interop
- Selection guide
- Failure signatures
- Verification
- Sources and freshness

## Status and runtime support

JSR reports `@okikio/observables` 1.4.0 as the latest release on 2026-07-17. It is a TC39-inspired, Web-Streams-backed Observable implementation for Deno, Node, Bun, browsers, and workers. It has no runtime dependencies according to the published package page.

Pin the version before using exact behavior:

```ts
import { Observable, filter, map, pipe } from "jsr:@okikio/observables@1.4.0";
```

The npm-compatible package is also documented as `@okikio/observables`. Verify which registry produced the installed lockfile.

## Core Observable contract

An `Observable<T>` is cold by default: the subscriber body runs independently for each subscription. The observer receives `next`, `error`, and `complete`; subscription teardown runs once on unsubscribe, completion, error, abort, or disposal according to the source contract.

```ts
const ticks = new Observable<number>((observer) => {
  let value = 0;
  const id = setInterval(() => observer.next(value++), 1_000);
  return () => clearInterval(id);
});

using subscription = ticks.subscribe({
  next: (value) => consume(value),
  error: (error) => report(error),
  complete: () => finish(),
});
```

`observer.start(subscription)` runs before the subscriber body. If an attached signal is already aborted, `start()` still sees a closed subscription and the subscriber body is skipped.

Do not confuse cold Observables with an `EventBus`, which is hot and multicasts one event source.

## Creation and consumption

Confirmed creation/consumption surfaces:

- `new Observable(subscriber)` for an owned producer;
- `Observable.of(...values)` for fixed values;
- `Observable.from(...)` for supported promises, iterables, async iterables, array-like inputs, and objects implementing `Symbol.observable`;
- `subscribe(observer)`;
- `subscribe(next, error?, complete?)`;
- subscribe options with `AbortSignal` cancellation;
- `for await ... of observable`;
- `observable.pull(...)` for backpressure-aware async iteration;
- `using`/`Symbol.dispose` and async disposal.

Verify exact overloads from 1.4.0 types before wrapping third-party subscribables; `Observable.from()` is intentionally narrower than the interop helper.

## Operator families

Operators are tree-shakeable pipeline stages used through `pipe(source, ...operators)`, not prototype methods.

Published and documented families include:

| Concern | Confirmed operators/helpers |
|---|---|
| transform/filter | `map`, `filter`, `scan` |
| bounds/search | `take`, `drop`, `find`, `findIndex`, `first`, `elementAt` |
| flatten/concurrency | `mergeMap`, `concatMap`, `switchMap` |
| combination | `withLatestFrom`, `combineLatestWith`, `zipWith`, `raceWith` |
| identity/change | `changed`, `unique` |
| scheduling | `debounce`, `throttle` |
| errors | `catchErrors`, `ignoreErrors`, `mapErrors`, `tapError` |
| custom stages | `createOperator`, `createStatefulOperator` |
| native/foreign interop | `fromStreamPair`, `fromObservableOperator` |

`pipe()` in 1.4.0 supports up to 19 operators per call at the type level. Split longer chains into named, testable helpers.

Choose flattening semantics deliberately:

- `switchMap`: later input supersedes/cancels prior inner work; good for search;
- `concatMap`: preserve order and run one inner operation after another;
- `mergeMap`: permit concurrency; define a bound and output ordering expectation.

```ts
const results = pipe(
  searchInput,
  debounce(250),
  filter((query) => query.length >= 3),
  switchMap((query) =>
    pipe(
      Observable.from(fetch(`/search?q=${encodeURIComponent(query)}`)),
      map((response) => response.json()),
      catchErrors([]),
    )
  ),
);
```

Confirm that the underlying fetch receives a usable abort signal when cancellation must stop network work; switching an Observable is not proof that an unrelated Promise was aborted.

## Error model

The package's operator system has four modes:

| Mode | Behavior/intent |
|---|---|
| `pass-through` | thrown transformation failures become `ObservableError` values for later recovery; documented default |
| `ignore` | skip the failure/value path |
| `throw` | fail fast |
| `manual` | custom operator owns all error behavior; lowest overhead/higher responsibility |

This differs materially from RxJS-style terminal error assumptions. Built-in 1.4.0 operators use pass-through behavior by default. A failed mapping can continue as an `ObservableError` value until `catchErrors`, `ignoreErrors`, `mapErrors`, or `tapError` handles it.

Do not silently choose `ignore` for data ingestion. Decide whether one bad record is rejected, emitted as a typed result, stops the stream, or enters a dead-letter path. Preserve correlation and redacted diagnostics.

Custom operator:

```ts
const decode = createOperator<string, Record<string, unknown>>({
  name: "decode-json",
  errorMode: "throw",
  transform(value, controller) {
    controller.enqueue(JSON.parse(value));
  },
});
```

## EventBus and EventDispatcher

Use `EventBus<T>` for one hot typed channel:

```ts
using bus = new EventBus<ProgressEvent>();
bus.events.subscribe(updateProgress);
bus.emit({ stage: "parse", completed: 10 });
```

Use `createEventDispatcher<EventMap>()` for distinct typed event names:

```ts
interface AppEvents {
  signedIn: { userId: string };
  listUpdated: { listId: string };
}

const events = createEventDispatcher<AppEvents>();
events.on("listUpdated", ({ listId }) => refreshList(listId));
events.emit("signedIn", { userId: "user_123" });
```

Published docs also describe waiting for events. Inspect exact `waitForEvent` signature in the pinned types before use.

An in-memory bus is not durable, replayable, cross-process, transactional, or guaranteed delivery. Do not use it as a Temporal/queue/outbox replacement. It is appropriate for process-local fan-out and UI coordination.

## Backpressure and pull consumption

The library uses Web Streams internally. `pull()` exposes an async generator backed by a `ReadableStream`, allowing a slow consumer to apply backpressure rather than accumulating an unbounded callback queue.

```ts
for await (
  const batch of source.pull({ strategy: { highWaterMark: 8 } })
) {
  await persist(batch);
}
```

Backpressure is only end-to-end when the source observes demand or its buffering is bounded. DOM events, WebSockets, and external callbacks may continue producing. Define overflow policy: drop, latest, bounded buffer, pause upstream, spill, or fail.

Use callback subscription for low-cost push reactions; use `pull()`/async iteration when sequential async processing or producer pacing matters.

## Resource lifetime and cancellation

Teardown may be a cleanup function, subscription `unsubscribe`, `Symbol.dispose`, or `Symbol.asyncDispose`. It must run exactly once.

Every source must handle:

- synchronous subscriber throw;
- observer cancellation before setup completes;
- abort during async work;
- completion/error race;
- inner `switchMap` cancellation;
- early `for await` break;
- disposal of EventBus/dispatcher;
- timers/listeners/socket/readable stream cleanup.

Prefer scoped `using` when target runtimes/toolchains support it. Otherwise use `try/finally` or explicit unsubscribe. Test teardown counts; do not infer cleanup from types.

## Custom operators and interop

`createStatefulOperator` creates per-subscription state:

```ts
function movingAverage(size: number) {
  return createStatefulOperator<number, number, number[]>({
    name: "moving-average",
    createState: () => [],
    transform(value, state, controller) {
      state.push(value);
      if (state.length > size) state.shift();
      controller.enqueue(state.reduce((sum, item) => sum + item, 0) / state.length);
    },
  });
}
```

Use `fromStreamPair(() => new CompressionStream("gzip"))` to adapt readable/writable platform transforms.

Use `fromObservableOperator()` for RxJS operator functions. Standard RxJS operators need a `sourceAdapter`, commonly RxJS `from(source)`. Alias overlapping imports. The wrapper accepts a wider direct-subscribable result than `Observable.from()` and wraps synchronous subscription failures as `ObservableError` values.

Interop has cost and semantic risk. Verify cancellation, error, scheduling, hot/cold behavior, backpressure, and teardown across the handoff.

## Selection guide

| Need | Choose |
|---|---|
| one eventual value | Promise/Effect, not Observable |
| multiple push values with transformations | Observable pipeline |
| sequential async consumption with pacing | `pull()` / async iteration |
| process-local one-to-many channel | `EventBus` |
| typed named process-local events | EventDispatcher |
| durable/replayable cross-process event | queue/workflow/event log, not this package |
| existing Web TransformStream | `fromStreamPair` |
| isolated reuse of an RxJS operator | `fromObservableOperator` |

## Failure signatures

| Signature | Likely defect | Correction |
|---|---|---|
| interval/listener survives unsubscribe | source omitted teardown | return cleanup and assert once |
| old search response wins | merge/independent promises used | `switchMap` plus real abort propagation |
| memory grows under ingestion | push source outruns consumer | `pull`, bound, pause/drop/spill policy |
| error appears as ordinary value | pass-through mode not handled | add error operator or select `throw` |
| two subscribers duplicate request | cold source assumed hot | share through deliberate bus/cache owner |
| EventBus loses restart events | in-memory bus used durably | durable workflow/queue/outbox |
| RxJS stage leaks | interop teardown not propagated | lifecycle handoff test |
| typing fails at giant chain | over 19 operators/inference depth | split named pipelines |

## Verification

- test each cold subscription gets independent setup/state;
- assert cleanup once on complete, error, unsubscribe, abort, dispose, and early iterator return;
- test all four error modes with sync/async failures;
- test `switchMap`, `concatMap`, and bounded `mergeMap` ordering/cancellation;
- test backpressure/overflow under a fast producer and slow consumer;
- test EventBus/EventDispatcher hot multicast and disposal;
- test native stream and RxJS interop both directions;
- benchmark representative pipelines and retained memory in fresh processes;
- run Deno, Node, and browser compatibility checks required by the consumer.

## Sources and freshness

- Versioned reference: [JSR `@okikio/observables@1.4.0`](https://jsr.io/@okikio/observables/1.4.0) for lifecycle, operators, errors, events, streams and interop.
- Current package metadata: [npm `@okikio/observables`](https://registry.npmjs.org/@okikio/observables), rechecked 2026-11-26; it reports 1.4.0 and declared root/focused exports.

Consumer examples do not establish package APIs. This package remains separate from `okikio/utils`; `@okikio/context/state` composes it for state observation. Verify the resolved artifact and required runtime behavior before adopting undocumented scheduler, buffering or disposal assumptions.
