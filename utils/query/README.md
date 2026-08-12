`@utils/query`
==============

Purpose
-------

`@utils/query` defines storage-neutral collection queries for filters, sorting,
sparse fieldsets, and bounded pagination. It validates and normalizes public
query input but does not execute a database query.

How it fits
-----------

HTTP request parsing can produce a normalized query value from this package.
A concrete database adapter then translates the value into Drizzle, ClickHouse,
SPARQL, or another native query language and rejects unsupported semantics.

Storage-neutral public collection-query definitions for filtering, sorting,
sparse fieldsets, bounded pagination, validation, encoding, documentation, and
provider capability checks.

The package does not execute database queries, construct HTTP responses, or
implement cursor cryptography. Drizzle/PostgreSQL, ClickHouse, SPARQL, and
Supabase adapters translate the normalized query value into their native query
language and must declare which semantics they can honor.

Define a query contract
-----------------------

```ts
import * as query from '@utils/query';

export const WidgetQuery = query.define({
  fields: {
    id: query.field(IdSchema, { sortable: true }),
    name: query.field(NameSchema, { sortable: true }),
    score: query.field(ScoreSchema, { sortable: true }),
    deletedAt: query.field(InstantSchema),
    internalNote: query.field(NoteSchema, { selectable: false }),
  },
  filters: {
    name: [query.eq, query.icontains, query.in],
    score: [query.gte, query.between],
    deletedAt: [query.isNull, query.isNotNull],
  },
  order: [query.desc('id', { tiebreaker: true })],
  pagination: query.pagination({
    default: 'cursor',
    cursor: query.cursor({ defaultLimit: 25, maximumLimit: 100 }),
    offset: query.offset({ defaultLimit: 20, maximumLimit: 100 }),
  }),
  fieldsets: {
    widgets: ['id', 'name', 'score'],
    owners: ['id', 'name'],
  },
  defaultFields: ['id', 'name', 'score'],
});
```

Cursor support requires exactly one stable tiebreaker so keyset traversal stays
deterministic.

Documented URL syntax
---------------------

```http
GET /widgets?
  filter[score][gte]=50&
  filter[deletedAt]=null&
  sort=score:desc,id:asc&
  fields=id,name,score&
  cursor=opaque&
  limit=50
```

JSON:API sparse fieldsets are preserved rather than flattened:

```http
GET /widgets?fields[widgets]=id,name&fields[owners]=id,name
```

Offset endpoints may accept either:

```http
GET /widgets?offset=40&limit=20
GET /widgets?page=3&per_page=20
```

Cursor, page, and offset modes cannot be mixed in one request. Unknown fields,
disallowed operators, invalid null semantics, duplicate sorts, excessive
values, and unsupported pagination fail closed with structured issues.

Provider adapters
-----------------

```ts
const compatibility = WidgetQuery.validateAdapter({
  operators: ['eq', 'gte', 'between', 'isNull'],
  pagination: ['offset'],
  fieldSelection: ['simple'],
  maximumSorts: 3,
});
```

Adapters reject unsupported operators or pagination strategies instead of
silently changing their meaning. Tenant, authorization, and row-level-security
predicates remain server-owned and are not represented by client filters.

`WidgetQuery.encode(value)` recreates canonical bracket filters, colon sorts,
sparse fieldsets, and the selected pagination form for link generation and
round-trip tests.


Request and adapter flow
------------------------

```ts
const ListImports = endpoint.get({
  id: 'imports.list',
  path: '/imports',
  query: ListImportsQuery,
  responses: [ImportPage],
  resources: [SelectImports],
});

const ListImportsHandler = endpoint.handler(ListImports, async (context) => {
  const selectImports = await context.resources.get(SelectImports);

  const page = await selectImports.execute({
    query: context.input.query,
    base: {
      organizationId: context.organization.id,
    },
    execution: context.execution,
  });

  return response.create(ImportPage, page);
});
```

The service runtime parses raw `URLSearchParams` and validates them through the
query definition before the handler runs. The handler receives a normalized
query value, not raw strings.

A provider package compiles the public definition once:

```ts
const SelectImports = postgres.collection(ListImportsQuery, {
  from: imports,
  columns: {
    id: imports.id,
    filename: imports.filename,
    status: imports.status,
    createdAt: imports.createdAt,
  },
  base: {
    organizationId: imports.organizationId,
  },
});
```

The adapter owns parameterized Drizzle expressions, keyset seek predicates,
count strategy, and cursor codec use. ClickHouse and SPARQL adapters map the
same normalized public contract into their native semantics and reject
unsupported combinations at adapter compilation.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

