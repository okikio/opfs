# Astro site architecture and runtime manual

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference for Astro routes, layouts, content, endpoints, middleware, adapters, islands, view transitions, images, fonts, and generated documents. Verify the installed Astro major and integration versions before applying configuration: several uploaded projects use Astro 6 or 7 and experimental options.

## Contents

- Repository evidence inventory
- Output and route rendering
- Page, layout, and endpoint ownership
- Client islands and server islands
- Middleware, locals, and cache
- Navigation and view transitions
- Static documentation and OpenAPI
- Assets and integrations
- Configuration review
- Failure signatures
- Verification
- Sources and freshness

## Repository evidence inventory

Inspect:

```sh
rg --files | rg '(astro\.config|src/pages|src/layouts|src/middleware|src/content\.config|src/live\.config|env\.d\.ts)'
rg -n 'output:|adapter:|prerender|client:|server:defer|defineMiddleware|Astro\.locals' .
rg -n 'integrations:|fonts:|image:|security:|session:|env:' astro.config.*
```

Record:

- Astro and integration versions;
- package manager and build/check/preview scripts;
- site origin and base path;
- static/server output default;
- per-route prerender exceptions;
- adapter and target runtime;
- framework integrations and island directives;
- middleware sequence and `locals` types;
- content source and preview/live mode;
- endpoint methods and cache/security headers;
- image, icon, font, Markdown, sitemap, and RSS integrations;
- experimental configuration and its verification source.

Do not copy a whole `astro.config.ts` between repositories. An integration can be valid only because of a particular Astro major, adapter, renderer, Vite plugin, environment, or deployment host.

## Output and route rendering

Astro defaults to static generation. Choose per route:

| Route need | Default | Required evidence |
|---|---|---|
| Public content known at build | Static/prerender | Content/build source available in CI |
| Request identity/cookie | On-demand SSR | Adapter and cache policy |
| Fresh uncached request data | On-demand SSR | Runtime API and failure policy |
| Mostly static page with personalized fragment | Static/cached shell plus `server:defer` | Adapter, fallback, deferred request |
| Server-default project with static page | `export const prerender = true` | No request-only dependency |
| Static-default project with dynamic page | `export const prerender = false` | Adapter installed |

`output: "server"` changes the default; it does not add a capability beyond route defaults. Start static unless most routes are genuinely request-time. In server mode, preserve static public routes explicitly:

```astro
---
export const prerender = true;
---

<MarketingHome />
```

In the marketing example, server output supports a prerendered homepage. In the documentation example, static output generates API reference routes. A hybrid application's auth pages use `prerender = false` because server capability/session data is request-time.

Choose the adapter from the deployment runtime and features. Verify environment access, streaming, image service, sessions, server islands, headers, filesystem assumptions, and startup behavior. An auto-adapter reduces configuration only if its detection result and production behavior are tested.

## Page, layout, and endpoint ownership

Astro owns document structure, routes, layouts, metadata, static content, and server response stages. Keep layout contracts explicit:

```astro
---
interface Props {
  title: string;
  description?: string;
  canonical?: URL;
}
const { title, description, canonical } = Astro.props;
---

<html lang="en">
  <head>
    <BaseHead {title} {description} {canonical} />
    <slot name="head" />
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <main id="content" tabindex="-1"><slot /></main>
  </body>
</html>
```

Endpoints own method, content type, cache, validation, and public errors:

```ts
import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  const catalog = await buildServiceCatalog();
  return Response.json(catalog, {
    headers: { "cache-control": "public, max-age=300" },
  });
};
```

Use a stable service/content factory shared with runtime code rather than reconstructing schemas inside pages. Avoid endpoint module side effects such as loading dotenv, connecting to databases, or logging environment values during import.

## Client islands and server islands

Framework components without `client:*` render HTML but no client JavaScript. Select hydration by user-visible urgency:

- `client:load`: immediately interactive above-fold UI;
- `client:idle`: lower priority, with optional timeout where supported;
- `client:visible`: below-fold/expensive; root margin can start before visibility;
- `client:media`: behavior exists only for a media query;
- `client:only="react"` or `"solid-js"`: no server HTML; explicit renderer and fallback required.

```astro
<DepthScene client:visible={{ rootMargin: "200px" }} />
<SignInForm client:load capabilities={publicCapabilities} />
<BrowserOnlyEditor client:only="react">
  <p slot="fallback">Loading editor…</p>
</BrowserOnlyEditor>
```

`client:visible` does not suspend a running island after it leaves the viewport. Continuous canvas/animation work needs its own visibility policy.

Use native HTML or a page script instead of an island when practical. The marketing example's active FAQ is `<details>`; its unused Solid accordion is not a reason to hydrate.

`server:defer` creates a server island. It needs an adapter, a layout-stable fallback, and a cache/auth design. It is useful for personalized fragments inside otherwise cacheable pages. Do not put critical SEO or primary content behind a deferred request without a deliberate product decision.

## Middleware, locals, and cache

Middleware should derive request-scoped facts once and place typed, minimal values in `Astro.locals`:

```text
request
  -> route intent
  -> session
  -> active organization/authorization
  -> shell/page model
  -> cache and security headers
  -> route
```

One reviewed application classifies `public`, `auth`, `auth-required`, and `app` routes. That can prevent duplicated pathname logic, but the classification is security-sensitive. Test every prefix, catch-all, trailing slash, API route, static asset, and new route.

Never let public be the accidental fallback for an unrecognized authenticated route. Prefer route metadata or a test that inventories every route when the framework exposes it.

Cache policy follows response authority:

- personalized/app/auth: normally `private, no-store` or explicit private caching;
- auth forms: avoid stale tokens/session-dependent output;
- static fingerprinted assets: long immutable cache;
- public documents/JSON: public validators/max-age with invalidation policy;
- CMS pages: provider cache hints mapped through one interface.

Verify final deployed headers, since the adapter/host may change them.

## Navigation and view transitions

`<ClientRouter />` enables Astro client-side navigation and route announcement. It respects reduced motion for transition animations. Every page still needs a useful `<title>` because the announcer prefers it.

Initialization attached to `astro:page-load` can run repeatedly. Use delegation or replace previous listeners with an `AbortController`. A counterexample `BaseHead` script adds handlers to every hash/external link on each page load without cleanup. Diagnose that duplication and assign listener cleanup to the script's owner.

Do not globally intercept all hash links unless you preserve:

- normal navigation and invalid target behavior;
- keyboard focus at the destination;
- browser history/back behavior;
- reduced motion;
- URL encoding and selector safety.

`transition:persist` changes lifetime: persisted elements/islands remain instead of being replaced. By default island state persists while new props may render; `transition:persist-props` keeps old props too. Test auth/user changes, subscriptions, media, and cleanup. CSS animations may restart and iframes may reload despite persistence.

Forms participate in ClientRouter navigation. If a form requires full browser behavior use `data-astro-reload`. For POST encoding, choose and test the intended enctype rather than assuming traditional URL encoding.

## Static documentation and OpenAPI

The documentation example illustrates this ownership model:

```text
service-owned endpoint/schema factory
  -> build-time service catalog
  -> getStaticPaths service pages
  -> per-service OpenAPI JSON
  -> Scalar reference wrapper
```

Static output is compatible with rich API docs when service factories are deterministic build inputs. Validate that importing them does not require runtime secrets or connect to production.

For authenticated “try it” requests, docs origin, API/service origin, Better Auth cookies, credentialed CORS, and auth method must agree. A cookie header is not a bearer token. Do not tell users to paste a raw cookie into an authorization field unless the API explicitly accepts it.

Generate and diff OpenAPI artifacts in CI. Test duplicate operation ids, broken refs, schema drift, server origins, public/private endpoints, and example redaction.

## Assets and integrations

Keep each integration scoped:

- images: correct service for build/runtime, dimensions, responsive sources, and adapter support;
- icons: Astro Icon for Astro templates, compiler-specific Unplugin Icons for islands;
- fonts: Astro Fonts API or Fontsource strategy with finite variants/preloads;
- sitemap/RSS: public route/content model and absolute site origin;
- Markdown/MDX: plugin order, raw HTML policy, code themes, and custom directive security;
- framework integrations: only installed for reachable islands;
- Vite plugins: compiler target and plugin type identity must match actual Vite runtime.

Avoid wildcard icon collections and preloading every font. The uploaded configs include both patterns; they require bundle/waterfall review.

Experimental options such as content intellisense, client prerender, SVG optimizers, or devtools workspace must be verified against the installed Astro version and production target. Do not use an uploaded config as an API reference.

## Configuration review

Review this ownership table:

| Config area | Question |
|---|---|
| `site` | Correct canonical production origin? |
| `output`/route exports | Minimal dynamic surface? |
| `adapter` | Matches deployed runtime and required features? |
| `integrations` | Every integration has reachable ownership? |
| `image` | Build/runtime service works on host? |
| `fonts` | Only required families/variants/preloads? |
| `env` | Client/server access and validation correct? |
| `server.headers`/middleware | Final policy complete and not contradictory? |
| `vite.plugins` | Correct renderer compiler and no duplicate runtime types? |
| `security` | CSP decision explicit, not disabled for convenience? |
| `session` | Driver durability and deployment topology appropriate? |
| `experimental` | Installed-version proof and fallback? |

## Failure signatures

| Signature | Likely cause | Inspect next |
|---|---|---|
| `client:only` cannot render | Missing renderer hint/integration | Direct import and exact hint |
| Static build connects to DB | Import side effect/request-only factory | Build import graph |
| Auth page cached across users | Route intent/header policy wrong | Middleware and deployed headers |
| Page-load action fires repeatedly | Navigation listener duplication | ClientRouter lifecycle cleanup |
| Server island fails only in production | Adapter binding/runtime mismatch | Target deployment output |
| OpenAPI docs build needs secrets | Service factory performs unsafe import-time work | Factory imports and env access |
| Sitemap/canonical uses localhost | `site`/environment contract wrong | Built artifacts |
| Island ships but never interactive | Missing/wrong client directive | Server HTML, chunk and console |
| CSP disabled to make plugins work | Resource/nonces not inventoried | CSP reports and integration origins |

## Verification

1. Run Astro check and production build through repository scripts.
2. Inspect generated route/prerender/adapter output.
3. Fetch raw HTML and headers for static, SSR, auth, API, and deferred routes.
4. Hydrate each renderer with mismatch diagnostics captured.
5. Navigate repeatedly with ClientRouter, hash links, back/forward, and focus checks.
6. Test no JavaScript for static/progressively enhanced routes.
7. Test adapter-equivalent startup and one request path, not only `astro dev`.
8. Diff generated OpenAPI/feed/sitemap artifacts.
9. Inspect island chunks, icon/font/image output, and critical-resource waterfall.
10. Test missing env/binding, CMS/API failure, expired session, and static asset failure.

## Sources and freshness

- Astro on-demand rendering: https://docs.astro.build/en/guides/on-demand-rendering/ (reviewed 2026-07-17).
- Astro directives: https://docs.astro.build/en/reference/directives-reference/ (reviewed 2026-07-17).
- Astro server islands: https://docs.astro.build/en/guides/server-islands/ (reviewed 2026-07-17).
- Astro view transitions: https://docs.astro.build/en/guides/view-transitions/ (reviewed 2026-07-17).
- Historical source scope: marketing, documentation, hybrid application, and runtime CMS reviews from 2026-07-17, adapted here into anonymized examples.
- Astro 6/7, auto-adapters, Emdash, and experimental config are version-sensitive. Inspect installed source/docs before implementing.
