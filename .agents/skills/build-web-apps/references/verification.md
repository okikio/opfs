# Web application verification manual

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference for stateful SSR applications, route loaders, server functions, forms, auth, tables, virtualization, query caches, mutations, and long-lived browser resources.

## Contents

- Application contract inventory
- Route and URL oracles
- Query and server-function oracles
- Form and mutation oracles
- Auth and tenant oracles
- Data-view and virtualization oracles
- SSR, hydration, and lifetime
- Accessibility, security, and performance
- Failure matrix
- Evidence report
- Sources and freshness

## Application contract inventory

Record before verification:

```text
Route tree and protected groups:
Validated params/search and defaults:
Loader dependencies and query factories:
Server functions/repositories and tenant scope:
Forms/mutations and idempotency:
Auth client/server/plugins/base paths:
Local/URL/query/session selection state:
Tables/virtualizers/charts:
SSR adapter and hydration:
Listeners/observers/frames/subscriptions:
Expected failures and safe targets:
```

Use fixtures and authorized local targets. Do not require production/shared mutations without permission.

## Route and URL oracles

For every route state:

- direct URL renders the same view as in-app navigation;
- reload preserves shareable filters, sort, page, and view;
- back/forward traverses intentional state changes;
- invalid search values parse to safe defaults or deliberate error;
- canonical defaults are stripped/preserved consistently;
- changing filter/query/sort/page-size resets dependent page;
- local dialog/selection/draft state does not pollute URL;
- protected route redirects preserve only allowlisted callback state;
- route error/not-found/pending states render distinct usable views.

Test the pure URL patch/reset functions and the actual router. A pure function passing does not prove browser history behavior.

## Query and server-function oracles

Assert:

- loader and component call the same query-options factory;
- key includes every result-changing input and server authority such as tenant;
- one SSR request gets a fresh request-scoped QueryClient where required;
- critical data is prefetched/streamed according to installed integration;
- stale time and invalidation match product freshness;
- initial pending differs from background refresh;
- server functions parse input again and derive authority from session;
- repository query enforces tenant/base filters;
- public errors are stable and diagnostics are redacted;
- abort/cancellation/reordered results cannot overwrite current state.

Instrumentation can fail tests on duplicate equivalent fetches or unexpected query keys.

## Form and mutation oracles

Test:

- label/autocomplete/description/error association;
- keyboard submit and button type;
- touched/blur/submit validation timing;
- client bypass and server validation;
- slow/reordered async validation;
- double submit, retry, idempotency, and unique conflict;
- navigation/close during pending work;
- expired session/forbidden/conflict/rate-limit/network/500;
- field/form error mapping and focus/announcement;
- optimistic snapshot, rollback, authoritative response, and exact invalidation;
- provider/social/passkey pending paths do not overlap.

Verify committed domain state at the server/repository, not only a success toast.

## Auth and tenant oracles

- importing client auth code requires no server secrets;
- server/client plugin and framework binding match;
- issuer/base URL, handler mount, discovery, callbacks, cookies, and trusted origins agree;
- allowed origin can send credentialed request; rejected origin cannot read it;
- unauthenticated, expired, revoked, and wrong-role sessions behave correctly;
- organization switch updates server authority, query keys, cached data, and UI;
- user cannot query/mutate another organization by changing URL/body/header;
- personalized routes are private/no-store as designed;
- logout/session invalidation clears protected state.

Test authorization at repository/service APIs. A route redirect and hidden button are insufficient.

## Data-view and virtualization oracles

- stable sorting with deterministic tie-breaker;
- filter/facet/count semantics under combinations;
- pagination edges after insert/delete;
- selected id remains the same record across sort/refresh;
- selection scope (page/ids/all-matching) matches bulk request;
- server reauthorizes every bulk target;
- table caption/headers/sort state and keyboard focus;
- responsive overflow/card alternative and zoom;
- virtualizer stable keys, measurement, overscan, scroll container, pinned rows, resize, and dynamic height;
- focused row policy when outside rendered range;
- SSR initial virtual range/hydration and scroll restoration;
- infinite load prevents duplicates/repeated calls and handles reordered pages;
- empty/loading/stale/partial/error/completed states remain distinct.

Run with realistic row counts and variable content lengths. A ten-row fixture does not prove virtualization.

## SSR, hydration, and lifetime

For representative routes:

1. Capture raw server HTML and initial serialized state.
2. Assert required content/styles before hydration.
3. Hydrate while capturing mismatch diagnostics.
4. Interact before/after hydration where possible.
5. Navigate/mount/unmount repeatedly.
6. Assert listener, observer, timer, frame, subscription, animation, WebGL, and retained-owner counts return to baseline.

Cover media/storage preferences, random/time/locale, auth capabilities, query dehydration, invalid HTML, client-only fallbacks, portals, and persisted islands.

## Accessibility, security, and performance

Accessibility:

- landmarks/headings/route announcement;
- keyboard/focus in dialogs, sheets, menus, grids, virtual lists;
- accessible field/status/error semantics;
- table/chart alternatives;
- zoom/reflow/contrast/forced colors/reduced motion/touch.

Security:

- client bundle/HTML/source maps contain no secrets;
- raw/rich content XSS tests;
- CSRF/origin/cookie/CORS tests;
- redirect allowlist;
- cross-tenant tests;
- cache headers and redacted logs/errors.

Performance:

- route JS/CSS and duplicate framework packages;
- loader waterfalls/query duplication;
- hydration/interaction timing;
- large table DOM/virtualization/memory;
- long tasks and continuous work;
- font/icon/image output;
- navigation memory/resource trend.

## Failure matrix

| Handoff | Required cases |
|---|---|
| URL/router | malformed, defaults, reload, back/forward, unknown route |
| Query | slow, stale, offline, abort, reordered, invalid response |
| Server function | invalid input, unauthenticated, forbidden, conflict, rate limit, 500 |
| Form | invalid/corrected, duplicate, pending navigation, server field error |
| Auth | expired/revoked session, bad origin/callback, organization switch |
| Table | empty, huge, sort ties, delete current page, resize, long content |
| Virtualizer | wrong estimate, dynamic height, focus off-range, fetch failure |
| Renderer | server mismatch, chunk failure, portal/theme mismatch |
| Resources | listener/frame/subscription leak, background/offscreen work |
| Deployment | missing env/binding, cold start, wrong base URL/cookie |

Every case needs an observable oracle: response/status, DOM/accessibility state, cache key, repository result, resource count, or artifact. “No exception” is too weak.

## Evidence report

```text
Passed
- exact check and contract proved

Failed
- observed signature and owning component

Blocked
- missing target/credential/authority/runtime and remaining risk

Not run
- deliberate exclusions

Artifacts
- route traces, network logs, screenshots, accessibility output,
  hydration diagnostics, bundle report, resource counters
```

Do not claim cross-browser, deployed, accessibility, security, or performance success from unit/type/build evidence alone.

## Sources and freshness

- Historical source scope: application, experimental Solid motion, and Solid Primitives reviews from 2026-07-17, adapted into anonymized verification scenarios.
- TanStack Router Query integration: https://tanstack.com/router/latest/docs/integrations/query (reviewed 2026-07-17).
- TanStack Router search params: https://tanstack.com/router/latest/docs/guide/search-params (reviewed 2026-07-17).
- Modern Web Guidance accessibility/forms/security/deferred-rendering guides retrieved 2026-07-17.
- Framework and auth APIs are version-sensitive; use repository-owned scripts and installed documentation.
