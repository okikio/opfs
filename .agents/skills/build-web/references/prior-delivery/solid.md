
# Solid Interface Instructions

Use Solid for fine-grained interactive UI where precise reactivity, small runtime cost, and direct JSX composition are valuable.

Apply the universal web interface guidelines first. Use this file for Solid, SolidStart, or Solid-compatible JSX UI code.

Do not apply React render-cycle rules to Solid. Solid components look like React components at the JSX surface, but they do not rerender the same way.

## Mental model

Solid component functions run once to create reactive relationships. Later updates happen through signals, memos, stores, resources, effects, and JSX expressions that read reactive values.

Write Solid so that:

- Reactive values stay reactive as accessors, stores, or resources.
- Props are read in ways that preserve reactivity.
- Effects synchronize with external systems, not normal derivation.
- Owner lifetime is treated as part of the architecture.
- Control-flow components preserve identity and cleanup.
- Async state, Suspense, transitions, and ErrorBoundaries are recoverable.

Before hand-rolling browser wiring, root-sharing helpers, resize tracking, media
query state, keyboard shortcuts, pointer tracking, or persistence glue, check
whether a `@solid-primitives/...` package already solves the problem in a
Solid-native way.

Use this table as a starting reference when tackling Solid-specific tasks:

| Package | Exported methods or components | Capabilities |
| --- | --- | --- |
| `@solid-primitives/event-listener` | `makeEventListener`, `makeEventListenerStack`, `createEventListener`, `createEventSignal`, `createEventListenerMap`, `WindowEventListener`, `DocumentEventListener`, `eventListener`, `preventDefault`, `stopPropagation`, `stopImmediatePropagation` | DOM and custom event wiring with Solid cleanup semantics, reactive listener targets and event types, listener maps, last-event signals, window or document listener components, directive-based listener attachment, and event-handler wrappers. |
| `@solid-primitives/refs` | `mergeRefs`, `resolveElements`, `resolveFirst`, `Refs`, `Ref`, `defaultElementPredicate` | Ref forwarding, keeping multiple child refs current, resolving nested JSX children into elements, and finding the first matching element in composed children. |
| `@solid-primitives/resize-observer` | `makeResizeObserver`, `createResizeObserver`, `createWindowSize`, `useWindowSize`, `createElementSize` | Resize observation with automatic disposal, reactive element-size tracking, shared window-size state, and layout-aware components without manual observer bookkeeping. |
| `@solid-primitives/media` | `makeMediaQueryListener`, `createMediaQuery`, `createBreakpoints`, `sortBreakpoints`, `createPrefersDark`, `usePrefersDark` | Media-query listeners, responsive breakpoint state, breakpoint ordering helpers, and shared dark-mode preference tracking with server fallback support. |
| `@solid-primitives/storage` | `makePersisted`, `cookieStorage`, `makeObjectStorage`, `multiplexStorage`, `storageSync`, `messageSync`, `wsSync`, `multiplexSync`, `addClearMethod`, `addWithOptionsMethod` | Persisting signals or stores to sync or async storage, cookie-backed or object-backed storage, fallback storage chains, multi-tab or websocket synchronization, and adapting custom storage APIs. |
| `@solid-primitives/scheduled` | `debounce`, `throttle`, `scheduleIdle`, `leading`, `leadingAndTrailing`, `createScheduled` | Debounced, throttled, idle-time, leading-edge, and leading-plus-trailing callbacks, plus tracked scheduling for Solid computations. |
| `@solid-primitives/keyboard` | `useKeyDownEvent`, `useKeyDownList`, `useCurrentlyHeldKey`, `useKeyDownSequence`, `createKeyHold`, `createShortcut` | Shared keyboard-state signals, held-key tracking, key-sequence tracking, single-key hold checks, and shortcut observers with optional default-prevention and reset behavior. |
| `@solid-primitives/mouse` | `createMousePosition`, `useMousePosition`, `createPositionToElement`, `makeMousePositionListener`, `makeMouseInsideListener`, `getPositionToElement`, `getPositionInElement`, `getPositionToScreen` | Reactive pointer position, shared window pointer tracking, element-relative cursor math, enter or leave detection, and page-to-element or page-to-screen coordinate conversion. |
| `@solid-primitives/rootless` | `createSubRoot`, `createCallback`, `createDisposable`, `createSingletonRoot`, `createHydratableSingletonRoot`, `createRootPool` | Owner-aware callbacks, disposable sub-roots, shared singleton roots, hydration-safe singleton variants, and pooled roots for frequently mounted or unmounted reactive work. |
| `@solid-primitives/list` | `List`, `listArray` | Alternative list control flow with reactive item values and reactive indices, useful when you need finer-grained array updates than a plain `.map()` or a default `<For>` pattern. |
| `@solid-primitives/platform` | boolean exports such as `isAndroid`, `isWindows`, `isMac`, `isIPhone`, `isIPad`, `isIPod`, `isIOS`, `isAppleDevice`, `isMobile`, `isFirefox`, `isOpera`, `isSafari`, `isIE`, `isChromium`, `isEdge`, `isChrome`, `isBrave`, `isGecko`, `isBlink`, `isWebKit`, `isPresto`, `isTrident`, `isEdgeHTML` | Tree-shakeable browser, device, and rendering-engine detection flags for platform-specific fallbacks or bug workarounds. |

Prefer these primitives over ad hoc wrappers when they already match the job.
If a package name or export looks close but not exact, verify the current API
before using it.
If no `@solid-primitives` package matches after verification, implement the
narrowest hand-rolled wrapper that respects Solid state & cleanup semantics such as
`onCleanup` or `createRoot` disposal, and leave a comment explaining why the
primitive was not used.

## Work in priority order

When writing or reviewing Solid, reason in this order:

1. Preserve native web semantics through JSX and components.
2. Respect Solid's fine-grained model: setup runs once, reactive computations update DOM.
3. Keep signals, memos, stores, resources, effects, and contexts scoped to the right owner lifetime.
4. Preserve accessors and prop reactivity through component APIs.
5. Use Solid control flow for conditional regions and list identity.
6. Keep events explicit: delegated or native based on behavior.
7. Model async resources, transitions, Suspense, errors, and retries deliberately.
8. Keep hydration, SSR, and client handoffs stable.
9. Clean up listeners, observers, timers, animation loops, and imperative integrations.

The priority order governs trade-offs between sections. When a specific section rule conflicts with a higher-priority item, the priority order wins.

For complex Solid interfaces, keep the reactive lifecycle visible. A diagram or
component example should show owner lifetime, data loading, stale state, retry,
cleanup, and descendant consumption when those details affect correctness. Do not
compress the workflow into a tiny component tree if the missing owner or cleanup
path is the actual source of bugs.

## Design Solid APIs around composition and reactive scopes

Use composition over configuration.

For complex UI flows, composition examples should preserve the real structure.
Show named regions, state owner, async status, error recovery, and cleanup paths
when those are part of the component contract. A longer example is preferable to
a tiny example that hides where state lives or how descendants receive updates.

Prefer:

- `props.children` for simple default regions.
- `children()` when children are inspected, reused, transformed, or read more than once.
- Explicit props for data.
- Context when descendants share state or actions.
- Accessors for live reactive values.
- Stores for nested structured state.
- Explicit variants for different workflows.
- `<Dynamic />` for runtime-selected components or root elements.

Use `createStore` when state is nested or partially updated, such as changing one field without replacing the whole object. Use `createSignal` for flat, scalar, or fully replaced values. Avoid stores for primitives that are always replaced atomically.

Avoid:

```tsx
<Composer isThread showFormatting showAttachments />
```

Prefer:

```tsx
<ThreadComposer.Provider channelId={channelId}>
  <Composer.Frame>
    <Composer.Input />
    <AlsoSendToChannelField channelId={channelId} />
    <Composer.Footer>
      <Composer.Formatting />
      <Composer.Attachments />
      <Composer.Submit />
    </Composer.Footer>
  </Composer.Frame>
</ThreadComposer.Provider>
```

Do not copy a React compound-component implementation without translating state, children, memoization, and effects to Solid primitives.

## Preserve prop reactivity

Do not destructure reactive props into plain locals when the value must update.

Avoid:

```tsx
function Label(props: { value: string }) {
  const { value } = props
  return <span>{value}</span>
}
```

Prefer:

```tsx
function Label(props: { value: string }) {
  return <span>{props.value}</span>
}
```

When a local accessor improves readability, wrap the read:

```tsx
function Label(props: { value: string }) {
  const value = () => props.value
  return <span>{value()}</span>
}
```

Use `splitProps` when separating local props from passthrough props while preserving reactivity.

```tsx
import { splitProps, type JSX } from "solid-js"

function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, others] = splitProps(props, ["class", "children"])

  return (
    <button class={["button", local.class].filter(Boolean).join(" ")} {...others}>
      {local.children}
    </button>
  )
}
```

Use `mergeProps` for reactive default props instead of object spread defaults that snapshot values.

## Keep signals as accessors

Pass `Accessor<T>` values when children should observe live state.

Avoid:

```tsx
const selected = selectedId()
return <SelectedBadge selected={selected} />
```

Prefer:

```tsx
return <SelectedBadge selected={selectedId} />

function SelectedBadge(props: { selected: Accessor<string | null> }) {
  return <span>{props.selected() ?? "None"}</span>
}
```

Read accessors inside JSX, `createMemo`, `createEffect`, resources, or other tracking scopes when updates should be tracked.

## Shape context around state, actions, and meta

Use Solid context when multiple descendants need shared state or actions.

Expose live values as accessors, stores, or resources. Do not expose snapshots captured during setup.

```tsx
import { createContext, createSignal, useContext, type Accessor, type JSX, type Setter } from "solid-js"

type ComposerContextValue = {
  state: {
    input: Accessor<string>
    isSubmitting: Accessor<boolean>
  }
  actions: {
    setInput: Setter<string>
    submit: () => Promise<void>
  }
  meta: {
    inputId: string
    errorId: string
  }
}

const ComposerContext = createContext<ComposerContextValue>()

function useComposer() {
  const value = useContext(ComposerContext)

  if (!value) {
    throw new Error("Composer components must be used inside ComposerProvider")
  }

  return value
}

function ComposerProvider(props: { children: JSX.Element }) {
  const [input, setInput] = createSignal("")
  const [isSubmitting, setIsSubmitting] = createSignal(false)

  const value: ComposerContextValue = {
    state: { input, isSubmitting },
    actions: {
      setInput,
      async submit() {
        setIsSubmitting(true)
        try {
          await submitMessage(input())
        } finally {
          setIsSubmitting(false)
        }
      },
    },
    meta: { inputId: "composer-input", errorId: "composer-error" },
  }

  return <ComposerContext.Provider value={value}>{props.children}</ComposerContext.Provider>
}
```

Review context by checking that context lookup happens inside an owner, the provider owns the signals/resources, and consumers do not depend on provider implementation details.

## Use `children()` only when needed

Use `props.children` when simply rendering children once.

Use `children()` when children are accessed multiple times, transformed, filtered, measured, memoized, or passed into reactive logic.

```tsx
import { Show, children, type JSX } from "solid-js"

function Panel(props: { children: JSX.Element }) {
  const resolved = children(() => props.children)
  const hasContent = () => resolved.toArray().length > 0

  return (
    <section classList={{ "panel-empty": !hasContent() }}>
      <Show when={hasContent()} fallback={<p>No content</p>}>
        <div>{resolved()}</div>
      </Show>
    </section>
  )
}
```

Do not normalize children by habit. It creates an accessor and changes when the child expression is evaluated.

## Use `<Dynamic />` for runtime-selected roots

Use `<Dynamic />` when the element or component type is selected at runtime.

```tsx
import { splitProps, type JSX, type ValidComponent } from "solid-js"
import { Dynamic } from "solid-js/web"

type BoxProps<T extends ValidComponent> = {
  as?: T
  children?: JSX.Element
} & JSX.HTMLAttributes<HTMLElement>

function Box<T extends ValidComponent = "div">(props: BoxProps<T>) {
  const [local, others] = splitProps(props, ["as", "children", "class"])

  return (
    <Dynamic
      component={local.as ?? "div"}
      class={["box", local.class].filter(Boolean).join(" ")}
      {...others}
    >
      {local.children}
    </Dynamic>
  )
}
```

Do not use polymorphism to hide semantics. A navigation surface still needs to render an anchor or router link with link behavior.

## Use `createMemo` for derived values

Use `createMemo` when a derived value is expensive, shared by multiple consumers, or should only recompute when specific dependencies change.

```tsx
const visibleItems = createMemo(() => {
  return items().filter((item) => item.name.includes(query()))
})
```

Do not use effects to write derived state that can be computed from signals or stores.

Avoid:

```tsx
createEffect(() => {
  setVisibleItems(items().filter((item) => item.name.includes(query())))
})
```

## Use `on(...)` for explicit dependencies

Use `on(...)` when an effect, memo, or computed derivation should track a specific source instead of every signal read inside the callback.

```tsx
import { createEffect, on } from "solid-js"

createEffect(
  on(selectedId, (id) => {
    logSelection(id, { source: analyticsSource() })
  }),
)
```

In this example, `selectedId` drives the effect. `analyticsSource()` is read when the effect runs, but it does not retrigger the effect.

Use `{ defer: true }` only when the first run should be skipped intentionally.

```tsx
createEffect(
  on(query, (value) => {
    syncQueryToUrl(value)
  }, { defer: true }),
)
```

Use `untrack` sparingly and only when a non-dependency read is intentional. Do not use `untrack` to hide a data-flow problem.

## Keep owner, root, and cleanup scopes explicit

Solid ownership scopes determine context lookup, cleanup, resource lifetime, error mappers, and disposal.

Use `createRoot` only for a deliberate lifetime scope outside normal component disposal. Keep and call the `dispose` function.

```tsx
import { createRoot } from "solid-js"

const dispose = createRoot((dispose) => {
  const [open, setOpen] = createSignal(false)
  mountOverlay({ open, setOpen })
  return dispose
})

// Later, when the external overlay system is destroyed.
dispose()
```

Use `getOwner` and `runWithOwner` only when bridging owner context across custom lifetimes. Document the reason when it is not obvious.

Always clean up external work:

```tsx
import { createEffect, onCleanup } from "solid-js"

createEffect(() => {
  const controller = new AbortController()
  window.addEventListener("resize", handleResize, { signal: controller.signal })
  onCleanup(() => controller.abort())
})
```

Avoid:

- Detached roots with no dispose path.
- Reactive primitives created after an `await` without preserving the intended owner.
- Retained DOM nodes whose reactive owner has already been disposed.
- Event listeners, observers, timers, or animation loops without cleanup.

## Use portals as DOM escape hatches with owner awareness

Use portals for overlays, modals, popovers, tooltips, and layered UI that must escape clipping or stacking context.

When using portals, ensure:

- Owner lifetime and cleanup remain valid.
- Context access still resolves as intended.
- Focus moves into the overlay and returns on close.
- Background content is inert when modal behavior requires it.
- Escape, outside click, scroll lock, and route changes have defined behavior.
- Portal event behavior is understood and tested.

```tsx
import { Portal } from "solid-js/web"

function Dialog(props: { open: Accessor<boolean>; onClose: () => void }) {
  return (
    <Show when={props.open()}>
      <Portal>
        <div role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h2 id="dialog-title">Settings</h2>
          <button type="button" onClick={props.onClose}>Close</button>
        </div>
      </Portal>
    </Show>
  )
}
```

## Use Solid control flow for conditions and lists

Use Solid's control-flow components for reactive branching and list identity.

- Use `<Show>` for conditional UI.
- Use `<Show keyed>` when the child block should recreate when the value changes, not only when truthiness changes.
- Use `<Switch>` and `<Match>` for mutually exclusive branches.
- Use `<For>` for dynamic keyed collections where item identity matters.
- Use `<Index>` only when item order and count are fixed and items carry no component-local state. Do not use `<Index>` for lists that can be reordered or where each item owns reactive state that must survive position changes.

```tsx
<Show when={user()} fallback={<SignInPrompt />}>
  {(currentUser) => <AccountMenu user={currentUser()} />}
</Show>
```

```tsx
<For each={products()} fallback={<p>No products found.</p>}>
  {(product) => <ProductCard product={product} />}
</For>
```

Avoid array `.map()` in JSX for dynamic UI lists unless you have confirmed the reactivity and identity behavior is correct.

Review lists by testing insert, remove, reorder, sort, filter, and focused input state.

## Model async with resources or explicit state machines

Use resources when async data belongs to the Solid island and should participate in tracking, refetching, Suspense, stale state, and error handling.

```tsx
const [userId, setUserId] = createSignal("1")
const [user, { refetch }] = createResource(userId, fetchUser)

return (
  <Suspense fallback={<p>Loading user...</p>}>
    <Show when={user.error} fallback={<UserProfile user={user()} />}>
      <RetryMessage onRetry={refetch} />
    </Show>
  </Suspense>
)
```

Ensure:

- Resource sources are stable and narrow.
- Loading, empty, error, stale, refresh, and success states are modeled.
- Stale results cannot overwrite newer user intent.
- Retry behavior resets or refetches the correct source.
- Background refresh does not erase usable stale content without reason.

Use explicit state machines when the workflow has complex user intent, optimistic updates, cancellation, or multi-step mutation state.

## Use transitions for non-urgent updates

Use transitions when deferring non-urgent UI preserves responsiveness.

```tsx
const [isPending, start] = useTransition()

function updateFilter(next: string) {
  setInput(next)
  start(() => setExpensiveFilter(next))
}
```

Do not use transitions to hide incorrect state ownership or uncontrolled async races.

## Place Suspense and ErrorBoundaries around recoverable regions

Suspense regions should wrap meaningful loading regions and preserve stable layout where possible.

```tsx
<DashboardShell>
  <Suspense fallback={<PanelSkeleton label="Loading activity" />}>
    <ActivityPanel />
  </Suspense>
</DashboardShell>
```

Error mappers should match product recovery regions.

The fallback should explain what failed and offer retry, reset, or navigation where possible. Do not only log errors to the console.

## Handle events with Solid semantics

Solid has delegated event handlers and native event handlers. Choose intentionally.

Use normal `onClick`, `onInput`, and similar handlers for common delegated events when delegation is appropriate.

Use `on:click` or other native listener forms when you need native event behavior, non-delegated events, custom events, or listener options.

```tsx
<button type="button" onClick={() => setOpen(true)}>Open</button>
<input onInput={(event) => setValue(event.currentTarget.value)} />
```

Do not assume React SyntheticEvent behavior. Solid event handlers receive native events.

Avoid:

- `onClick` navigation on non-link elements.
- Duplicate keyboard activation on real buttons.
- Imperative event listeners without cleanup.
- Async event handlers setting state after owner disposal.
- Preventing default browser behavior without a clear replacement.

## Design forms with native behavior first

Use native form semantics unless client-side behavior materially improves the workflow.

Ensure:

- Labels, IDs, names, and autocomplete values are stable.
- Controlled input updates are cheap per keystroke.
- Field errors connect to fields.
- Pending, validation failure, recoverable error, success, and retry states are distinct.
- Failed submissions preserve input unless clearing is safer.
- Double-submit is prevented when needed.

```tsx
function SignupForm() {
  const [email, setEmail] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  return (
    <form onSubmit={submitSignup} noValidate>
      <label for="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        value={email()}
        aria-invalid={error() ? "true" : undefined}
        aria-describedby={error() ? "email-error" : undefined}
        onInput={(event) => setEmail(event.currentTarget.value)}
      />
      <Show when={error()}>
        {(message) => <p id="email-error">{message()}</p>}
      </Show>
      <button type="submit">Create account</button>
    </form>
  )
}
```

## Keep SSR and hydration stable

Ensure server and client initial output match in structure and user-visible text.

Avoid reading browser-only APIs during server render:

- `window`
- `document`
- `localStorage`
- `matchMedia`
- viewport size
- layout measurements

Use mount-time logic for browser-only reads.

```tsx
onMount(() => {
  setPrefersDark(window.matchMedia("(prefers-color-scheme: dark)").matches)
})
```

Keep IDs stable across server and client. Do not serialize secrets or privileged data into client bundles or resources.

## Style Solid components with `class`, `classList`, and real state

Use `class` for static classes and `classList` for stateful class toggles.

```tsx
<button
  type="button"
  aria-pressed={selected()}
  class="view-button"
  classList={{ "view-button--selected": selected() }}
>
  Grid view
</button>
```

Use inline styles for dynamic values or CSS variables, not large static style objects by default.

Expose `class`, `classList`, `style`, refs, and accessibility props from reusable wrappers when consumers need them.

## Optimize by narrowing dependencies

Solid performance comes from precise dependencies. Preserve that precision.

Check:

- Accessors are read only where the UI needs them.
- Broad store reads do not subscribe computations to unrelated fields.
- Expensive derived work uses `createMemo`.
- Multiple signal writes that represent one user-visible update are batched when needed.
- Resources do not refetch due to unstable or broad sources.
- List rendering preserves DOM and state identity.
- Observers, listeners, timers, roots, and animation loops clean up on owner disposal.

Avoid effect chains that bounce values between signals.

## Use Solid inside Astro carefully

When Solid is used inside Astro, the Solid component becomes a hydrated island only when given a `client:*` directive.

Astro can pass static children and named slots into Solid. Named Astro slots become top-level props in Solid, with kebab-case slot names converted to camelCase.

Do not expect Astro frontmatter functions to become client callbacks. Pass serializable data and keep interactive actions inside Solid.

## Test Solid through behavior and reactivity

Test:

- Signal-driven updates.
- Prop pass-through preserving reactivity.
- Context providers with composed children.
- `on(...)` dependency behavior when important.
- Owner cleanup for listeners, timers, observers, and roots.
- Portal focus and dismissal.
- `<For>`, `<Index>`, `<Show>`, `<Switch>`, and `<Match>` behavior.
- Resources, Suspense, ErrorBoundary, retry, and stale states.
- Forms, events, keyboard behavior, and accessible names.
- SSR and hydration when applicable.

## Review what you wrote

Before considering Solid UI complete, ask:

- Did I preserve native semantics?
- Did I keep signals live as accessors where needed?
- Did I avoid destructuring props into stale locals?
- Did I choose `props.children` or `children()` intentionally?
- Did I use `<For>`, `<Index>`, `<Show>`, and `<Dynamic />` where they fit?
- Are owner lifetimes, roots, portals, and cleanup explicit?
- Are resources, transitions, Suspense, and errors recoverable?
- Are events native or delegated intentionally?
- Is SSR or Astro island hydration safe?
- Are reactive dependencies narrow enough?

For every important finding, show the concrete Solid fix.

## Solid anti-patterns to avoid

Avoid:

- Assuming component functions rerun like React renders.
- Destructuring props and losing reactivity.
- Calling accessors once during setup and expecting updates.
- Writing to a signal inside an effect that depends on the same signal without a guard.
- Broad effects that accidentally subscribe to unrelated reads.
- `untrack` used to hide a data-flow problem.
- Detached `createRoot` without dispose.
- Reactive primitives created after `await` without intended owner context.
- Retained DOM whose owner has been disposed.
- Array `.map()` for dynamic JSX lists where `<For>` or `<Index>` is required.
- `<Index>` for reorderable data with item-local state.
- Resource sources that are too broad or unstable.
- Full-page Suspense fallbacks hiding stable layout unnecessarily.
- Event listener, observer, timer, or animation loop without cleanup.
- Browser API reads during SSR.
- React `className`, SyntheticEvent, memo, or render-cycle assumptions copied into Solid code.
