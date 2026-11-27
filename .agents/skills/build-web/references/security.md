# Web security and connected-system trust handoffs

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference for pages, forms, server functions, Astro endpoints, webhooks, auth routes, embeds, CMS rendering, file/media flows, and client-side navigation. A UI that renders correctly can still leak tenant data, secrets, or executable content.

## Contents

- Threat and authority inventory
- Server/client handoff
- Output and content safety
- Forms and mutations
- Authentication and authorization
- Cookies, CORS, CSRF, and origins
- Headers and caching
- Webhooks and provider calls
- Browser and third-party resources
- Failure handling and logging
- Verification
- Sources and freshness

## Threat and authority inventory

For every externally reachable route record:

```text
Method and path:
Caller identity:
Required organization/tenant/role:
Input schema and size limit:
Side effects and idempotency key:
Credentials/cookies/origin behavior:
External providers:
Public response/error shape:
Diagnostic fields and redaction:
Cache policy:
Rate/replay/abuse policy:
Verification source/signature:
```

Trace authority from the server-observed identity into the database/provider query. A client-provided `organizationId`, hidden button, route guard, or disabled control is not authorization.

## Server/client handoff

Server secrets and authority must not enter client bundles or serialized props. Inspect import reachability, not only variable prefixes.

A useful pattern: server code resolves enabled auth capabilities, then passes a small client-safe list of provider ids to a React island. The browser does not import environment-backed server configuration to decide what auth methods exist.

```ts
type PublicAuthCapabilities = {
  socialProviders: readonly ("github" | "google")[];
  allowPasskey: boolean;
};
```

Keep server-only modules in explicit server paths and add a build/test that importing client entrypoints does not require production secrets. Never serialize complete environment objects, session records, database errors, provider payloads, or internal stack traces into HTML.

## Output and content safety

Framework interpolation escapes text by default; raw HTML APIs change the contract. For Astro `set:html`, React `dangerouslySetInnerHTML`, CMS rich text, Markdown plugins, SVG, and search snippets:

1. Identify whether the value is trusted source code, sanitized rich text, or untrusted user/provider input.
2. Parse or sanitize at one named handoff with a defined allowlist.
3. Preserve structured content as data instead of concatenating HTML when possible.
4. Test script elements, event attributes, `javascript:` URLs, SVG/script combinations, malformed markup, and encoded payloads.
5. Apply Content Security Policy as defense in depth, not a replacement for output encoding.

The illustrative CMS adapter's plain-text fallback escapes `&`, `<`, `>`, and quotes before creating HTML. That example covers a narrow fallback, not a complete Portable Text renderer. Full rich text requires mark, link, embed, and custom-block handling with explicit safe renderers.

Do not render provider search snippets containing `<mark>` through a raw HTML sink without proving how all other tags/attributes were removed.

## Forms and mutations

Every mutation requires server-side validation and authorization even if the client uses Zod or a form library. Define:

- accepted content types and maximum total/field/file size;
- duplicate/double-submit policy;
- idempotency or optimistic concurrency where retries occur;
- CSRF/origin policy for cookie-authenticated requests;
- spam/rate limits for public forms;
- safe redirect/callback URL allowlist;
- public validation versus internal diagnostic detail;
- audit fields that exclude secrets and excessive PII.

Do not expose mutation through GET or alias the same handler to GET and POST. Do not disable the submit button before the user can discover validation errors; disable or gate after a valid submission begins to prevent duplicates.

For file uploads verify MIME by content where needed, limit size/count, randomize storage names, prevent path traversal, isolate public/private storage, and scan or transform risky formats before serving.

## Authentication and authorization

Authentication contract:

- issuer/base URL and handler mount agree;
- cookie domain, path, `Secure`, `HttpOnly`, and `SameSite` fit the topology;
- trusted origins and callback URLs are finite;
- provider/client plugins match the server configuration;
- discovery metadata points to reachable endpoints;
- credentialed browser requests use the intended origin and CORS policy;
- session rotation, expiration, revocation, and organization switching are tested.

Authorization contract:

```ts
const session = await requireSession(request);
const scope = await requireOrganizationMembership(session.user.id, routeOrg);
const result = await repository.search({ organizationId: scope.organizationId, filters });
```

Do not accept an organization from the body and compare it only in the UI. Put tenant scope into the repository query or service policy so missing a later filter is harder.

Sensitive account changes should require appropriate freshness/re-authentication and invalidate relevant sessions when the product policy requires it.

## Cookies, CORS, CSRF, and origins

CORS controls which browser origins may read responses; it is not authentication. For credentialed cross-origin requests:

- use a specific allowed origin, never `*`;
- set `Access-Control-Allow-Credentials: true` only where needed;
- handle preflight methods/headers explicitly;
- configure cookies so they are actually sent;
- keep allowed origins synchronized with auth trusted origins;
- verify both allowed and rejected origins in a browser-equivalent flow.

Cookie-authenticated mutations require a CSRF defense such as strict same-site topology plus origin checks or a correctly implemented token strategy. Evaluate top-level navigation, subdomains, embedded contexts, and OAuth callbacks before assuming `SameSite` alone is enough.

Validate redirect destinations against an allowlist or same-origin policy. URL parsing must reject scheme-relative and encoded bypasses.

## Headers and caching

Set policy at the deployment/server response stage and verify the final response:

- `Content-Security-Policy` appropriate to scripts, styles, images, fonts, frames, and connections;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy`;
- `Permissions-Policy` for unavailable capabilities;
- clickjacking policy through CSP `frame-ancestors` (and `X-Frame-Options` as legacy defense when appropriate);
- HSTS only on production HTTPS domains with a deliberate subdomain/preload decision;
- cross-origin isolation headers only when required and compatible with dependencies.

`X-XSS-Protection` is obsolete and is not a substitute for CSP/encoding. Do not present its presence as a modern XSS control.

Personalized/auth routes should normally use `private, no-store` or another explicitly justified private policy. Middleware that classifies app and auth routes can then set cache behavior. Verify that route intent cannot misclassify a personalized route as public. Public static assets and documents can use cache validators or immutable fingerprinted caching.

Never cache one tenant's HTML under a key that omits identity/tenant. `Vary` must match any request header that changes a shared-cache response.

## Webhooks and provider calls

Webhook sequence:

```text
raw request bytes
  -> size limit
  -> timestamp/replay window
  -> provider signature over documented bytes
  -> constant-time verification
  -> parse and schema validate
  -> idempotency/event-id check
  -> authorized side effect
  -> redacted audit record
  -> provider-compatible status
```

Do not parse/re-serialize before signature verification when the provider signs raw bytes. Store enough event identity to make retries safe.

An anonymized webhook counterexample logs an API key and the complete environment, logs payload-derived PII, permits unknown fields broadly, and lacks demonstrated provider signature verification. Its package mappings may be useful domain data after validation; the endpoint architecture is not reusable.

Provider error messages may contain request data or internal identifiers. Map them to a stable public error and retain a redacted cause in structured diagnostics.

## Browser and third-party resources

Treat analytics, embeds, iframes, scripts, OAuth popups, WebGL textures, fonts, and icon SVGs as supply-chain and privacy constraints:

- pin or control dependency versions and provenance;
- minimize third-party origins in CSP;
- sandbox iframes to the minimum capability and provide a title;
- use `rel="noopener noreferrer"` where external opener/referrer policy requires it;
- avoid injecting arbitrary SVG or remote script content;
- obtain consent before nonessential tracking where applicable;
- never put tokens or PII in analytics labels, page titles, URLs, or referrers;
- validate `postMessage` origin, source, and schema;
- clean up embedded resources on navigation.

Do not write a global handler that mutates every external link after each client navigation if the links can be rendered safely in the first place.

## Failure handling and logging

Public errors should be useful and non-sensitive:

```json
{
  "type": "https://example.invalid/problems/invalid-form",
  "title": "The form could not be submitted",
  "status": 400,
  "errors": { "email": ["Enter a valid email address"] },
  "correlationId": "..."
}
```

Diagnostics can include route, operation, correlation id, safe actor/tenant identifiers, duration, provider status class, retry count, and redacted cause. Do not include authorization headers, cookies, passwords, tokens, complete payloads, or environment objects.

Distinguish 401 (authentication required/invalid), 403 (authenticated but forbidden), 404 (including deliberate anti-enumeration policy), 409 (conflict), 422/400 (validation according to project contract), 429, and 5xx.

## Verification

1. Enumerate routes/methods and test authentication plus tenant/role authorization.
2. Send valid, malformed, oversized, duplicate, replayed, and cross-origin requests.
3. Verify cookie attributes and actual credentialed browser behavior.
4. Test CSRF and redirect allowlists with encoded and scheme-relative inputs.
5. Inject XSS payloads into every raw/rich content rendering path and inspect rendered DOM.
6. Inspect final deployed CSP, cache, frame, MIME, referrer, and permissions headers.
7. Verify public/client bundles and HTML contain no server secret names or values.
8. Search logs/test capture for secrets, cookies, tokens, raw payloads, and PII.
9. Test webhook signature over exact raw bytes, replay window, idempotency, and retry.
10. Attempt cross-tenant reads and mutations through the real repository/service path.

## Sources and freshness

- Historical source scope: application, auth-integration, and runtime CMS reviews from 2026-07-17, adapted into anonymized security examples and counterexamples.
- Modern Web Guidance security and forms guides retrieved 2026-07-17.
- Better Auth details belong to `build-web-apps/references/auth.md`; verify current official documentation before using plugin-specific options.
- Browser header support, cookie rules, auth provider behavior, and framework raw-HTML APIs change. Verify target runtime and installed versions. This reference does not replace a project-specific threat model.
