# Better Auth in Solid and TanStack Start applications

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Contents

- Evidence and version gate
- Server/client architecture
- Mount, issuer, cookies, and origins
- Database and schema ownership
- Plugin capability map
- Organizations and authorization
- Passkeys, social providers, and magic links
- OAuth provider and consent
- Polar/billing server contract
- Construction and resource lifetime
- Failure signatures
- Verification
- Sources and freshness

## Evidence and version gate

The historical auth-integration example used Better Auth 1.6.x with separate packages/plugins for API keys, OAuth provider, passkeys, organization, JWT, magic link, Drizzle, TanStack Start cookies, and Polar webhooks. Exact options and import paths are versioned. Inspect the installed lockfile, official docs, and plugin types before copying configuration.

The anonymized example describes one application integration. Use upstream Better Auth documentation and the installed plugin types to establish supported provider behavior.

## Server/client architecture

Separate four layers:

```text
validated host environment
  -> shared auth policy/options
  -> host-specific server plugin (TanStack cookies)
  -> one Better Auth server instance + wildcard handler

shared browser options
  -> renderer-specific createAuthClient (Solid)
  -> matching client plugins
```

Server example from the uploaded architecture:

```ts
function createFrontendAuth() {
  const config = parseAuthConfig(readFrontendAuthEnv());
  const baseOptions = createAuthOptions({ config });

  return betterAuth({
    ...baseOptions,
    plugins: [...baseOptions.plugins, tanstackStartCookies()],
  });
}
```

Browser example:

```ts
import { createAuthClient } from "@identity/auth/solid";
import { createAuthClientOptions } from "@identity/auth/client";

export const authClient = createAuthClient(createAuthClientOptions());
```

Do not import `better-auth/react` in a Solid app. Do not configure a server plugin without its required browser client plugin.

## Mount, issuer, cookies, and origins

Align one contract:

- canonical external `baseURL`;
- normalized `basePath`, commonly `/api/auth`;
- wildcard route mounted at that path;
- reverse proxy forwarded host/protocol behavior;
- cookie domain/path/secure/same-site settings;
- trusted origins;
- OAuth callback URLs;
- passkey RP ID and origin;
- discovery/authorization metadata paths;
- client `basePath`.

The uploaded TanStack handler dynamically imports auth and forwards both GET and POST:

```ts
async function handleAuthRequest(request: Request): Promise<Response> {
  const { getAuth } = await import("#/lib/auth.ts");
  return getAuth().handler(request);
}
```

The route must preserve the original request URL, method, body, headers, and cookies. Test root and prefixed deployments through the real proxy/CDN adapter.

Do not concatenate metadata paths by intuition. The uploaded shared route helpers distinguish OIDC discovery beneath an issuer path from RFC 8414 authorization metadata path construction.

Trusted origins are an allowlist, not a CORS wildcard. Parse, normalize, and validate environment lists. Include production site/app origins and intentional local development origins only.

## Database and schema ownership

The server uses `drizzleAdapter(db, { provider: "pg", schema })`. Keep Better Auth schema tables, relations, migration generation/application, and runtime database instance aligned.

Decide:

- whether Better Auth and application tables share a database/schema;
- migration owner and generated-artifact review;
- database pool lifetime;
- ID generation policy;
- transaction behavior;
- session cleanup/retention;
- organization/membership uniqueness;
- plugin table migrations;
- test database isolation.

Adding a plugin can add or change schema requirements. Run the supported schema/migration workflow and review the diff before deployment. A plugin appearing in the options does not prove its table exists.

Do not construct a second pool inside auth when the host already owns a database. The uploaded `createAuthOptions` accepts an optional database for this reason.

## Plugin capability map

| Capability | Server owner in uploaded code | Browser counterpart / interface |
|---|---|---|
| email/password | core `emailAndPassword` | core client actions |
| sessions | core | `getSession`/session client |
| magic link | `magicLink` | `magicLinkClient` |
| organizations | `organization` | `organizationClient` |
| passkeys | `@better-auth/passkey` | `passkeyClient` |
| OAuth/OIDC provider | `@better-auth/oauth-provider` | `oauthProviderClient` |
| JWT | `better-auth/plugins/jwt` | inspect whether browser extension is required |
| API keys | `@better-auth/api-key` | server/API management surface |
| TanStack cookies | `tanstackStartCookies` | server-framework integration |
| Polar | `@polar-sh/better-auth` webhooks only in uploaded policy | billing service owns organization checkout/usage |

Client plugin order generally matters less than symmetry, but preserve upstream guidance and test generated methods. Type presence is not runtime proof.

## Organizations and authorization

Authentication identifies a user. It does not authorize organization data.

For every protected server function/request:

1. resolve the current session from request headers/cookies;
2. resolve active organization deliberately;
3. verify membership and required role/permission;
4. apply organization scope as a server-owned query predicate;
5. avoid trusting organization ID from URL/body alone;
6. return stable forbidden/not-found semantics without leaking existence.

Define behavior for no organization, one organization, many organizations, removed membership, disabled organization, invitation pending/expired, and active organization switching.

The uploaded OAuth policy distinguishes user-only scopes (`openid`, `profile`, `email`, `offline_access`) from organization-bound scopes. Organization scopes require explicit organization selection and bind consent to an active organization reference. Preserve that invariant across UI, provider callbacks, token claims, and API authorization.

## Passkeys, social providers, and magic links

Passkeys require exact WebAuthn identity:

- `rpID` matches the registrable host policy;
- `origin` matches browser-facing origin including scheme/port;
- `rpName` is user-facing;
- proxy/public URL configuration is correct;
- local development and production credentials do not collide accidentally;
- user verification/resident-key policy is understood;
- registration, sign-in, rename/list/delete, and lost-device recovery exist.

Social providers require complete client ID/secret pairs. The uploaded Zod config rejects half-configured GitHub or Google credentials. Register exact callback URLs for each environment and protect state/PKCE behavior through the upstream integration.

Magic links require a real sender, expiry, single-use behavior, redirect allowlist, resend/rate limiting, and enumeration-resistant responses. The uploaded code currently logs the email and URL with `console.info`; that is development scaffolding and leaks a bearer credential. Do not retain it in production and do not use console output where the repository requires LogTape.

Do not set `requireEmailVerification: true` until delivery, confirmation, expiry, resend, error, and support workflows work end to end. The uploaded policy intentionally keeps it false because those pieces are absent.

## OAuth provider and consent

If the application itself acts as an OAuth/OIDC provider, define:

- issuer and metadata endpoints;
- authorization/token/userinfo/revocation behavior;
- client registration policy;
- authenticated versus unauthenticated dynamic registration;
- exact scopes and audiences;
- user versus organization subject/reference;
- account and organization selection;
- consent storage/revocation;
- redirect URI validation;
- key rotation and token lifetime;
- disabled/conflicting core paths.

The uploaded policy disables Better Auth's built-in `/token` path because the OAuth provider plugin owns it. Keep one route owner.

Dynamic unauthenticated client registration is a security/product decision, not a convenient development default. The uploaded defaults allow dynamic registration but disallow unauthenticated registration; review before exposure.

Test metadata documents and a complete authorization-code flow with user-only and organization-bound scopes. Test consent denial, organization switch, invalid audience, revoked membership, redirect mismatch, token refresh, and revocation.

## Polar/billing server contract

The uploaded architecture deliberately limits the Better Auth Polar plugin to webhooks. Its product billing is organization-scoped, while generic Better Auth Polar checkout helpers can be user-scoped. Creating checkout/customer records through both paths could create duplicate customer authority.

Choose one billing customer identity:

- Better Auth user ID for personal products; or
- organization ID for organization products.

Keep checkout creation, portal, usage metering, entitlements, webhook projection, retry/idempotency, and reconciliation in the billing service when organization-scoped. Better Auth may still authenticate the caller and receive verified webhooks.

Webhook verification must use raw request bytes as required by the provider, replay protection/idempotency, stable event identity, and durable processing. Do not grant entitlements solely from the checkout success-page query string.

## Construction and resource lifetime

Avoid environment reads, database connections, and global logger configuration at package import. Build config through a Zod schema, then construct at the host composition root.

The uploaded frontend lazily memoizes `getAuth()` so public demo routes do not require auth/database configuration merely because the route tree imports account pages. This is useful when public and authenticated surfaces share a deployment, but the database/client shutdown owner must remain reachable for tests and graceful termination.

Forward request headers into `auth.api.getSession({ headers })`. Do not fabricate a browser session from client state in server loaders.

Cache auth instances only at a scope safe for the deployment runtime. Hot-reload, serverless isolate lifetime, per-request secrets, tenant-specific config, and test isolation can change the correct scope.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| session works locally, absent behind proxy | base URL/cookie secure/domain/forwarded headers | request/response cookie trace |
| browser method missing | client plugin not paired | server/client plugin lists and renderer import |
| passkey says RP/origin mismatch | public URL, RP ID, or port differs | browser origin and parsed config |
| OAuth discovery 404 | issuer/base path/wildcard route mismatch | route helpers and mounted handler |
| organization data crosses accounts | membership not enforced in service query | direct cross-org server test |
| every email sign-in blocked | verification required without workflow | sender/routes/config |
| magic link appears in logs | development callback retained | logging and secret-redaction audit |
| migration succeeds but plugin fails | plugin tables absent/schema drift | generated schema diff and DB inspection |
| duplicate Polar customers | user-scoped plugin plus org-scoped billing service | customer external IDs and checkout owners |
| public route requires DB env | eager auth import/construction | import graph and lazy composition |
| React auth hook in Solid app | renderer binding mismatch | client import and TS config |

## Verification

1. Parse empty, partial, local, preview, and production environment fixtures.
2. Prove incomplete social credentials fail validation.
3. Apply auth/plugin migrations to an empty and upgraded PostgreSQL database.
4. Test wildcard GET/POST handler at direct and proxied base paths.
5. Test sign-up/sign-in/sign-out/session expiry/revocation/cross-tab behavior.
6. Test organization create/invite/accept/select/remove and cross-org denial.
7. Test passkey registration/sign-in/recovery on real origins.
8. Test OAuth metadata, user-only scopes, organization scopes, consent, audiences, refresh, and revocation.
9. Test magic-link expiry/single use/rate limit without logging tokens.
10. Test Polar webhook signature, replay, out-of-order delivery, reconciliation, and organization identity.
11. Import public route modules without auth/database environment.
12. Verify production SSR/deployment adapter cookies and graceful database shutdown.

## Sources and freshness

- Primary: [Better Auth documentation](https://www.better-auth.com/docs/), verified 2026-07-17 for public server/client, adapter, session, organization, and plugin concepts.
- Historical source scope: a Better Auth 1.6.x integration and Solid/TanStack consumers reviewed 2026-07-17, adapted into anonymized examples.

The attachment is a user integration, not upstream Better Auth. Plugin option names, generated schema, cookie adapters, Polar behavior, and import paths are version-sensitive; unobserved private APIs remain unverified.
