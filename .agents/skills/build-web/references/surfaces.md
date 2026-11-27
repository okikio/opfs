# Web surface classification and ownership

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference before choosing a framework, renderer, hydration directive, state library, or deployment adapter. The repository name and dependency list are not enough. Classify each reachable route and subsystem from runtime evidence.

## Contents

- Required evidence inventory
- Surface and route classification
- Ownership decisions
- Anonymized repository examples
- Decision record
- Failure paths
- Verification
- Sources and freshness

## Required evidence inventory

Inspect the active graph before proposing architecture:

1. Route and endpoint entrypoints, including catch-alls, middleware, layouts, generated route trees, content configuration, and server functions.
2. Build output, adapter, deployment runtime, prerender exports, cache middleware, redirects, and headers.
3. Framework integrations and which `.astro`, `.tsx`, `.jsx`, custom-element, or plain-script files are actually imported.
4. Data sources: local content, build-time factories, request-time CMS, auth/session, query cache, database, browser persistence, and URL parameters.
5. Client resources: listeners, observers, animation frames, workers, WebGL contexts, media queries, subscriptions, retained roots, and cleanup.
6. Failure contracts: no JavaScript, no network, stale CMS, expired session, blocked storage, no WebGL, asset failure, and unsupported browser feature.
7. Connected systems: auth mount and base URL, CORS and cookies, CMS cache hints, OpenAPI factories, icon/font compilers, deployment adapter, and test runtime.

Treat unused files, installed packages, research notes, migration inputs, and commented prototypes as evidence of exploration. They become architecture only when reachable from an entrypoint or named as an intended target by the task.

Useful inspection commands include:

```sh
rg --files | rg '(astro\.config|package\.json|src/pages|src/routes|middleware|content\.config|live\.config|components\.json)'
rg -n 'client:(load|idle|visible|media|only)|server:defer|prerender|output:|adapter:' .
rg -n 'addEventListener|requestAnimationFrame|ResizeObserver|IntersectionObserver|createRoot|subscribe' src
rg -n 'from ["\x27](react|solid-js|@astrojs/|@tanstack/|better-auth)' src
```

## Surface and route classification

Classify at route or route-group granularity. A repository can contain several surfaces.

| Surface | Default document owner | Typical rendering | Durable state owner | Escalation signal |
|---|---|---|---|---|
| Marketing or editorial | Astro/static document layer | Static HTML; isolated hydration | Content source and URL | Request-time personalization or live CMS preview |
| Documentation/API reference | Astro/static document layer | Build-time pages and JSON artifacts | Service-owned schemas/factories | Private viewer-specific documentation |
| Runtime CMS site | Astro server routes | Request-time or cached SSR | CMS mapped through project view models | Author preview, live collections, dynamic plugins |
| Product application | Application router | SSR plus client reactivity | URL, query cache, local UI, session, server | Long-lived workflows or offline synchronization |
| Hybrid product/marketing | Route-level split | Static public routes plus SSR app routes | Different owner per route group | Shared shell must not erase cache/security differences |
| Embedded widget | Host document plus isolated component | Script/custom element or island | Explicit embed instance | Cross-origin messaging, versioned embed contract |
| Browser extension | Extension runtime | Manifest/context-specific | Extension storage/background context | Content-script, service-worker, and permission scopes |

Ask these questions for every route:

- Can the response be generated without the incoming request?
- Does it depend on identity, cookie, organization, entitlement, locale, preview token, or live data?
- Must the state survive refresh, be shareable, or participate in browser history?
- Is the data remote server state, local interaction state, session state, or derived display state?
- Which renderer owns the DOM subtree after hydration?
- What remains usable before JavaScript loads or when it fails?
- What cache policy is safe for this exact response?
- Does a deployment adapter provide a required capability, or was one added without a route need?

Do not infer that `output: "server"` makes every route dynamic. An Astro server project can and should set `export const prerender = true` on static routes. Conversely, static output cannot read request-time cookies during page generation.

## Ownership decisions

Write down one primary owner per concern. Split ownership by concern, not by convenience.

| Concern | Valid owner examples | Invalid split |
|---|---|---|
| Route and canonical URL | Astro route or application router | Component-local string concatenation in many islands |
| Request identity and authorization | Server middleware/service | Browser visibility checks presented as security |
| Shareable filters/sort/page | Validated URL schema | Duplicated URL, component state, and query state |
| Remote result lifecycle | Query cache or route loader | Copying query results into a second global store |
| Draft input | Form/component state | Writing every keystroke to remote cache |
| CMS provider record | Source adapter | Raw provider fields spread across pages |
| Layout and metadata | Document framework/layout | Each interactive island mutating document head |
| Interactive subtree | One renderer | Two frameworks mutating the same DOM nodes |
| Browser resource | Mounted owner with cleanup | Module singleton with no disposal policy |
| Stable static result | Server/build generator | Client fetching content already known at build time |

A useful route decision record is:

```text
Route: /search
Response: request-time, organization-scoped
Document owner: application router
URL state: query, technology filters, sort, page, page size
Remote state: canonical query-options factory keyed by organization + validated URL
Local state: query draft before debounce, selected row ids, open dialogs
Security: server derives organization; client cannot supply authority
Failure: route error region, retry, empty state, expired-session redirect
Verification: direct URL, reload, back/forward, cross-org request, SSR hydration
```

## Anonymized repository examples

### Marketing site

The illustrative homepage imports Astro sections and uses native `<details>` for FAQ disclosure. A separate Solid `Faq.tsx` exists but is not imported by the homepage. The example import graph supports:

- Astro ownership for page copy, headings, anchors, metadata, and section layout;
- native disclosure with no hydrated FAQ bundle;
- one narrow Solid island for the WebGL depth scene because it owns pointer input, media-query state, animation frames, WebGL, and cleanup;
- a static fallback image inside the island for context or texture failure.

Do not conclude that every `.tsx` marketing component is an island. Do not hydrate the unused Solid FAQ merely because it is more abstract.

### Documentation application

The docs package uses static output and generates service pages plus OpenAPI JSON endpoints from service-owned factories. Rich API references do not require a runtime server when the schemas are build inputs. The product frontend remains a separate SSR application with auth and query state.

This is a multi-surface monorepo:

```text
service schemas/factories
  -> static docs catalog and OpenAPI JSON
  -> runtime API handlers

product frontend
  -> request-scoped auth and organization
  -> URL/query/local state
```

### Hybrid application with server auth

A hybrid application configures Astro server output and marks auth pages `prerender = false`. Server code derives enabled auth capabilities and passes only client-safe provider identifiers into React form islands. Middleware classifies public, auth, auth-required, and app routes before applying session and cache policy.

The architecture is not “Astro versus React.” Astro owns request routing, layouts, middleware, response headers, and document output; React owns the form interaction subtree.

### Runtime CMS site

The site has a runtime CMS integration and a project-owned `cms.ts` adapter. The adapter maps provider records into article, author, topic, category, image, and page models. This adapter interface is reusable. The webhook file is counterexample evidence: it logs environment/secrets and payload data, lacks a trustworthy verification step, and mixes extraction, provider mapping, and delivery.

Never generalize “the repository uses this” into “this is approved.” Inspect behavior and tests.

### Name-only extension or app classification

A repository called “browser,” “extension,” or “desktop” is not enough. Require a manifest, background/service-worker entrypoint, content script, extension APIs, runtime permissions, or packaging config. If those are absent, report the mismatch instead of inventing an extension architecture.

## Decision record

Before implementation, record:

```text
Surface and routes:
Active entrypoints:
Static/request-time/deferred execution modes:
Document owner:
Interactive owners:
URL state:
Remote/cache state:
Local/session state:
Auth and tenant authority:
Cache policy:
No-JS/failure fallback:
Deployment adapter requirement:
Connected-system contracts:
Validation commands:
Behavioral verification:
Unresolved evidence:
```

If evidence is unresolved, use conditional language and inspect the installed version or source. Do not fill a missing runtime contract with a familiar framework pattern.

## Failure paths

Define what the user sees and what operators can inspect for:

- static build cannot reach content source;
- request-time CMS is unavailable or returns invalid rich text;
- session expires during navigation or submission;
- JavaScript bundle, island, WebGL texture, or font fails;
- query is stale, partially loaded, or invalidated during interaction;
- client hydration sees different time, randomness, locale, media, or storage state;
- repeated client navigation re-runs page initialization;
- deployment adapter lacks streaming, image, session, or runtime API support;
- user opens a deep link with malformed filters;
- authenticated user attempts another tenant's resource.

Do not collapse loading, empty, unavailable, unauthorized, forbidden, partial, and stale into one blank view.

## Verification

Verify classification with evidence, not a prose review:

1. Build static and server targets that the repository claims.
2. Inspect generated routes and output artifacts.
3. Fetch representative HTML before hydration and confirm required content exists.
4. Exercise direct navigation, reload, back/forward, and copied deep links.
5. Disable JavaScript for surfaces claiming progressive enhancement.
6. Capture cache and security headers for public and personalized routes.
7. Count shipped JavaScript/islands and compare with the ownership record.
8. Run one failure for each connected system and verify the intended owner handles it.
9. Trace an authorization decision from request identity through the server query.

## Sources and freshness

- Historical source scope: marketing, documentation, hybrid application, and runtime CMS reviews from 2026-07-17, adapted into anonymized surface-ownership examples.
- Astro on-demand rendering: https://docs.astro.build/en/guides/on-demand-rendering/ (reviewed 2026-07-17).
- Astro server islands: https://docs.astro.build/en/guides/server-islands/ (reviewed 2026-07-17).
- Treat deployment adapters, experimental Astro options, and application-local route conventions as version-sensitive. Verify the installed manifest and adapter documentation before copying configuration.
