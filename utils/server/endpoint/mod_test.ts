import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as response from '@utils/http/response';
import * as problem from '@utils/http/problem';
import * as endpoint from './mod.ts';

function schema<Output>(jsonSchema: Readonly<Record<string, unknown>>, validate: (value: unknown) => Output): StandardSchemaV1<unknown, Output> & endpoint.StandardJsonSchemaV1 {
	return {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate(value) {
				try { return { value: validate(value) }; }
				catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }; }
			},
		},
		'~standard-json-schema': { version: 1, vendor: 'test', jsonSchema },
	};
}

const Path = schema({ type: 'object', properties: { widgetId: { type: 'string' } }, required: ['widgetId'] }, (value) => value as { widgetId: string });
const Query = schema({ type: 'object', properties: { include: { type: 'array', items: { type: 'string' } } } }, (value) => value as { include?: string[] });
const Widget = schema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, (value) => value as { id: string });
const Detail = response.ok(Widget, { id: 'widgets:detail', description: 'Widget detail.' });
const NotFound = problem.define({
	id: 'widgets:not-found',
	type: 'https://api.kaiju.land/problems/widget-not-found',
	status: 404,
	title: 'Widget not found',
	description: 'The requested widget does not exist.',
});

const GetWidget = endpoint.operation.get({
	id: 'widgets.get',
	operationId: 'getWidget',
	query: Query,
	responses: [Detail],
	problems: [NotFound],
});
const WidgetById = endpoint.define({
	id: 'widgets.by-id',
	path: '/:widgetId',
	param: Path,
	operations: [GetWidget],
});

describe('endpoint definitions and handlers', () => {
	it('binds operations by direct identity and requires exhaustive multi-method maps', () => {
		const Update = endpoint.operation.patch({ id: 'widgets.update', json: Widget, responses: [Detail] });
		const definition = endpoint.define({ id: 'widgets.item', path: '/:widgetId', param: Path, operations: [GetWidget, Update] });
		expect(() => endpoint.handler(definition, { get: async () => response.create(Detail, { id: 'a' }) } as never)).toThrow(TypeError);
		const handlers = endpoint.handler(definition, {
			get: async () => response.create(Detail, { id: 'a' }),
			patch: async () => response.create(Detail, { id: 'b' }),
		});
		expect(handlers.bindings.map((binding) => binding.operation)).toEqual([GetWidget, Update]);
	});

	it('rejects conflicting body inputs and path templates without param contracts', () => {
		expect(() => endpoint.post({ id: 'widgets.invalid', path: '/', json: Widget, raw: Widget, responses: [Detail] })).toThrow(TypeError);
		expect(() => endpoint.define({ id: 'widgets.invalid-path', path: '/:widgetId', operations: [GetWidget] })).toThrow(TypeError);
	});

	it('requires canonical endpoint paths at definition time', () => {
		expect(() => endpoint.get({ id: 'widgets.double-slash', path: '//widgets', responses: [Detail] })).toThrow('empty path segments');
		expect(() => endpoint.get({ id: 'widgets.trailing-slash', path: '/widgets/', responses: [Detail] })).toThrow('must not end with /');
	});


	it('promotes a single-method route parameter schema to the path contract', () => {
		const endpoint_ = endpoint.get({
			id: 'widgets.single',
			path: '/widgets/:widgetId',
			param: Path,
			responses: [Detail],
		});
		expect(endpoint_.inputs.param).toBe(Path);
		expect(endpoint.validate(endpoint_).valid).toBe(true);
	});

	it('rejects attaching one operation object to multiple endpoint paths', () => {
		const first = endpoint.define({
			id: 'widgets.first-path',
			path: '/first/:widgetId',
			param: Path,
			operations: [GetWidget],
		});
		const second = endpoint.define({
			id: 'widgets.second-path',
			path: '/second/:widgetId',
			param: Path,
			operations: [GetWidget],
		});
		const result = endpoint.validate([first, second]);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.issues.some((issue) =>
				issue.code === 'duplicate-operation-id' && issue.message.includes('one endpoint path owner')
			)).toBe(true);
		}
	});

	it('rejects operations without a declared result envelope', () => {
		const invalid = endpoint.get({
			id: 'widgets.empty',
			path: '/widgets',
		});
		const result = endpoint.validate(invalid);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.issues.some((issue) => issue.code === 'missing-result')).toBe(true);
	});

	it('snapshots contribution arrays at definition time', () => {
		const responses: response.ResponseDefinition[] = [Detail];
		const definition = endpoint.get({
			id: 'widgets.snapshot',
			path: '/widgets',
			responses,
		});
		responses.push(response.noContent());
		expect(definition.operations[0]?.responses).toEqual([Detail]);
	});

	it('projects exact path parameters, request inputs, responses, and RFC problems to OpenAPI', async () => {
		const Widgets = endpoint.group({ id: 'widgets', path: '/widgets', endpoints: [WidgetById] });
		const document = await endpoint.openapi(Widgets, { title: 'Widgets', version: '1.0.0' });
		const operation = document.paths['/widgets/{widgetId}']?.get as Record<string, unknown>;
		expect(operation.operationId).toBe('getWidget');
		expect(operation.parameters).toEqual([
			{ in: 'param', name: 'widgetId', required: true, schema: { type: 'string' } },
			{ in: 'query', name: 'include', required: false, schema: { type: 'array', items: { type: 'string' } }, style: 'form', explode: false },
		]);
		const responses = operation.responses as Record<string, unknown>;
		expect(Object.keys(responses)).toEqual(['200', '404']);
	});


	it('documents paginated envelopes and isolated HTML responses as their actual wire bodies', async () => {
		const Page = response.paginated(Widget, {
			id: 'widgets:page',
			description: 'Widget page.',
			pagination: { links: 'both', totals: 'body' },
		});
		const Html = response.html({ id: 'widgets:html', description: 'Widget HTML.' });
		const List = endpoint.get({ id: 'widgets.list', path: '/widgets', responses: [Page] });
		const Human = endpoint.get({ id: 'widgets.human', path: '/widgets.html', responses: [Html] });
		const document = await endpoint.openapi([List, Human], { title: 'Widgets', version: '1' });
		type PageSchema = Readonly<{
			properties: Readonly<{
				data: object;
				meta: Readonly<{ properties: Readonly<{ pagination: Readonly<{ properties: Readonly<{ total: object }> }> }> }>;
				links: Readonly<{ properties: Readonly<{ next: object }> }>;
			}>;
		}>;
		type OpenApiResponse = Readonly<{ content: Readonly<Record<string, Readonly<{ schema: PageSchema | object }>>> }>;
		type OperationDocument = Readonly<{ responses: Readonly<Record<string, OpenApiResponse>> }>;
		const page = (document.paths['/widgets']?.get as OperationDocument).responses['200']!;
		const pageSchema = page.content['application/json']!.schema as PageSchema;
		expect(pageSchema.properties.data).toEqual({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
		expect(pageSchema.properties.meta.properties.pagination.properties.total).toEqual({ type: 'integer', minimum: 0 });
		expect(pageSchema.properties.links.properties.next).toEqual({ type: 'string', format: 'uri-reference' });
		const html = (document.paths['/widgets.html']?.get as OperationDocument).responses['200']!;
		expect(html.content['text/html; charset=utf-8']!.schema).toMatchObject({ type: 'string' });
	});

	it('rejects path schemas that do not exactly match the route template', async () => {
		const WrongPath = schema({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, (value) => value as { id: string });
		const wrong = endpoint.define({ id: 'widgets.wrong', path: '/:widgetId', param: WrongPath, operations: [GetWidget] });
		await expect(endpoint.openapi(wrong, { title: 'Wrong', version: '1' })).rejects.toThrow('does not match the route template');
	});
});
