
## Compose Framework Primitives, Not Renderer-shaped APIs

Design the component API around **semantic regions and state ownership scopes**, then
implement those regions with the primitive that belongs to the framework.

A compositional API should answer four questions before choosing syntax:

1. What stable regions does this component expose?
2. Which regions are static structure and which are interactive?
3. Where does state live, and how do children read or update it?
4. What browser semantics must the rendered output preserve?

Do not copy a React compound-component pattern into Solid or Astro unchanged.
React, Solid, and Astro all use JSX-like syntax, but their runtime models are
not the same:

- React re-renders component functions and uses memoization, context, children,
  and stable component identity to control work.
- Solid runs component functions once, then updates fine-grained reactive reads
  through signals, memos, stores, and control-flow components.
- Astro renders server-first HTML and projects content through slots. Hydrated
  React or Solid islands should be kept as narrow as possible.

The shared rule is **composition over configuration**. The implementation must
stay native to the renderer.

Composition examples should be detailed enough to reveal ownership and lifecycle.
Do not compress a complex pattern into a tiny component tree when the important
part is where state lives, how descendants consume it, how async states recover,
or how cleanup happens. Prefer chaptered examples or staged diagrams when the
pattern crosses framework, server/client, or ownership scopes.

## Incorrect: renderer-shaped configuration API

```tsx
<ProductCard
  product={product}
  as="article"
  compact
  featured
  interactive
  showMedia
  showBadge
  showActions
  showFooter
  renderMedia={() => <ProductImage product={product} />}
  renderActions={() => <AddToCart product={product} />}
  renderFooter={() => <ShippingEstimate product={product} />}
/>
```

This API mixes layout regions, state mode, HTML element choice, interactivity,
and renderer callbacks into one component. Every new region becomes another prop
or render callback. Every boolean multiplies the number of valid states.

## Correct: named regions plus explicit state ownership scope

Start with a renderer-neutral composition contract:

```tsx
<ProductCard.Root>
  <ProductCard.Media />
  <ProductCard.Body>
    <ProductCard.Title />
    <ProductCard.Price />
  </ProductCard.Body>
  <ProductCard.Actions>
    <AddToCart />
  </ProductCard.Actions>
</ProductCard.Root>
```

Then implement that contract differently per framework.

## React: compound components, context, and stable identity

Use React compound components when subcomponents need shared state or actions.
Keep the provider API explicit. Components that need the shared state do
not need to be visually nested inside the root frame, but they do need to be
inside the provider.

```tsx
import { createContext, memo, use, useMemo, useState } from "react"

type ProductCardState = {
  product: Product
  selectedVariantId: string | null
}

type ProductCardActions = {
  selectVariant: (variantId: string) => void
}

type ProductCardContextValue = {
  state: ProductCardState
  actions: ProductCardActions
}

const ProductCardContext = createContext<ProductCardContextValue | null>(null)

function useProductCard() {
  const value = use(ProductCardContext)

  if (!value) {
    throw new Error("ProductCard components must be used inside ProductCard.Provider")
  }

  return value
}

function ProductCardProvider({
  product,
  children,
}: {
  product: Product
  children: React.ReactNode
}) {
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    product.defaultVariantId,
  )

  const value = useMemo<ProductCardContextValue>(
    () => ({
      state: { product, selectedVariantId },
      actions: { selectVariant: setSelectedVariantId },
    }),
    [product, selectedVariantId],
  )

  return (
    <ProductCardContext value={value}>
      {children}
    </ProductCardContext>
  )
}

function ProductCardRoot({ children }: { children: React.ReactNode }) {
  return <article className="product-card">{children}</article>
}

function ProductCardTitle() {
  const {
    state: { product },
  } = useProductCard()

  return <h2>{product.name}</h2>
}

const ProductCardVariantButton = memo(function ProductCardVariantButton({
  variant,
}: {
  variant: ProductVariant
}) {
  const {
    state: { selectedVariantId },
    actions: { selectVariant },
  } = useProductCard()

  return (
    <button
      type="button"
      aria-pressed={selectedVariantId === variant.id}
      onClick={() => selectVariant(variant.id)}
    >
      {variant.name}
    </button>
  )
})

function ProductCardActions({ children }: { children: React.ReactNode }) {
  return <footer className="product-card__actions">{children}</footer>
}

export const ProductCard = {
  Provider: ProductCardProvider,
  Root: ProductCardRoot,
  Title: ProductCardTitle,
  VariantButton: ProductCardVariantButton,
  Actions: ProductCardActions,
}
```

Usage:

```tsx
<ProductCard.Provider product={product}>
  <ProductCard.Root>
    <ProductCard.Title />
    {product.variants.map((variant) => (
      <ProductCard.VariantButton key={variant.id} variant={variant} />
    ))}
    <ProductCard.Actions>
      <AddToCart productId={product.id} />
    </ProductCard.Actions>
  </ProductCard.Root>
</ProductCard.Provider>
```

### React rules

1. **Do not define compound subcomponents inside another component.** React sees
   a new component type on each render and remounts it, losing state, focus, and
   effects.
2. **Use context for shared component state, but keep the context value stable
   when children are memoized or expensive.** Use `useMemo` when the provider
   value would otherwise create a new object on every render.
3. **Do not store derived state in effects.** Compute cheap derived values during
   render and use `useMemo` only for expensive pure derivations.
4. **Do not overuse `React.Children` introspection.** It can be useful for
   narrow transforms, but it does not see the rendered output of child
   components and can make composition fragile.
5. **Use render props only when the parent must provide data back to the child.**
   For layout regions, prefer normal children or compound subcomponents.
6. **Preserve rendered semantics.** A navigational child should render an anchor;
   an action child should render a button. Use project composition primitives,
   such as `asChild`, only when they preserve the correct rendered element.
7. **In React 19+, prefer `ref` as a normal prop and `<Context value={...}>` for
   providers.** Keep older React compatibility in a separate rule when needed.

## Solid: signals, accessors, control flow, and `<Dynamic />`

Solid composition looks like React at the JSX surface, but the reactivity model
is different. A Solid component function runs once. Reactive reads inside JSX,
`createMemo`, `createEffect`, resources, stores, and control-flow components are
what update later.

The context contract should expose signals as **accessors** and actions as
functions. Do not convert signals into stale values while composing children.

```tsx
import {
  For,
  Show,
  children,
  createContext,
  createMemo,
  createSignal,
  splitProps,
  useContext,
  type Accessor,
  type JSX,
  type Setter,
  type ValidComponent,
} from "solid-js"
import { Dynamic } from "solid-js/web"

type ProductCardContextValue = {
  product: Accessor<Product>
  selectedVariantId: Accessor<string | null>
  setSelectedVariantId: Setter<string | null>
  selectedVariant: Accessor<ProductVariant | undefined>
}

const ProductCardContext = createContext<ProductCardContextValue>()

function useProductCard() {
  const value = useContext(ProductCardContext)

  if (!value) {
    throw new Error("ProductCard components must be used inside ProductCard.Provider")
  }

  return value
}

function ProductCardProvider(props: {
  product: Product
  children: JSX.Element
}) {
  const [selectedVariantId, setSelectedVariantId] = createSignal<string | null>(
    props.product.defaultVariantId,
  )

  const product = () => props.product

  const selectedVariant = createMemo(() =>
    product().variants.find((variant) => variant.id === selectedVariantId()),
  )

  return (
    <ProductCardContext.Provider
      value={{
        product,
        selectedVariantId,
        setSelectedVariantId,
        selectedVariant,
      }}
    >
      {props.children}
    </ProductCardContext.Provider>
  )
}

function ProductCardRoot<T extends ValidComponent = "article">(
  props: {
    as?: T
    children: JSX.Element
  } & JSX.IntrinsicElements["article"],
) {
  const [local, others] = splitProps(props, ["as", "children", "class"])

  return (
    <Dynamic
      component={local.as ?? "article"}
      class={['product-card', local.class].filter(Boolean).join(' ')}
      {...others}
    >
      {local.children}
    </Dynamic>
  )
}

function ProductCardTitle() {
  const card = useProductCard()

  return <h2>{card.product().name}</h2>
}

function ProductCardVariantList() {
  const card = useProductCard()

  return (
    <Show when={card.product().variants.length > 0}>
      <ul>
        <For each={card.product().variants}>
          {(variant) => (
            <li>
              <button
                type="button"
                aria-pressed={card.selectedVariantId() === variant.id}
                onClick={() => card.setSelectedVariantId(variant.id)}
              >
                {variant.name}
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function ProductCardActions(props: { children: JSX.Element }) {
  const resolved = children(() => props.children)

  return <footer class="product-card__actions">{resolved()}</footer>
}

export const ProductCard = {
  Provider: ProductCardProvider,
  Root: ProductCardRoot,
  Title: ProductCardTitle,
  VariantList: ProductCardVariantList,
  Actions: ProductCardActions,
}
```

Usage:

```tsx
<ProductCard.Provider product={product}>
  <ProductCard.Root>
    <ProductCard.Title />
    <ProductCard.VariantList />
    <ProductCard.Actions>
      <AddToCart productId={product.id} />
    </ProductCard.Actions>
  </ProductCard.Root>
</ProductCard.Provider>
```

### Solid rules

1. **Keep signals as accessors.** Store and pass `Accessor<T>` values when the
   child should remain reactive. Read them with `value()` inside JSX, memos, or
   effects. Do not snapshot them into plain values during setup.
2. **Do not destructure reactive props into plain locals.** Use `props.foo`, an
   accessor like `() => props.foo`, or `splitProps` when separating local props
   from rest props.
3. **Use `createMemo` for expensive or shared derived values.** Do not use
   effects to write derived state that can be computed from signals.
4. **Use `<For>` for dynamic keyed collections.** Use `<Index>` only when order
   and length are stable but item values change frequently.
5. **Use `<Show>` for conditional regions.** Use `keyed` intentionally when the
   child block should recreate on value changes, not only truthiness changes.
6. **Use `children()` when you need to inspect, normalize, or reuse children.**
   Normal `props.children` is fine when simply rendering children once.
7. **Use `<Dynamic />` for polymorphic roots and dynamic component selection.**
   Prefer it over ad-hoc conditional branches when the only change is the root
   element or component type.
8. **Keep owner and lifetime scopes explicit.** Context lookup and cleanup
   are tied to Solid’s owner tree. Do not retain UI beyond the owner that created
   the signals, context, or resources it depends on.
9. **Prefer `class` and `classList` for Solid-native class composition.** Use a
   project class helper only when variant merging or Tailwind conflict handling
   actually matters.
10. **Do not apply React memo rules blindly.** Stable JSX identity and signal
    granularity matter more than `memo`, `useMemo`, or `useCallback`, which are
    React tools, not Solid tools.

## Astro: slots, server-first regions, and narrow islands

Astro composition should be slot-first. Astro components define the structural
regions, then callers fill those regions with static HTML, Astro components, or
small hydrated islands.

```astro
---
// ProductCard.astro
interface Props {
  variant?: "default" | "featured"
}

const { variant = "default" } = Astro.props
---

<article class:list={["product-card", `product-card--${variant}`]}>
  {Astro.slots.has("media") && (
    <div class="product-card__media">
      <slot name="media" />
    </div>
  )}

  <div class="product-card__body">
    <slot />
  </div>

  {Astro.slots.has("actions") && (
    <footer class="product-card__actions">
      <slot name="actions" />
    </footer>
  )}
</article>
```

Usage:

```astro
---
import ProductCard from "./ProductCard.astro"
import AddToCartIsland from "./AddToCartIsland.tsx"
---

<ProductCard variant="featured">
  <img slot="media" src={product.image.src} alt={product.image.alt} />

  <h2>{product.name}</h2>
  <p>{product.description}</p>

  <AddToCartIsland slot="actions" productId={product.id} client:visible />
</ProductCard>
```

### Astro rules

1. **Prefer `.astro` components and slots for static structure.** Do not hydrate
   a React or Solid component just to render a styled card, heading, or link.
2. **Use named slots for named regions.** Use the default slot for primary body
   content. Use `Astro.slots.has()` when wrappers should render only when a
   region exists.
3. **Push hydration down to the smallest interactive island.** A card can remain
   server-rendered while the add-to-cart action is a hydrated React or Solid
   child.
4. **Do not force provider/context composition across `.astro` slots.** If a
   region needs shared interactive state, make that whole interactive region a
   React or Solid island and place the provider inside that island.
5. **When passing named slots from Astro into React or Solid framework
   components, treat those slots as top-level props.** Keep names simple and
   prefer camelCase-compatible names.
6. **Preserve the browser contract with static HTML whenever possible.** Links
   should be anchors, forms should be forms, and actions that do not need client
   state should not become islands.

## Cross-framework decision table

| Need | React | Solid | Astro |
| --- | --- | --- | --- |
| Static named regions | Children or named subcomponents | Children or named subcomponents | Default and named slots |
| Shared interactive state | Context provider + hooks | Context provider + signals/accessors | Hydrated island containing React/Solid provider |
| Polymorphic root element | `as`/`asChild` pattern if project supports it | `<Dynamic component={...} />` | Pick the element in `.astro`; avoid client hydration |
| Dynamic list region | `.map()` with stable keys | `<For>` or `<Index>` | Render server-side list, or island if interactive |
| Conditional region | conditional JSX | `<Show>`, `<Switch>`, `<Match>` | slot presence, frontmatter branch, or island |
| Derived values | render calculation or `useMemo` | direct derived signal or `createMemo` | frontmatter calculation or island state |
| Child inspection | Avoid unless necessary; use `React.Children` carefully | `children()` when normalizing/reusing children | `Astro.slots.has()` or `<slot />` |

## Final checklist

Before adding a prop, render callback, or boolean mode, ask:

- Is this actually a named region the caller should compose?
- Is this a structural variant that deserves an explicit wrapper component?
- Is this state shared by multiple descendants or siblings?
- Does this need client-side state, or can Astro render it statically?
- In Solid, am I preserving signals as accessors and using control-flow
  components for dynamic regions?
- In React, am I preserving stable component identity and avoiding effects for
  derived state?
- Does the rendered output still preserve native button, link, form, focus, and
  accessibility semantics?

## When not to use this pattern

Do not make every primitive a compound component. A simple `Button`, `Input`,
`Icon`, or `Text` component can use normal props. Use this rule when the
component has multiple meaningful regions, multiple variants, or shared state
that crosses visual regions.

References:

- https://react.dev/reference/react/Children
- https://react.dev/reference/react/memo
- https://react.dev/reference/react/useMemo
- https://react.dev/reference/react/useCallback
- https://docs.solidjs.com/concepts/components/basics
- https://docs.solidjs.com/concepts/components/props
- https://docs.solidjs.com/reference/component-apis/children
- https://docs.solidjs.com/concepts/control-flow/dynamic
- https://docs.solidjs.com/concepts/control-flow/list-rendering
- https://docs.solidjs.com/reference/components/show
- https://docs.astro.build/en/basics/astro-components/
- https://docs.astro.build/en/guides/framework-components/
- https://docs.astro.build/en/reference/directives-reference/
