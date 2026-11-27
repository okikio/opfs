
# Astro Interface Instructions

Use Astro for content-heavy, route-level, layout, marketing, documentation, and server-rendered interface work. Astro should be the default for pages that do not require persistent client-side interaction.

Apply the universal web interface guidelines first. Use this file for Astro pages, layouts, content collections, MDX, client scripts, integrations, endpoints, and framework components imported into Astro.

Do not apply Astro island rules to ordinary React, Solid, or SPA code outside an Astro surface.

## Mental model

Astro is server-first. `.astro` components render HTML. Component frontmatter runs on the server or at build time, and client JavaScript is not shipped by default.

Start with HTML, props, and slots. Add a hydrated framework island only when the interaction needs client runtime state.

Write Astro so that:

- Static and server-rendered content stays static or server-rendered.
- Slots express composition and named regions.
- Islands are narrow and intentional.
- Hydration directives match the interaction urgency.
- Client scripts are used only for page-level browser behavior that does not need framework state.
- Server/client handoffs do not leak secrets, browser APIs, or non-serializable values.

## Work in priority order

When writing or reviewing Astro, reason in this order:

1. Preserve server-first and static-first rendering where it fits the page.
2. Hydrate only the smallest interactive island that needs browser behavior.
3. Choose the narrowest `client:*` directive that satisfies the interaction.
4. Use slots and named regions instead of React-shaped render props.
5. Keep data fetching, routing, and content freshness aligned with the route.
6. Preserve progressive forms, links, metadata, and document semantics.
7. Keep scripts safe across navigation and view transitions.
8. Optimize images, assets, CSS, and bundle cost.
9. Make async, fallback, error, and recovery states explicit.

## Use `.astro` for server-rendered structure

Use `.astro` for:

- Pages and layouts.
- Static or server-rendered components.
- Content collection rendering.
- SEO, metadata, Open Graph, and structured document regions.
- Composition wrappers that arrange static content and framework islands.
- Route-level data loading that does not require client state.

Use React or Solid islands only for client-owned interactivity.

Avoid hydrating a card, section, heading, or marketing region just because it is a reusable component.

## Compose with slots and named regions

Astro composition is slot-first.

Use:

- The default `<slot />` for primary body content.
- Named slots for stable regions like `media`, `actions`, `aside`, `footer`, or `toolbar`.
- `Astro.slots.has()` when wrappers should render only if the caller supplied that region.
- Props for serializable data and variant values.

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

Do not use render-prop APIs for Astro structure. Astro cannot pass executable render props from frontmatter into hydrated framework components as client callbacks. Use slots or move the interactive composition into the island.

## Keep named slots simple across framework islands

When Astro passes named slots into React, Preact, or Solid framework components, those named slots become top-level props. Kebab-case slot names become camelCase props.

Prefer simple names:

```astro
<FrameworkCard client:visible>
  <h2 slot="title">Featured comic</h2>
  <AddToCart slot="actions" productId={product.id} />
</FrameworkCard>
```

Avoid slot names that require awkward prop access or hide the rendered structure.

## Hydrate the smallest island

Choose the narrowest island that owns the interactive state.

Prefer:

```astro
<ProductCard>
  <img slot="media" src={product.image.src} alt={product.image.alt} />
  <h2>{product.name}</h2>
  <AddToCartIsland slot="actions" productId={product.id} client:visible />
</ProductCard>
```

Avoid:

```astro
<ProductCardIsland product={product} client:load />
```

unless the entire card genuinely needs client-owned state.

Use directives intentionally:

- `client:load` for immediately needed interactivity.
- `client:idle` for non-critical interactivity.
- `client:visible` for below-the-fold islands.
- `client:media` when the island is only relevant for a media query.
- `client:only` only when server rendering is impossible or unsafe.

Review every hydrated component by asking: what user interaction breaks if this JavaScript never loads?

## Keep island state inside the island

Do not force provider or context composition across `.astro` slots.

If multiple interactive regions need shared client state, create one island that owns that state and render the interactive regions inside it.

```astro
---
import ProductPurchaseIsland from "./ProductPurchaseIsland.tsx"
---

<ProductCard>
  <img slot="media" src={product.image.src} alt={product.image.alt} />
  <h2>{product.name}</h2>
  <ProductPurchaseIsland slot="actions" product={product} client:visible />
</ProductCard>
```

If islands need to communicate, prefer:

- URL state for shareable navigation state.
- Server actions or form submissions for durable mutations.
- Shared backend data or cache invalidation for persistent state.
- Custom browser events only for narrow page-local coordination.

Avoid global client stores just to coordinate static Astro regions.

## Use server islands and fallbacks deliberately

Use server islands or deferred rendering when a mostly static page has a server-rendered region that can load independently.

Ensure:

- The fallback has stable layout and useful text.
- The deferred region has a clear loading, error, and recovery path.
- Personal or privileged data is not cached at the wrong level.
- The page remains meaningful before the deferred region resolves.

Example shape:

```astro
<StaticProductOverview product={product} />
<UserSpecificPrice server:defer productId={product.id}>
  <PriceSkeleton slot="fallback" />
</UserSpecificPrice>
```

Use this for server-owned personalization, not client interaction that belongs in an island.

## Use forms and actions progressively

Prefer real forms for submissions.

```astro
<form method="post" action="/newsletter">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required />
  <button type="submit">Join newsletter</button>
</form>
```

Use Astro actions or endpoint-backed submissions when the route owns the mutation. Add a hydrated island only when the form needs client-only behavior such as live validation, dependent fields, optimistic previews, or complex wizard state.

Ensure:

- Submission works or fails gracefully without optional JavaScript when practical.
- Field errors are rendered near fields.
- Pending state prevents duplicate submission when needed.
- Failed submission preserves input unless clearing is safer.
- Server validation remains authoritative.

## Use client scripts for page-level browser behavior

Use Astro `<script>` for small page-level behavior that does not need framework state.

Good uses:

- Theme initialization.
- Small analytics hooks.
- Progressive enhancement for static controls.
- Browser event wiring for static markup.

Keep scripts safe across client-side navigation and view transitions:

- Avoid registering duplicate listeners.
- Clean up observers, timers, and animation loops when needed.
- Account for scripts that may run again after navigation.
- Prefer idempotent initialization.

```astro
<script>
  const root = document.documentElement
  root.dataset.theme = localStorage.getItem("theme") ?? "system"
</script>
```

Do not put product state machines into loose page scripts when a framework island would make ownership, cleanup, and testing clearer.

## Keep routing, content, and freshness explicit

Match route rendering to the content lifecycle:

- Static generation for stable content.
- Server rendering for request-specific data.
- Deferred server regions for independent server-owned regions.
- Hydrated islands for client-owned interactions.

For content collections and MDX, keep document structure, headings, links, code blocks, and media semantics intact.

When data can become stale, define whether the page rebuilds, renders per request, revalidates, or fetches inside an island.

## Use view transitions carefully

Use view transitions to preserve spatial continuity and reduce navigation jank.

Ensure:

- Navigation remains accessible without animation.
- Focus moves to the correct new content after navigation.
- Reduced-motion preferences are respected.
- Scripts and event listeners do not duplicate after transitions.
- Persistent elements do not retain stale state incorrectly.

Avoid using transitions to hide slow data or broken loading states.

## Optimize images and assets by default

For images:

- Use Astro image tooling or project image helpers where available.
- Provide width and height or stable layout constraints.
- Use meaningful alt text or decorative empty alt text.
- Avoid lazy-loading critical images that affect first impression.
- Use responsive image sizes for cards, hero images, and content images.

```astro
---
import { Image } from "astro:assets"
import cover from "../assets/cover.png"
---

<Image src={cover} alt="Cover art for The Night Market" widths={[320, 640, 960]} />
```

For icons, keep decorative icons hidden and give icon-only controls accessible names.

## Use scoped CSS and global styles intentionally

Astro scoped styles are a good default for component-local styling.

Use global styles for:

- Design tokens.
- Reset or base typography.
- Theme variables.
- Document-level layout.
- Third-party content styling when scoped styles cannot reach it cleanly.

Use `class:list` for conditional classes.

```astro
<div class:list={["callout", important && "callout--important"]}>
  <slot />
</div>
```

Avoid hydrating a framework component only to compute classes.

## Preserve content safety

Be careful with raw HTML, markdown, MDX, remote content, and user-generated content.

Ensure:

- Untrusted HTML is sanitized before rendering.
- Markdown and MDX plugins do not introduce unsafe output.
- External links follow project security rules.
- Code blocks and embedded media preserve accessibility.
- `set:html` or equivalent raw insertion has a documented trusted source.

Avoid mixing trusted and untrusted content paths without a clear handoff.

## Model async, errors, and loading in Astro surfaces

For server-rendered pages:

- Decide whether errors should produce a route error, inline recovery UI, fallback content, or redirect.
- Avoid blank pages for missing optional data.
- Use not-found behavior intentionally for missing route entities.
- Keep stable layout around loading or deferred regions.
- Do not leak server error details into user-facing pages.

For islands:

- The island owns its client loading, empty, error, retry, and success states.
- Serialized props should be minimal and safe.
- The server-rendered fallback should remain meaningful before hydration.

## Keep browser APIs out of frontmatter unless they are server-safe

Astro frontmatter does not run in the browser.

Avoid:

```astro
---
const width = window.innerWidth
---
```

Prefer server-safe defaults and client enhancement:

```astro
<div data-enhance-layout></div>

<script>
  document.querySelector("[data-enhance-layout]")?.setAttribute("data-ready", "true")
</script>
```

## Keep bundle cost visible

Astro's performance advantage comes from not shipping JavaScript by default. Preserve that advantage.

Review:

- Hydrated island count.
- `client:load` usage.
- Framework imports in pages that could stay static.
- Large libraries inside islands.
- Duplicate framework runtimes.
- Client scripts that run on every page.
- Images and media weight.
- CSS that blocks or bloats critical rendering.

Do not turn a mostly static page into an SPA without a product reason.

## Test Astro through rendered output and handoffs

Test:

- Rendered HTML semantics.
- Slot presence and wrappers.
- Hydration directives and island hydration scopes.
- Forms and actions.
- Routing, content collection behavior, and missing content.
- Client scripts across navigation and view transitions.
- Image output and alt text.
- Accessibility names, headings, and keyboard behavior.
- No unnecessary client JavaScript for static pages.

## Review what you wrote

Before considering Astro UI complete, ask:

- Could this be static or server-rendered instead of hydrated?
- Is the island as small as possible?
- Is the `client:*` directive the narrowest one that satisfies the interaction?
- Are slots used for structure and props used for data?
- Does any shared interactive state belong inside one framework island?
- Are forms progressive and server-validated?
- Are scripts idempotent across navigation and view transitions?
- Are images, CSS, and assets optimized?
- Are async, fallback, error, and not-found states handled?
- Is content safe when sourced from markdown, MDX, remote APIs, or users?

For every important finding, show the concrete Astro fix.

## Astro anti-patterns to avoid

Avoid:

- Hydrating static components.
- Hydrating a whole page for one interactive button.
- Using `client:load` by default.
- Using `client:only` because SSR output was not designed carefully.
- Render props for Astro composition.
- Expecting Astro frontmatter functions to become client callbacks.
- Provider/context composition across `.astro` slots.
- Global stores for coordination that should be URL state, server state, or one island.
- Browser APIs in frontmatter.
- Scripts that duplicate listeners after navigation.
- Raw HTML from untrusted sources.
- Missing fallback or recovery UI for deferred regions.
- Unoptimized images or layout-shifting media.
- Turning content pages into SPAs without a product reason.
