# API contracts, validation, OpenAPI, and problems

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [Contract layers](#contract-layers)
- [Zod and Standard Schema ownership](#zod-and-standard-schema-ownership)
- [Request sources](#request-sources)
- [Normalization and coercion](#normalization-and-coercion)
- [Response and problem contracts](#response-and-problem-contracts)
- [OpenAPI completeness](#openapi-completeness)
- [Contract evolution](#contract-evolution)
- [Testing and verification](#testing-and-verification)
- [Failure signatures](#failure-signatures)

## Contract layers

Keep these layers distinct and traceable:

```text
wire bytes / URL / headers
  -> source-specific transport parser
  -> runtime schema validation
  -> normalized application input
  -> domain capability
  -> domain result or typed failure
  -> HTTP response variant
  -> OpenAPI operation and generated client expectations
```

The schema nearest the wire owns wire syntax. A domain schema owns domain
meaning. They can share fragments, but do not pretend a query-string boolean and
a JSON boolean have the same input representation.

Author wire schemas and endpoint definitions in their owning service or
capability, and re-export those import-safe definitions from published contract
packages. Do not independently define route identity, auth requirements, or
response schemas in an SDK package and then import that catalog back into its
own service. Derive OpenAPI from the mounted definition rather than duplicating
it in a hand-authored document.

## Zod and Standard Schema ownership

Use Zod v4 schemas as the source of truth where the repository has selected Zod,
then infer types with `z.input`, `z.output`, or the repository's helpers:

```ts
export const CreateImportJsonSchema = z.object({
  upload_id: z.uuid(),
  mapping: z.record(z.string(), z.string()),
})

export type CreateImportJsonInputType = z.input<typeof CreateImportJsonSchema>
export type CreateImportJsonType = z.output<typeof CreateImportJsonSchema>
```

Input and output types differ when a schema coerces, defaults, transforms, or
brands. Choose deliberately.

Use Standard Schema at a validator-neutral library API:

```ts
export async function validateWith<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: StandardSchemaV1.InferInput<TSchema>,
): Promise<StandardSchemaV1.InferOutput<TSchema>> {
  const result = await schema["~standard"].validate(input)
  if (result.issues) throw new BoundaryValidationError(result.issues)
  return result.value
}
```

Do not rewrite application schemas in multiple validators to prove neutrality.
Test the reusable utility against representative Zod and one other Standard
Schema implementation only when multi-validator support is a real requirement.

## Request sources

Define separate schemas for each source read by the handler:

| Source | Wire concerns | Common traps |
|---|---|---|
| Path params | Percent decoding, non-empty identifiers | Treating untrusted ID as authorization scope |
| Query | Repeated keys, strings, empty values, ordering | Boolean/number coercion and ignored unknown keys |
| Headers | Case-insensitive names, combined/repeated values | Expecting original casing after normalization |
| Cookies | Name/value restrictions, signing, scope | Treating client cookie as trusted session data |
| JSON | Content type, size, finite values, unknown fields | Parsing twice or accepting non-JSON content |
| Form/multipart | Repeated fields, files, limits, streaming | Buffering an unbounded upload |

Register matching middleware before reading a validated Hono source:

```ts
export const Middleware = [
  createValidator("param", Definition.schemas.Param),
  createValidator("query", Definition.schemas.Query),
  createValidator("json", Definition.schemas.Json),
]

const params = c.req.valid("param")
const query = c.req.valid("query")
const body = c.req.valid("json")
```

An endpoint definition alone does not populate `c.req.valid(...)`.

Validate each untrusted request source at its owning transport seam, then pass
the parsed output to the domain capability. Do not reparse the same schema in
admission, routing, and every handler merely to create typed values again.
Revalidate at a different trust or semantic seam, such as stored legacy data or
an external provider response, when that seam has an independent contract.

## Normalization and coercion

Normalize only after source-aware validation. Make absence, empty string, false,
zero, repeated values, and invalid values observably different where the API
contract needs them.

```ts
export const ListQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(200)).default("50"),
  cursor: z.string().min(1).optional(),
  include_archived: z.enum(["true", "false"]).transform((value) => value === "true").default("false"),
})
```

This is an example, not a universal coercion policy. If a query parser supplies
arrays for repeated keys, decide whether to reject or support them before the
transform. Do not let JavaScript's `Boolean("false")` or permissive `Number("")`
define the public API.

Use `.strict()`, `.passthrough()`, or explicit catchalls according to forward
compatibility and security needs. Security-sensitive command inputs usually
benefit from rejecting unknown fields; metadata bags may intentionally retain
them.

## Response and problem contracts

Model complete response variants, not the payload alone:

Enforce declared status, body, and headers at the serving seam when the API
promises runtime response validation. Otherwise prove equivalent guarantees
with typed handlers and focused real-response schema tests. Do not bypass a
declared response schema with unexamined direct JSON serialization on selected
branches. Match all documented problem variants as well as successful ones.

```ts
const Responses = {
  202: {
    contentType: "application/json",
    schema: AcceptedImportSchema,
    headers: z.object({ location: z.string().url() }),
  },
  401: problem("unauthorized"),
  403: problem("forbidden"),
  409: problem("idempotency-conflict"),
  422: validationProblem,
} as const
```

Use an RFC 9457-style problem registry with stable types/codes and safe public
detail. A problem should carry enough stable information for a client decision:

```json
{
  "type": "https://api.example.test/problems/idempotency-conflict",
  "title": "Idempotency key conflict",
  "status": 409,
  "detail": "The key was already used for a different request.",
  "instance": "/imports",
  "code": "idempotency_conflict",
  "correlation_id": "req_..."
}
```

Do not include SQL, filesystem, provider, stack, secret, or raw validation input
in a public problem. Preserve the original cause in redacted diagnostics.

For validation problems, retain source and path:

```json
{
  "code": "validation_failed",
  "errors": [
    {
      "source": "json",
      "path": ["mapping", "email"],
      "location": "json.mapping.email",
      "message": "Expected a column name"
    }
  ]
}
```

## OpenAPI completeness

OpenAPI is derived from the runtime definition registry or checked against it.
For each operation declare:

- stable `operationId`, method, path, tags, summary, and description;
- path/query/header/cookie parameters with required and repeated semantics;
- every request body content type and schema;
- every success, empty, redirect, accepted, validation, auth, conflict,
  rate-limit, and known domain-error response;
- response headers such as `Location`, `Retry-After`, cursor, ETag, or rate limit;
- auth/security schemes and per-operation requirements;
- examples that validate;
- deprecation and version information;
- streaming media type and event schema where applicable.

For accepted durable work, document status, cancellation, and event-stream links.
For cursor endpoints, document cursor opacity and invalid/expired behavior.

OpenAPI compatibility checks should distinguish:

| Change | Typical classification |
|---|---|
| Remove operation or response field | Breaking |
| Make optional request field required | Breaking |
| Narrow enum accepted by server | Breaking |
| Add optional response field | Usually compatible, but strict clients can fail |
| Add error response | Behaviorally significant; document and test |
| Change operation ID | Client-generation breaking |
| Change default/sort/cursor semantics | Semantic breaking even if schema unchanged |

## Contract evolution

Version behavior, not just shapes. Keep a compatibility window between deployed
clients, API hosts, workers, and migrations. Use additive evolution where
possible and explicit version negotiation where semantics cannot remain
compatible.

Do not embed a service implementation version into every route automatically.
Choose URL, header, media-type, or capability versioning according to external
consumer needs. Internal APIs still need deployment-order compatibility.

For events and workflow inputs, retain schemas/decoders for in-flight historical
versions or migrate durable records explicitly. An API host can accept a request
under a new schema while an older worker remains responsible for the run.

## Testing and verification

- Parse valid/invalid values for every request source.
- Assert handler non-execution after validation failure.
- Verify unknown-key, repeated-key, empty-value, coercion, content-type, and size
  behavior.
- Parse every actual success and problem response with its declared schema.
- Assert headers and empty responses, not only bodies.
- Verify safe causes and redaction with hostile provider/SQL error strings.
- Compare declared, registered, documented, and request-tested operation sets.
- Run OpenAPI lint and breaking-change checks against the released baseline.
- Generate a client and execute at least one representative request when client
  generation is promised.
- Replay stored workflow/event inputs against compatible decoders.

## Failure signatures

| Signature | Cause | Correction |
|---|---|---|
| `c.req.valid()` is empty | Validator middleware absent/wrong source | Pair schemas and route middleware |
| Type compiles but runtime returns string | `z.input`/`z.output` confusion or missing transform | Test parsed output |
| Client cannot handle actual response | Payload-only schema | Declare full variants/status/headers |
| OpenAPI route returns 404 | Generator catalog differs from runtime registry | One registry plus reachability test |
| Validation returns 500 | Transform threw outside normalized validation stage | Normalize schema and thrown validator errors |
| Cross-org ID passes schema | Validation mistaken for authorization | Server-owned policy after identity |
| Generated client breaks after “additive” change | Strict decoder or operation ID drift | Compatibility test the real client |
| Raw SQL appears in problem detail | Cause copied to public response | Stable problem and redacted diagnostic |

## Sources and freshness

- Standard Schema specification: https://github.com/standard-schema/standard-schema
  (primary source; validate the installed specification version).
- Zod v4 documentation: https://zod.dev/ (primary source; examples assume v4).
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html (primary source;
  generator/library support can lag the latest specification).
- RFC 9457 Problem Details: https://www.rfc-editor.org/rfc/rfc9457.html (stable standard).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/endpoint/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
