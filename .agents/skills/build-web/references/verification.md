# Web verification manual

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference to prove a web change across build artifacts, server output, hydration, browser behavior, accessibility, security, connected systems, performance, and resource lifetime. A passing typecheck is not a browser result.

## Contents

- Verification target inventory
- Layered matrix
- Build and artifact checks
- Server and hydration checks
- Browser behavior
- Accessibility
- Security and connected systems
- Performance and lifetime
- Visual and content verification
- Failure injection
- Evidence report
- Sources and freshness

For difficult text, translated labels, and data-boundary checks, use the
[Break UI catalog](../../design-interfaces/references/rendered-content.md).
It owns field limits, fixture choices, and decisions about visible content.
For drag cancellation, native scroll conflicts, or claims about how a phone's
browser chrome and keyboard affect controls, use [touch interactions](touch-interactions.md).

## Verification target inventory

Before running commands record:

```text
Routes changed:
Static/server/deferred output:
Renderer and island directives:
URL/query/local/session state:
Forms and mutations:
Auth/tenant authority:
CMS/API/provider dependencies:
Assets/icons/fonts/motion:
Deployment adapter:
Browser support policy:
Expected no-JS behavior:
Authorized test targets:
```

Read repository-owned scripts and CI before inventing commands. Keep formatters scoped away from authored Markdown unless the user requests document formatting.

## Layered matrix

| Layer | What it proves | What it does not prove |
|---|---|---|
| Schema/typecheck | Static contracts and reachable type errors | Runtime DOM, CSS, network, adapter behavior |
| Unit test | Pure policy/state cases | Real framework integration unless mounted accordingly |
| Production build | Compiler, bundler, routes, adapter output | Deployed runtime and user behavior |
| Server integration | HTTP, middleware, cookies, services | Hydration, focus, layout, browser APIs |
| Hydration test | Server/client structural agreement | Full browser accessibility/performance |
| Browser test | User flows and platform behavior | All target environments unless matrixed |
| Visual inspection | Layout/aesthetic result | Semantics, auth, hidden failures |
| Deployment smoke | Host adapter and configuration | Broad regression suite |

Do not substitute a lower layer for a higher-risk claim.

## Build and artifact checks

Run each output mode the repository claims. For Astro this often includes:

```sh
pnpm astro check
pnpm build
pnpm preview
```

Use the actual package manager/scripts. Then inspect:

- route manifest and generated paths;
- prerendered versus server routes;
- server adapter output and startup entrypoint;
- OpenAPI/feed/sitemap/robots/redirect/header artifacts;
- client chunks per island and duplicate framework runtimes;
- source maps and accidental secret/environment serialization;
- icon collection and font assets;
- image dimensions/formats and static fallback assets;
- cache-busting filenames and public base paths.

A successful server build can still misclassify a route or ship an empty client-only placeholder.

## Server and hydration checks

Capture raw HTML before client JavaScript:

```sh
curl -fsS -D /tmp/headers.txt http://127.0.0.1:4321/search?q=solid > /tmp/page.html
```

Assert required headings, content, canonical metadata, form labels, fallback states, and initial styles. For personalized pages, use safe local fixtures and authorized session setup.

Hydration harness requirements:

1. Render through the actual server renderer with hydration markers enabled.
2. Execute required hydration bootstrap.
3. Hydrate the same component/route and capture `console.error`/`console.warn`.
4. Fail on hydration/mismatch diagnostics.
5. Assert initial style/DOM before hydration and interactive state after.
6. Dispose and confirm external resources stop.

Cover time/randomness, media queries, local storage, auth capability props, SVG, CSS variables, transforms, client-only fallback, and invalid HTML.

## Browser behavior

Test real sequences, not snapshots only:

- direct deep link, reload, back, forward, and copied URL;
- invalid URL values and canonical default stripping;
- initial loading, stale refresh, empty, partial, offline, retry, and fatal error;
- interaction before and during hydration;
- double click/submit, reordered async response, cancellation, and route departure;
- repeated client navigation and page initialization;
- dialogs/sheets/menus with keyboard, pointer, touch, and focus return;
- responsive overflow and orientation change;
- browser zoom/text resize;
- reduced motion and preference changes;
- no JavaScript where progressive enhancement is claimed;
- image, font, icon, canvas/WebGL, CMS/API, and auth failure.

For URL-owned filters assert that a copied link reconstructs query, filter, sort, and page. Changing a filter should reset dependent page state according to the documented policy.

## Accessibility

Automated checks are a starting point. Manually verify:

- document language, unique title, landmarks, skip link, and heading outline;
- link/button semantics and accessible names;
- keyboard order, visible focus, modal trap and return;
- native form labels, autocomplete, field hints, errors, and error summary/focus;
- live-region restraint and announcements after async updates;
- tables with captions/header associations and chart alternatives;
- image alternatives and decorative SVG/canvas removal;
- zoom/reflow, contrast, forced colors, reduced motion;
- route announcement after client-side navigation;
- virtualized content focus/accessibility behavior.

Inspect the browser accessibility tree for complex primitives and custom elements. DOM attributes alone may not reveal ElementInternals semantics.

## Security and connected systems

Exercise real handoffs:

- allowed and rejected auth states;
- cross-tenant queries and mutations;
- cookie path/domain/SameSite/Secure behavior;
- trusted and untrusted origins with credentialed CORS;
- CSRF/origin checks;
- raw/rich HTML injection;
- cache headers for public and personalized routes;
- webhook signatures, replay, idempotency, and redaction;
- CMS cache hints and invalid/provider-error records;
- OpenAPI generation from the same factories as runtime services;
- deployment headers and redirects.

Do not test production writes or shared targets without authorization. When a real target is blocked, report the exact unverified contract rather than calling the local check equivalent.

## Performance and lifetime

Record a before/after budget for:

- transferred JavaScript and CSS by route/island;
- duplicate framework/runtime packages;
- icon modules and font files/preloads;
- LCP resource priority, CLS, INP/long tasks;
- offscreen content rendering and DOM size;
- hydration time and interaction-before-hydration;
- continuous animation/frame work;
- listener, observer, timer, subscription, worker, WebGL, and retained-root counts;
- memory across repeated navigation.

Instrument lifecycle in tests:

```ts
const add = vi.spyOn(window, "addEventListener");
const remove = vi.spyOn(window, "removeEventListener");

for (let index = 0; index < 5; index += 1) {
  const dispose = mountFeature();
  dispose();
}

expect(activeListenerBalance(add, remove)).toBe(0);
```

The exact helper is project-owned. Also spy on `requestAnimationFrame`/`cancelAnimationFrame`, observers, animations, and third-party destroy calls.

When using `content-visibility: auto`, pair it with an appropriate `contain-intrinsic-size`, avoid above-fold critical content, and verify keyboard reachability across deferred sections. Treat support/fallback according to the project's browser policy.

## Visual and content verification

Use responsive screenshots when layout or styling changed. Cover at least narrow mobile, common desktop, and a stress width/content case. Inspect:

- no clipping/overlap or horizontal page scroll;
- loading/empty/error states, not only happy data;
- fixed/sticky elements and safe areas;
- focus ring and destructive/disabled/invalid states;
- font fallback before/after load;
- image/canvas fallback;
- light/dark/forced colors;
- motion at normal and reduced preferences.

For content sites verify canonical URL, title/description, social image, structured data, feed, sitemap, draft exclusion, pagination, taxonomy links, missing media, and broken internal links.

## Failure injection

At minimum inject:

| Handoff | Failure |
|---|---|
| Server data | timeout, invalid schema, 401/403/404/409/429/500 |
| Client query | offline, stale cache, reordered responses |
| Form | invalid server response, double submit, route leave |
| CMS | missing relation/media, malformed rich text, outage |
| Auth | expired session, organization switch, bad callback |
| Assets | image/font/icon load failure |
| Motion | reduced motion, background tab, cancel during exit |
| WebGL | no context, context/texture failure, resize/unmount |
| Navigation | repeated route events, back/forward, hash target |
| Deployment | missing env/binding, cold startup, wrong base URL |

The assertion must distinguish the intended safe fallback from a silent blank view.

## Evidence report

Report:

```text
Passed:
- command/test and the contract it proves

Failed:
- command/test, failure signature, likely owner

Blocked:
- exact missing authority/environment/dependency
- what remains unverified

Not run:
- deliberately out-of-scope checks

Artifacts:
- screenshots, logs, traces, bundle reports, generated output
```

Do not merge failed and blocked checks. Do not claim a deployed, cross-browser, accessibility, or performance result from source inspection alone.

## Sources and freshness

- Historical source scope: motion, application, marketing, and Solid Primitives reviews from 2026-07-17, adapted into anonymized verification scenarios. Execute the selected checks against the active project.
- Modern Web Guidance accessibility, security, forms, and deferred-rendering guides retrieved 2026-07-17.
- Astro view transitions: https://docs.astro.build/en/guides/view-transitions/ (reviewed 2026-07-17).
- Browser performance APIs and framework build commands are version-sensitive. Prefer repository-owned scripts and the target-browser policy.
