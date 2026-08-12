import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Query field schema and public documentation metadata. */
export interface QueryField<Schema extends StandardSchemaV1 = StandardSchemaV1> {
	readonly kind: 'query-field';
	readonly schema: Schema;
	readonly description?: string;
	readonly selectable: boolean;
	readonly sortable: boolean;
	readonly jsonSchema?: unknown;
}

/** Input accepted by {@link field}. */
export interface QueryFieldOptions {
	readonly description?: string;
	readonly selectable?: boolean;
	readonly sortable?: boolean;
	readonly jsonSchema?: unknown;
}

/** Named public field collection. */
export type QueryFields = Readonly<Record<string, QueryField>>;

/** Value type emitted by one query field. */
export type QueryFieldValue<Field extends QueryField> = StandardSchemaV1.InferOutput<Field['schema']>;

/** Built-in filter operator names. */
export type QueryOperatorName =
	| 'eq'
	| 'ne'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'between'
	| 'in'
	| 'nin'
	| 'contains'
	| 'icontains'
	| 'startsWith'
	| 'endsWith'
	| 'isNull'
	| 'isNotNull';

/** Immutable query operator definition. */
export interface QueryOperator<Name extends QueryOperatorName = QueryOperatorName> {
	readonly kind: 'query-operator';
	readonly id: `query:${Name}`;
	readonly name: Name;
	readonly value: 'none' | 'one' | 'many' | 'pair';
	readonly description: string;
}

/** Allowed filter operators by public field. */
export type QueryFilters<Fields extends QueryFields> = Readonly<
	Partial<Record<keyof Fields & string, readonly QueryOperator[]>>
>;

/** Sort direction. */
export type QuerySortDirection = 'asc' | 'desc';

/** Static default sort entry. */
export interface QueryOrder<Field extends string = string> {
	readonly kind: 'query-order';
	readonly field: Field;
	readonly direction: QuerySortDirection;
	readonly tiebreaker: boolean;
}

/** Cursor query parameter names. */
export interface CursorPaginationParameters {
	readonly cursor: string;
	readonly limit: string;
}

/** Offset/page query parameter names. */
export interface OffsetPaginationParameters {
	readonly offset: string;
	readonly limit: string;
	readonly page: string;
	readonly perPage: string;
}

/** Cursor pagination policy. */
export interface CursorPaginationDefinition {
	readonly kind: 'query-pagination';
	readonly type: 'cursor';
	readonly defaultLimit: number;
	readonly maximumLimit: number;
	readonly minimumLimit: number;
	readonly ttl?: Temporal.Duration;
	readonly parameters: CursorPaginationParameters;
}

/** Offset pagination policy, including page-number syntax. */
export interface OffsetPaginationDefinition {
	readonly kind: 'query-pagination';
	readonly type: 'offset';
	readonly defaultLimit: number;
	readonly maximumLimit: number;
	readonly minimumLimit: number;
	readonly maximumOffset: number;
	readonly defaultStyle: 'offset' | 'page';
	readonly parameters: OffsetPaginationParameters;
}

/** Explicitly supported pagination modes for one endpoint. */
export interface PaginationModesDefinition {
	readonly kind: 'query-pagination-modes';
	readonly type: 'modes';
	readonly default: 'cursor' | 'offset';
	readonly cursor?: CursorPaginationDefinition;
	readonly offset?: OffsetPaginationDefinition;
}

/** Supported pagination definitions. */
export type QueryPaginationDefinition =
	| CursorPaginationDefinition
	| OffsetPaginationDefinition
	| PaginationModesDefinition;

/** Input accepted by {@link cursor}. */
export interface CursorPaginationOptions {
	readonly defaultLimit?: number;
	readonly maximumLimit?: number;
	readonly minimumLimit?: number;
	readonly ttl?: Temporal.Duration;
	readonly parameters?: Partial<CursorPaginationParameters>;
}

/** Input accepted by {@link offset}. */
export interface OffsetPaginationOptions {
	readonly defaultLimit?: number;
	readonly maximumLimit?: number;
	readonly minimumLimit?: number;
	readonly maximumOffset?: number;
	readonly defaultStyle?: 'offset' | 'page';
	readonly parameters?: Partial<OffsetPaginationParameters>;
}

/** Input accepted by {@link pagination}. */
export interface PaginationModesOptions {
	readonly default?: 'cursor' | 'offset';
	readonly cursor?: CursorPaginationDefinition;
	readonly offset?: OffsetPaginationDefinition;
}

/** One allowed JSON:API sparse-fieldset resource. */
export interface QueryFieldsetDefinition {
	readonly fields: readonly string[];
	readonly description?: string;
}

/** Authoring value accepted for a resource fieldset. */
export type QueryFieldsetInput = readonly string[] | QueryFieldsetDefinition;

/** Named sparse-fieldset resource collection. */
export type QueryFieldsets = Readonly<Record<string, QueryFieldsetDefinition>>;

/** Complete storage-neutral query definition input. */
export interface QueryDefinitionInput<Fields extends QueryFields> {
	readonly fields: Fields;
	readonly filters?: QueryFilters<Fields>;
	readonly order?: readonly QueryOrder<keyof Fields & string>[];
	readonly pagination: QueryPaginationDefinition;
	readonly fieldsets?: Readonly<Record<string, QueryFieldsetInput>>;
	readonly maximumFilters?: number;
	readonly maximumSorts?: number;
	readonly maximumSelectedFields?: number;
	readonly maximumValuesPerFilter?: number;
	readonly maximumValueLength?: number;
	readonly maximumParameters?: number;
	readonly defaultFields?: readonly (keyof Fields & string)[];
	readonly description?: string;
}


/** Pagination parameter names exposed to server/response adapters. */
export interface QueryPaginationParameters {
	readonly cursor?: string;
	readonly limit: string;
	readonly offset?: string;
	readonly page?: string;
	readonly perPage?: string;
}

/** One normalized filter. */
export type QueryFilter<Fields extends QueryFields> = {
	readonly [Key in keyof Fields & string]: Readonly<{
		readonly field: Key;
		readonly operator: QueryOperatorName;
		readonly value?: QueryFieldValue<Fields[Key]> | readonly QueryFieldValue<Fields[Key]>[];
	}>;
}[keyof Fields & string];

/** One normalized client-selected sort. */
export interface QuerySort<Field extends string = string> {
	readonly field: Field;
	readonly direction: QuerySortDirection;
	readonly tiebreaker: boolean;
}

/** Simple sparse-field selection for the endpoint's primary resource. */
export interface SimpleFieldSelection<Field extends string = string> {
	readonly kind: 'simple';
	readonly fields: readonly Field[];
}

/** JSON:API-style sparse fieldsets keyed by resource type. */
export interface ResourceFieldSelection {
	readonly kind: 'resource';
	readonly resources: Readonly<Record<string, readonly string[]>>;
}

/** Normalized sparse-field selection. */
export type QueryFieldSelection<Field extends string = string> =
	| SimpleFieldSelection<Field>
	| ResourceFieldSelection;

/** Normalized cursor pagination request. */
export interface CursorPagination {
	readonly kind: 'cursor';
	readonly limit: number;
	readonly cursor?: string;
}

/** Normalized offset or page-number pagination request. */
export interface OffsetPagination {
	readonly kind: 'offset';
	readonly limit: number;
	readonly offset: number;
	readonly source: 'offset' | 'page';
	readonly page?: number;
}

/** Complete normalized collection query. */
export interface QueryValue<Fields extends QueryFields = QueryFields> {
	readonly filters: readonly QueryFilter<Fields>[];
	readonly order: readonly QuerySort<keyof Fields & string>[];
	readonly fields: QueryFieldSelection<keyof Fields & string>;
	readonly pagination: CursorPagination | OffsetPagination;
}

/** Validation issue emitted while parsing a collection query. */
export interface QueryIssue extends StandardSchemaV1.Issue {
	readonly code:
		| 'unknown-field'
		| 'unknown-fieldset'
		| 'unknown-operator'
		| 'invalid-value'
		| 'invalid-sort'
		| 'duplicate-sort'
		| 'invalid-limit'
		| 'invalid-offset'
		| 'invalid-page'
		| 'invalid-cursor'
		| 'pagination-conflict'
		| 'unsupported-pagination'
		| 'field-selection-conflict'
		| 'too-many-parameters'
		| 'too-many-filter-values'
		| 'too-many-selected-fields'
		| 'value-too-long'
		| 'too-many-filters'
		| 'too-many-sorts'
		| 'sorting-disabled'
		| 'selection-disabled'
		| 'invalid-input';
}

/** Non-throwing query parse result. */
export type QueryParseResult<Value> =
	| Readonly<{ readonly success: true; readonly value: Value }>
	| Readonly<{ readonly success: false; readonly issues: readonly QueryIssue[] }>;

/** Query semantics required by a provider adapter. */
export interface QueryRequirements {
	readonly operators: readonly QueryOperatorName[];
	readonly pagination: readonly ('cursor' | 'offset')[];
	readonly fieldSelection: readonly ('simple' | 'resource')[];
	readonly maximumSorts: number;
	readonly stableTiebreaker?: string;
}

/** Capabilities truthfully supported by one provider adapter. */
export interface QueryAdapterCapabilities {
	readonly operators: 'all' | readonly QueryOperatorName[];
	readonly pagination: readonly ('cursor' | 'offset')[];
	readonly fieldSelection: readonly ('simple' | 'resource')[];
	readonly maximumSorts?: number;
}

/** One provider capability mismatch. */
export interface QueryAdapterIssue {
	readonly code: 'unsupported-operator' | 'unsupported-pagination' | 'unsupported-field-selection' | 'sort-limit';
	readonly message: string;
}

/** Provider capability validation result. */
export type QueryAdapterValidationResult =
	| Readonly<{ readonly valid: true; readonly requirements: QueryRequirements }>
	| Readonly<{ readonly valid: false; readonly requirements: QueryRequirements; readonly issues: readonly QueryAdapterIssue[] }>;

/** Portable opaque cursor codec contract implemented by a resource adapter. */
export interface CursorCodec<Payload = Readonly<Record<string, unknown>>> {
	encode(payload: Payload): string | Promise<string>;
	decode(cursor: string): Payload | Promise<Payload>;
}

/** Runtime and documentation contract exposed by one query definition. */
export interface QueryDefinition<Fields extends QueryFields = QueryFields>
	extends StandardSchemaV1<unknown, QueryValue<Fields>> {
	readonly kind: 'query-definition';
	readonly fields: Fields;
	readonly filters: QueryFilters<Fields>;
	readonly order: readonly QueryOrder<keyof Fields & string>[];
	readonly pagination: QueryPaginationDefinition;
	readonly fieldsets: QueryFieldsets;
	readonly maximumFilters: number;
	readonly maximumSorts: number;
	readonly maximumSelectedFields: number;
	readonly maximumValuesPerFilter: number;
	readonly maximumValueLength: number;
	readonly maximumParameters: number;
	readonly defaultFields: readonly (keyof Fields & string)[];
	readonly description?: string;
	readonly '~standard-json-schema': Readonly<{
		readonly version: 1;
		readonly vendor: 'kaiju-query';
		readonly jsonSchema: () => Readonly<Record<string, unknown>>;
	}>;
	parse(input: unknown): Promise<QueryValue<Fields>>;
	safeParse(input: unknown): Promise<QueryParseResult<QueryValue<Fields>>>;
	encode(value: QueryValue<Fields>): URLSearchParams;
	document(): QueryDocument;
	requirements(): QueryRequirements;
	validateAdapter(capabilities: QueryAdapterCapabilities): QueryAdapterValidationResult;
}

/** JSON-safe query documentation. */
export interface QueryDocument {
	readonly description?: string;
	readonly fields: readonly Readonly<{
		readonly name: string;
		readonly description?: string;
		readonly selectable: boolean;
		readonly sortable: boolean;
		readonly operators: readonly QueryOperatorName[];
	}>[];
	readonly fieldsets: Readonly<Record<string, QueryFieldsetDefinition>>;
	readonly defaultOrder: readonly QueryOrder[];
	readonly pagination: QueryPaginationDefinition;
	readonly maximumFilters: number;
	readonly maximumSorts: number;
	readonly maximumSelectedFields: number;
	readonly maximumValuesPerFilter: number;
	readonly maximumValueLength: number;
	readonly maximumParameters: number;
	readonly defaultFields: readonly string[];
	readonly wire: Readonly<{
		readonly filter: 'filter[field]=value / filter[field][operator]=value';
		readonly sort: 'sort=field:direction,field:direction';
		readonly fields: 'fields=a,b / fields[resource]=a,b';
		readonly pagination: readonly string[];
	}>;
}
