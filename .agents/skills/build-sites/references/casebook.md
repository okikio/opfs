# Site evidence casebook

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use these cases as reasoning patterns, not templates. Each case separates example architecture, useful pattern, counterexample, unresolved claim, and verification.

## Contents

- How to use the casebook
- Marketing site example
- Documentation site example
- Hybrid site and application with server auth
- Runtime CMS site example
- Solid motion experiment
- Cross-case decisions
- Sources and freshness

## How to use the casebook

For a similar repository:

1. Identify the current entrypoints, consumers, and installed versions.
2. Classify observed source as positive, counterexample, experimental, or unresolved.
3. Extract the ownership principle, not package/file names alone.
4. Recompute the decision for current routes and deployment.
5. Run the case's verification and failure checks.

## Marketing site example

### Example architecture

- Astro page imports marketing sections and prerenders the homepage even though project output defaults to server.
- Astro owns title/description, layout, content, headings, anchors, and sections.
- FAQ uses native `<details>/<summary>` and Astro Icon; a separate Solid accordion exists but is not imported.
- Hero hydrates a narrow Solid `DepthScene` with `client:visible`.
- DepthScene owns pointer state, reduced-motion query, animation frame, particles, WebGL runtime, and static image fallback.
- Solid cleanup cancels frames, removes listeners, removes media query listener, destroys particles, and destroys WebGL.
- Astro config includes Solid, Astro Icon, Unplugin Icons, fonts, Markdown, sitemap, server adapter, and experimental options.

### Useful decisions

```text
Static document and CTA
  -> Astro HTML

Disclosure
  -> native details/summary + CSS

Decorative depth effect
  -> one Solid island
  -> static image fallback
  -> decorative aria-hidden canvas
```

The island hydration scope corresponds to resource ownership, not visual region size.

### Counterexamples/review targets

- `BaseHead` attaches link listeners on every `astro:page-load` without cleanup or delegation.
- It prevents default behavior for all hash anchors, which requires focus/history/reduced-motion care.
- Astro Icon includes wildcard collections, which needs bundle verification.
- Multiple fonts are preloaded, which needs waterfall and critical-face review.
- CSP is disabled in the shown configuration, which is not a production security recommendation.
- The renderer compiler and package versions must be verified; do not copy config by shape.

### Verification

- inspect built homepage for only the intended island;
- disable JS and confirm content/FAQ/CTA/static hero remain;
- force WebGL and texture failure;
- toggle reduced motion and navigate repeatedly;
- assert listener/frame/WebGL cleanup;
- inspect icon/font output and CSP/resource needs.

## Documentation site example

### Example architecture

- Separate Astro app uses static output.
- `getStaticPaths()` enumerates service catalog entries.
- per-service pages render a Scalar reference wrapper.
- JSON routes emit service catalogs and service OpenAPI documents.
- service schema/factory packages are build inputs.
- docs explain credentialed cookie testing for an authenticated billing API.

### Useful decisions

```text
service endpoint/schema factories
  -> docs service catalog
  -> static service pages
  -> static OpenAPI JSON
  -> runtime services
```

The static docs build proves that API reference richness does not imply runtime SSR. It also creates a drift risk: the build and services must consume the same factories and compatible versions.

For browser “try it,” the docs origin, service origin, cookie scope, trusted origins, and credentialed CORS form one contract. A copied cookie header is not a bearer token.

### Verification

- build without production database/provider secrets;
- diff generated OpenAPI artifacts;
- validate refs, operation ids, examples, and service origins;
- crawl every generated service page/JSON path;
- run allowed and rejected credentialed CORS from the docs origin;
- confirm examples/logs contain no credentials.

## Hybrid site and application with server auth

### Example architecture

- Astro server output and Node-targeted auto adapter.
- React integration for form and application islands.
- auth pages are on-demand and server-resolve public auth capabilities.
- TanStack Form owns local field state/validation timing; Better Auth owns auth requests/session.
- middleware derives route intent and cache/security headers.
- Astro layouts own document and shell composition; slots provide route-specific regions.
- URL helper functions preserve/removes query values for server-rendered views.
- richer data-grid examples use TanStack Table plus TanStack Virtual.

### Useful decisions

```text
Astro server/middleware
  -> route intent, session, cache, document layout
  -> public auth capability view model
  -> React form island
      -> TanStack Form local draft/errors
      -> Better Auth client request
```

The client sees enabled provider ids, not server environment configuration. Field labels, autocomplete, touched errors, pending actions, and method-specific pending state are explicit.

### Counterexamples/review targets

- route-prefix classification can make security mistakes when new routes are added;
- `validateSecrets: false` and optional secrets need startup/runtime contract tests;
- headers include obsolete `X-XSS-Protection` and lack a demonstrated CSP;
- wildcard icons and many font families need bundle/waterfall review;
- disabling buttons controls UX but is not server idempotency.

### Verification

- enumerate every route against route intent;
- prove public/auth/auth-required/app cache and session behavior;
- import client bundle without server env;
- test native/server validation plus form pending/error/focus;
- test expired session, auth callback/origin, and provider capability mismatch;
- inspect route bundles, fonts, icons, and headers.

## Runtime CMS site example

### Example architecture

- Astro server output with auto-selected adapter and Emdash integration.
- local SQLite/media defaults for development, with configured runtime env.
- one live collection loader for Emdash.
- project `cms.ts` maps provider entries into article/author/topic/category/media view models.
- mapping resolves relationships, headings, plain text, dates, publication status, and cache hints.
- article/listing/taxonomy/feed routes consume the adapter.

### Useful decisions

The adapter prevents provider records from becoming the page contract. Provider-specific Portable Text remains at the content renderer handoff. Legacy local content can remain migration input without being a second runtime source.

### Counterexample endpoint

The webhook source must not be copied:

- logs API key and complete environment;
- logs payload fields containing PII;
- no demonstrated raw-body signature verification or replay window;
- broad passthrough payload schema;
- provider extraction, group mapping, delivery, and logging are tightly coupled;
- error exposure and idempotency are not a proven production contract.

The mapping tables may be useful domain data after validation. The endpoint lifecycle is negative evidence.

### Verification

- public/draft/preview direct/list/feed parity;
- missing relations/media and invalid rich text;
- provider outage/cache behavior and N+1 count;
- XSS through blocks, marks, links, embeds, and search snippets;
- webhook signature/replay/idempotency/redaction rewrite;
- adapter target, storage, sessions, and environment startup.

## Solid motion experiment

### Observed scope

- Solid-owned MotionState and reactive option snapshots;
- framework-neutral `motion-dom` value/DOM primitives;
- pure server initial-style resolution;
- server-render plus hydration-diagnostic tests;
- `PresenceChild` completion aggregation;
- single-slot `AnimatePresence` with limited modes;
- explicit research on priority, layout timing, presence, and Solid 2 risk.

### Correct interpretation

This is strong evidence about the seams a Solid animation adapter needs. It is experimental evidence, not proof of full gesture, keyed-list presence, layout projection, or Solid 2 parity.

The case teaches:

- type/API surface must follow runtime capability;
- logical removal and physical owner retention are separate;
- initial styles must be pure and hydration-identical;
- cleanup must survive retained exits;
- high-level animation-engine internals should not be adopted until adapter seams exist.

### Verification

- target priority/cancellation tests;
- explicit/false/omitted initial SSR-hydration tests;
- nested/zero-animation/cancel/reentry presence cases;
- keyed-list claims forbidden until executable coverage exists;
- resource and owner counts after disposal.

## Cross-case decisions

| Decision | Evidence lesson |
|---|---|
| Native versus island | Choose by behavior and lifetime, not file type |
| Static versus server | Choose by request-time dependency per route |
| Content source | One runtime owner plus project mapping |
| Auth capability | Server derives; client receives minimal public model |
| Generated docs | Share service factories; build statically when possible |
| Motion | Claim only implemented/tested lanes and lifetime behavior |
| Uploaded code | Distinguish positive, counterexample, and experimental source |
| Configuration | Verify installed version and target runtime before copying |

## Sources and freshness

- Historical source scope: marketing, documentation, hybrid application, runtime CMS, and experimental Solid motion reviews from 2026-07-17, adapted into anonymized cases.
- These illustrative cases preserve ownership and failure lessons. Verify package APIs, versions, active consumers, experimental configuration, and runtime behavior in the target repository.
