# API query contracts and collection endpoints

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


Use this reference when an HTTP/API endpoint exposes filtering, sorting, field selection, pagination, counts, search, or graph queries. It owns public syntax and semantic compatibility. Compose with `build-data/references/queries.md` for storage compilation and execution.

## Contents

- Public ownership model
- Source decoding and normalization
- Endpoint configuration
- Filtering
- Sorting
- Field selection
- Pagination and cursors
- Count and response metadata
- Authorization and policy
- Compatibility and OpenAPI
- Integration example
- Failure and error mapping
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Public ownership model

An API query contract includes more than a request schema:

- accepted source and exact wire syntax;
- supported public fields/operators/directions;
- defaults and disabled-feature behavior;
- maximum complexity and page size;
- stable ordering and cursor semantics;
- count semantics;
- server-owned tenant/visibility policy;
- response envelope, links, pagination metadata, status, and headers;
- stable errors for invalid, expired, forbidden, too-complex, timed-out, and unavailable queries;
- versioning and generated-client/OpenAPI behavior.

Changing default order, cursor payload interpretation, count from exact to estimated, wildcard expansion, or operation ID can break clients even when the JSON schema still validates.

## Source decoding and normalization

Query parameters, JSON bodies, and form data have different wire shapes. Decode one selected source and normalize into one internal query specification:

```text
query: filter[status][in]=open,blocked&sort=-created_at&fields=id,status
  -> transport decoder
  -> normalized filters/sorts/fields/pagination
```

Do not merge sources by an undocumented precedence such as JSON over query over form. If an endpoint accepts multiple sources, define whether duplicate components conflict, one source wins, or the request is rejected.

The current `@okikio/query` definition parses the declared request language and can encode its supported wire form. Inspect exported fields/operators and pagination contracts. The application's backend adapter executes the checked data and rejects unsupported semantics; parsing alone proves neither query execution nor authorization.

Parsing and policy are separate:

- decoder recognizes bracket/CSV/JSON syntax;
- validator enforces limits and public registries;
- handler receives normalized values only after matching middleware ran;
- data layer maps approved public fields to storage expressions.

## Endpoint configuration

Make each collection endpoint's capabilities inspectable:

```ts
const ListAccountsQuery = defineCollectionQuery({
  source: 'query',
  filters: {
    max: 12,
    fields: {
      status: { type: 'enum', operators: ['eq', 'in'], values: ACCOUNT_STATUS },
      openedAt: { type: 'date', operators: ['gte', 'lte'] },
    },
  },
  sorts: {
    allowed: ['createdAt', 'name'],
    default: [{ field: 'createdAt', direction: 'desc' }],
    tiebreaker: 'id',
    max: 3,
  },
  fields: {
    allowed: ['id', 'name', 'status', 'createdAt'],
    defaults: ['id', 'name', 'status'],
  },
  pagination: { modes: ['cursor'], defaultLimit: 20, maxLimit: 100 },
  count: 'none',
})
```

This is a conceptual contract. Use the consumer's selected schema/query library and verified APIs.

Disabled components must either reject supplied parameters or document that the component is unavailable and normalizes to `null`. Silently accepting ignored filters is a false API.

## Filtering

Useful URL syntax includes:

```text
filter[status]=active
filter[amount][gte]=50
filter[amount][lte]=200
filter[deleted_at]=null
filter[status][in]=open,blocked
```

Define:

- whether missing operator means `eq`;
- null keywords versus literal strings;
- escaping/delimiter rules for arrays (CSV is ambiguous when values contain commas);
- repeated-key behavior;
- AND/OR semantics; do not imply arbitrary boolean groups if only AND exists;
- supported operators per field;
- scalar types and enum values;
- maximum filters and values;
- date/timezone normalization;
- empty list behavior.

Do not expose storage column names by accident. Public fields map through an allowlist. Reject unknown operators before the storage layer.

## Sorting

Define one public syntax, for example `sort=-createdAt,name`, and whether `-` means descending. Each endpoint owns allowed fields, defaults, maximum keys, and the immutable unique tiebreaker.

A sort contract is semantically breaking if its default or null/collation behavior changes. If clients can sort by a non-unique field, the API still appends a tiebreaker for cursor stability, whether or not it is displayed in public metadata.

Reject a client attempt to mark an arbitrary field as the cursor tiebreaker. That is server-owned configuration.

## Field selection

Support only what the response model can honor:

```text
fields=id,name,status
fields[accounts]=id,name
```

Define wildcard, default, duplicate, unknown-field, and cross-resource behavior. Keep relationship inclusion separate from scalar field selection. Always load internal fields needed for authorization/cursor construction, then omit them from the response if they are not public.

Never make `*` mean “every current database column.” Expand against an explicit public registry, so a newly added secret/internal column cannot become public.

## Pagination and cursors

Expose cursor and offset as different contracts, not interchangeable fields.

Cursor response example:

```json
{
  "data": [],
  "pagination": {
    "type": "cursor",
    "limit": 20,
    "next": "opaque-token",
    "previous": null,
    "expiresAt": "2026-07-18T14:22:33Z"
  }
}
```

Define:

- stable sort and tiebreaker;
- opaque authenticated token policy;
- TTL and the endpoint's documented expired-token status;
- invalid/tampered/cross-endpoint status;
- binding to filters, sort, resource, API version, and relevant authority context;
- next and previous direction semantics;
- behavior under inserts, deletes, and updates;
- page size and `limit + 1` continuation detection.

A cursor that contains only sort values, a tiebreaker, direction and creation time does not bind itself to a resource, filter or authorization scope. Include and validate that context when cross-query replay would change the contract.

Offset/page pagination must define maximum offset and concurrent-write instability. It can be appropriate for bounded administration or snapshot-stable results.

## Count and response metadata

Publicly distinguish:

- `exact`: same authoritative filtered relation;
- `planned`: planner estimate for the filtered query;
- `estimated`: coarse relation/table statistic;
- `none`: no total promised.

Use names clients cannot mistake:

```json
{"count":{"mode":"estimated","value":120000,"asOf":"2026-07-17T14:22:33Z"}}
```

Do not put an estimate in `total` if generated clients/UI treat it as exact. If page rows and count are not read from one snapshot, document that they may diverge under concurrent writes.

Response contracts include status and headers as well as payload. Model success variants and stable problem details. A payload-only schema can pass while the actual tuple/wrapper/status is wrong.

## Authorization and policy

Authentication identifies a session/user; it does not authorize requested organization, family, account, or dataset. The endpoint should resolve current authority and pass server-owned constraints to execution:

```text
valid session
  -> current membership/permission
  -> requested resource belongs to authorized organization
  -> base query predicate
  -> client filters within that scope
```

Do not accept `organization_id` as a normal client filter that can broaden results. Avoid counts that reveal out-of-scope records. Search/SPARQL projections cannot substitute for current membership unless the architecture explicitly owns and validates that authority.

## Compatibility and OpenAPI

Document the exact query syntax in OpenAPI using the capabilities of the chosen generator. Complex bracket notation or JSON-encoded filters may need examples and manual parameter definitions. Verify generated clients; some generators cannot represent arbitrary deep-object query syntax consistently.

Treat these as possible breaking changes:

- rename/remove field or operator;
- alter coercion, case, date/timezone, null, or empty semantics;
- change default sort/tiebreaker;
- change cursor version, signing, TTL, or context;
- change count mode/meaning;
- lower limits clients relied on;
- change operation ID or response metadata shape;
- change disabled parameters from reject to ignore or vice versa.

Version cursor payloads and reject unsupported versions rather than guessing.

## Integration example

```ts
export const Middleware = [
  requireSession(),
  requireOrganizationMembership(),
  validate('query', ListAccountsQuery),
]

export async function Handler(c: Context) {
  const query = c.req.valid('query')
  const authority = c.get('organizationAuthority')
  const result = await accounts.list({ query, authority, signal: c.req.raw.signal })
  return c.json(toCollectionResponse(result), 200)
}
```

Names are illustrative. If the consumer uses Hono validators, middleware registration must match `c.req.valid(...)`. If another framework is selected, preserve the same ownership and cancellation path.

## Failure and error mapping

| Failure | Public contract | Internal evidence |
|---|---|---|
| unknown field/operator | 400/422 stable validation problem | normalized issue path and endpoint config |
| malformed cursor/signature | 400 invalid cursor | safe reason, cursor version/key ID |
| expired cursor | documented 410 or selected status | age/TTL without token contents |
| wrong filter/resource/version cursor | 400 invalid context | expected/actual digest metadata safely |
| unauthorized organization/resource | 403 or non-disclosing 404 by policy | current membership decision and trace |
| query timeout/engine unavailable | stable timeout/unavailable problem | dependency, duration, retryability |
| result decoding defect | 500 generic problem | schema/driver cause, never raw values to client |

## Test matrix

Test:

- query, JSON, and form sources only where endpoint declares them;
- source conflicts and repeated keys;
- every allowed/forbidden field/operator/type;
- null, arrays, delimiters, Unicode, wildcards, malformed dates/numbers;
- complexity, page, offset, and value-list limits;
- disabled components with supplied parameters;
- default and compound sorts with duplicates;
- cursor round trip, tampering, expiry, rotation, wrong route/filter/sort/version;
- inserts/deletes/updates between pages;
- exact/planned/estimated/no-count response semantics;
- fields defaults/wildcard/internal-field exclusion;
- current membership and cross-tenant adversarial requests;
- OpenAPI output and at least one generated/real client encoding;
- response status, headers, envelope, links, and problem variants;
- timeout/cancellation and dependency errors;
- semantic compatibility snapshots for defaults and operation IDs.

## Executable verification

Start the actual service, issue encoded requests with `curl` or the repository client, and inspect the generated OpenAPI document. Traverse a fixture collection through all cursor pages and assert every authorized ID appears once. Repeat while inserting/deleting records. Attempt cross-organization filters and cursors. Compare exact counts with the same authoritative predicate. Verify cancellation reaches the storage request.

## Deliberate exclusions

- Do not force one query utility, Hono, Zod, Drizzle, or SPARQL library.
- Do not advertise operators the selected backend cannot implement consistently.
- Do not accept and ignore unsupported query parameters.
- Do not expose raw database fields through wildcard selection.
- Do not trust client tenant filters or cursor contents as authorization.
- Do not call estimated counts exact.
- Do not assume OpenAPI schema compatibility means semantic compatibility.
- Do not promise stable pagination without total ordering and context-bound cursors.

## Sources and freshness

Public utility source: [`query`](https://github.com/okikio/utils/tree/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query) and [`server/endpoint`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/endpoint/mod.ts), inspected at the pinned revision. Source APIs do not prove registry availability. The conceptual contracts in this guide are application design criteria, not additional package exports. Verify wire encoding, cursor context, OpenAPI and generated clients in the consumer's selected version.
