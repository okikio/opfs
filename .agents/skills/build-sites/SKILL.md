---
name: build-sites
description: Design, implement, migrate, review, diagnose, or verify content-first websites, marketing sites, documentation, blogs, feeds, and CMS-backed publishing. Use for Astro routes, layouts, content collections, live CMS adapters, content migrations, islands, SEO, structured data, feeds, redirects, fonts, icons, deployment adapters, and static or server rendering. Do not use as the primary skill for a stateful product application with substantial URL, query-cache, session, and local interaction state. Compose with design-interfaces when visual hierarchy, layout, or polish changes.
---

# Build content-first sites

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

This skill owns the publishing contract of a content-first web surface: content
authority, page composition, render mode, discovery metadata, feeds, redirects,
assets, previews, and deployment behavior.

When `build-web` is active, consume its renderer, component, motion, security,
and browser map instead of repeating discovery. the shared quality contract owns the
final completion verdict.

For visual creation, redesign, or polish, select `design-interfaces` when
installed. It owns visual judgment; this skill retains its implementation
contracts. A frontend logic change that leaves the design unchanged does not
need that companion.

## Outcome

A content-first site should have a traceable path from source content to the
published URL:

```text
content source
   |
   v
validated project model
   |
   v
route/layout/component
   |
   +--> metadata / structured data
   +--> sitemap / feeds
   +--> images / icons / fonts
   +--> optional island
   |
   v
built or request-rendered page
   |
   v
deployed URL and crawler/browser behavior
```

Do not let a CMS SDK, generated collection, or migration file become an implicit
second content model.

## Evidence preflight

Inventory:

- route tree, layouts, content collections, endpoints, redirects, and 404/500
  behavior;
- local Markdown/MDX/data files and external CMS/data sources;
- schemas, slugs, references, media, authors, categories, dates, drafts, and
  preview state;
- static/prerender/server output and deployment adapter;
- interactive islands and renderer/client directives;
- canonical URLs, titles, descriptions, Open Graph/Twitter metadata,
  structured data, sitemap, robots, RSS/Atom/JSON feeds, and pagination;
- image processing, fonts, icons, CSS, and content-security implications;
- cache/invalidation policy for live content;
- migration scripts, source-to-target mappings, and rollback/replay evidence;
- browser, link, accessibility, performance, and deployed-output tests.

A content schema describing an intended future collection is not proof that the
published route consumes it. Trace the actual page.

## Procedure

1. **Classify content authority.** Identify the canonical source for each content
   family. Separate migration input, authoring source, normalized project model,
   cache, and published output.
2. **Choose route rendering from data needs.** Static, prerendered, and
   request-rendered routes have different freshness, identity, cache, and
   deployment contracts. Do not select server rendering merely because the
   framework supports it.
3. **Validate before presentation.** Map external or legacy content into strict
   project-owned schemas/view models. Put important field meaning, units,
   defaults, and authoring examples on the schema fields that own the contract.
4. **Keep Astro surfaces in Astro when selected.** Prefer native HTML and Astro
   templates for content. Add scripts or framework islands only when the
   interaction requires them. Choose `client:*` directives deliberately.
5. **Define missing-content behavior.** Drafts, missing authors, broken media,
   unresolved references, unsupported rich blocks, and malformed metadata must
   have explicit preview/build/runtime behavior. Do not invent placeholder
   authors or silently drop required content.
6. **Own discoverability.** Canonical URL, alternate/hreflang policy, metadata,
   structured data, sitemap, feeds, pagination, and redirects are generated from
   the same route/content truth.
7. **Treat fonts and icons as build/runtime contracts.** Verify renderer
   integration, accessible names, preload correctness, privacy, subset/weight
   usage, generated types, and built asset paths.
8. **Keep migrations replayable.** Preserve source identity and mapping rules,
   validate the destination, and make partial failures visible. A migration that
   can only be rerun by manual cleanup is not complete.
9. **Document non-obvious publishing rules.** Slug normalization, reference
   resolution, draft filtering, feed selection, cache invalidation, and migration
   rules deserve comments/TSDoc when the code alone does not explain them.

## Non-happy paths

Test at least the applicable cases:

- duplicate or unstable slugs;
- missing required relations or media;
- invalid frontmatter/CMS records;
- a live CMS outage or stale cache;
- draft/preview content leaking into production;
- wrong canonical/redirect chains;
- feed/sitemap entries that do not match reachable pages;
- renderer island hydration failures;
- font/icon assets missing only in production output;
- unsanitized rich content;
- migration interruption and rerun;
- deployed adapter differences from local preview.

## Verification

Verify the page as a publication artifact, not only as a component:

1. schema/content tests and migration fixtures;
2. static/server build;
3. generated route list, redirects, sitemap, feeds, and metadata inspection;
4. internal and external link checks as appropriate;
5. browser accessibility and interaction for islands;
6. performance and asset/network behavior;
7. deployed adapter behavior when claimed;
8. clean rebuild or migration replay for generated content.

## Reference routing

- [astro.md](references/astro.md): Astro output, adapters, routing, layouts,
  islands, scripts, navigation lifecycle, and deployment behavior.
- [content.md](references/content.md): content authority, collections, live CMS,
  project models, drafts, media, references, cache, feeds, and migration.
- [site-quality.md](references/site-quality.md): metadata, structured data, SEO,
  accessibility, performance, assets, links, and verification.
- [icons.md](references/icons.md): Astro Icon, Unplugin Icons, renderer
  compilers, local SVG collections, accessibility, and bundle control.
- [fonts.md](references/fonts.md): Astro Fonts, Fontsource, local/variable
  fonts, privacy, preload, fallback metrics, and layout shift.
- [casebook.md](references/casebook.md): anonymized site architecture examples,
  counterexamples, and evidence classification.

Do not infer browser-extension support or application behavior from a site
repository name. Route stateful product work to `build-web-apps`.

## Completion gate

A site is not complete because `astro build` passed. The intended pages must be
reachable, content and relation failures must be handled as designed, metadata
and feeds must agree with route truth, interactive islands must work in the
browser, assets must resolve from built output, and the selected deployment
adapter must be verified for any deployment-specific claim.

## Astro source and neighboring owners

Read the maintained [Astro reference](references/astro.md) for the route/island decision in scope. Inspect the site or frontend app, the installed version, renderer imports, adapter and hydration directives. Historical audits and their scripts live in Git; they are not current gates.

Select build-web for browser/renderer/island lifetime and hydration, build-web-apps for session/URL/cache/product state, design-interfaces for visual/motion judgment, accessibility for detailed access testing and shadcn for its installed components. A .tsx filename does not identify React; an Astro page does not authorize changing the existing UI. Keep framework examples subordinate to the actual repository.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
