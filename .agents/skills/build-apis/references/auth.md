# Authentication, organization policy, and Better Auth

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [Separate identity from authorization](#separate-identity-from-authorization)
- [Better Auth ecosystem preflight](#better-auth-ecosystem-preflight)
- [Construction and route mounting](#construction-and-route-mounting)
- [Organization policy](#organization-policy)
- [Endpoint middleware patterns](#endpoint-middleware-patterns)
- [Cookies, origins, and CSRF](#cookies-origins-and-csrf)
- [Plugins and client symmetry](#plugins-and-client-symmetry)
- [Operational workflows](#operational-workflows)
- [Tests and failure signatures](#tests-and-failure-signatures)

## Separate identity from authorization

| Layer | Question | Example evidence |
|---|---|---|
| Authentication | Who is making the request? | Verified session/user/API key |
| Tenant selection | Which organization/team is active for this operation? | URL/resource relationship plus session preference |
| Membership | Does the user belong to it? | Server-side membership row |
| Authorization | Can this member perform this operation on this resource? | Role/permission/domain policy |
| Data scope | Which rows can the operation observe/mutate? | Server-owned base filter/scope object |

Never infer authorization from a client-provided organization ID, UI visibility,
or authentication alone. Do not rely on frontend route guards for backend policy.

## Better Auth ecosystem preflight

Treat Better Auth as an ecosystem. Inspect the exact installed versions and
official status of:

- server core and selected database adapter;
- generated auth schema/migrations;
- framework handler integration;
- client package and renderer-specific client binding;
- organization, OAuth/OIDC provider, admin, passkey, API key, session-management,
  or other plugins actually enabled;
- email sender/verification/reset/invitation callbacks;
- base URL/path, trusted origins, cookie configuration, proxy/TLS behavior;
- rate limiting and secondary storage where configured.

Do not infer first-party compatibility from package naming. Community adapters
and plugins need source/version/security review. Do not enable a plugin only on
the server when it requires a paired client plugin for typed client methods.

## Construction and route mounting

Export an import-safe factory. Do not read mandatory env, open a database, or
configure global logging at module import:

```ts
export interface MakeAuthOptions {
  readonly baseURL: string
  readonly secret: string
  readonly database: AuthDatabase
  readonly sendInvitation: SendInvitation
  readonly trustedOrigins: readonly string[]
}

export function makeAuth(options: MakeAuthOptions) {
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    database: options.database,
    trustedOrigins: [...options.trustedOrigins],
    plugins: [organization({ sendInvitationEmail: options.sendInvitation })],
  })
}
```

Construct one long-lived auth instance at the host composition root. Mount the
handler at the configured wildcard/base path and test the exact deployed prefix.
Align:

- public base URL and reverse-proxy prefix;
- auth base path and wildcard route;
- callback/redirect URLs;
- issuer, OAuth/OIDC metadata and consent paths;
- secure cookie domain/path/same-site settings;
- trusted origins and CORS credential policy.

Do not create a new auth instance per request. Do not mount two instances with
different secrets/adapters in nested apps.

## Organization policy

Resolve an authorized scope object before domain/data access:

```ts
export const AuthorizedOrganization = z.object({
  organizationId: z.string(),
  membershipId: z.string(),
  actorId: z.string(),
  role: z.string(),
  permissions: z.set(z.string()),
})
```

The middleware/policy service should:

1. require a valid session;
2. obtain requested organization from route/resource/product rules;
3. look up current membership server-side;
4. evaluate operation/resource policy;
5. produce an immutable scope;
6. ensure queries receive this scope as a base constraint;
7. audit sensitive mutations.

For a route like `/organizations/:organization_id/imports/:import_id`, verify the
import belongs to the organization in the same server-owned query. Avoid loading
the import globally and checking organization later if existence leakage matters.

```ts
const result = await db.query.imports.findFirst({
  where: and(
    eq(imports.id, importId),
    eq(imports.organizationId, scope.organizationId),
  ),
})
```

Whether policy lives in middleware or a domain service depends on context, but a
handler must not be able to forget the tenant base filter. Consider a scoped
store/capability that requires `AuthorizedOrganization`.

Define behavior for suspended/deleted membership, organization switch, resource
transfer, invitation acceptance, and concurrent revocation. A cached session
claim can become stale; decide which high-risk operations re-read policy.

## Endpoint middleware patterns

Use explicit variants:

| Middleware | Guarantee |
|---|---|
| optional auth | `session` may be absent; no policy grant |
| required auth | verified session/user exists |
| optional organization | organization context may resolve; no membership guarantee unless named |
| required organization | current membership and requested scope verified |
| operation policy | named permission/domain predicate satisfied |

Route order normally authenticates, authorizes scope, then validates user input
and runs the handler. Validate path syntax before an expensive policy lookup only
if failure behavior does not leak resource existence and middleware contracts
remain explicit.

Do not accept an `organization_id` inside JSON as authoritative when route or
server state already determines scope. If accepted for commands, compare it to
the authorized scope and reject mismatch.

## Cookies, origins, and CSRF

Define deployment-specific cookie policy:

- `Secure` in production HTTPS;
- `HttpOnly` for session cookies;
- appropriate `SameSite` for same-site or cross-site flows;
- narrow domain/path;
- rotation/expiry/revocation;
- proxy-aware secure detection;
- no secret session material in logs.

Credentialed cross-origin requests require exact allowed origins; wildcard CORS
is invalid/unsafe. CSRF defenses depend on cookie/same-site architecture and
Better Auth's exact integration. Test hostile origins, preflights, redirects, and
state-changing requests through the real proxy.

Do not place reusable auth tokens in URLs. For SSE where `EventSource` header
constraints matter, prefer same-origin cookies or short-lived resource-scoped
stream tickets.

## Plugins and client symmetry

For every plugin build a matrix:

| Capability | Server plugin/config | Client plugin/binding | Routes/schema | Operational dependency |
|---|---|---|---|---|
| Organization | organization plugin | organization client plugin where required | org/member/invite | email/invitation policy |
| OAuth provider | provider plugin | OAuth client flow | metadata/authorize/token/consent | keys, redirect URLs |
| Passkey | passkey plugin | browser passkey client | credential tables/routes | secure origin |
| API keys | API-key plugin | management client/UI | key records/routes | hashing, scopes, rotation |

Confirm schema generation/migrations after plugin changes. Keep server and client
versions compatible. Test both root and custom base-path mounts if supported.

## Operational workflows

Do not enable a policy gate without its completion path:

- email verification requires sender, template, expiry, resend, bounce/failure,
  and support recovery;
- password reset requires one-time expiry, session revocation decision, and abuse
  controls;
- organization invitation requires membership/role policy, expiry, resend,
  duplicate invite, wrong-account, and revocation handling;
- OAuth requires provider error, account-linking, redirect, consent, and state
  validation;
- session management requires revoke-one/revoke-all and device/session display if
  promised;
- account deletion requires organization/data retention and background cleanup.

## Tests and failure signatures

Test:

- import without env/network;
- one auth instance across concurrent requests;
- exact base path, callbacks, cookies, trusted origins, and proxy HTTPS;
- anonymous, expired, revoked, and malformed sessions;
- cross-organization reads/mutations and guessed resource IDs;
- organization switching and membership revocation during a session;
- each role/permission and server-owned base filter;
- plugin server/client symmetry and generated schema;
- sender/provider/database failure;
- redaction of cookie, authorization, password, token, and secret fields;
- SSE/long request authorization expiry policy.

| Signature | Defect | Correction |
|---|---|---|
| Authenticated user sees another org | Authentication used as authorization | Membership/policy + scoped query |
| Auth methods missing in client | Paired plugin/binding absent | Server/client plugin matrix |
| OAuth callback fails only in production | Base URL/path/proxy mismatch | Deployed route/cookie integration test |
| Import crashes without secret | Module-scope construction | Factory + composition root |
| CORS accepts arbitrary credentialed origin | Unsafe default | Exact origin policy |
| Email verification blocks all users | Operational email flow incomplete | Complete sender/recovery or defer gate |
| Resource 404 leaks across tenant timing/body | Global lookup before scope | Scoped base query |

## Sources and freshness

- Better Auth official documentation: https://www.better-auth.com/docs
  (primary source, checked 2026-07-17; plugin and framework APIs are version-sensitive).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/authz/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
