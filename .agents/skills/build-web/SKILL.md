---
name: build-web
description: Classify, design, implement, review, diagnose, or verify web work that spans content sites, stateful applications, server rendering, interactive islands, design systems, accessibility, motion, touch interactions, browser lifecycles, and shared frontend infrastructure. Use for hybrid or cross-surface web architecture and for shared renderer, component, asset, security, design, and browser-verification decisions. Compose with build-sites for content publishing or build-web-apps for application state; retain this skill for renderer semantics, accessibility, and browser verification even within one application. Compose with design-interfaces when visual hierarchy, layout, or polish changes.
---

# Build web systems

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



## Select the complete task

Read [applying standards](../../guides/applying-standards.md) before domain work.
Select companions by the contracts being changed, with one discovery pass,
plan, and verdict. For repository work, use the shared quality contract when installed
for naming, schemas, tests, documentation, validation, and completion. Apply
rules by purpose; test-runner imports and trivial private fixtures are not
public runtime APIs. If a companion is absent, use the bundled compact defaults
and inspect local instructions rather than inventing unavailable guidance.

Use this skill for renderer or browser contracts within one surface as well as
across surfaces. It is the shared web owner for renderer choice, browser behavior,
component-system integration, design and motion quality, asset delivery,
security, accessibility, and cross-surface verification.

`build-sites` owns content-first publishing. `build-web-apps` owns stateful
product applications. the shared quality contract owns repository completion.
`explore-ecosystems` owns dependency topology. Do not duplicate their work.

For visual creation, redesign, or polish, select `design-interfaces` when
installed. It owns visual judgment; this skill retains its implementation
contracts. A frontend logic change that leaves the design unchanged does not
need that companion.

## Outcome

Produce a web system where each surface has a clear owner and a reader can trace:

```text
route or entrypoint
   |
   v
render owner
   |
   +--> server/static data
   +--> client hydration
   +--> URL/session/local state
   +--> assets and components
   +--> browser resources
   |
   v
accessible, secure, measured user flow
```

The result must work in the browser, not only type-check or render a component in
isolation.

## Classify every surface first

For each app, route group, embedded island, or browser-facing entrypoint, record:

- purpose: marketing, content, docs, product, admin, authenticated account, or
  hybrid;
- render mode: static, prerendered, request-rendered, streamed, client-rendered,
  or mixed;
- renderer: native HTML, Astro template, Solid, React, Web Components, or another
  verified owner;
- state owners: URL, server request, remote cache, session, local interaction,
  durable data, and browser storage;
- component and asset owners: primitives, CSS/tokens, icon compiler, fonts,
  images, generated registries, and motion runtime;
- connected systems: auth, APIs, CMS, analytics, service workers, browser APIs,
  and deployment adapter;
- required user flows, failure states, performance budgets, and accessibility
  behavior.

A monorepo can contain several classifications. Do not force one framework
policy over an Astro docs site, a runtime CMS, and a TanStack application.

## Evidence preflight

Before editing a non-trivial web surface, inspect:

1. route manifests and reachable entrypoints;
2. rendering and hydration directives;
3. component registry/configuration and generated source;
4. CSS layers, design tokens, fonts, icons, and asset pipeline;
5. URL, query-cache, session, local, and durable state owners;
6. auth, cookies, CORS/CSP, server functions, API clients, and secrets;
7. browser-owned resources such as observers, workers, WebGL contexts, media,
   timers, streams, and listeners;
8. accessibility primitives and focus/keyboard behavior;
9. build configuration, deployment adapter, SSR output, and browser tests;
10. screenshots, traces, performance results, and real user-flow evidence when
    available.

Similar component names or framework packages do not prove compatible runtime
semantics. Inspect the exact installed version and integration.

## Shared implementation rules

1. **Native first.** Use semantic HTML and CSS before hydration when browser
   semantics already satisfy the interaction.
2. **One owner per state class.** URL state, remote records, session scope, local
   interaction, and durable business records have different lifetimes. Do not
   mirror the same authority into several stores without an explicit sync rule.
3. **Preserve renderer semantics.** Do not translate React effects or component
   lifetimes mechanically into Solid, Astro, or another renderer.
4. **Keep integration families aligned.** When the repository uses Unplugin
   Icons, generated component registries, Base UI/Kobalte/Corvu, or similar
   tooling, verify the renderer/compiler integration, virtual imports, SSR/SSG,
   tree-shaking, generated types, and built output. Do not add the ecosystem by
   habit.
5. **Treat design as behavior.** Choose an aesthetic direction and make layout,
   type, spacing, density, interaction, and motion support the product task.
   Motion should explain state, continuity, origin, feedback, or product
   personality. High-frequency operations should remain fast and restrained.
6. **Respect reduced motion and interruption.** Motion must have a reduced-motion
   policy and normally be interruptible. Clean up animation, observers, timers,
   listeners, WebGL resources, and media on lifetime end.
7. **Accessibility is executable behavior.** Verify semantic roles, names,
   keyboard paths, focus movement/restoration, touch targets, live updates,
   contrast, reduced motion, and zoom/reflow where applicable.
8. **Browser security is part of the surface.** Trace cookies, CSRF, CORS, CSP,
   webhooks, cross-origin messages, user HTML, secrets, PII, and server-only
   code. Never solve an origin/auth problem with a broad wildcard by default.
9. **Prefer local, deterministic first paint.** Fonts, icons, critical styles,
   and SSR output should not depend on a client-only race to become usable.
10. **Document non-obvious internal contracts.** Component state machines,
    focus rules, motion lifetimes, observer ownership, generated registries,
    responsive invariants, and performance-sensitive code deserve comments even
    when private.

## Failure and non-happy-path review

Actively test for:

- hydration mismatch or client-only masking of an SSR defect;
- stale URL/query/local state after navigation;
- session or tenant data leaking between requests or cache keys;
- event listeners, observers, media, workers, WebGL contexts, or animations that
  survive navigation;
- modal/drawer/menu focus traps or focus loss;
- keyboard-only, touch-only, and reduced-motion failures;
- generated icon/component imports that work in dev but not SSR/build output;
- font preloads that do not match actual requests;
- CORS/CSP/auth workarounds that broaden access;
- route-specific error states rendered as blank content or endless spinners;
- performance demos that collapse under representative data.

Use [failures.md](references/failures.md) when the symptom crosses renderer,
state, browser, security, or resource ownership.

## Verification ladder

Verify in increasing scope:

1. schema/type/component unit contracts;
2. renderer/build output and SSR/static HTML inspection;
3. focused browser interaction tests;
4. keyboard, focus, touch, reduced-motion, and responsive paths;
5. authenticated/deep-link/navigation state changes;
6. resource cleanup after navigation or component disposal;
7. performance on representative data and at least one realistic device class;
8. deployed-adapter behavior when deployment is part of the claim.

A successful production build does not prove a user flow. Lighthouse alone does
not prove interaction correctness. A screenshot alone does not prove lifecycle
or accessibility.

## Reference routing

- [surfaces.md](references/surfaces.md): route and application classification,
  render/state authority, and cross-surface ownership.
- [renderers.md](references/renderers.md): Astro, Solid, React, native HTML,
  islands, SSR, hydration, and renderer-specific lifetimes.
- [assets.md](references/assets.md): icon/font integration points, generated
  assets, component registries, privacy, and built-output verification.
- [components.md](references/components.md): component primitives, Zaidan,
  shadcn-style generation, Kobalte/Corvu, tokens, accessibility, and ownership.
- [motion.md](references/motion.md): motion purpose, presence, interruption,
  reduced motion, Solid lifetimes, Motion, Web Animations, WebGL, and cleanup.
  For a motion audit, begin at [audit from the visible symptom](references/motion.md#audit-motion-from-the-visible-symptom).
  For opportunities to add motion, use [where motion would help](references/motion.md#find-where-motion-would-help).
- [Touch interactions](references/touch-interactions.md): when a drag, swipe,
  hold, mobile scroll container, browser chrome, or keyboard changes how a
  control responds or whether it stays reachable.
- [security.md](references/security.md): forms, HTML, webhooks, auth, cookies,
  CORS/CSP, secrets, cross-origin behavior, and PII.
- [verification.md](references/verification.md): build, browser, accessibility,
  navigation, lifecycle, and performance matrices.
- [failures.md](references/failures.md): evidence-grounded failure signatures
  and correction paths.

When a surface is clearly content-first, route domain work to `build-sites`.
When it is clearly a stateful product application, route domain work to
`build-web-apps`. Keep this skill active only when shared web decisions remain.

## Completion gate

Do not call cross-surface web work complete until the intended routes are
reachable, rendering mode matches the data/session contract, browser behavior is
verified, important accessibility paths work, resource cleanup is proven,
security-sensitive paths are tested, and the built/deployed output was inspected
for the claims being made. Report unrun browser or deployment gates explicitly.

## Renderer and platform detail

Read [React patterns](references/react-patterns.md) for component API or measured
render/bundle decisions, then only the relevant rule file. Read
[platform research](references/platform-research.md) when browser capability or
support is uncertain. Select build-sites for Astro route/island ownership,
build-web-apps for product state, and design-interfaces for visual/motion purpose.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
