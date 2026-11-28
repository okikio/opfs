# HTTP runtime, middleware, errors, and resources

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [Adapter preflight](#adapter-preflight)
- [Middleware ownership and order](#middleware-ownership-and-order)
- [Request context](#request-context)
- [Error mapper](#error-mapper)
- [Resource lifetime](#resource-lifetime)
- [Timeout and cancellation](#timeout-and-cancellation)
- [Logging and tracing](#logging-and-tracing)
- [Security defaults](#security-defaults)
- [Verification](#verification)

## Adapter preflight

Hono's standards-oriented API does not make every host identical. Inspect the
actual deployed adapter for:

- request/response streaming and disconnect signals;
- raw request access required by webhook signature verification;
- connection and execution duration limits;
- body size and multipart behavior;
- WebSocket/SSE support;
- remote address and trusted proxy handling;
- serverless instance/resource reuse;
- graceful shutdown hooks;
- TLS and HTTP protocol ownership.

Run adapter-specific integration tests. An `app.request(...)` test proves route
composition, not the host's networking or lifetime behavior.

## Middleware ownership and order

Use three levels:

| Level | Examples | Rule |
|---|---|---|
| Root | correlation, security headers, tracing, error mapper, access log | Install exactly once |
| Service/group | service capability context, shared org policy, rate limits | Mount on explicit prefix/group |
| Route | auth requirement, resource authorization, source validation | Keep visible beside handler |

For a directly authored Hono stack, a typical order is:

1. request ID/correlation and safe request context;
2. trusted proxy/origin/security policy;
3. tracing, timing, and access-log frame;
4. CORS where cross-origin browser access is intended;
5. session authentication;
6. capability adapters/resource context;
7. organization/resource authorization;
8. request-source validation;
9. handler;
10. centralized result/error normalization and final access record.

The framework's onion execution order means “registered first” and “response
finalizes first” can differ. Test both request and response phases. Do not assume
nested Hono apps deduplicate middleware.

## Request context

Put guarantees, not arbitrary bags, into context:

- parsed correlation/request ID;
- authenticated session or explicit anonymous marker;
- authorized organization/resource scope;
- request logger/span already bound to safe fields;
- capabilities or an Effect runner backed by host-owned resources;
- request deadline/disconnect signal.

Make context types reflect middleware preconditions. A route that needs an
organization should not accept the optional environment type and then assert
non-null inside the handler.

Do not store raw request bodies, auth headers, cookies, passwords, or unredacted
provider payloads in generic context or log properties.

## Error mapper

One root error mapper owns unexpected failure completion. Translation sequence:

```text
expected domain error
  -> stable problem variant
unexpected typed infrastructure error
  -> safe 5xx problem + structured redacted cause
defect / unknown throw
  -> safe 500 + Cause/stack in controlled diagnostics
response already committed
  -> abort/close stream + diagnostic; never attempt second response
```

Handlers can map expected domain errors close to the route, but they should not
emit the same final error log and rethrow into the root logger. Use the selected
runtime's declared validation rejection, never a universal 422. The current
compiled utility service uses `ServerProblems.InvalidRequest` (400) for invalid
input and authenticates before normal body parsing/validation. Its declared
middleware lanes determine order; a Hono example does not reorder that runtime.
Authentication uses 401;
known authenticated-but-disallowed policy uses 403; hide resource existence with
404 only when that is the explicit security contract.

Preserve one correlation ID in public problems and diagnostics. Redact before a
record reaches any sink, including JSON/file/telemetry exporters.

## Resource lifetime

| Lifetime | Resources |
|---|---|
| Process/host | pools, logger sinks, auth, workflow clients, DNS/TLS clients |
| Request | spans, authorized scope, transaction when truly request-wide |
| Operation | temporary files, one upload decoder, one provider request |
| Stream | subscription, encoder, heartbeat, backpressure queue |

Construct host resources once and provide them through an explicit root. Avoid
module-scope acquisition because imports are used by tests, OpenAPI generation,
codegen, and CLIs. Export factories and pure registries from libraries.

If a serverless adapter reuses isolates, cache only resources the adapter permits
and handles safely. Do not infer that a global pool is safe on every edge host.

## Timeout and cancellation

Distinguish:

- client/request deadline;
- server handler timeout;
- database statement timeout;
- external provider connect/request timeout;
- workflow start RPC timeout;
- overall durable workflow/activity timeout.

Propagate the earliest relevant deadline or AbortSignal. A timeout response does
not prove downstream work stopped. Connect cancellation to fetch/database/Effect
interruption where supported, or persist a cancel/abandon policy.

Do not cancel durable work merely because the start request disconnects after
durable acceptance. Do cancel request-scoped queries, upload decoding, and SSE
delivery unless the contract says otherwise.

## Logging and tracing

If LogTape is the selected transport, use categories to separate stable results
from operational diagnostics and configure it once. HTTP APIs normally return
results as responses, while LogTape handles diagnostics; CLI raw result sinks are
a separate contract.

Recommended request diagnostic fields:

- correlation, trace, and request IDs;
- method and route template, not sensitive raw URL;
- service/operation and status;
- duration and response bytes where available;
- authenticated actor/organization only under policy;
- failure tag, retry/cancellation classification;
- workflow run ID for accepted work.

Avoid logging entire request/response bodies. Sample intentionally and apply
redaction before serialization. Make replay-aware logging choices inside durable
workflow runtimes so replay does not duplicate operational events.

## Security defaults

Production defaults are explicit. Do not label a preset secure while it enables
wildcard credentialed CORS, verbose errors, pretty development middleware,
trusted arbitrary proxy headers, unlimited bodies, or public diagnostics.

Define:

- exact allowed origins, methods, and credential behavior;
- trusted proxy count/ranges;
- security headers and CSP ownership;
- body/file limits and accepted content types;
- cookie security and CSRF policy;
- rate/admission limits at the correct identity scope;
- error-detail/redaction policy;
- health and metrics exposure.

## Verification

- Assert middleware invocation and order for success, validation, auth, handler
  failure, and committed streaming response.
- Test malformed proxy/origin/request IDs.
- Cancel a live database/provider call on disconnect.
- Exhaust the pool and verify bounded safe failure.
- Run concurrent requests against one shared resource graph.
- Import registries without env or network access.
- Start and drain the real adapter.
- Verify one correlated diagnostic per public failure and zero secret leakage.
- Test production CORS, body limit, timeout, and security-header configuration.

## Sources and freshness

- Hono official documentation: https://hono.dev/docs/ (primary source, checked
  2026-07-17; runtime adapter and streaming support are version-sensitive).
- Effect official documentation: https://effect.website/docs/ (primary source;
  interruption/runtime APIs require installed-version verification).
- LogTape official documentation: https://logtape.org/ (primary source; use only
  when the repository selects LogTape as transport).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
