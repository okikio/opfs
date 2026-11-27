# Gateway route authority and forwarding lifetime

## Mental model

A gateway owns a network hop. It derives method/path routing from live service
definitions or an explicitly admitted artifact, then applies host forwarding
policy. A mount describes the origin; it does not instantiate a service.
Compilation checks static route/policy data, not upstream business behavior.

The origin still owns validation, domain authorization, and storage. Edge
authentication is not permission to a domain record. For a local Fetch handler,
use in-process composition rather than creating a network gateway.

## Current utility composition

Resolve `@okikio/server/gateway` from the verified source or installed artifact.
Use `use-utils` to check publication separately from the source version:

```text
exact ServiceDefinition + origin -> gateway.mount
mounts + edge policies -> gateway.define -> gateway.compile
compiled graph + transport/adapters -> gateway.create -> fetch(Request)
```

Imported definitions supply route identity for `mount()`. The explicit
`mountArtifact()` path instead validates and snapshots an owner-projected
routing manifest and OpenAPI document. The host must select admitted route IDs,
resolve the origin, bind foreign authentication IDs and map caller security
schemes. Serialized data never impersonates a local definition object.
The deployment host owns sockets, process lifetime and upstream startup.

The inspected manifest declares `@okikio/server/gateway/openapi`,
`@okikio/server/gateway/artifact` and `@okikio/server/client`. Check the consumer's
resolved export map before using them. Telemetry adapters belong to the
telemetry package; the application owns backend configuration.

## Forwarding policy

The inspected gateway defaults strip caller cookies, authorization, response
cookies, hop-by-hop headers, and untrusted forwarding/trust headers. Deliberate
pass-through requires route policy. Provider-auth routes may need cookies;
programmatic routes may strip a credential and attach a verified internal
assertion through the live host. Do not broaden every route to fix one provider.

The gateway reconstructs forwarding metadata from trusted host inputs. Test
spoofed `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, and application trust fields.
Redirects are handled manually under preserve, rewrite, or allowlist policy.
Inspect request body admission, correlation, cache, timeout, and response policy
together, including headers nominated by `Connection`.

## Response lifetime is longer than headers

Preserve cancellation and any configured total timeout through body completion,
cancellation, or source error. Retire acquired upstream bodies after abort even
when downstream never begins reading. Release readers and listeners when the
body completes. Returning status/headers is not terminal resource completion.

Native Fetch may decode supported compressed responses while retaining wire
metadata. Use the selected implementation's response filtering; do not blindly
preserve stale content length/encoding or assume a custom transport has native
decoding semantics. Keep request forwarding streaming unless a bounded policy
explicitly requires inspection.

Observers record forwarding, response, completed, denied, failed, or aborted
stages. They do not provide a durable security audit or an outbox.

## Proof and common failures

Test with an injected upstream Fetch function and inspect both sides of the hop:

- compiled method/path and service prefix, including unknown routes;
- credential and response-cookie policy for each affected route class;
- forged forwarding metadata and manual redirect decisions;
- body-limit rejection before unintended upstream work;
- disconnect/deadline during streaming and retirement of unread bodies;
- observer terminal stage and absence of credential/body disclosure.

Then test the real listener/proxy topology when deployment behavior is claimed.
A unit test that returns an upstream Response is not proof of origin-side
authorization or real reverse-proxy streaming.

## Sources and freshness

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[gateway exports](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/gateway/mod.ts),
[artifact admission](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/gateway/artifact.ts),
[credential defaults](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/gateway/definition.ts), and
[package subpaths](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/package.json).
These are source contracts, not registry-publication or deployment results.
Verify the selected transport, adapter, origin and listener for stronger claims.
