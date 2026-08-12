import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as query from './mod.ts';

const StringSchema: StandardSchemaV1<unknown, string> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			return typeof value === 'string' && value.length > 0
				? { value }
				: { issues: [{ message: 'Expected a string.' }] };
		},
	},
};
const NumberSchema: StandardSchemaV1<unknown, number> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			const number = typeof value === 'number' ? value : Number(value);
			return Number.isFinite(number) ? { value: number } : { issues: [{ message: 'Expected a number.' }] };
		},
	},
};

const Definition = query.define({
	fields: {
		id: query.field(StringSchema, { sortable: true }),
		name: query.field(StringSchema, { sortable: true }),
		score: query.field(NumberSchema, { sortable: true }),
		deletedAt: query.field(StringSchema),
		secret: query.field(StringSchema, { selectable: false }),
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

describe('query definitions', () => {
	it('parses bracket filters, null keywords, colon sorts, fields, and cursor pagination', async () => {
		const value = await Definition.parse(new URLSearchParams({
			'filter[name][icontains]': 'kaiju',
			'filter[score][gte]': '10',
			'filter[deletedAt]': 'null',
			sort: 'score:desc,id:asc',
			fields: 'id,name',
			limit: '50',
			cursor: 'opaque',
		}));
		expect(value.filters).toEqual([
			{ field: 'name', operator: 'icontains', value: 'kaiju' },
			{ field: 'score', operator: 'gte', value: 10 },
			{ field: 'deletedAt', operator: 'isNull' },
		]);
		expect(value.order).toEqual([
			{ field: 'score', direction: 'desc', tiebreaker: false },
			{ field: 'id', direction: 'asc', tiebreaker: true },
		]);
		expect(value.fields).toEqual({ kind: 'simple', fields: ['id', 'name'] });
		expect(value.pagination).toEqual({ kind: 'cursor', limit: 50, cursor: 'opaque' });
	});

	it('preserves JSON:API sparse fieldset resource keys', async () => {
		const value = await Definition.parse(new URLSearchParams({
			'fields[widgets]': 'id,name',
			'fields[owners]': 'id',
		}));
		expect(value.fields).toEqual({
			kind: 'resource',
			resources: { widgets: ['id', 'name'], owners: ['id'] },
		});
	});

	it('supports page/per_page and offset/limit as explicit offset modes', async () => {
		const page = await Definition.parse(new URLSearchParams({ page: '3', per_page: '20' }));
		expect(page.pagination).toEqual({ kind: 'offset', source: 'page', page: 3, offset: 40, limit: 20 });

		const offset = await Definition.parse(new URLSearchParams({ offset: '40', limit: '20' }));
		expect(offset.pagination).toEqual({ kind: 'offset', source: 'offset', offset: 40, limit: 20 });
	});

	it('round trips the documented wire syntax', async () => {
		const parsed = await Definition.parse(new URLSearchParams({
			'filter[name][in]': 'kaiju,dragon',
			sort: 'score:desc,id:asc',
			'fields[widgets]': 'id,name',
			page: '2',
			per_page: '10',
		}));
		const encoded = Definition.encode(parsed);
		expect(encoded.get('filter[name][in]')).toBe('kaiju,dragon');
		expect(encoded.get('sort')).toBe('score:desc,id:asc');
		expect(encoded.get('fields[widgets]')).toBe('id,name');
		expect(encoded.get('page')).toBe('2');
		expect(encoded.get('per_page')).toBe('10');
		expect(await Definition.parse(encoded)).toEqual(parsed);
	});

	it('fails closed for unknown fields, mixed field syntaxes, and mixed pagination modes', async () => {
		const result = await Definition.safeParse(new URLSearchParams({
			'filter[missing]': 'x',
			fields: 'secret',
			'fields[widgets]': 'id',
			cursor: 'abc',
			offset: '10',
		}));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.issues.map((entry) => entry.code)).toEqual([
				'unknown-field',
				'field-selection-conflict',
				'pagination-conflict',
			]);
		}
	});

	it('rejects the removed minus-prefix sort syntax with a helpful issue', async () => {
		const result = await Definition.safeParse(new URLSearchParams({ sort: '-score' }));
		expect(result.success).toBe(false);
		if (!result.success) expect(result.issues[0]?.code).toBe('invalid-sort');
	});


	it('validates operator cardinality, value length, and filter limits', async () => {
		const pair = await Definition.safeParse(new URLSearchParams({ 'filter[score][between]': '10' }));
		expect(pair.success).toBe(false);
		if (!pair.success) expect(pair.issues[0]?.code).toBe('invalid-value');

		const many = await Definition.safeParse(new URLSearchParams({ 'filter[name][in]': 'a,b,c' }));
		expect(many.success).toBe(true);
		if (many.success) expect(many.value.filters[0]?.value).toEqual(['a', 'b', 'c']);

		const Limited = query.define({
			fields: { id: query.field(StringSchema, { sortable: true }), name: query.field(StringSchema) },
			filters: { name: [query.eq, query.in] },
			order: [query.asc('id', { tiebreaker: true })],
			pagination: query.cursor(),
			maximumFilters: 1,
			maximumValuesPerFilter: 2,
			maximumValueLength: 3,
		});
		const limits = await Limited.safeParse(new URLSearchParams({
			'filter[name]': 'long',
			'filter[name][in]': 'a,b,c',
		}));
		expect(limits.success).toBe(false);
		if (!limits.success) {
			expect(limits.issues.map((entry) => entry.code)).toContain('value-too-long');
			expect(limits.issues.map((entry) => entry.code)).toContain('too-many-filter-values');
		}
	});

	it('coerces repeated filters through each field schema and retains stable ordering', async () => {
		const params = new URLSearchParams();
		params.append('filter[score][gte]', '10');
		params.append('filter[score][gte]', '20');
		params.set('sort', 'name');
		const value = await Definition.parse(params);
		expect(value.filters).toEqual([
			{ field: 'score', operator: 'gte', value: 10 },
			{ field: 'score', operator: 'gte', value: 20 },
		]);
		expect(value.order).toEqual([
			{ field: 'name', direction: 'asc', tiebreaker: false },
			{ field: 'id', direction: 'desc', tiebreaker: true },
		]);
	});

	it('honors custom pagination parameter names in parsing and encoding', async () => {
		const Custom = query.define({
			fields: { id: query.field(StringSchema, { sortable: true }) },
			order: [query.asc('id', { tiebreaker: true })],
			pagination: query.pagination({
				default: 'cursor',
				cursor: query.cursor({ parameters: { cursor: 'after', limit: 'size' } }),
				offset: query.offset({ parameters: { offset: 'skip', limit: 'take', page: 'number', perPage: 'size_per_page' } }),
			}),
		});
		const cursor = await Custom.parse(new URLSearchParams({ after: 'opaque', size: '15' }));
		expect(cursor.pagination).toEqual({ kind: 'cursor', cursor: 'opaque', limit: 15 });
		expect(Custom.encode(cursor).toString()).toBe('after=opaque&size=15');
		const page = await Custom.parse(new URLSearchParams({ number: '4', size_per_page: '10' }));
		expect(page.pagination).toEqual({ kind: 'offset', source: 'page', page: 4, offset: 30, limit: 10 });
		expect(Custom.encode(page).toString()).toBe('number=4&size_per_page=10');
	});

	it('accepts structured record input without changing the normalized contract', async () => {
		const value = await Definition.parse({
			filter: { score: { gte: 25 }, deletedAt: 'not_null' },
			sort: 'score:desc',
			fields: { widgets: 'id,name' },
			pagination: { offset: 20, limit: 10 },
		});
		expect(value.filters).toEqual([
			{ field: 'score', operator: 'gte', value: 25 },
			{ field: 'deletedAt', operator: 'isNotNull' },
		]);
		expect(value.fields).toEqual({ kind: 'resource', resources: { widgets: ['id', 'name'] } });
		expect(value.pagination).toEqual({ kind: 'offset', source: 'offset', offset: 20, limit: 10 });
	});

	it('exposes exact pagination parameter names to server adapters', () => {
		expect(query.is(Definition)).toBe(true);
		expect(query.paginationParameters(Definition, 'cursor')).toEqual({ cursor: 'cursor', limit: 'limit' });
		expect(query.paginationParameters(Definition, 'offset')).toEqual({
			offset: 'offset', limit: 'limit', page: 'page', perPage: 'per_page',
		});
	});

	it('documents the exact wire grammar and provider requirements', () => {
		const document = Definition.document();
		expect(document.wire).toEqual({
			filter: 'filter[field]=value / filter[field][operator]=value',
			sort: 'sort=field:direction,field:direction',
			fields: 'fields=a,b / fields[resource]=a,b',
			pagination: ['cursor=opaque&limit=50', 'offset=40&limit=20', 'page=3&per_page=20'],
		});
		expect(Definition.requirements()).toMatchObject({
			pagination: ['cursor', 'offset'],
			fieldSelection: ['simple', 'resource'],
			stableTiebreaker: 'id',
		});
	});

	it('projects the actual flat URL parameters for OpenAPI rather than a fictitious pagination object', async () => {
		const schema = await Definition['~standard-json-schema'].jsonSchema() as {
			readonly properties: Readonly<Record<string, unknown>>;
		};
		expect(Object.keys(schema.properties)).toEqual([
			'filter[name]',
			'filter[name][icontains]',
			'filter[name][in]',
			'filter[score][gte]',
			'filter[score][between]',
			'filter[deletedAt]',
			'sort',
			'fields',
			'fields[widgets]',
			'fields[owners]',
			'cursor',
			'limit',
			'offset',
			'page',
			'per_page',
		]);
		expect(schema.properties.pagination).toBeUndefined();
	});

	it('requires exactly one stable cursor tiebreaker', () => {
		expect(() => query.define({
			fields: { id: query.field(StringSchema, { sortable: true }) },
			pagination: query.cursor(),
		})).toThrow('exactly one stable tiebreaker');
	});

	it('reports provider capability mismatches instead of silently degrading', () => {
		const result = Definition.validateAdapter({
			operators: [query.eq.name],
			pagination: ['offset'],
			fieldSelection: ['simple'],
			maximumSorts: 1,
		});
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.issues.map((entry) => entry.code)).toContain('unsupported-operator');
			expect(result.issues.map((entry) => entry.code)).toContain('unsupported-pagination');
			expect(result.issues.map((entry) => entry.code)).toContain('unsupported-field-selection');
			expect(result.issues.map((entry) => entry.code)).toContain('sort-limit');
		}
	});
});
