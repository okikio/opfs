
# React Interface Instructions

Use React for stateful interface regions, component libraries, application workflows, and interactive islands where React owns the client runtime.

Apply the universal web interface guidelines first. Use this file for React, Next.js, Remix, React Router, or React-compatible JSX UI code.

Do not apply React render-cycle rules to Solid components or Astro-only `.astro` markup.

## Mental model

React renders component functions from props, state, and context. Each render is a snapshot. Event handlers, effects, memoized values, and async callbacks close over the render that created them.

Write React so that:

- Render stays pure, cheap, and deterministic.
- State ownership is explicit.
- Composition is visible in JSX.
- Effects synchronize with external systems, not normal derivation.
- Components preserve native HTML semantics.
- Server and client handoffs are intentional.

Default to React 19 patterns for new code unless the project is pinned to React 18 or earlier.

## Work in priority order

When writing or reviewing React, reason in this order:

1. Preserve native web semantics through component abstractions.
2. Keep render pure, cheap, and deterministic.
3. Keep state ownership clear: local, URL, server, form, external store, transition, or context state.
4. Use composition instead of boolean configuration.
5. Keep effects limited to external synchronization.
6. Model async work, pending state, error recovery, and Suspense regions deliberately.
7. Preserve identity for lists, keys, IDs, refs, focus, and retained state.
8. Keep server rendering, hydration, and client handoffs stable.
9. Use memoization only when it protects real work or stable identity.

## Design component APIs around composition

Prefer small, explicit component APIs:

- Use `children` for layout composition.
- Use named compound components for stable regions.
- Use explicit variant components for meaningfully different workflows.
- Use discriminated unions for mutually exclusive prop modes.
- Use booleans only for real binary state, not structural customization.
- Keep the rendered native element clear from the API.

Avoid:

```tsx
<Composer
  isThread
  isEditing={false}
  showFormatting
  showAttachments
  renderFooter={() => <ThreadFooter />}
/>
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

Use render props only when the parent must provide data back to the child.

```tsx
// Acceptable: the parent owns item iteration and gives item data to the child.
<List items={items} renderItem={(item) => <ProductRow product={item} />} />
```

For static regions, use children or named compound components instead.

## Use compound components when descendants share state

Use compound components when a family of components shares state, actions, IDs, refs, or metadata.

Keep the provider API explicit. Components that need shared state do not need to be visually nested inside the root frame, but they must be inside the provider.

```tsx
import { createContext, use, useMemo, useState, type ReactNode } from "react"

type SearchState = {
  query: string
  isPending: boolean
}

type SearchActions = {
  setQuery: (query: string) => void
  submit: () => void
}

type SearchMeta = {
  inputId: string
  errorId: string
}

type SearchContextValue = {
  state: SearchState
  actions: SearchActions
  meta: SearchMeta
}

const SearchContext = createContext<SearchContextValue | null>(null)

function useSearch() {
  const value = use(SearchContext)

  if (!value) {
    throw new Error("Search components must be used inside Search.Provider")
  }

  return value
}

function SearchProvider(props: { children: ReactNode }) {
  const [query, setQuery] = useState("")
  const [isPending, setIsPending] = useState(false)

  const value = useMemo<SearchContextValue>(
    () => ({
      state: { query, isPending },
      actions: {
        setQuery,
        submit() {
          setIsPending(true)
        },
      },
      meta: { inputId: "search-input", errorId: "search-error" },
    }),
    [query, isPending],
  )

  return <SearchContext value={value}>{props.children}</SearchContext>
}

function SearchInput() {
  const { state, actions, meta } = useSearch()

  return (
    <input
      id={meta.inputId}
      name="q"
      value={state.query}
      onChange={(event) => actions.setQuery(event.currentTarget.value)}
    />
  )
}
```

Review this pattern by checking:

- The context value exposes state, actions, and meta rather than implementation details.
- Consumers read the context through a typed helper with a clear missing-provider error.
- Provider values are memoized when consumers are memoized or expensive.
- State ownership is not hidden inside a leaf component that siblings need to coordinate with.

## Keep component identity stable

Do not define component functions inside another component unless you intentionally want a new component type on every render.

Avoid:

```tsx
function Page() {
  function Toolbar() {
    return <button type="button">Refresh</button>
  }

  return <Toolbar />
}
```

Prefer:

```tsx
function Toolbar() {
  return <button type="button">Refresh</button>
}

function Page() {
  return <Toolbar />
}
```

Nested component definitions can remount stateful children, lose focus, recreate effects, and make memoization ineffective.

## Use React 19 intentionally

For React 19 and newer:

- Accept `ref` as a normal prop in function components.
- Use `<Context value={value}>` provider syntax for new code.
- Use `use(Context)` where the project has adopted React 19 patterns.
- Keep compatibility wrappers only when the project still supports React 18.

```tsx
function TextField({ ref, ...props }: React.ComponentProps<"input">) {
  return <input ref={ref} {...props} />
}
```

Do not mix React 19-only APIs into code that must run on React 18.

## Keep render pure and derived state out of effects

Compute values during render when they are cheap and pure.

Avoid:

```tsx
function CartSummary({ items }: { items: CartItem[] }) {
  const [total, setTotal] = useState(0)

  useEffect(() => {
    setTotal(items.reduce((sum, item) => sum + item.price, 0))
  }, [items])

  return <p>{total}</p>
}
```

Prefer:

```tsx
function CartSummary({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, item) => sum + item.price, 0)
  return <p>{total}</p>
}
```

Use `useMemo` only when the derivation is expensive or the stable identity matters for downstream memoization.

## Choose the right state owner

Before adding state, identify what kind of state it is:

- Local UI state: open menus, selected local tab, draft input.
- URL state: query, filters, sorting, pagination, selected route entity.
- Server state: fetched data, cache, invalidation, background refresh.
- Form state: field values, validation, submission, optimistic mutation.
- External state: browser API, subscription, socket, store, media query.
- Transition state: non-urgent UI updates.
- Context state: state shared by a component family.

Keep state as close as possible to its real owner, but lift it when siblings or descendants need to coordinate.

Avoid copying props into state unless there is an explicit reset or draft workflow.

## Handle events with native semantics

Use native event behavior wherever possible.

Ensure:

- Actions are buttons.
- Navigation is anchors or router links that preserve anchor behavior.
- Form submit uses form semantics.
- Event handlers use `event.currentTarget` when reading from the bound element.
- Prevent default only when replacing native behavior intentionally.
- Async handlers guard stale state when user intent can change before the promise resolves.

```tsx
function SaveButton({ onSave }: { onSave: () => Promise<void> }) {
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        try {
          await onSave()
        } finally {
          setPending(false)
        }
      }}
    >
      {pending ? "Saving..." : "Save"}
    </button>
  )
}
```

## Design forms with pending, validation, and recovery

Use native forms first. Add React state where the workflow needs live validation, dependent UI, optimistic mutation, or pending display.

When using React 19 form features, ensure Actions, pending state, optimistic state, and server functions preserve progressive behavior where the framework supports it.

```tsx
function ProfileForm({ action }: { action: (formData: FormData) => Promise<void> }) {
  return (
    <form action={action}>
      <label htmlFor="display-name">Display name</label>
      <input id="display-name" name="displayName" autoComplete="name" />
      <SubmitButton />
    </form>
  )
}
```

When using controlled fields, keep per-keystroke work cheap.

```tsx
function SearchField() {
  const [query, setQuery] = useState("")

  return (
    <input
      type="search"
      name="q"
      value={query}
      onChange={(event) => setQuery(event.currentTarget.value)}
    />
  )
}
```

Review forms for:

- Double-submit protection.
- Accessible field errors.
- Stable IDs.
- Autofill compatibility.
- Preserved input on failure.
- Clear success and retry behavior.

## Preserve list identity with keys

Keys must represent stable item identity, not array position, when order can change.

Avoid:

```tsx
{items.map((item, index) => (
  <CartRow key={index} item={item} />
))}
```

Prefer:

```tsx
{items.map((item) => (
  <CartRow key={item.id} item={item} />
))}
```

Review lists by testing insert, remove, sort, filter, reorder, and pagination. Focus, input state, animation state, and optimistic updates should stay attached to the right item.

## Use IDs and refs for identity, not state escape hatches

Use stable IDs for labels, descriptions, controls, and error messages. Use framework or project helpers when server rendering requires stable IDs.

Use refs for DOM integration:

- Focus management.
- Measurement after layout.
- Imperative browser APIs.
- Third-party widgets.

Avoid refs for reading component state on submit when state should be lifted or stored in the form.

```tsx
function FocusableInput() {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <input ref={inputRef} />
      <button type="button" onClick={() => inputRef.current?.focus()}>
        Focus input
      </button>
    </>
  )
}
```

## Use effects only for external systems

Effects are for synchronization with systems outside React:

- DOM APIs not expressible in JSX.
- Subscriptions.
- Event listeners.
- Timers.
- Observers.
- Third-party widgets.
- Network connections owned by the component lifecycle.

Every effect should answer:

1. What external system is being synchronized?
2. What starts the synchronization?
3. What stops it?
4. Which dependencies intentionally retrigger it?

```tsx
useEffect(() => {
  const controller = new AbortController()

  window.addEventListener("resize", handleResize, { signal: controller.signal })

  return () => controller.abort()
}, [])
```

Avoid effect chains that copy state from one place to another when render calculation, event handlers, or derived values would be clearer.

## Model async UI, transitions, and scheduling

Async UI should distinguish pending work from completed state.

Use transitions for non-urgent UI updates that should not block urgent input. Do not use transitions for controlled text input updates.

```tsx
function ProductSearch() {
  const [query, setQuery] = useState("")
  const [resultsQuery, setResultsQuery] = useState("")
  const [isPending, startTransition] = useTransition()

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(event) => {
          const next = event.currentTarget.value
          setQuery(next)
          startTransition(() => setResultsQuery(next))
        }}
      />
      {isPending && <p>Updating results...</p>}
      <Results query={resultsQuery} />
    </>
  )
}
```

Guard against stale async results overwriting newer user intent.

```tsx
useEffect(() => {
  const controller = new AbortController()

  fetchResults(query, { signal: controller.signal })
    .then(setResults)
    .catch((error) => {
      if (error.name !== "AbortError") setError(error)
    })

  return () => controller.abort()
}, [query])
```

## Place Suspense and error mappers around recoverable regions

Use Suspense for meaningful loading regions, not as a blanket replacement for the entire app when stable layout can remain visible.

```tsx
<DashboardShell>
  <Suspense fallback={<PanelSkeleton label="Loading invoices" />}>
    <InvoicePanel />
  </Suspense>
</DashboardShell>
```

Use error mappers around product recovery regions. The fallback should explain what failed and offer a reset, retry, or navigation path when possible.

Avoid full-page fallbacks that hide navigation or stable context unnecessarily.

## Use portals without losing focus or accessibility

Portals are appropriate for overlays, modals, popovers, tooltips, and layered UI that needs to escape clipping or stacking context.

When using portals, ensure:

- The logical owner still controls open state.
- Focus is moved and restored correctly.
- Background content is inert or otherwise inaccessible when modal behavior requires it.
- Escape, outside click, and route changes have defined behavior.
- Stacking and scroll locking are deliberate.
- The portal content has the right accessible name and description.

```tsx
<Dialog.Root open={open} onOpenChange={setOpen}>
  <Dialog.Trigger>Open settings</Dialog.Trigger>
  <Dialog.Portal>
    <Dialog.Content aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>
      <button type="button" onClick={() => setOpen(false)}>Close</button>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
```

## Keep server and client handoffs explicit

For frameworks with server components or route loaders, keep browser-only code out of server-only modules.

Ensure:

- Server-rendered markup matches initial client markup.
- Browser APIs are read in client-safe code.
- Client components are as narrow as possible.
- Serializable props cross server-client handoffs.
- Secrets, tokens, and privileged data never enter client bundles.
- Random IDs, dates, locale output, media query values, and viewport values cannot create accidental hydration mismatch.

Hydration warnings need a concrete root cause and a narrow fix.

## Style React components through state and semantics

Expose `className`, style, refs, data attributes, and accessibility props when wrapper components need to be reusable.

Keep visual state tied to real state:

```tsx
<button
  type="button"
  aria-pressed={selected}
  data-state={selected ? "selected" : "idle"}
  className={cn("view-button", selected && "view-button--selected")}
>
  List view
</button>
```

Avoid class strings so complex that state relationships become unreadable. Use a project variant helper when it clarifies the state map.

## Use memoization as a tool, not a default

Use `memo`, `useMemo`, and `useCallback` when they protect a measured cost, stabilize identity for a memoized child, or prevent unnecessary expensive work.

Avoid using memoization to hide impure render logic or unstable component API design.

```tsx
const visibleItems = useMemo(
  () => expensiveFilter(items, query),
  [items, query],
)
```

Review performance by looking for:

- Large subtrees rerendering from small state changes.
- Context values recreated on every render when consumers are expensive.
- Expensive derivations recomputed per keystroke.
- Unstable callbacks passed into memoized children.
- Client components or hydrated islands that could be server-rendered or static.

## Test React through user behavior

Test:

- Composed component APIs with real children.
- Provider state and missing-provider errors.
- Forms and validation.
- List identity after reorder.
- Portals and focus restoration.
- Suspense, error, empty, pending, and success states.
- Server-client handoffs when applicable.
- Accessible names and keyboard behavior.

Prefer DOM-facing tests over implementation snapshots.

## Review what you wrote

Before considering React UI complete, ask:

- Does the component render the correct native element for each interaction?
- Is state owned by the right parent, URL, server cache, form, or provider?
- Did composition replace boolean structural modes?
- Are effects only synchronizing external systems?
- Are async states visible and recoverable?
- Are keys, refs, IDs, and focus stable?
- Are server/client handoffs explicit and safe?
- Is memoization justified by cost or identity?

For every important finding, show the concrete React fix.

## React anti-patterns to avoid

Avoid:

- Boolean prop modes for structural variation.
- Nested component definitions that remount children.
- Derived state written through effects.
- Effects used for event handling.
- Missing cleanup for listeners, observers, timers, and subscriptions.
- Index keys for reorderable lists.
- Context values recreated carelessly for expensive consumers.
- Controlled inputs tied to expensive synchronous work.
- Browser APIs in server render.
- Full-page Suspense hiding stable UI unnecessarily.
- Portals without focus or dismissal behavior.
- `div` buttons and click-only navigation.
