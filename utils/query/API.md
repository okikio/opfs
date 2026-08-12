@utils/query public API usage
=============================

Purpose
-------

This reference maps every public export target declared by `@utils/query` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/query
------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `asc` | function | Define ascending default/stable ordering. | `asc(...)` | `.agents/tests/production-e2e.test.ts:161` uses `asc`. |
| `between` | value | Inclusive pair/range filter. | `between` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `contains` | value | Case-sensitive substring filter. | `contains` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `cursor` | function | Define opaque cursor pagination. | `cursor(...)` | `.agents/tests/production-e2e.test.ts:162` uses `cursor`. |
| `CursorCodec` | interface | Portable opaque cursor codec contract implemented by a resource adapter. | `value: CursorCodec` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPagination` | interface | Normalized cursor pagination request. | `value: CursorPagination` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationDefinition` | interface | Cursor pagination policy. | `value: CursorPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationOptions` | interface | Input accepted by {@link cursor}. | `value: CursorPaginationOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationParameters` | interface | Cursor query parameter names. | `value: CursorPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one storage-neutral collection query contract. | `define(...)` | `.agents/tests/production-e2e.test.ts:159` uses `define`. |
| `desc` | function | Define descending default/stable ordering. | `desc(...)` | `.agents/tests/public-api-matrix.test.ts:355` uses `desc`. |
| `document` | function | Create JSON-safe documentation for a query definition. | `document(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `endsWith` | value | Suffix filter. | `endsWith` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `eq` | value | Equality filter. | `eq` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `field` | function | Define one public query field. | `field(...)` | `.agents/tests/production-e2e.test.ts:160` uses `field`. |
| `gt` | value | Greater-than filter. | `gt` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `gte` | value | Greater-than-or-equal filter. | `gte` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `icontains` | value | Case-insensitive substring filter. | `icontains` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `in` | value | Set-membership filter. | `in` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `inArray` | value | Set-membership filter. | `inArray` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is a collection-query definition. | `is(...)` | `utils/server/service/runtime.ts:649` uses `is`. |
| `isNotNull` | value | Non-null check. | `isNotNull` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isNull` | value | Null check. | `isNull` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `lt` | value | Less-than filter. | `lt` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `lte` | value | Less-than-or-equal filter. | `lte` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ne` | value | Inequality filter. | `ne` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `nin` | export | Explicit readable alias for `nin`. | `nin` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `notInArray` | value | Set-exclusion filter. | `notInArray` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `offset` | function | Define bounded offset pagination with both offset/limit and page/per_page syntax. | `offset(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPagination` | interface | Normalized offset or page-number pagination request. | `value: OffsetPagination` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationDefinition` | interface | Offset pagination policy, including page-number syntax. | `value: OffsetPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationOptions` | interface | Input accepted by {@link offset}. | `value: OffsetPaginationOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationParameters` | interface | Offset/page query parameter names. | `value: OffsetPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `pagination` | function | Explicitly enable more than one pagination strategy for an endpoint. | `pagination(...)` | `utils/server/service/runtime_test.ts:199` uses `pagination`. |
| `PaginationModesDefinition` | interface | Explicitly supported pagination modes for one endpoint. | `value: PaginationModesDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationModesOptions` | interface | Input accepted by {@link pagination}. | `value: PaginationModesOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `paginationParameters` | function | Return exact query parameter names for request-aware pagination links. | `paginationParameters(...)` | `utils/server/service/runtime.ts:654` uses `paginationParameters`. |
| `QueryAdapterCapabilities` | interface | Capabilities truthfully supported by one provider adapter. | `value: QueryAdapterCapabilities` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryAdapterIssue` | interface | One provider capability mismatch. | `value: QueryAdapterIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryAdapterValidationResult` | type | Provider capability validation result. | `value: QueryAdapterValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDefinition` | interface | Runtime and documentation contract exposed by one query definition. | `value: QueryDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDefinitionInput` | interface | Complete storage-neutral query definition input. | `value: QueryDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDocument` | interface | JSON-safe query documentation. | `value: QueryDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryField` | interface | Query field schema and public documentation metadata. | `value: QueryField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldOptions` | interface | Input accepted by {@link field}. | `value: QueryFieldOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFields` | type | Named public field collection. | `value: QueryFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldSelection` | type | Normalized sparse-field selection. | `value: QueryFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsetDefinition` | interface | One allowed JSON:API sparse-fieldset resource. | `value: QueryFieldsetDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsetInput` | type | Authoring value accepted for a resource fieldset. | `value: QueryFieldsetInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsets` | type | Named sparse-fieldset resource collection. | `value: QueryFieldsets` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldValue` | type | Value type emitted by one query field. | `value: QueryFieldValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFilter` | type | One normalized filter. | `value: QueryFilter` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFilters` | type | Allowed filter operators by public field. | `value: QueryFilters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryIssue` | interface | Validation issue emitted while parsing a collection query. | `value: QueryIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOperator` | interface | Immutable query operator definition. | `value: QueryOperator` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOperatorName` | type | Built-in filter operator names. | `value: QueryOperatorName` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOrder` | interface | Static default sort entry. | `value: QueryOrder` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryPaginationDefinition` | type | Supported pagination definitions. | `value: QueryPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryPaginationParameters` | interface | Pagination parameter names exposed to server/response adapters. | `value: QueryPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryParseResult` | type | Non-throwing query parse result. | `value: QueryParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryRequirements` | interface | Query semantics required by a provider adapter. | `value: QueryRequirements` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QuerySort` | interface | One normalized client-selected sort. | `value: QuerySort` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QuerySortDirection` | type | Sort direction. | `value: QuerySortDirection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryValidationError` | class | Error thrown by `QueryDefinition.parse()`. | `new QueryValidationError(...)` | `.agents/tests/public-api-matrix.test.ts:354` uses `QueryValidationError`. |
| `QueryValue` | interface | Complete normalized collection query. | `value: QueryValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirements` | function | Describe provider capabilities required to execute a query definition faithfully. | `requirements(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResourceFieldSelection` | interface | JSON:API-style sparse fieldsets keyed by resource type. | `value: ResourceFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SimpleFieldSelection` | interface | Simple sparse-field selection for the endpoint's primary resource. | `value: SimpleFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `startsWith` | value | Prefix filter. | `startsWith` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validateAdapter` | function | Fail clearly when a provider adapter cannot honor a query definition. | `validateAdapter(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`asc` appears in `.agents/tests/production-e2e.test.ts:161`:

~~~~ typescript
order: [query.asc('id', { tiebreaker: true })],
			pagination: query.cursor(),
		});
		assert.equal(Query.requirements().stableTiebreaker, 'id');
~~~~

`cursor` appears in `.agents/tests/production-e2e.test.ts:162`:

~~~~ typescript
pagination: query.cursor(),
		});
		assert.equal(Query.requirements().stableTiebreaker, 'id');
		const values = await streams.collect([1, 2, 3], { maximumItems: 3 });
~~~~

`define` appears in `.agents/tests/production-e2e.test.ts:159`:

~~~~ typescript
const Query = query.define({
			fields: { id: query.field(Text, { sortable: true }) },
			order: [query.asc('id', { tiebreaker: true })],
			pagination: query.cursor(),
~~~~

`desc` appears in `.agents/tests/public-api-matrix.test.ts:355`:

~~~~ typescript
assert.equal(query.desc('id').direction, 'desc');
			assert.equal(new queue.QueueItemNotFoundError(`item-${index}`).itemId, `item-${index}`);
			assert.equal(new queue.QueueCapacityError(index + 1).capacity, index + 1);
			assert.equal(new queue.StaleClaimError('item', `claim-${index}`).claimId, `claim-${index}`);
~~~~

`field` appears in `.agents/tests/production-e2e.test.ts:160`:

~~~~ typescript
fields: { id: query.field(Text, { sortable: true }) },
			order: [query.asc('id', { tiebreaker: true })],
			pagination: query.cursor(),
		});
~~~~

`is` appears in `utils/server/service/runtime.ts:649`:

~~~~ typescript
if (!query.is(schema)) return Object.freeze({});
	const pageKind = typeof body === 'object' && body !== null && 'kind' in body
		? (body as { readonly kind?: unknown }).kind
		: undefined;
~~~~

`paginationParameters` appears in `utils/server/service/runtime.ts:654`:

~~~~ typescript
return query.paginationParameters(schema, pageKind) ?? Object.freeze({});
}

/**
~~~~

`pagination` appears in `utils/server/service/runtime_test.ts:199`:

~~~~ typescript
if (input.query.pagination.kind !== 'cursor') throw new TypeError('Expected cursor pagination.');
				return response.create(Page, {
				kind: 'cursor',
				items: [{ message: 'first' }],
~~~~

`QueryValidationError` appears in `.agents/tests/public-api-matrix.test.ts:354`:

~~~~ typescript
assert.equal(new query.QueryValidationError([{ code: 'invalid-value', message: 'invalid', path: ['value'] }]).issues.length, 1);
			assert.equal(query.desc('id').direction, 'desc');
			assert.equal(new queue.QueueItemNotFoundError(`item-${index}`).itemId, `item-${index}`);
			assert.equal(new queue.QueueCapacityError(index + 1).capacity, index + 1);
~~~~

@utils/query/definition
-----------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `asc` | function | Define ascending default/stable ordering. | `asc(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `cursor` | function | Define opaque cursor pagination. | `cursor(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one storage-neutral collection query contract. | `define(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `desc` | function | Define descending default/stable ordering. | `desc(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create JSON-safe documentation for a query definition. | `document(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `field` | function | Define one public query field. | `field(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is a collection-query definition. | `is(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `offset` | function | Define bounded offset pagination with both offset/limit and page/per_page syntax. | `offset(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `pagination` | function | Explicitly enable more than one pagination strategy for an endpoint. | `pagination(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `paginationParameters` | function | Return exact query parameter names for request-aware pagination links. | `paginationParameters(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryValidationError` | class | Error thrown by `QueryDefinition.parse()`. | `new QueryValidationError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirements` | function | Describe provider capabilities required to execute a query definition faithfully. | `requirements(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validateAdapter` | function | Fail clearly when a provider adapter cannot honor a query definition. | `validateAdapter(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/query/operators
----------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `between` | value | Inclusive pair/range filter. | `between` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `contains` | value | Case-sensitive substring filter. | `contains` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `endsWith` | value | Suffix filter. | `endsWith` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `eq` | value | Equality filter. | `eq` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `gt` | value | Greater-than filter. | `gt` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `gte` | value | Greater-than-or-equal filter. | `gte` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `icontains` | value | Case-insensitive substring filter. | `icontains` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `in` | export | Alias using the handbook spelling. | `in` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `inArray` | value | Set-membership filter. | `inArray` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isNotNull` | value | Non-null check. | `isNotNull` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isNull` | value | Null check. | `isNull` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `lt` | value | Less-than filter. | `lt` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `lte` | value | Less-than-or-equal filter. | `lte` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ne` | value | Inequality filter. | `ne` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `nin` | export | Explicit readable alias for `nin`. | `nin` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `notInArray` | value | Set-exclusion filter. | `notInArray` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `startsWith` | value | Prefix filter. | `startsWith` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/query/types
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `CursorCodec` | interface | Portable opaque cursor codec contract implemented by a resource adapter. | `value: CursorCodec` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPagination` | interface | Normalized cursor pagination request. | `value: CursorPagination` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationDefinition` | interface | Cursor pagination policy. | `value: CursorPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationOptions` | interface | Input accepted by {@link cursor}. | `value: CursorPaginationOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CursorPaginationParameters` | interface | Cursor query parameter names. | `value: CursorPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPagination` | interface | Normalized offset or page-number pagination request. | `value: OffsetPagination` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationDefinition` | interface | Offset pagination policy, including page-number syntax. | `value: OffsetPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationOptions` | interface | Input accepted by {@link offset}. | `value: OffsetPaginationOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OffsetPaginationParameters` | interface | Offset/page query parameter names. | `value: OffsetPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationModesDefinition` | interface | Explicitly supported pagination modes for one endpoint. | `value: PaginationModesDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PaginationModesOptions` | interface | Input accepted by {@link pagination}. | `value: PaginationModesOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryAdapterCapabilities` | interface | Capabilities truthfully supported by one provider adapter. | `value: QueryAdapterCapabilities` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryAdapterIssue` | interface | One provider capability mismatch. | `value: QueryAdapterIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryAdapterValidationResult` | type | Provider capability validation result. | `value: QueryAdapterValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDefinition` | interface | Runtime and documentation contract exposed by one query definition. | `value: QueryDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDefinitionInput` | interface | Complete storage-neutral query definition input. | `value: QueryDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryDocument` | interface | JSON-safe query documentation. | `value: QueryDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryField` | interface | Query field schema and public documentation metadata. | `value: QueryField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldOptions` | interface | Input accepted by {@link field}. | `value: QueryFieldOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFields` | type | Named public field collection. | `value: QueryFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldSelection` | type | Normalized sparse-field selection. | `value: QueryFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsetDefinition` | interface | One allowed JSON:API sparse-fieldset resource. | `value: QueryFieldsetDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsetInput` | type | Authoring value accepted for a resource fieldset. | `value: QueryFieldsetInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldsets` | type | Named sparse-fieldset resource collection. | `value: QueryFieldsets` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFieldValue` | type | Value type emitted by one query field. | `value: QueryFieldValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFilter` | type | One normalized filter. | `value: QueryFilter` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryFilters` | type | Allowed filter operators by public field. | `value: QueryFilters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryIssue` | interface | Validation issue emitted while parsing a collection query. | `value: QueryIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOperator` | interface | Immutable query operator definition. | `value: QueryOperator` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOperatorName` | type | Built-in filter operator names. | `value: QueryOperatorName` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryOrder` | interface | Static default sort entry. | `value: QueryOrder` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryPaginationDefinition` | type | Supported pagination definitions. | `value: QueryPaginationDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryPaginationParameters` | interface | Pagination parameter names exposed to server/response adapters. | `value: QueryPaginationParameters` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryParseResult` | type | Non-throwing query parse result. | `value: QueryParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryRequirements` | interface | Query semantics required by a provider adapter. | `value: QueryRequirements` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QuerySort` | interface | One normalized client-selected sort. | `value: QuerySort` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QuerySortDirection` | type | Sort direction. | `value: QuerySortDirection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueryValue` | interface | Complete normalized collection query. | `value: QueryValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResourceFieldSelection` | interface | JSON:API-style sparse fieldsets keyed by resource type. | `value: ResourceFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SimpleFieldSelection` | interface | Simple sparse-field selection for the endpoint's primary resource. | `value: SimpleFieldSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 140 public names across 4 package export targets. 9 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

