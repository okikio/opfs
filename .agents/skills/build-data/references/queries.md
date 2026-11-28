# Query execution, safety, pagination, and count semantics

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference when translating a normalized query contract into SQL, SPARQL, search requests, or another storage protocol. The query layer must preserve server authority, public semantics, parameter safety, ordering, resource bounds, and error classification. A typed builder does not prove those properties.

## Contents

- Ownership handoffs
- Normalized query model
- Field and operator registries
- Server-owned constraints
- SQL construction
- SPARQL construction
- Sorting and cursor pagination
- Field selection
- Count strategies
- Resource and error policy
- Integration sequence
- Failure cases
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Ownership handoffs

Keep these layers separate:

```text
transport decoder
  -> normalized query specification
  -> endpoint/domain policy
  -> storage field/operator registry
  -> storage-specific expression compiler
  -> query execution and cancellation
  -> row/binding decoding
  -> response pagination/count metadata
```

Transport syntax does not own database identifiers. A public field such as `createdAt` maps through an allowlisted registry to a specific SQL column or SPARQL variable/pattern. The server owns tenant, organization, lifecycle, visibility, and other non-overridable constraints.

The current `@okikio/query` package owns checked query definitions and their supported wire encoding. Inspect its public field/operator, sort, and pagination contracts. An application adapter owns SQL/SPARQL execution, count semantics, authorization, and rejection of unsupported operators. A parsed query is data, not an executed or authorized query.

## Normalized query model

Use one internal model after source decoding. The following is an application design sketch, not the exported `@okikio/query` type or an exhaustive list of its operators:

```ts
type QuerySpec = {
  filters: null | Array<{
    field: string
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' |
      'between' | 'in' | 'nin' | 'contains' | 'icontains' |
      'startswith' | 'endswith' | 'is_null' | 'is_not_null'
    value?: unknown
  }>
  sorts: null | Array<{ field: string; direction: 'asc' | 'desc'; tiebreaker: boolean }>
  fields: null | { type: 'simple'; fields: string[] } |
    { type: 'jsonapi'; fields: Record<string, string[]> }
  pagination:
    | { type: 'offset'; offset: number; limit: number }
    | { type: 'cursor'; limit: number; cursor?: string; decodedCursor?: CursorData }
}
```

Disabled features need explicit semantics. If a consumer represents unavailable filters, sorts or fields as `null`, distinguish that from an empty request. Reject supplied unsupported parameters or document their treatment; do not silently accept a filter and ignore it.

Cap complexity before compilation: number of filters/sorts/selected fields, values in `in`, nesting if supported, offset, limit, decoded cursor size, query timeout, and maximum response rows/bytes.

## Field and operator registries

Public fields need storage-owned mappings:

```ts
const accountQueryFields = {
  status: {
    expression: account.status,
    filter: { type: 'enum', operators: ['eq', 'in'], values: ACCOUNT_STATUS },
    sortable: true,
    selectable: true,
  },
  createdAt: {
    expression: account.createdAt,
    filter: { type: 'date', operators: ['gt', 'gte', 'lt', 'lte', 'between'] },
    sortable: true,
    selectable: true,
  },
  id: { expression: account.id, sortable: true, selectable: true },
} as const
```

Registry rules:

- unknown fields/operators fail closed;
- values are parsed according to the registry, not guessed by the compiler;
- enum membership is explicit;
- null operators reject values;
- `between` requires exactly two ordered/coercible values;
- array-consuming operators are enabled per field and have length limits;
- string operators define escaping, collation, and case behavior;
- identifier/expression values come from code-owned registry entries only;
- sortable/selectable/filterable are separate capabilities.

An empty registry must have intentional semantics. Prefer deny-all for public input. An unrestricted internal mode needs an explicit name and a separate trusted caller; an empty configuration must not accidentally authorize arbitrary identifiers.

## Server-owned constraints

Apply policy constraints before user input and make them impossible for the client to remove:

```ts
const authority = and(
  eq(account.organizationId, auth.organizationId),
  ne(account.status, 'deleted'),
)

const userPredicate = compileFilters(spec.filters, accountQueryFields)
const where = and(authority, userPredicate)
```

Never use a client-provided organization ID as authority after merely validating that it is a UUID. Check membership/permission and bind the authorized organization/resource pair in the same query where feasible.

For SPARQL, “base patterns” must constrain the actual result graph. Adding a tenant triple pattern is insufficient if OPTIONAL/UNION/subquery structure lets data escape it. Test the generated query with adversarial data from two tenants.

## SQL construction

Compile normalized operators to the installed query builder/dialect:

| Public operator | SQL concept | Edge contract |
|---|---|---|
| `eq` / `ne` | `=` / `<>` | null uses distinct null operator, not `= NULL` |
| range | `> >= < <= BETWEEN` | type coercion and inclusive semantics |
| `in` / `nin` | `IN` / `NOT IN` | empty list semantics; null behavior; max size |
| contains | escaped `LIKE`/`ILIKE` or full-text | wildcard escaping, collation, index support |
| null | `IS NULL` / `IS NOT NULL` | no client value |

Use parameters for values. Registry-owned identifiers/expressions can be composed through the query builder. Do not interpolate arbitrary public fields, operators, sort fragments, table names, or loader column lists.

Inspect generated SQL and parameter order. Test query plans for representative filter/sort combinations. Type compatibility does not prove an index is usable or that a cast avoids it.

## SPARQL construction

Separate:

- term/variable/prefix construction;
- triple patterns and authoritative scoping;
- value serialization with datatype/language rules;
- filter expression construction;
- ordering and pagination;
- endpoint transport, timeout, and cancellation;
- SPARQL JSON result parsing;
- domain decoding and error mapping.

Do not build `IN`, `between`, or cursor expressions by concatenating `.value` strings unless the builder explicitly guarantees safe, correct serialization. Verify the selected backend's parameter/term representation and test malicious values, typed literals, and unsupported operators at its execution adapter.

Date values require correct RDF datatype and precision. A cursor value truncated to `YYYY-MM-DD` changes ordering if the field is actually `xsd:dateTime`. Tiebreaker comparisons through `STR(...)` can differ from numeric/IRI ordering. Match the cursor encoding and query term type exactly.

Treat query preview text as sensitive. Redact credentials/endpoints and consider whether literals contain personal data.

## Sorting and cursor pagination

Cursor pagination requires one deterministic total order. If the public sort is not unique, append an immutable unique tiebreaker:

```text
ORDER BY created_at DESC, id DESC
next page predicate:
  created_at < :last_created_at
  OR (created_at = :last_created_at AND id < :last_id)
```

Cursor payload should bind to the semantics it resumes:

```ts
interface CursorV2 {
  version: 2
  resource: 'accounts'
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>
  position: Record<string, string | number>
  filterDigest: string
  authorityDigest?: string
  issuedAt: string
  expiresAt: string
}
```

Sign or authenticate opaque cursors where clients must not tamper with cursor positions. Canonicalize payloads before HMAC. Use constant-time signature comparison where the runtime provides it. Rotate secrets with a key/version identifier. Never include secret or private row data merely because the token is base64url encoded.

Authentication of cursor bytes does not bind them to a resource, filter, sort, or authority context. A cursor reused across filters can return incorrect pages even with a valid HMAC. Add a context digest or an equivalent server-owned binding and test cross-context rejection.

Offset pagination can be appropriate for bounded admin views or snapshot-stable results. Define maximum offset and concurrent-write behavior. Do not present it as stable traversal under ongoing inserts/deletes.

## Field selection

Field selection affects storage cost and public data exposure. Define:

- public-to-storage mapping;
- default selection;
- wildcard expansion semantics;
- always-required identity/tiebreaker fields;
- fields required for authorization/domain mapping but omitted from response;
- JSON:API resource-type handling if supported;
- relationship expansion separately from scalar selection;
- maximum selected fields.

Do not treat `allowedFields: []` as unrestricted accidentally. Do not expose a new database column automatically through `*`. Expand wildcards against an explicit public registry.

## Count strategies

Name the strategy in code and response metadata:

| Strategy | Meaning | Verification |
|---|---|---|
| Exact | Count of the same authoritative filtered relation | Execute count with identical base/user predicates |
| Planned | Planner estimate for the active query | `EXPLAIN`/planner output for that filtered query |
| Estimated | Coarse table/relation statistic | Document that filters may not be reflected |
| None | No total promised | Continuation/next cursor only |

Do not label a relation estimate “total” if clients interpret it as exact filtered rows. Decide whether counts share the request snapshot with page rows. If not, document that concurrent writes can make them differ.

## Resource and error policy

Set and propagate:

- database/endpoint timeout;
- request abort/cancellation;
- statement/result limits;
- pool wait timeout;
- query complexity caps;
- retry policy only for safe transient failures;
- redaction of SQL/SPARQL and values;
- stable domain/API error categories.

Map expected failures such as invalid cursor, expired cursor, unsupported field, timeout, unavailable store, serialization retry exhaustion, and rejected query complexity. Preserve the cause in diagnostics without returning raw driver/query text to clients.

## Integration sequence

```text
decode query/json/form source
  -> validate and normalize public query spec
  -> resolve current authorization/tenant authority
  -> map public fields/operators through storage registry
  -> compile parameterized SQL/SPARQL/search request
  -> execute with timeout/cancellation/resource bounds
  -> decode rows/bindings and fetch one extra row if using cursor continuation
  -> construct signed next/previous cursor from actual position rows
  -> execute declared count strategy
  -> shape stable response metadata
```

## Failure cases

| Signature | Likely defect | Required correction |
|---|---|---|
| Cross-tenant row appears with valid input | Client filter substituted for authority | Server-owned predicate and adversarial fixture |
| Cursor repeats/skips equal timestamps | No stable or direction-consistent tiebreaker | Compound total order and concurrent pagination test |
| Valid cursor works with different filters | Cursor not bound to query context | Filter/resource/version digest |
| Search works but SQL fails for same operator | Shared public model overpromises dialect parity | Per-backend capability registry |
| SPARQL literal breaks query | Raw expression/value concatenation | Inspected serializer/builder and malicious literal tests |
| Exact count differs semantically from page | Predicates or snapshot differ | Shared authority/filter compiler and documented consistency |
| Query compiles but scans entire table | Type/cast/index mismatch | Representative `EXPLAIN` and performance bound |
| Empty allowlist exposes arbitrary columns | Empty interpreted as unrestricted | Explicit deny-all/unrestricted modes |

## Test matrix

Test:

- every field/operator/type pair and forbidden pair;
- null, empty list, large list, malformed date/UUID/number, Unicode, wildcard characters;
- public field names that resemble SQL/SPARQL injection;
- server authority plus adversarial tenant/org filters;
- disabled features and ignored-parameter prevention;
- ascending/descending single and compound sorts;
- duplicate primary sort values and stable tiebreakers;
- insert/delete/update between pages;
- cursor tampering, expiry, key rotation, wrong endpoint/filter/sort/version;
- first/last/empty page, limit+1 continuation, previous-page semantics if supported;
- exact/planned/estimated/no-count response contracts;
- timeout, cancellation, unavailable engine, pool exhaustion;
- generated SQL parameter order and representative query plans;
- generated SPARQL escaping, datatypes, query endpoint behavior, and cross-tenant fixture;
- result decoding for nulls, decimals, dates, IRIs, language tags, and driver-specific values.

## Executable verification

Capture generated query text and parameters in tests through a safe test adapter, then run against disposable real engines. Use `EXPLAIN`/`EXPLAIN ANALYZE` only with controlled data and permissions. Replay a frozen dataset through every pagination mode and assert the set of IDs is complete with no duplicates. Execute malicious and cross-tenant inputs and require zero unauthorized results.

For SPARQL, run queries against the selected QLever/Blazegraph/other engine; parser-level builder tests cannot establish engine extension or term-comparison behavior.

## Deliberate exclusions

- Do not require one query implementation or infer public APIs from historical application code.
- Do not force Zod; Standard Schema or another selected validator can own normalization.
- Do not force Drizzle, `@okikio/sparql`, PostgreSQL, or a graph engine.
- Do not allow a generic query DSL to claim operators a backend cannot implement faithfully.
- Do not use arbitrary public identifiers or raw fragments.
- Do not encode authorization solely in a client-visible cursor or projection.
- Do not promise stable pagination without a total order and context-bound cursor.
- Do not call planner/table estimates exact.

## Sources and freshness

Primary utility source: [`query`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/mod.ts) and [`query/postgres`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/postgres.ts). The PostgreSQL adapter compiles SQL and parameters; it does not execute queries. The conceptual model in this guide is application-owned. Consult the selected database's official documentation and test identifier safety, cursor context, count policy and datatype comparisons against its installed version.
