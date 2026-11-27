# Site quality gates

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference to define acceptance criteria for public sites and documentation. Quality is a set of observable route contracts, not a Lighthouse score or attractive screenshot.

## Contents

- Quality inventory
- Document and accessibility contract
- Content and discoverability
- Performance budget
- Resilience and progressive enhancement
- Security and privacy
- Visual and interaction quality
- Deployment and operations
- Verification matrix
- Sources and freshness

## Quality inventory

For each route family record:

```text
Audience and user task:
Primary content/action:
Static/request-time/deferred rendering:
Canonical and index policy:
Required JavaScript/islands:
Images/fonts/icons/embeds:
CMS/API/auth dependencies:
No-JS behavior:
Failure fallback:
Performance budget:
Accessibility risks:
Privacy/security trust transitions:
Deployment adapter and cache:
```

Use budgets tied to the route. A WebGL marketing hero, API reference, article, and authenticated settings page need different checks.

## Document and accessibility contract

Every page needs:

- correct `<html lang>` and unique, front-loaded title;
- one useful main landmark, restrained landmarks, and a skip link when repeated navigation exists;
- meaningful heading outline;
- link purpose that remains understandable out of context;
- native interactive elements where possible;
- visible focus and logical order;
- accessible names for icon-only controls;
- labeled forms, instructions, field errors, and submission status;
- image alternatives and decorative SVG/canvas removed from the accessibility tree;
- semantic tables and text/data alternatives for charts;
- usable zoom/reflow, contrast, forced colors, coarse pointer, and reduced motion;
- route announcement/focus behavior during client navigation.

Automated accessibility checks cannot validate focus strategy, announcement quality, alt usefulness, or whether a custom widget implements its keyboard contract. Inspect the accessibility tree and perform keyboard/screen-reader smoke tests.

Native HTML can eliminate entire defect classes. The marketing example's `<details>` FAQ is preferable to an unused hydrated accordion when ordinary disclosure semantics are sufficient.

## Content and discoverability

Validate from the actual mapped content model:

- page title, description, canonical, social card, and structured data;
- absolute production URLs with correct base path;
- sitemap, robots, feed, pagination, taxonomy, and archives;
- draft/preview/scheduled exclusion;
- canonical and redirects for migrated slugs;
- missing author/media/taxonomy and deleted content behavior;
- heading ids/table of contents stability;
- code/reference links and OpenAPI schema links;
- useful 404 and error pages.

Do not generate metadata independently in page, feed, and sitemap layers. A shared view model/policy should make them agree.

For API docs, diff generated OpenAPI and route catalogs. Ensure examples contain no real tokens, cookies, secrets, private hosts, or customer data.

## Performance budget

Measure the route rather than repeating generic advice:

| Resource/work | Evidence |
|---|---|
| HTML | Required content present before JS; reasonable size |
| JavaScript | Per-island chunks, duplicate renderer runtimes, unused islands |
| CSS | Critical styles, generated component layers, unused/global cost |
| Images | Intrinsic dimensions, responsive sources, format, priority, alt |
| Fonts | Critical faces only, subset/variants, preload, fallback metrics |
| Icons | Finite imports/collections; renderer/compiler match |
| Third parties | Origin, blocking cost, consent, failure isolation |
| Motion/WebGL | frames, long tasks, DPR/texture cap, background/offscreen suspension |
| DOM/rendering | large lists, `content-visibility`, layout/paint cost |

Track Core Web Vitals in representative conditions, but keep causal artifacts such as waterfalls, traces, bundle analysis, and long-task/frame evidence. A score alone does not identify ownership.

For `content-visibility: auto`, target large below-fold sections, pair with `contain-intrinsic-size`, and test keyboard accessibility. Do not apply it indiscriminately above the fold.

## Resilience and progressive enhancement

Test:

- JavaScript disabled or island chunk blocked;
- slow and failed images, fonts, icons, third-party embeds;
- no WebGL/context/texture and reduced motion;
- CMS/API timeout, invalid record, stale cache, and outage;
- repeated Astro client navigation, back/forward, and hash links;
- offline/static-asset caching if claimed;
- form/server validation when client validation is bypassed;
- preview/auth expiration;
- deployment cold start and missing binding/env;
- 404/500 and maintenance/error pages.

Progressive enhancement means the primary task has a defined baseline, not that every flourish works without JavaScript. State the baseline per route.

The illustrative depth scene keeps a static image when WebGL initialization fails. This is the correct ownership shape for decorative enhancement: content and calls to action remain Astro HTML.

## Security and privacy

Verify:

- raw/rich content renderer against XSS payloads;
- public forms for CSRF/origin, rate/spam, validation, size, and duplicate policy;
- webhooks for raw-body signature, replay, idempotency, and redacted logs;
- CSP/resource origins, frame policy, referrer and permissions policy;
- external links, iframes, embeds, analytics, and consent;
- cache policy for preview/personalized pages;
- no secrets/PII in HTML, JS, metadata, URLs, generated docs, logs, or source maps.

Do not count obsolete `X-XSS-Protection` as modern XSS defense. Do not disable CSP because an integration was not inventoried.

## Visual and interaction quality

Inspect real content and states at multiple sizes:

- primary hierarchy and action remain clear;
- no clipping, overlay collision, layout shift, or horizontal page scroll;
- long titles, translated labels, large text, and missing media;
- focus, hover, pressed, selected, disabled, invalid, loading, and error states;
- sticky headers/rails and safe areas;
- readable line length and typography before/after font load;
- light/dark/forced-color consistency;
- reduced-motion replacement;
- touch target and coarse-pointer usability;
- visual fallback for canvas, image, and embed failure.

Do not use a Mermaid chart when a short sequence/table is clearer. Diagrams should clarify relationships, not decorate documentation.

## Deployment and operations

Verify the target adapter and host:

- build artifact and startup command;
- runtime version and APIs;
- environment/bindings and secret scope;
- static asset, image service, and media storage paths;
- redirects, headers, compression, cache/CDN behavior;
- server island and session support;
- canonical origin and preview domains;
- logs, correlation ids, error monitoring, and redaction;
- health/readiness behavior where applicable.

`astro dev` or a generic preview does not prove target-host behavior. Run an adapter-equivalent smoke or document the block.

## Verification matrix

1. Repository lint/type/content checks and Astro check.
2. Static/server production build and route/artifact inspection.
3. Link, canonical, feed, sitemap, robots, redirect, and OpenAPI validation.
4. Raw HTML/no-JS assertions and hydration diagnostics.
5. Browser keyboard, focus, accessibility-tree, zoom, responsive, touch, reduced-motion tests.
6. Screenshots for happy and failure states at narrow/desktop/stress sizes.
7. Bundle/waterfall/CWV/long-task/resource-lifetime evidence.
8. XSS, form, cache, auth/preview, webhook, and header checks.
9. CMS/API/media/WebGL/third-party failure injection.
10. Target-adapter startup and representative deployed request.

Report passed, failed, blocked, and not-run separately. Never translate a local build into a deployed, accessible, secure, or performant verdict without corresponding evidence.

## Sources and freshness

- Historical source scope: marketing, documentation, application, and runtime CMS reviews from 2026-07-17, adapted into anonymized quality examples.
- Modern Web Guidance accessibility, forms, security, and deferred-rendering guides retrieved 2026-07-17.
- Astro view-transition accessibility: https://docs.astro.build/en/guides/view-transitions/ (reviewed 2026-07-17).
- Performance thresholds, browser support, and deployment behavior are environment-sensitive. Use the project's declared targets and measured baselines.
