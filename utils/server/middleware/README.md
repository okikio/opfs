`@utils/server/middleware`
==========================

Import-safe middleware contracts, typed context definitions, direct runtime
handler bindings, deterministic placement plans, validation, and documentation.

The package does not own authentication providers, organization repositories,
Hono applications, request validation, permissions, billing, or resource
construction. Those concerns contribute their own definitions and are composed
by the server compiler.

Definitions and context
-----------------------

```ts
import * as middleware from '@utils/server/middleware';

export const Authentication = middleware.context<{
  readonly actorId: string;
}>()({
  id: 'identity.authentication',
  description: 'Verified application authentication.',
});

export const Organization = middleware.context<{
  readonly organizationId: string;
}>()({
  id: 'identity.organization',
  description: 'Active organization.',
});

export const ResolveOrganization = middleware.define({
  id: 'identity.resolve-organization',
  description: 'Resolve the active organization.',
  requires: [Authentication],
  provides: [Organization],
  resources: [OrganizationRepository],
  problems: [OrganizationRequired],
});
```

Definitions are static data. Runtime behavior is supplied separately and bound
by direct identity:

```ts
export const ResolveOrganizationHandler = middleware.handler(
  ResolveOrganization,
  async (context, next) => {
    // Resolve and set the declared context value.
    return await next();
  },
);
```

Placement and ordering
----------------------

A plain middleware definition uses the normal `afterValidation` lane. Special
placement is explicit at the composition site:

```ts
middleware: [
  middleware.wholeRequest(RequestDiagnostics),
  middleware.beforeValidation(VerifyWebhookSignature),
  ResolveOrganization,
  middleware.aroundOperation(TransactionBoundary),
]
```

The lane names describe **what they surround**, not what the middleware itself does:

1. `wholeRequest` — surrounds every application stage from raw request guards
   through the declared handler result. It does not imply that a streamed body
   has finished reaching the client.
2. `beforeValidation` — runs after whole-request setup and before endpoint input
   parsing/Standard Schema validation. Use it for exact raw webhook signatures
   and other pre-parsing guards.
3. `afterValidation` — the default lane. It receives validated inputs and runs
   before authorization, entitlements, billing, and the operation.
4. `aroundOperation` — the innermost lane immediately around the endpoint
   handler. Use it for transactions and units of work.

```text
incoming Request
│
├─ wholeRequest.before
│  │
│  ├─ beforeValidation.before
│  │  ├─ authentication
│  │  ├─ parse request locations
│  │  ├─ Standard Schema validation
│  │  │
│  │  └─ afterValidation.before        ← default lane
│  │     ├─ permissions
│  │     ├─ entitlements
│  │     ├─ billing admission
│  │     │
│  │     └─ aroundOperation.before
│  │        └─ endpoint handler
│  │        aroundOperation.after
│  │     afterValidation.after
│  │  beforeValidation.after
│  wholeRequest.after
│
├─ verify declared result/problem
├─ materialize with the Hono Context
└─ response-completion observer
   body drained, cancelled, aborted, or errored
```

Authored order is preserved within each lane. Each lane uses normal onion
semantics, so post-`next()` work unwinds in reverse order. Response completion
is deliberately a separate host lifecycle because returning a streaming
response is not the same as finishing delivery.

Once-per-request handlers
-------------------------

When the same imported middleware definition is intentionally contributed at
several composition layers, wrap its runtime binding rather than storing state
in Hono or module-global sets:

```ts
export const RequestMetricsHandler = middleware.once(
  middleware.handler(RequestMetrics, async (context, next) => {
    return await recordRequest(context, next);
  }),
);
```

The wrapper is keyed by the actual `Request` object and exact middleware
definition. Duplicate occurrences still call `next()`, while the wrapped inner
work runs once. A different request is never suppressed.

Validation and documentation
----------------------------

- `middleware.plan()` normalizes nested middleware input into deterministic
  lanes.
- `middleware.validate()` detects duplicate IDs, unavailable required context,
  and conflicting context providers before runtime creation.
- `middleware.middlewareCatalog()`, `select()`, and `compose()` provide reusable
  immutable collections without global registration.
- `middleware.document()` produces JSON-safe context, resource, problem,
  permission, entitlement, and resiliency inventories.

Definitions snapshot nested contribution arrays, so later mutation of authoring
inputs cannot change a compiled graph.
