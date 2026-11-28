# Review a Better Auth integration against its installed contract

A signed-in person can still lack permission to read an attachment. Start with
one real request: the host constructs Better Auth with its configured adapter,
the routed handler establishes a session, and application policy checks current
membership and the requested record before returning private data. Diagnose
which owner failed before changing provider configuration or schema.

This reference supports configuration and review. It does not prescribe a new
installation, enable a provider, or authorize schema generation or migration.
Current source, resolved dependencies and executable checks own those facts.

## Resolve the version and the actual integration

Inspect the lockfile's resolved `better-auth` and separately packaged adapter or
plugin versions. A manifest range is a fallback when no resolution exists.
For an upgrade, keep the installed and target versions separate throughout the
review. Do not substitute a latest CLI or rolling documentation example for
an installed-version contract.

Start with the official [documentation index](https://better-auth.com/llms.txt)
and select matching version material where available. If a connected Better
Auth documentation tool offers version selection, select the resolved version
and retain its returned identifiers unchanged. Where published documentation is
rolling, compare the claim with installed declarations, exports and source;
state what remains unverified.

Locate the real server factory, application environment owner, database
adapter, route binding, client creation and enabled plugin lists. A package in
the lockfile or a feature in a plan does not establish that it is configured or
reachable. Read the consumer's package exports before choosing server, client,
framework or plugin import paths. Some plugins are separately packaged; do not
assume every plugin belongs under `better-auth/plugins`.

## Reconcile configuration with the host

Inspect each setting where the application supplies it. Keep reusable factories
inert; the executable chooses when to read environment values, acquire clients,
configure logging and attach listeners.

| Area | Decision and evidence to inspect |
| --- | --- |
| Origin and routes | Effective public origin, `baseURL`, `basePath`, reverse-proxy behavior and actual mounted methods/path. Confirm callback URLs against this route. |
| Secrets | Explicit source, required format for the installed version, deployment availability and rotation consequences. Do not print secrets or infer precedence between environment and options. |
| Credentials and providers | Actual email/password flag, configured social providers, callback URLs and provider credentials. A listed provider is not a working integration. |
| Trusted requests | Allowed origins, CSRF/origin checks, secure-cookie policy, domain scope and trusted proxy headers. Keep trust decisions with the deployment owner. |
| Storage | Adapter/driver compatibility, instantiated client, exact schema mapping, secondary storage and who closes each borrowed client. |
| Abuse controls | Rate-limit storage, process-local versus shared state, supported configuration and behavior on storage failure. |

Use [the options reference](https://better-auth.com/docs/reference/options) to
locate a setting, then verify its installed signature and effective value.
Do not copy default lifetimes, precedence rules or security labels from an older
guide. Document why an exception to cookie, origin or CSRF policy is required
and verify the resulting request boundary.

## Keep schema candidates separate from physical schema authority

An adapter maps Better Auth's logical models and fields to an ORM schema and
physical database. Compare all three. Do not assume a plural table name is the
logical model name or that every adapter normalizes names the same way.

Read the configured schema object and database history. Reconcile model and
column names, key generation, nullability, defaults, foreign keys, indexes,
relations and extra fields. Include tables and fields required by the exact
enabled plugins. Confirm that the adapter receives an initialized client of the
expected driver, rather than a configuration object with a similar shape.

When Better Auth generation produces a review candidate and Drizzle owns
PostgreSQL migration generation and application, treat the output as a candidate. Inspect the candidate's
semantic diff against the physical schema; preserve existing tables and
migration history. Resolve the exact config, output destination and command from
the workspace's finite tooling before running an authorized generation task.
A plugin change requires schema reconciliation, not automatic overwrite.

Generation, migration generation and migration application are separate steps.
An ORM's schema object or a passing type check cannot prove that the physical
database has been migrated. Any live operation requires an explicit target,
known credentials, consequences and recovery under the owning workflow. Never
borrow an ambient database URL or run a generic push command to silence drift.
See [the database concepts](https://better-auth.com/docs/concepts/database) for
upstream adapter distinctions; they do not replace the repository's migration owner.

## Trace sessions, cookies and revocation together

Identify the authoritative session store and any secondary storage or cookie
cache. Inspect `expiresIn`, refresh timing, freshness rules, cache age/version
and the actual logout/revocation path. Record units from the installed API.
The cache's representation is not the same question as where the authoritative
session lives or how quickly a revocation takes effect.

If a cache, stateless mode or shared store is enabled, trace what another
process and an already-open client observe after revocation. Check which custom
fields are cached or refetched; do not assume that a cached session carries
current membership. Verify expiry, refresh, logout and stale-cookie behavior
with the application's real adapters. A successful session lookup establishes
identity; the private operation still needs current record authorization.

Use [session management](https://better-auth.com/docs/concepts/session-management)
for the selected version's storage, freshness and cache semantics. A health
response alone cannot establish any of these lifecycle behaviors.

## Bind email, plugins and hooks deliberately

Verification and password-reset flows need actual application-owned senders.
Inspect when each callback is invoked, the URL and token lifetime, failure
reporting, replay behavior and what a user can do after delivery fails. Do not
infer a configured mail capability from an enabled auth option.

Compare the server plugin list with the matching client plugins and schema
requirements. Verify the installed package entry and options for organization,
passkey, magic-link, OTP, API-key, OAuth or other selected capabilities. Do not
retain a catalogue of popular plugins as evidence that this application uses
them. Framework-specific client bindings must match the authorized client scope.

Endpoint hooks and database hooks have different timing and state. Read the
installed callback signature and hook context before accessing paths, returned
responses, sessions or internal adapters. Trace whether failure prevents a
write, follows a committed write, or triggers an external effect. A callback
does not make a database write and an email or remote call atomic. Give retries
an explicit duplicate-safety or reconciliation contract.

Derive client/session types from the configured instance or the installed
library's supported inference surface. Do not maintain an independent record
shape or infer enabled plugins from a generic client type argument.

## Verify the boundary being claimed

For a configuration review, report configured versus planned capabilities and
exact source evidence. For an authorized change, exercise successful and
rejected sign-in, invalid or replayed tokens, expiry/refresh, logout/revocation,
provider or storage failure and current access denial as applicable. Use owned
disposable fixtures. Check the mounted HTTP path when claiming reachability;
check the real storage and recovery path when claiming persistence.

State unrun provider, browser, database and deployment checks separately. Neither
schema generation nor a healthy endpoint proves working callbacks, applied
migrations, session invalidation or protection of a private record.

## Provenance and further lookup

Curated from the supplied `using-better-auth` integration guide. Its useful
version-selection, adapter, session, plugin and lifecycle topics are retained
here as decisions to verify. The former installation sequence, latest-CLI
recipes, schema-push shortcuts and fixed default claims are intentionally not
active instructions. The supplied guide included no separate license notice;
this reference does not infer a license for upstream material.

Primary lookup: [Better Auth documentation](https://better-auth.com/docs),
[official repository](https://github.com/better-auth/better-auth),
[options](https://better-auth.com/docs/reference/options), and the version-aware
[index](https://better-auth.com/llms.txt). Link to a resolved release or commit
when citing installed behavior; `main` and rolling docs are discovery inputs.
