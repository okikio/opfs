`@utils/server/gateway`
=======================

Import-driven edge routing and forwarding derived from compiled service
artifacts. Gateway definitions do not copy service path strings and do not own
application authorization, entitlements, billing, or domain validation.

```text
compiled service route
  -> exact gateway route ownership
  -> shallow request guards and credential policy
  -> optional edge authentication / signed assertion
  -> sanitized streaming Request
  -> upstream fetch with manual redirects
  -> response policy and completion observation
```

Definition
----------

```ts
const DashboardCredentials = gateway.credentials({
  requestCookies: 'preserve',
  requestAuthorization: 'strip',
  responseCookies: 'preserve',
});

const DashboardPolicy = gateway.policy({
  id: 'dashboard',
  endpoints: [DashboardApi],
  bodyLimit: 5_000_000,
  timeout: Temporal.Duration.from({ seconds: 30 }),
  cache: gateway.noStore(),
  credentials: DashboardCredentials,
  redirects: gateway.redirects({ mode: 'rewrite-origin' }),
});

const PublicGateway = gateway.define({
  id: 'public',
  services: [
    gateway.mount(DashboardService, {
      origin: DashboardOrigin,
    }),
  ],
  policies: [DashboardPolicy],
});
```

The compiler resolves exact method/path ownership, origins, policy conflicts,
credential treatment, redirect behavior, observers, and manifests before a
runtime is created.

Secure defaults
---------------

Unless an imported policy says otherwise, the gateway strips:

- caller `Cookie`;
- caller `Authorization`;
- response `Set-Cookie`;
- hop-by-hop headers;
- caller-supplied `Forwarded` and `X-Forwarded-*`;
- caller-supplied application trust headers.

Authentication-provider proxy routes must opt into provider cookie
pass-through. Programmatic routes normally verify the incoming API credential,
strip it, and add a signed internal assertion through an explicit runtime
adapter.

Redirects use `redirect: 'manual'`. Policies may preserve the `Location`,
rewrite an internal origin to the public gateway origin, or reject cross-origin
locations outside an allowlist.

Streaming lifetime
------------------

The gateway does not buffer a body unless a declared policy needs bounded
inspection. The request body is forwarded as a stream, and the total timeout,
abort propagation, byte accounting, and lifecycle observers remain active until
the response body drains, cancels, aborts, or errors.

Observers
---------

Observer definitions are import-safe and handlers are bound by direct identity.
Events contain redacted identifiers and metrics, not cloned request/response
bodies or credential-bearing URLs:

```ts
const GatewayTelemetry = gateway.observer.define({
  id: 'gateway.telemetry',
  description: 'Records gateway lifecycle metrics.',
});

const GatewayTelemetryHandler = gateway.observer.handler(
  GatewayTelemetry,
  (event) => logger.info(event.kind, event),
);
```

Supported stages are `denied`, `forwarding`, `response`, `completed`, `failed`,
and `aborted`.


An observer answers a different question from middleware or a policy:

```text
policy
  decides what the gateway is allowed to do

observer
  records what the gateway actually did
```

Typical uses are route-denial audits, origin latency, bytes transferred,
upstream failure rates, client cancellation, and proving whether a streamed
response completed after its headers were sent. Observers are not mandatory for
a gateway to route traffic. They become required only when the gateway
definition imports an observer definition; the runtime then needs the matching
handler.

```text
forwarding
  sanitized request is about to leave the gateway

response
  upstream status and headers arrived

completed
  downstream body fully drained

aborted
  client or deadline cancelled the body

failed
  forwarding or the body stream failed
```
 Durable security audits should still be written through an
outbox rather than relying on best-effort logging.
