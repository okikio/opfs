import type { StandardSchemaV1 } from '@standard-schema/spec';

import type {
	CursorPaginationDefinition,
	CursorPaginationOptions,
	OffsetPaginationDefinition,
	OffsetPaginationOptions,
	PaginationModesDefinition,
	PaginationModesOptions,
	QueryAdapterCapabilities,
	QueryAdapterIssue,
	QueryAdapterValidationResult,
	QueryDefinition,
	QueryDefinitionInput,
	QueryDocument,
	QueryField,
	QueryFieldOptions,
	QueryFields,
	QueryFieldSelection,
	QueryFieldsetDefinition,
	QueryFieldsets,
	QueryFilter,
	QueryFilters,
	QueryIssue,
	QueryOperator,
	QueryOperatorName,
	QueryOrder,
	QueryPaginationDefinition,
	QueryPaginationParameters,
	QueryParseResult,
	QueryRequirements,
	QuerySort,
	QuerySortDirection,
	QueryValue,
} from './types.ts';

const filterPattern = /^filter\[([^\]]+)](?:\[([^\]]+)])?$/;
const fieldsetPattern = /^fields\[([^\]]+)]$/;
const fieldNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const parameterNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const operatorAliases: Readonly<Record<string, QueryOperatorName>> = Object.freeze({
	eq: 'eq',
	ne: 'ne',
	gt: 'gt',
	gte: 'gte',
	lt: 'lt',
	lte: 'lte',
	between: 'between',
	in: 'in',
	nin: 'nin',
	contains: 'contains',
	icontains: 'icontains',
	startswith: 'startsWith',
	starts_with: 'startsWith',
	endswith: 'endsWith',
	ends_with: 'endsWith',
	is_null: 'isNull',
	isnull: 'isNull',
	is_not_null: 'isNotNull',
	isnotnull: 'isNotNull',
});

/** Define one public query field. */
export function field<const Schema extends StandardSchemaV1>(
	schema: Schema,
	options: QueryFieldOptions = {},
): QueryField<Schema> {
	assertSchema(schema);
	return Object.freeze({
		kind: 'query-field',
		schema,
		...(options.description !== undefined ? { description: options.description } : {}),
		selectable: options.selectable ?? true,
		sortable: options.sortable ?? false,
		...(options.jsonSchema !== undefined ? { jsonSchema: options.jsonSchema } : {}),
	});
}

/** Define ascending default/stable ordering. */
export function asc<const Field extends string>(
	fieldName: Field,
	options: Readonly<{ readonly tiebreaker?: boolean }> = {},
): QueryOrder<Field> {
	return order(fieldName, 'asc', options.tiebreaker ?? false);
}

/** Define descending default/stable ordering. */
export function desc<const Field extends string>(
	fieldName: Field,
	options: Readonly<{ readonly tiebreaker?: boolean }> = {},
): QueryOrder<Field> {
	return order(fieldName, 'desc', options.tiebreaker ?? false);
}

/** Define opaque cursor pagination. Cursor verification belongs to a codec resource. */
export function cursor(options: CursorPaginationOptions = {}): CursorPaginationDefinition {
	const definition: CursorPaginationDefinition = Object.freeze({
		kind: 'query-pagination',
		type: 'cursor',
		defaultLimit: options.defaultLimit ?? 50,
		maximumLimit: options.maximumLimit ?? 200,
		minimumLimit: options.minimumLimit ?? 1,
		...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
		parameters: Object.freeze({
			cursor: options.parameters?.cursor ?? 'cursor',
			limit: options.parameters?.limit ?? 'limit',
		}),
	});
	assertCursorPagination(definition);
	return definition;
}

/** Define bounded offset pagination with both offset/limit and page/per_page syntax. */
export function offset(options: OffsetPaginationOptions = {}): OffsetPaginationDefinition {
	const definition: OffsetPaginationDefinition = Object.freeze({
		kind: 'query-pagination',
		type: 'offset',
		defaultLimit: options.defaultLimit ?? 50,
		maximumLimit: options.maximumLimit ?? 200,
		minimumLimit: options.minimumLimit ?? 1,
		maximumOffset: options.maximumOffset ?? 1_000_000,
		defaultStyle: options.defaultStyle ?? 'offset',
		parameters: Object.freeze({
			offset: options.parameters?.offset ?? 'offset',
			limit: options.parameters?.limit ?? 'limit',
			page: options.parameters?.page ?? 'page',
			perPage: options.parameters?.perPage ?? 'per_page',
		}),
	});
	assertOffsetPagination(definition);
	return definition;
}

/** Explicitly enable more than one pagination strategy for an endpoint. */
export function pagination(options: PaginationModesOptions): PaginationModesDefinition {
	if (options.cursor === undefined && options.offset === undefined) {
		throw new TypeError('Pagination modes require a cursor or offset definition.');
	}
	const defaultMode = options.default ?? (options.cursor !== undefined ? 'cursor' : 'offset');
	if (defaultMode === 'cursor' && options.cursor === undefined) {
		throw new TypeError('Cursor cannot be the default when cursor pagination is disabled.');
	}
	if (defaultMode === 'offset' && options.offset === undefined) {
		throw new TypeError('Offset cannot be the default when offset pagination is disabled.');
	}
	if (options.cursor !== undefined) assertCursorPagination(options.cursor);
	if (options.offset !== undefined) assertOffsetPagination(options.offset);
	assertPaginationParameterCompatibility(options.cursor, options.offset);
	return Object.freeze({
		kind: 'query-pagination-modes',
		type: 'modes',
		default: defaultMode,
		...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
		...(options.offset !== undefined ? { offset: options.offset } : {}),
	});
}

/** Define one storage-neutral collection query contract. */
export function define<const Fields extends QueryFields>(
	input: QueryDefinitionInput<Fields>,
): QueryDefinition<Fields> {
	const fields = freezeFields(input.fields);
	const filters = freezeFilters((input.filters ?? {}) as QueryFilters<Fields>, fields);
	const defaultOrder = Object.freeze([...(input.order ?? [])]);
	validateOrder(defaultOrder, fields, input.pagination);
	const defaultFields = Object.freeze(
		input.defaultFields ? [...input.defaultFields] : Object.keys(fields).filter((key) => fields[key]!.selectable),
	) as readonly (keyof Fields & string)[];
	validateSelectedFields(defaultFields, fields);
	const fieldsets = freezeFieldsets(input.fieldsets ?? {});
	const maximumFilters = input.maximumFilters ?? 20;
	const maximumSorts = input.maximumSorts ?? 5;
	const maximumSelectedFields = input.maximumSelectedFields ?? 100;
	const maximumValuesPerFilter = input.maximumValuesPerFilter ?? 100;
	const maximumValueLength = input.maximumValueLength ?? 4_096;
	const maximumParameters = input.maximumParameters ?? 200;
	for (const [name, value] of Object.entries({
		maximumFilters,
		maximumSorts,
		maximumSelectedFields,
		maximumValuesPerFilter,
		maximumValueLength,
		maximumParameters,
	})) assertPositiveInteger(value, name);

	const definition: QueryDefinition<Fields> = {
		kind: 'query-definition',
		fields,
		filters,
		order: defaultOrder,
		pagination: input.pagination,
		fieldsets,
		maximumFilters,
		maximumSorts,
		maximumSelectedFields,
		maximumValuesPerFilter,
		maximumValueLength,
		maximumParameters,
		defaultFields,
		...(input.description !== undefined ? { description: input.description } : {}),
		'~standard': {
			version: 1,
			vendor: 'kaiju-query',
			validate: async (value: unknown) => {
				const result = await safeParse(definition, value);
				return result.success ? { value: result.value } : { issues: result.issues };
			},
		},
		'~standard-json-schema': {
			version: 1,
			vendor: 'kaiju-query',
			jsonSchema: () => jsonSchema(definition),
		},
		parse: async (value: unknown) => {
			const result = await safeParse(definition, value);
			if (result.success) return result.value;
			throw new QueryValidationError(result.issues);
		},
		safeParse: (value: unknown) => safeParse(definition, value),
		encode: (value: QueryValue<Fields>) => encode(definition, value),
		document: () => document(definition),
		requirements: () => requirements(definition),
		validateAdapter: (capabilities: QueryAdapterCapabilities) => validateAdapter(definition, capabilities),
	};
	return Object.freeze(definition);
}

/** Error thrown by `QueryDefinition.parse()`. */
export class QueryValidationError extends Error {
	readonly issues: readonly QueryIssue[];

	constructor(issues: readonly QueryIssue[]) {
		super(issues.map((entry) => entry.message).join('; '));
		this.name = 'QueryValidationError';
		this.issues = Object.freeze([...issues]);
	}
}

/** Return whether a value is a collection-query definition. */
export function is(value: unknown): value is QueryDefinition<QueryFields> {
	return typeof value === 'object' && value !== null &&
		(value as { readonly kind?: unknown }).kind === 'query-definition';
}

/** Return exact query parameter names for request-aware pagination links. */
export function paginationParameters<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	mode: 'cursor' | 'offset',
): QueryPaginationParameters | undefined {
	const modes = paginationDefinitions(definition.pagination);
	if (mode === 'cursor') {
		const value = modes.cursor;
		return value === undefined ? undefined : Object.freeze({
			cursor: value.parameters.cursor,
			limit: value.parameters.limit,
		});
	}
	const value = modes.offset;
	return value === undefined ? undefined : Object.freeze({
		offset: value.parameters.offset,
		limit: value.parameters.limit,
		page: value.parameters.page,
		perPage: value.parameters.perPage,
	});
}

/** Create JSON-safe documentation for a query definition. */
export function document<Fields extends QueryFields>(definition: QueryDefinition<Fields>): QueryDocument {
	return Object.freeze({
		...(definition.description !== undefined ? { description: definition.description } : {}),
		fields: Object.freeze(Object.entries(definition.fields).map(([name, value]) => Object.freeze({
			name,
			...(value.description !== undefined ? { description: value.description } : {}),
			selectable: value.selectable,
			sortable: value.sortable,
			operators: Object.freeze((definition.filters[name] ?? []).map((operator) => operator.name)),
		}))),
		fieldsets: definition.fieldsets,
		defaultOrder: definition.order,
		pagination: definition.pagination,
		maximumFilters: definition.maximumFilters,
		maximumSorts: definition.maximumSorts,
		maximumSelectedFields: definition.maximumSelectedFields,
		maximumValuesPerFilter: definition.maximumValuesPerFilter,
		maximumValueLength: definition.maximumValueLength,
		maximumParameters: definition.maximumParameters,
		defaultFields: definition.defaultFields,
		wire: Object.freeze({
			filter: 'filter[field]=value / filter[field][operator]=value',
			sort: 'sort=field:direction,field:direction',
			fields: 'fields=a,b / fields[resource]=a,b',
			pagination: Object.freeze(paginationWireExamples(definition.pagination)),
		}),
	});
}

/** Describe provider capabilities required to execute a query definition faithfully. */
export function requirements<Fields extends QueryFields>(definition: QueryDefinition<Fields>): QueryRequirements {
	const operators = new Set<QueryOperatorName>();
	for (const values of Object.values(definition.filters)) {
		for (const operator of values ?? []) operators.add(operator.name);
	}
	const stable = definition.order.find((entry) => entry.tiebreaker)?.field;
	return Object.freeze({
		operators: Object.freeze([...operators]),
		pagination: Object.freeze(enabledPaginationModes(definition.pagination)),
		fieldSelection: Object.freeze([
			'simple' as const,
			...(Object.keys(definition.fieldsets).length > 0 ? ['resource' as const] : []),
		]),
		maximumSorts: definition.maximumSorts,
		...(stable !== undefined ? { stableTiebreaker: stable } : {}),
	});
}

/** Fail clearly when a provider adapter cannot honor a query definition. */
export function validateAdapter<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	capabilities: QueryAdapterCapabilities,
): QueryAdapterValidationResult {
	const required = requirements(definition);
	const issues: QueryAdapterIssue[] = [];
	if (capabilities.operators !== 'all') {
		const supported = new Set(capabilities.operators);
		for (const operator of required.operators) {
			if (!supported.has(operator)) issues.push(Object.freeze({
				code: 'unsupported-operator',
				message: `Adapter does not support query operator ${operator}.`,
			}));
		}
	}
	const paginationModes = new Set(capabilities.pagination);
	for (const mode of required.pagination) {
		if (!paginationModes.has(mode)) issues.push(Object.freeze({
			code: 'unsupported-pagination',
			message: `Adapter does not support ${mode} pagination.`,
		}));
	}
	const selections = new Set(capabilities.fieldSelection);
	for (const mode of required.fieldSelection) {
		if (!selections.has(mode)) issues.push(Object.freeze({
			code: 'unsupported-field-selection',
			message: `Adapter does not support ${mode} field selection.`,
		}));
	}
	if (capabilities.maximumSorts !== undefined && capabilities.maximumSorts < required.maximumSorts) {
		issues.push(Object.freeze({
			code: 'sort-limit',
			message: `Adapter supports at most ${capabilities.maximumSorts} sorts but the query permits ${required.maximumSorts}.`,
		}));
	}
	return issues.length === 0
		? Object.freeze({ valid: true, requirements: required })
		: Object.freeze({ valid: false, requirements: required, issues: Object.freeze(issues) });
}

/**
 * Attempts parse and returns structured failure information instead of throwing inside provider-neutral query definitions.
 *
 * Query internals validate and normalize public query semantics while leaving SQL or provider execution to concrete adapters.
 *
 * @internal
 */
async function safeParse<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	input: unknown,
): Promise<QueryParseResult<QueryValue<Fields>>> {
	const issues: QueryIssue[] = [];
	const entries = normalizeInput(input, issues);
	if (entries.size > definition.maximumParameters) {
		issues.push(issue(
			'too-many-parameters',
			`At most ${definition.maximumParameters} query parameters are allowed.`,
			[],
		));
	}
	if (issues.length > 0) return failure(issues);

	const filters = await parseFilters(definition, entries, issues);
	const order = parseSorts(definition, entries, issues);
	const fields = parseFields(definition, entries, issues);
	const parsedPagination = parsePagination(definition.pagination, entries, issues);
	if (issues.length > 0) return failure(issues);

	return Object.freeze({
		success: true,
		value: Object.freeze({
			filters: Object.freeze(filters),
			order: Object.freeze(order),
			fields,
			pagination: parsedPagination,
		}),
	});
}

/**
 * Parses filters into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
async function parseFilters<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	entries: ReadonlyMap<string, readonly unknown[]>,
	issues: QueryIssue[],
): Promise<QueryFilter<Fields>[]> {
	const result: QueryFilter<Fields>[] = [];
	for (const [key, values] of entries) {
		const match = filterPattern.exec(key);
		if (!match) continue;
		const fieldName = match[1]!;
		const explicitOperator = match[2];
		const fieldDefinition = definition.fields[fieldName];
		if (!fieldDefinition) {
			issues.push(issue('unknown-field', `Unknown filter field ${JSON.stringify(fieldName)}.`, ['filter', fieldName]));
			continue;
		}
		for (const raw of values) {
			const operatorName = explicitOperator === undefined
				? implicitOperator(raw)
				: resolveOperator(explicitOperator);
			const allowed = definition.filters[fieldName] ?? Object.freeze([]);
			const operator = allowed.find((candidate) => candidate.name === operatorName);
			if (!operator) {
				issues.push(issue(
					'unknown-operator',
					`Operator ${JSON.stringify(operatorName)} is not allowed for ${fieldName}.`,
					['filter', fieldName, operatorName],
				));
				continue;
			}
			const effectiveRaw = explicitOperator === undefined && (operatorName === 'isNull' || operatorName === 'isNotNull')
				? undefined
				: raw;
			const parsed = await parseOperatorValue(
				fieldDefinition.schema,
				operator,
				effectiveRaw,
				['filter', fieldName, operatorName],
				definition,
				issues,
			);
			if (parsed.accepted) {
				result.push(Object.freeze({
					field: fieldName,
					operator: operator.name,
					...(parsed.hasValue ? { value: parsed.value } : {}),
				}) as QueryFilter<Fields>);
			}
		}
	}
	if (result.length > definition.maximumFilters) {
		issues.push(issue('too-many-filters', `At most ${definition.maximumFilters} filters are allowed.`, ['filter']));
	}
	return result;
}

/**
 * Parses operator value into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
async function parseOperatorValue<Fields extends QueryFields>(
	schema: StandardSchemaV1,
	operator: QueryOperator,
	raw: unknown,
	path: readonly PropertyKey[],
	definition: QueryDefinition<Fields>,
	issues: QueryIssue[],
): Promise<Readonly<{ readonly accepted: boolean; readonly hasValue: boolean; readonly value?: unknown }>> {
	if (operator.value === 'none') {
		if (raw !== '' && raw !== undefined && raw !== null && raw !== true && raw !== 'true') {
			issues.push(issue('invalid-value', `${operator.name} does not accept a value.`, path));
			return { accepted: false, hasValue: false };
		}
		return { accepted: true, hasValue: false };
	}
	const values = operator.value === 'one' ? scalarValues(raw) : listValues(raw);
	if (values.length > definition.maximumValuesPerFilter) {
		issues.push(issue(
			'too-many-filter-values',
			`At most ${definition.maximumValuesPerFilter} values are allowed for one filter.`,
			path,
		));
		return { accepted: false, hasValue: true };
	}
	if (operator.value === 'pair' && values.length !== 2) {
		issues.push(issue('invalid-value', `${operator.name} requires exactly two values.`, path));
		return { accepted: false, hasValue: true };
	}
	if (operator.value === 'one' && values.length !== 1) {
		issues.push(issue('invalid-value', `${operator.name} requires exactly one value.`, path));
		return { accepted: false, hasValue: true };
	}
	if (operator.value === 'many' && values.length === 0) {
		issues.push(issue('invalid-value', `${operator.name} requires at least one value.`, path));
		return { accepted: false, hasValue: true };
	}
	const parsed: unknown[] = [];
	for (const value of values) {
		if (typeof value === 'string' && value.length > definition.maximumValueLength) {
			issues.push(issue(
				'value-too-long',
				`Filter values may contain at most ${definition.maximumValueLength} characters.`,
				path,
			));
			continue;
		}
		const validation = await schema['~standard'].validate(value);
		if (validation.issues) {
			for (const schemaIssue of validation.issues) {
				const issuePath = (schemaIssue.path ?? []).map((segment) =>
					typeof segment === 'object' && segment !== null && 'key' in segment
						? segment.key
						: segment as PropertyKey
				);
				issues.push(issue('invalid-value', schemaIssue.message, [...path, ...issuePath]));
			}
		} else parsed.push(validation.value);
	}
	if (parsed.length !== values.length) return { accepted: false, hasValue: true };
	return {
		accepted: true,
		hasValue: true,
		value: operator.value === 'one' ? parsed[0] : Object.freeze(parsed),
	};
}

/**
 * Parses sorts into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function parseSorts<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	entries: ReadonlyMap<string, readonly unknown[]>,
	issues: QueryIssue[],
): QuerySort<keyof Fields & string>[] {
	const requested = (entries.get('sort') ?? []).flatMap(listValues).map(String).filter(Boolean);
	const result: QuerySort<keyof Fields & string>[] = [];
	const seen = new Set<string>();
	for (const token of requested) {
		const parsed = parseSortToken(token);
		if (!parsed) {
			issues.push(issue(
				'invalid-sort',
				`Invalid sort ${JSON.stringify(token)}. Use field:asc or field:desc.`,
				['sort'],
			));
			continue;
		}
		const fieldDefinition = definition.fields[parsed.field];
		if (!fieldDefinition) {
			issues.push(issue('unknown-field', `Unknown sort field ${JSON.stringify(parsed.field)}.`, ['sort']));
			continue;
		}
		if (!fieldDefinition.sortable && !definition.order.some((entry) => entry.field === parsed.field)) {
			issues.push(issue('sorting-disabled', `Field ${JSON.stringify(parsed.field)} is not sortable.`, ['sort']));
			continue;
		}
		if (seen.has(parsed.field)) {
			issues.push(issue('duplicate-sort', `Sort field ${JSON.stringify(parsed.field)} is duplicated.`, ['sort']));
			continue;
		}
		seen.add(parsed.field);
		result.push(Object.freeze({ field: parsed.field, direction: parsed.direction, tiebreaker: false }) as QuerySort<keyof Fields & string>);
	}
	if (result.length > definition.maximumSorts) {
		issues.push(issue('too-many-sorts', `At most ${definition.maximumSorts} sorts are allowed.`, ['sort']));
	}
	if (result.length === 0) return definition.order.map(normalizeOrder);
	for (const stable of definition.order.filter((entry) => entry.tiebreaker)) {
		if (!seen.has(stable.field)) result.push(normalizeOrder(stable));
		else {
			const index = result.findIndex((entry) => entry.field === stable.field);
			result[index] = Object.freeze({ ...result[index]!, tiebreaker: true });
		}
	}
	return result;
}

/**
 * Parses sort token into the validated internal model used by later phases.
 *
 * @internal
 */
function parseSortToken(token: string): Readonly<{ readonly field: string; readonly direction: QuerySortDirection }> | undefined {
	const trimmed = token.trim();
	if (trimmed.length === 0 || trimmed.startsWith('+') || trimmed.startsWith('-')) return undefined;
	const parts = trimmed.split(':');
	if (parts.length > 2) return undefined;
	const fieldName = parts[0]?.trim() ?? '';
	if (!fieldNamePattern.test(fieldName)) return undefined;
	const direction = (parts[1]?.trim() || 'asc') as QuerySortDirection;
	if (direction !== 'asc' && direction !== 'desc') return undefined;
	return Object.freeze({ field: fieldName, direction });
}

/**
 * Normalizes order into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeOrder<Field extends string>(entry: QueryOrder<Field>): QuerySort<Field> {
	return Object.freeze({
		field: entry.field,
		direction: entry.direction,
		tiebreaker: entry.tiebreaker,
	});
}

/**
 * Parses fields into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function parseFields<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	entries: ReadonlyMap<string, readonly unknown[]>,
	issues: QueryIssue[],
): QueryFieldSelection<keyof Fields & string> {
	const simpleRaw = [...(entries.get('fields') ?? [])];
	const resourceRaw = new Map<string, unknown[]>();
	for (const [key, values] of entries) {
		const match = fieldsetPattern.exec(key);
		if (!match) continue;
		resourceRaw.set(match[1]!, [...(resourceRaw.get(match[1]!) ?? []), ...values]);
	}
	if (simpleRaw.length > 0 && resourceRaw.size > 0) {
		issues.push(issue(
			'field-selection-conflict',
			'Use either fields=a,b or fields[resource]=a,b in one request, not both.',
			['fields'],
		));
	}
	if (resourceRaw.size > 0) {
		const resources: Record<string, readonly string[]> = Object.create(null);
		let selectedCount = 0;
		for (const [resource, raw] of resourceRaw) {
			const fieldset = definition.fieldsets[resource];
			if (!fieldset) {
				issues.push(issue('unknown-fieldset', `Unknown fieldset resource ${JSON.stringify(resource)}.`, ['fields', resource]));
				continue;
			}
			const selected = uniqueStrings(raw.flatMap(listValues).map(String).filter(Boolean));
			selectedCount += selected.length;
			const allowed = new Set(fieldset.fields);
			for (const name of selected) {
				if (!allowed.has(name)) issues.push(issue(
					'unknown-field',
					`Unknown field ${JSON.stringify(name)} for resource ${JSON.stringify(resource)}.`,
					['fields', resource],
				));
			}
			resources[resource] = Object.freeze(selected);
		}
		if (selectedCount > definition.maximumSelectedFields) {
			issues.push(issue(
				'too-many-selected-fields',
				`At most ${definition.maximumSelectedFields} selected fields are allowed.`,
				['fields'],
			));
		}
		return Object.freeze({ kind: 'resource', resources: Object.freeze(resources) });
	}

	if (simpleRaw.length === 0) return Object.freeze({ kind: 'simple', fields: definition.defaultFields });
	const result: (keyof Fields & string)[] = [];
	for (const name of uniqueStrings(simpleRaw.flatMap(listValues).map(String).filter(Boolean))) {
		const fieldDefinition = definition.fields[name];
		if (!fieldDefinition) {
			issues.push(issue('unknown-field', `Unknown selected field ${JSON.stringify(name)}.`, ['fields']));
			continue;
		}
		if (!fieldDefinition.selectable) {
			issues.push(issue('selection-disabled', `Field ${JSON.stringify(name)} cannot be selected.`, ['fields']));
			continue;
		}
		result.push(name);
	}
	if (result.length > definition.maximumSelectedFields) {
		issues.push(issue(
			'too-many-selected-fields',
			`At most ${definition.maximumSelectedFields} selected fields are allowed.`,
			['fields'],
		));
	}
	return Object.freeze({ kind: 'simple', fields: Object.freeze(result) });
}

/**
 * Parses pagination into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function parsePagination(
	definition: QueryPaginationDefinition,
	entries: ReadonlyMap<string, readonly unknown[]>,
	issues: QueryIssue[],
) {
	const modes = paginationDefinitions(definition);
	const cursorDefinition = modes.cursor;
	const offsetDefinition = modes.offset;
	const cursorExplicit = cursorDefinition !== undefined && entries.has(cursorDefinition.parameters.cursor);
	const offsetExplicit = offsetDefinition !== undefined && entries.has(offsetDefinition.parameters.offset);
	const pageExplicit = offsetDefinition !== undefined && entries.has(offsetDefinition.parameters.page);
	const perPageExplicit = offsetDefinition !== undefined && entries.has(offsetDefinition.parameters.perPage);
	const pageModeExplicit = pageExplicit || perPageExplicit;
	const explicitModes = Number(cursorExplicit) + Number(offsetExplicit) + Number(pageModeExplicit);
	if (explicitModes > 1) {
		issues.push(issue('pagination-conflict', 'Cursor, offset, and page pagination cannot be mixed.', ['pagination']));
	}

	const unsupportedCursor = cursorDefinition === undefined && hasAny(entries, ['cursor']);
	const unsupportedOffset = offsetDefinition === undefined && hasAny(entries, ['offset', 'page', 'per_page']);
	if (unsupportedCursor) issues.push(issue('unsupported-pagination', 'Cursor pagination is not supported by this endpoint.', ['cursor']));
	if (unsupportedOffset) issues.push(issue('unsupported-pagination', 'Offset/page pagination is not supported by this endpoint.', ['page']));

	const selected = cursorExplicit
		? 'cursor'
		: offsetExplicit || pageExplicit || perPageExplicit
		? 'offset'
		: modes.default;
	if (selected === 'cursor') {
		if (!cursorDefinition) {
			issues.push(issue('unsupported-pagination', 'Cursor pagination is not supported by this endpoint.', ['cursor']));
			return Object.freeze({ kind: 'cursor' as const, limit: 1 });
		}
		const rawCursor = last(entries.get(cursorDefinition.parameters.cursor));
		const cursorValue = optionalString(rawCursor);
		if (cursorExplicit && cursorValue === undefined) {
			issues.push(issue('invalid-cursor', 'Cursor cannot be empty.', [cursorDefinition.parameters.cursor]));
		}
		const limit = parseLimit(
			last(entries.get(cursorDefinition.parameters.limit)),
			cursorDefinition,
			issues,
			cursorDefinition.parameters.limit,
		);
		return Object.freeze({
			kind: 'cursor' as const,
			limit,
			...(cursorValue !== undefined ? { cursor: cursorValue } : {}),
		});
	}

	if (!offsetDefinition) {
		issues.push(issue('unsupported-pagination', 'Offset pagination is not supported by this endpoint.', ['offset']));
		return Object.freeze({ kind: 'offset' as const, limit: 1, offset: 0, source: 'offset' as const });
	}
	const usePage = pageModeExplicit || (!offsetExplicit && offsetDefinition.defaultStyle === 'page');
	if (usePage) {
		if (entries.has(offsetDefinition.parameters.limit)) {
			issues.push(issue(
				'pagination-conflict',
				`Page pagination uses ${offsetDefinition.parameters.perPage}, not ${offsetDefinition.parameters.limit}.`,
				['pagination'],
			));
		}
		const page = integer(last(entries.get(offsetDefinition.parameters.page)) ?? 1);
		if (page === undefined || page < 1) {
			issues.push(issue('invalid-page', 'Page must be a positive integer.', [offsetDefinition.parameters.page]));
		}
		const limit = parseLimit(
			last(entries.get(offsetDefinition.parameters.perPage)),
			offsetDefinition,
			issues,
			offsetDefinition.parameters.perPage,
		);
		const offsetValue = Math.max(0, ((page ?? 1) - 1) * limit);
		if (!Number.isSafeInteger(offsetValue) || offsetValue > offsetDefinition.maximumOffset) {
			issues.push(issue(
				'invalid-offset',
				`Page resolves beyond the maximum offset of ${offsetDefinition.maximumOffset}.`,
				[offsetDefinition.parameters.page],
			));
		}
		return Object.freeze({ kind: 'offset' as const, limit, offset: offsetValue, source: 'page' as const, page: page ?? 1 });
	}

	if (entries.has(offsetDefinition.parameters.perPage)) {
		issues.push(issue(
			'pagination-conflict',
			`Offset pagination uses ${offsetDefinition.parameters.limit}, not ${offsetDefinition.parameters.perPage}.`,
			['pagination'],
		));
	}
	const offsetValue = integer(last(entries.get(offsetDefinition.parameters.offset)) ?? 0);
	if (offsetValue === undefined || offsetValue < 0 || offsetValue > offsetDefinition.maximumOffset) {
		issues.push(issue(
			'invalid-offset',
			`Offset must be between 0 and ${offsetDefinition.maximumOffset}.`,
			[offsetDefinition.parameters.offset],
		));
	}
	const limit = parseLimit(
		last(entries.get(offsetDefinition.parameters.limit)),
		offsetDefinition,
		issues,
		offsetDefinition.parameters.limit,
	);
	return Object.freeze({ kind: 'offset' as const, limit, offset: offsetValue ?? 0, source: 'offset' as const });
}

/**
 * Parses limit into the validated internal model used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function parseLimit(
	raw: unknown,
	definition: CursorPaginationDefinition | OffsetPaginationDefinition,
	issues: QueryIssue[],
	parameter: string,
): number {
	const value = integer(raw ?? definition.defaultLimit);
	if (value === undefined || value < definition.minimumLimit || value > definition.maximumLimit) {
		issues.push(issue(
			'invalid-limit',
			`Limit must be between ${definition.minimumLimit} and ${definition.maximumLimit}.`,
			[parameter],
		));
	}
	return value ?? definition.defaultLimit;
}

/**
 * Encodes value into the module's external representation.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function encode<Fields extends QueryFields>(
	definition: QueryDefinition<Fields>,
	value: QueryValue<Fields>,
): URLSearchParams {
	const parameters = new URLSearchParams();
	for (const filter of value.filters) {
		const name = filter.operator === 'eq'
			? `filter[${filter.field}]`
			: filter.operator === 'isNull' || filter.operator === 'isNotNull'
			? `filter[${filter.field}]`
			: `filter[${filter.field}][${wireOperator(filter.operator)}]`;
		const raw = filter.operator === 'isNull'
			? 'null'
			: filter.operator === 'isNotNull'
			? 'not_null'
			: Array.isArray(filter.value)
			? filter.value.map(stringValue).join(',')
			: stringValue(filter.value);
		parameters.append(name, raw);
	}
	if (!sameOrder(value.order, definition.order)) {
		parameters.set('sort', value.order.map((entry) => `${entry.field}:${entry.direction}`).join(','));
	}
	if (value.fields.kind === 'simple') {
		if (!sameStrings(value.fields.fields, definition.defaultFields)) parameters.set('fields', value.fields.fields.join(','));
	} else {
		for (const [resource, fields] of Object.entries(value.fields.resources)) {
			parameters.set(`fields[${resource}]`, fields.join(','));
		}
	}
	const modes = paginationDefinitions(definition.pagination);
	if (value.pagination.kind === 'cursor') {
		const policy = modes.cursor;
		if (!policy) throw new TypeError('Cannot encode cursor pagination for a query that does not support it.');
		if (value.pagination.cursor !== undefined) parameters.set(policy.parameters.cursor, value.pagination.cursor);
		parameters.set(policy.parameters.limit, String(value.pagination.limit));
	} else {
		const policy = modes.offset;
		if (!policy) throw new TypeError('Cannot encode offset pagination for a query that does not support it.');
		if (value.pagination.source === 'page') {
			const page = value.pagination.page ?? Math.floor(value.pagination.offset / value.pagination.limit) + 1;
			parameters.set(policy.parameters.page, String(page));
			parameters.set(policy.parameters.perPage, String(value.pagination.limit));
		} else {
			parameters.set(policy.parameters.offset, String(value.pagination.offset));
			parameters.set(policy.parameters.limit, String(value.pagination.limit));
		}
	}
	return parameters;
}


/**
 * Checks whether order are equivalent for the purposes of provider-neutral query definitions.
 *
 * @internal
 */
function sameOrder(left: readonly QuerySort[], right: readonly QueryOrder[]): boolean {
	return left.length === right.length && left.every((entry, index) => {
		const candidate = right[index];
		return candidate !== undefined && entry.field === candidate.field && entry.direction === candidate.direction && entry.tiebreaker === candidate.tiebreaker;
	});
}

/**
 * Checks whether strings are equivalent for the purposes of provider-neutral query definitions.
 *
 * @internal
 */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Normalizes input into the canonical internal form used by later phases.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function normalizeInput(input: unknown, issues: QueryIssue[]): ReadonlyMap<string, readonly unknown[]> {
	const result = new Map<string, unknown[]>();
	const add = (key: string, value: unknown): void => {
		const values = result.get(key) ?? [];
		values.push(value);
		result.set(key, values);
	};
	if (input instanceof URLSearchParams) {
		input.forEach((value, key) => add(key, value));
		return result;
	}
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		issues.push(issue('invalid-input', 'A query must be a URLSearchParams or plain record.', []));
		return result;
	}
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key === 'filter' && isRecord(value)) {
			for (const [fieldName, filterValue] of Object.entries(value)) {
				if (isRecord(filterValue)) {
					for (const [operator, nested] of Object.entries(filterValue)) add(`filter[${fieldName}][${operator}]`, nested);
				} else add(`filter[${fieldName}]`, filterValue);
			}
			continue;
		}
		if (key === 'fields' && isRecord(value)) {
			for (const [resource, nested] of Object.entries(value)) add(`fields[${resource}]`, nested);
			continue;
		}
		if (key === 'pagination' && isRecord(value)) {
			for (const [name, nested] of Object.entries(value)) add(name, nested);
			continue;
		}
		if (Array.isArray(value)) for (const item of value) add(key, item);
		else add(key, value);
	}
	return result;
}

/**
 * Builds the json schema used to validate data entering provider-neutral query definitions.
 *
 * Query internals validate and normalize public query semantics while leaving SQL or provider execution to concrete adapters.
 *
 * @internal
 */
function jsonSchema<Fields extends QueryFields>(definition: QueryDefinition<Fields>): Readonly<Record<string, unknown>> {
	const properties: Record<string, unknown> = Object.create(null);
	for (const [fieldName, operators] of Object.entries(definition.filters)) {
		const fieldDefinition = definition.fields[fieldName]!;
		const fieldSchema = fieldDefinition.jsonSchema ?? Object.freeze({});
		const implicit = (operators ?? []).filter((operator) =>
			operator.name === 'eq' || operator.name === 'isNull' || operator.name === 'isNotNull'
		);
		if (implicit.length > 0) {
			const acceptsValue = implicit.some((operator) => operator.name === 'eq');
			const keywords = [
				...(implicit.some((operator) => operator.name === 'isNull') ? ['null'] : []),
				...(implicit.some((operator) => operator.name === 'isNotNull') ? ['not_null'] : []),
			];
			properties[`filter[${fieldName}]`] = Object.freeze({
				...(acceptsValue && keywords.length > 0
					? { oneOf: Object.freeze([fieldSchema, Object.freeze({ type: 'string', enum: Object.freeze(keywords) })]) }
					: acceptsValue ? fieldSchema : { type: 'string', enum: Object.freeze(keywords) }),
				description: `Filter ${fieldName} by equality${keywords.length > 0 ? ` or ${keywords.join('/')}` : ''}.`,
			});
		}
		for (const operator of operators ?? []) {
			if (operator.name === 'eq' || operator.name === 'isNull' || operator.name === 'isNotNull') continue;
			properties[`filter[${fieldName}][${wireOperator(operator.name)}]`] = Object.freeze({
				...(operator.value === 'one' ? fieldSchema : { type: 'string' }),
				description: operator.value === 'pair'
					? `${operator.description} Supply two comma-separated values.`
					: operator.value === 'many'
					? `${operator.description} Supply comma-separated or repeated values.`
					: operator.description,
			});
		}
	}
	if (Object.values(definition.fields).some((field) => field.sortable)) {
		properties.sort = Object.freeze({
			type: 'string',
			description: 'Comma-separated field:asc or field:desc entries. A unique stable tiebreaker is appended when omitted.',
			example: definition.order.map((entry) => `${entry.field}:${entry.direction}`).join(','),
		});
	}
	if (Object.values(definition.fields).some((field) => field.selectable)) {
		properties.fields = Object.freeze({
			type: 'string',
			description: 'Comma-separated selected fields for the primary resource.',
			example: definition.defaultFields.join(','),
		});
	}
	for (const [resource, fieldset] of Object.entries(definition.fieldsets)) {
		properties[`fields[${resource}]`] = Object.freeze({
			type: 'string',
			description: fieldset.description ?? `Comma-separated fields for ${resource}.`,
			example: fieldset.fields.join(','),
		});
	}
	const modes = paginationDefinitions(definition.pagination);
	if (modes.cursor !== undefined) {
		properties[modes.cursor.parameters.cursor] = Object.freeze({
			type: 'string',
			minLength: 1,
			description: 'Opaque cursor returned by a previous response.',
		});
		properties[modes.cursor.parameters.limit] = integerParameter(
			modes.cursor.minimumLimit,
			modes.cursor.maximumLimit,
			modes.cursor.defaultLimit,
			'Maximum number of records returned.',
		);
	}
	if (modes.offset !== undefined) {
		properties[modes.offset.parameters.offset] = Object.freeze({
			type: 'integer',
			minimum: 0,
			maximum: modes.offset.maximumOffset,
			default: 0,
			description: 'Number of records to skip. Do not combine with page/per_page.',
		});
		properties[modes.offset.parameters.limit] ??= integerParameter(
			modes.offset.minimumLimit,
			modes.offset.maximumLimit,
			modes.offset.defaultLimit,
			'Maximum number of records returned with offset pagination.',
		);
		properties[modes.offset.parameters.page] = Object.freeze({
			type: 'integer',
			minimum: 1,
			default: 1,
			description: 'One-indexed page number. Do not combine with cursor or offset.',
		});
		properties[modes.offset.parameters.perPage] = integerParameter(
			modes.offset.minimumLimit,
			modes.offset.maximumLimit,
			modes.offset.defaultLimit,
			'Number of records per page.',
		);
	}
	return Object.freeze({
		type: 'object',
		additionalProperties: true,
		properties: Object.freeze(properties),
	});
}

/**
 * Creates the integer query-parameter contract used by pagination and other numeric query fields.
 *
 * @internal
 */
function integerParameter(minimum: number, maximum: number, defaultValue: number, description: string): Readonly<Record<string, unknown>> {
	return Object.freeze({ type: 'integer', minimum, maximum, default: defaultValue, description });
}

/**
 * Snapshots fields so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeFields<Fields extends QueryFields>(fields: Fields): Fields {
	if (Object.keys(fields).length === 0) throw new TypeError('A query definition must expose at least one field.');
	const result: Record<string, QueryField> = Object.create(null);
	for (const [name, value] of Object.entries(fields)) {
		assertFieldName(name);
		if (value.kind !== 'query-field') throw new TypeError(`Query field ${JSON.stringify(name)} is invalid.`);
		result[name] = value;
	}
	return Object.freeze(result) as Fields;
}

/**
 * Snapshots filters so later compilation cannot observe caller mutation.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function freezeFilters<Fields extends QueryFields>(filters: QueryFilters<Fields>, fields: Fields): QueryFilters<Fields> {
	const result: Record<string, readonly QueryOperator[]> = Object.create(null);
	for (const [fieldName, operators] of Object.entries(filters)) {
		if (!fields[fieldName]) throw new TypeError(`Filter field ${JSON.stringify(fieldName)} is not public.`);
		const seen = new Set<QueryOperatorName>();
		for (const operator of operators ?? []) {
			if (seen.has(operator.name)) throw new TypeError(`Filter ${fieldName} repeats operator ${operator.name}.`);
			seen.add(operator.name);
		}
		result[fieldName] = Object.freeze([...(operators ?? [])]);
	}
	return Object.freeze(result) as QueryFilters<Fields>;
}

/**
 * Snapshots fieldsets so later compilation cannot observe caller mutation.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function freezeFieldsets(input: Readonly<Record<string, readonly string[] | QueryFieldsetDefinition>>): QueryFieldsets {
	const result: Record<string, QueryFieldsetDefinition> = Object.create(null);
	for (const [resource, value] of Object.entries(input)) {
		assertFieldName(resource);
		const definition: QueryFieldsetDefinition = Array.isArray(value)
			? { fields: value }
			: value as QueryFieldsetDefinition;
		const fields = uniqueStrings([...definition.fields]);
		if (fields.length === 0) throw new TypeError(`Fieldset ${JSON.stringify(resource)} must expose at least one field.`);
		for (const fieldName of fields) assertFieldName(fieldName);
		result[resource] = Object.freeze({
			fields: Object.freeze(fields),
			...(definition.description !== undefined ? { description: definition.description } : {}),
		});
	}
	return Object.freeze(result);
}

/**
 * Checks order and preserves the deterministic issues needed by callers.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function validateOrder<Fields extends QueryFields>(
	entries: readonly QueryOrder<keyof Fields & string>[],
	fields: Fields,
	paginationDefinition: QueryPaginationDefinition,
): void {
	const seen = new Set<string>();
	let tiebreakers = 0;
	for (const entry of entries) {
		if (!fields[entry.field]) throw new TypeError(`Order field ${JSON.stringify(entry.field)} is not public.`);
		if (seen.has(entry.field)) throw new TypeError(`Order field ${JSON.stringify(entry.field)} is duplicated.`);
		seen.add(entry.field);
		if (entry.tiebreaker) tiebreakers += 1;
	}
	if (tiebreakers > 1) throw new TypeError('A query order may contain only one tiebreaker.');
	if (enabledPaginationModes(paginationDefinition).includes('cursor') && tiebreakers !== 1) {
		throw new TypeError('Cursor pagination requires exactly one stable tiebreaker order field.');
	}
}

/**
 * Checks selected fields and preserves the deterministic issues needed by callers.
 *
 * @internal
 */
function validateSelectedFields<Fields extends QueryFields>(selected: readonly (keyof Fields & string)[], fields: Fields): void {
	for (const name of selected) {
		const definition = fields[name];
		if (!definition) throw new TypeError(`Default selected field ${JSON.stringify(name)} is not public.`);
		if (!definition.selectable) throw new TypeError(`Default selected field ${JSON.stringify(name)} is not selectable.`);
	}
}

/**
 * Normalizes the order requested by callers of provider-neutral query definitions.
 *
 * @internal
 */
function order<const Field extends string>(fieldName: Field, direction: QuerySortDirection, tiebreaker: boolean): QueryOrder<Field> {
	assertFieldName(fieldName);
	return Object.freeze({ kind: 'query-order', field: fieldName, direction, tiebreaker });
}

/**
 * Rejects invalid cursor pagination before it can enter authoritative module state.
 *
 * @internal
 */
function assertCursorPagination(definition: CursorPaginationDefinition): void {
	assertLimits(definition);
	for (const parameter of Object.values(definition.parameters)) assertParameterName(parameter);
	if (definition.parameters.cursor === definition.parameters.limit) throw new TypeError('Cursor and limit parameter names must differ.');
	if (definition.ttl !== undefined && durationMilliseconds(definition.ttl) <= 0) {
		throw new TypeError('Cursor ttl must be positive.');
	}
}

/**
 * Rejects invalid offset pagination before it can enter authoritative module state.
 *
 * @internal
 */
function assertOffsetPagination(definition: OffsetPaginationDefinition): void {
	assertLimits(definition);
	assertPositiveInteger(definition.maximumOffset, 'maximumOffset', true);
	const names = Object.values(definition.parameters);
	for (const parameter of names) assertParameterName(parameter);
	if (new Set(names).size !== names.length) throw new TypeError('Offset pagination parameter names must be unique.');
}

/**
 * Rejects invalid pagination parameter compatibility before it can enter authoritative module state.
 *
 * It keeps public query semantics provider-neutral so storage adapters can compile the same validated request differently.
 *
 * @internal
 */
function assertPaginationParameterCompatibility(
	cursorDefinition: CursorPaginationDefinition | undefined,
	offsetDefinition: OffsetPaginationDefinition | undefined,
): void {
	if (!cursorDefinition || !offsetDefinition) return;
	const sharedLimit = cursorDefinition.parameters.limit === offsetDefinition.parameters.limit;
	const cursorName = cursorDefinition.parameters.cursor;
	if (Object.values(offsetDefinition.parameters).includes(cursorName)) {
		throw new TypeError('Cursor parameter name conflicts with offset pagination parameters.');
	}
	if (!sharedLimit && Object.values(offsetDefinition.parameters).includes(cursorDefinition.parameters.limit)) {
		throw new TypeError('Cursor limit parameter conflicts with offset pagination parameters.');
	}
}

/**
 * Rejects invalid limits before it can enter authoritative module state.
 *
 * @internal
 */
function assertLimits(definition: CursorPaginationDefinition | OffsetPaginationDefinition): void {
	assertPositiveInteger(definition.minimumLimit, 'minimumLimit');
	assertPositiveInteger(definition.defaultLimit, 'defaultLimit');
	assertPositiveInteger(definition.maximumLimit, 'maximumLimit');
	if (definition.minimumLimit > definition.defaultLimit || definition.defaultLimit > definition.maximumLimit) {
		throw new TypeError('Pagination limits must satisfy minimumLimit <= defaultLimit <= maximumLimit.');
	}
}

/**
 * Derives the pagination definitions from the query contract used by provider-neutral query definitions.
 *
 * @internal
 */
function paginationDefinitions(definition: QueryPaginationDefinition): Readonly<{
	readonly default: 'cursor' | 'offset';
	readonly cursor?: CursorPaginationDefinition;
	readonly offset?: OffsetPaginationDefinition;
}> {
	if (definition.type === 'modes') return definition;
	return definition.type === 'cursor'
		? Object.freeze({ default: 'cursor' as const, cursor: definition })
		: Object.freeze({ default: 'offset' as const, offset: definition });
}

/**
 * Returns the enabled pagination modes derived from the active configuration of provider-neutral query definitions.
 *
 * @internal
 */
function enabledPaginationModes(definition: QueryPaginationDefinition): ('cursor' | 'offset')[] {
	const modes = paginationDefinitions(definition);
	return [
		...(modes.cursor !== undefined ? ['cursor' as const] : []),
		...(modes.offset !== undefined ? ['offset' as const] : []),
	];
}

/**
 * Derives the pagination wire examples from the query contract used by provider-neutral query definitions.
 *
 * @internal
 */
function paginationWireExamples(definition: QueryPaginationDefinition): string[] {
	const modes = paginationDefinitions(definition);
	const examples: string[] = [];
	if (modes.cursor) examples.push(`${modes.cursor.parameters.cursor}=opaque&${modes.cursor.parameters.limit}=50`);
	if (modes.offset) {
		examples.push(`${modes.offset.parameters.offset}=40&${modes.offset.parameters.limit}=20`);
		examples.push(`${modes.offset.parameters.page}=3&${modes.offset.parameters.perPage}=20`);
	}
	return examples;
}

/**
 * Maps the wire operator into the representation understood by provider-neutral query definitions.
 *
 * @internal
 */
function wireOperator(operator: QueryOperatorName): string {
	return operator === 'startsWith'
		? 'startswith'
		: operator === 'endsWith'
		? 'endswith'
		: operator === 'isNull'
		? 'is_null'
		: operator === 'isNotNull'
		? 'is_not_null'
		: operator;
}

/**
 * Maps the implicit operator into the representation understood by provider-neutral query definitions.
 *
 * @internal
 */
function implicitOperator(value: unknown): QueryOperatorName {
	return value === 'null' ? 'isNull' : value === 'not_null' ? 'isNotNull' : 'eq';
}

/**
 * Resolves operator from already validated module inputs.
 *
 * @internal
 */
function resolveOperator(value: string): QueryOperatorName {
	return operatorAliases[value.toLowerCase()] ?? value as QueryOperatorName;
}

/**
 * Returns the scalar values consumed by provider-neutral query definitions.
 *
 * @internal
 */
function scalarValues(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(scalarValues);
	return value === undefined ? [] : [value];
}

/**
 * Returns the list values consumed by provider-neutral query definitions.
 *
 * @internal
 */
function listValues(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(listValues);
	if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
	return value === undefined ? [] : [value];
}

/**
 * Validates integer before it is used by provider-neutral query definitions.
 *
 * @internal
 */
function integer(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
	if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Normalizes the optional string while preserving absence as `undefined` for provider-neutral query definitions.
 *
 * @internal
 */
function optionalString(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return typeof value === 'string' ? value : String(value);
}

/**
 * Returns the string value in the representation expected by provider-neutral query definitions.
 *
 * @internal
 */
function stringValue(value: unknown): string {
	if (value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	return String(value);
}

/**
 * Generates the unique strings without colliding with identities already owned by provider-neutral query definitions.
 *
 * @internal
 */
function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Checks whether any is present for provider-neutral query definitions.
 *
 * @internal
 */
function hasAny(entries: ReadonlyMap<string, readonly unknown[]>, names: readonly string[]): boolean {
	return names.some((name) => entries.has(name));
}

/**
 * Returns the last available value required by provider-neutral query definitions, or absence when the collection is empty.
 *
 * @internal
 */
function last(values: readonly unknown[] | undefined): unknown {
	return values?.at(-1);
}

/**
 * Checks whether record satisfies the condition required by provider-neutral query definitions.
 *
 * @internal
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects invalid positive integer before it can enter authoritative module state.
 *
 * @internal
 */
function assertPositiveInteger(value: number, name: string, allowZero = false): void {
	if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
	}
}

/**
 * Rejects invalid field name before it can enter authoritative module state.
 *
 * @internal
 */
function assertFieldName(value: string): void {
	if (!fieldNamePattern.test(value)) throw new TypeError(`Invalid query field ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid parameter name before it can enter authoritative module state.
 *
 * @internal
 */
function assertParameterName(value: string): void {
	if (!parameterNamePattern.test(value)) throw new TypeError(`Invalid query parameter name ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid schema before it can enter authoritative module state.
 *
 * @internal
 */
function assertSchema(value: unknown): asserts value is StandardSchemaV1 {
	if (typeof value !== 'object' || value === null ||
		typeof (value as { ['~standard']?: { validate?: unknown } })['~standard']?.validate !== 'function') {
		throw new TypeError('Query fields must use Standard Schema-compatible validators.');
	}
}

/**
 * Converts duration into the millisecond value used by provider-neutral query definitions.
 *
 * @internal
 */
function durationMilliseconds(duration: Temporal.Duration): number {
	return duration.total({ unit: 'milliseconds', relativeTo: Temporal.PlainDate.from('2000-01-01') });
}

/**
 * Checks whether sue satisfies the condition required by provider-neutral query definitions.
 *
 * @internal
 */
function issue(code: QueryIssue['code'], message: string, path: readonly PropertyKey[]): QueryIssue {
	return Object.freeze({ code, message, ...(path.length > 0 ? { path } : {}) });
}

/**
 * Builds the failure used when provider-neutral query definitions cannot complete as intended.
 *
 * @internal
 */
function failure(issues: readonly QueryIssue[]): QueryParseResult<never> {
	return Object.freeze({ success: false, issues: Object.freeze([...issues]) });
}
