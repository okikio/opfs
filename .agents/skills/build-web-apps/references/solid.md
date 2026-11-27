# Solid and Solid Primitives

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Contents

- Reactive ownership
- Components and control flow
- Effects and external systems
- SSR and hydration
- Cleanup and roots
- Solid Primitives ecosystem map
- Selection procedure
- Scheduling and global event coordination
- Motion and presence lifecycle
- Failure signatures
- Verification
- Sources and freshness

## Reactive ownership

Solid executes a component function once to create a reactive graph. It does not rerun the component on every state change. Preserve accessors and ownership:

| Need | Owner | Avoid |
|---|---|---|
| mutable scalar/local value | `createSignal` | mutable untracked local variable |
| derived value | `createMemo` or inline accessor | effect that writes another signal without need |
| list keyed by identity | `<For>` / keyed primitive when necessary | React-shaped `.map()` assumptions |
| index-keyed list | `<Index>` when values change but positions are stable | using it for reordered identity lists |
| conditional subtree | `<Show>`, `<Switch>/<Match>` | eager branch evaluation |
| async resource | resource/query owner selected from data semantics | duplicate signal plus fetch effect |
| external synchronization | `createEffect`/`onMount` with cleanup | effects as general computation |

Props are live access paths. Do not destructure reactive props casually:

```tsx
function Counter(props: { count: number }) {
  const doubled = createMemo(() => props.count * 2);
  return <output>{doubled()}</output>;
}
```

Use `splitProps`, `mergeProps`, or relevant `@solid-primitives/props` helpers when adapting component APIs. Verify which properties must remain getters.

## Components and control flow

Components own composition, not rerender cycles. Pass children with Solid's `children()` helper when access may need normalization or repeated evaluation. Avoid reading a conditional child before its owner branch exists.

For lists, make identity explicit. A data grid may need row IDs independent of page position. A keyed wrapper is useful only when the default control flow does not preserve the required reconciliation behavior.

Events use native event semantics. Prefer delegated JSX handlers for common bubbling events; use explicit event listeners when target, capture/passive options, or non-delegated events require them.

## Effects and external systems

Use effects for synchronization with APIs that exist outside Solid:

- DOM methods not expressible declaratively;
- storage/history synchronization;
- canvas/WebGL/animation runtime updates;
- subscriptions and external event sources;
- imperative third-party widgets.

Read dependencies intentionally. Use `on(...)` or `untrack(...)` only when the dependency contract demands it. A self-triggering effect usually indicates derived state or ownership is misplaced.

Every effect that starts a resource needs a teardown or a resource whose primitive registers teardown automatically.

## SSR and hydration

Server and first client render must agree. Guard browser globals, measurements, random values, current time, storage, media queries, and feature detection behind an SSR-aware primitive or mount scope.

Do not create shared singleton state at module scope in SSR. It can leak one request's state into another. The uploaded Solid Primitives `rootless` package marks hydratable singleton behavior experimental; inspect the installed version before depending on it.

For viewport/media-dependent UI, render a deterministic usable default and enhance after hydration. Avoid hiding the entire page until `onMount` solely to silence a mismatch.

Test streaming SSR, direct navigation, client navigation, and repeated route mounting. Development mode may not reproduce production hydration ordering.

## Cleanup and roots

Solid ownership automatically disposes registered cleanup when a component/root goes away. It does not clean resources that were created outside the owner or never registered.

Dispose:

- listeners and observers;
- intervals/timeouts/idle callbacks;
- animation frames and motion values;
- `AbortController`s and network streams;
- WebSocket/SSE subscriptions;
- workers and message channels;
- external stores and observable subscriptions;
- retained subroots/singletons;
- result objects holding native resources.

`@solid-primitives/rootless` provides patterns such as `createDisposable`, `createSubRoot`, `createCallback`, and `createSingletonRoot`. Use them only when normal component ownership cannot represent the lifetime. `createDisposable` is appropriate for a resource that must stop before owner cleanup.

## Solid Primitives ecosystem map

The uploaded monorepo contains roughly eighty-five focused packages. Treat the repository as an ecosystem and search sibling packages before writing a new primitive.

| Concern | Candidate packages from uploaded source | Selection question |
|---|---|---|
| events | `event-listener`, `event-bus`, `event-dispatcher`, `event-props` | DOM target, single channel, typed multi-event, or prop adapter? |
| scheduling | `scheduled`, `raf`, `timer`, `idle` | debounce/throttle, one frame loop, timer, or idle work? |
| observers | `intersection-observer`, `mutation-observer`, `resize-observer` | what is the SSR default and cleanup owner? |
| environment | `media`, `page-visibility`, `connectivity`, `platform`, `devices`, `permission` | is the first render deterministic? |
| state/data | `resource`, `promise`, `storage`, `db-store`, `fetch`, `graphql`, `sse`, `websocket` | remote cache, stream, browser store, or one request? |
| composition | `props`, `refs`, `context`, `destructure`, `controlled-props`, `keyed` | preserve accessors and ownership? |
| collections | `list`, `map`, `set`, `pagination`, `virtual` | stable identity, pagination, or DOM bound? |
| roots | `rootless`, `lifecycle` | can normal owner cleanup work instead? |
| motion | `spring`, `tween`, `presence`, `transition-group` | lifecycle, interruption, SSR, and reduced motion? |
| browser capability | `clipboard`, `fullscreen`, `geolocation`, `filesystem`, `workers`, `broadcast-channel` | permission, failure, and server fallback? |

Package maturity badges matter. The uploaded `scheduled` and `rootless` docs show stage 2 while `event-listener` shows stage 3. Recheck the installed release; maturity can change independently per package.

## Selection procedure

For a candidate primitive:

1. search the monorepo package list and consuming lockfile;
2. inspect the package README, source exports, tests, maturity stage, and version;
3. distinguish `make*` non-reactive setup from `create*` reactive ownership;
4. identify server behavior and initial value;
5. identify owner cleanup and any manual early-dispose API;
6. inspect sibling packages required by the example;
7. test repeated mount/unmount and SSR;
8. import the smallest package, not the entire ecosystem.

Example event listener:

```tsx
import { createEventListener } from "@solid-primitives/event-listener";

let button!: HTMLButtonElement;
createEventListener(() => button, "click", handleClick, { passive: true });

return <button ref={button}>Run</button>;
```

The reactive `createEventListener` rebinds when reactive target/type changes and cleans up with the owner. In the uploaded 2.x documentation it does not return an early clear function; use an empty target/type or a disposable subroot when early removal is required. Do not copy the older return contract.

## Scheduling and global event coordination

The `scheduled` package provides cancellable `debounce`, `throttle`, idle scheduling, leading/trailing wrappers, and `createScheduled`. Timers clear on owner disposal.

```ts
import { debounce } from "@solid-primitives/scheduled";

const commitSearch = debounce((value: string) => navigate({ search: { q: value } }), 250);
onCleanup(() => commitSearch.clear());
```

For many pointer/scroll/animation consumers, prefer one shared requestAnimationFrame scheduler rather than one loop per component. Define registration, visibility pause, document-hidden pause, elapsed/delta clamping, reduced-motion policy, and last-subscriber teardown. Use `@solid-primitives/raf` only after verifying its API fits that singleton ownership.

EventBus is appropriate for hot one-to-many notifications. Do not replace routable URL state, remote query state, or durable workflow events with an in-memory bus.

## Motion and presence lifecycle

Treat the illustrative Solid motion integration as experimental. The evidence notes incomplete gesture types and SSR/presence caveats. Use proven Solid Primitives or Web Animations/CSS where they satisfy the behavior. A type-compatible motion prototype is not production parity.

Presence must preserve exit lifetime, cancellation/interruption, nested ownership, focus, reduced motion, and deterministic server output. Verify rapid enter/exit toggles and route navigation.

## Failure signatures

| Signature | Likely defect | Correction |
|---|---|---|
| prop stops updating | reactive prop destructured | retain accessor or use Solid prop helper |
| effect loops | derived state modeled as effect | replace with memo/accessor |
| state leaks between SSR users | module singleton/root | request-local owner or hydratable verified primitive |
| listener count grows after navigation | created outside owner or missing cleanup | primitive/cleanup plus mount-count test |
| debounce fires after unmount | scheduler not owner-bound | clear/register cleanup |
| first paint flashes | browser value differs from SSR default | deterministic initial state and mount enhancement |
| wrong rows retain state | incorrect keyed/indexed control flow | choose stable identity owner |
| virtual list loses keyboard focus | mounted window owns focus incorrectly | focus retention/overscan/fallback |
| animation never exits | subtree removed before presence owner finishes | explicit presence lifecycle |

## Verification

- unit-test pure state and schema logic;
- use owner-root tests that dispose and assert listener/timer/subscription counts;
- SSR render and hydrate representative routes;
- navigate repeatedly and compare retained roots/resources;
- test document visibility, reduced motion, offline/permission failure;
- use fake timers only where they preserve scheduler semantics;
- test actual browser layout/observer/RAF behavior;
- run production build and inspect renderer/compiler output.

## Sources and freshness

- Primary: [Solid Primitives documentation](https://primitives.solidjs.community/), verified 2026-07-17 for the published ecosystem and package-level guidance.
- Historical source scope: Solid Primitives and application-consumer reviews from 2026-07-17, adapted into anonymized ownership, cleanup, SSR, and scheduling examples. Verify current package maturity and installed exports.

Individual primitive APIs and maturity stages are package-version-sensitive. Experimental or stage-listed packages are not stable merely because they appear in the monorepo; verify their package manifest, README, tests, and installed version.
