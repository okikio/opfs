import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as endpoint from '@utils/server/endpoint';
import * as middleware from '@utils/server/middleware';
import * as query from '@utils/query';
import * as resilience from '@utils/resilience';
import * as response from '@utils/http/response';
import * as resource from '@utils/resource';
import * as service from './mod.ts';

function schema<Output>(
	validate: (value: unknown) => Output,
): StandardSchemaV1<unknown, Output> {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1,
			vendor: 'test',
			validate(value: unknown) {
				try {
					return { value: validate(value) };
				} catch (error) {
					return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
				}
			},
		}),
	});
}

const MessageSchema = schema<{ readonly message: string }>((value) => {
	if (typeof value !== 'object' || value === null || typeof (value as { message?: unknown }).message !== 'string') {
		throw new TypeError('Expected a message object.');
	}
	return Object.freeze({ message: (value as { message: string }).message });
});
const Message = response.ok(MessageSchema, {
	id: 'runtime:message',
	description: 'Runtime test response.',
});

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('service runtime', () => {
	it('preserves middleware onion ordering around authentication, validation, concerns, and handlers', async () => {
		const events: string[] = [];
		const Query = schema<Readonly<{ readonly value: string }>>((value) => {
			events.push('validation');
			if (typeof value !== 'object' || value === null || (value as { value?: unknown }).value !== 'ok') {
				throw new TypeError('Expected value=ok.');
			}
			return Object.freeze({ value: 'ok' });
		});
		const permission = Object.freeze({ id: 'runtime:read', kind: 'permission' });
		const authentication = Object.freeze({ id: 'runtime:session', kind: 'authentication' });
		const WholeRequest = middleware.define({ id: 'runtime.wholeRequest', description: 'Surround the complete application request pipeline.' });
		const BeforeValidation = middleware.define({ id: 'runtime.before-validation', description: 'Before validation.' });
		const AfterValidation = middleware.define({ id: 'runtime.after-validation', description: 'After validation.' });
		const AroundOperation = middleware.define({ id: 'runtime.around-handler', description: 'Around handler.' });
		const trace = (name: string, definition: middleware.MiddlewareDefinition) => middleware.handler(
			definition,
			async (_context, next) => {
				events.push(`${name}:before`);
				const result = await next();
				events.push(`${name}:after`);
				return result;
			},
		);
		const Read = endpoint.get({
			id: 'runtime.read',
			path: '/runtime',
			query: Query,
			authentication,
			permissions: [permission],
			responses: [Message],
		});
		const definition = service.define({
			id: 'runtime',
			path: '/api',
			middleware: [
				middleware.wholeRequest(WholeRequest),
				middleware.beforeValidation(BeforeValidation),
				middleware.afterValidation(AfterValidation),
				middleware.aroundOperation(AroundOperation),
			],
			endpoints: [Read],
		});
		const implementation = service.implement(definition, {
			endpoints: [endpoint.handler(Read, async () => {
				events.push('handler');
				return response.create(Message, { message: 'ok' });
			})],
			middleware: [
				trace('wholeRequest', WholeRequest),
				trace('before-validation', BeforeValidation),
				trace('after-validation', AfterValidation),
				trace('around-handler', AroundOperation),
			],
			resources: resource.implementations(),
		});
		await using runtime = service.create(service.compile(implementation), {
			host: Object.freeze({}),
			concerns: {
				authenticate: async () => {
					events.push('authentication');
					return Object.freeze({ authentication: Object.freeze({ id: 'session' }) });
				},
				authorize: async () => {
					events.push('authorization');
				},
			},
		});
		const result = await runtime.fetch(new Request('http://localhost/api/runtime?value=ok'));
		expect(result.status).toBe(200);
		expect(events).toEqual([
			'wholeRequest:before',
			'before-validation:before',
			'authentication',
			'validation',
			'after-validation:before',
			'authorization',
			'around-handler:before',
			'handler',
			'around-handler:after',
			'after-validation:after',
			'before-validation:after',
			'wholeRequest:after',
		]);
	});

	it('actively enforces deadlines even when a handler does not poll the signal', async () => {
		const Slow = endpoint.get({
			id: 'runtime.slow',
			path: '/slow',
			resiliency: resilience.timeout({ milliseconds: 5 }),
			responses: [Message],
		});
		const definition = service.define({ id: 'slow', path: '/', endpoints: [Slow] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Slow, async () => {
				await delay(50);
				return response.create(Message, { message: 'late' });
			})],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });
		const result = await runtime.fetch(new Request('http://localhost/slow'));
		expect(result.status).toBe(504);
		expect((await result.json() as { type: string }).type).toBe('https://api.kaiju.land/problems/deadline-exceeded');
	});

	it('rejects oversized bodies before validation while preserving allowed raw request bytes', async () => {
		const RawRequest = schema<Request>((value) => {
			if (!(value instanceof Request)) throw new TypeError('Expected the raw Request.');
			return value;
		});
		const Echo = endpoint.post({
			id: 'runtime.echo',
			path: '/echo',
			raw: RawRequest,
			resiliency: resilience.bodyLimit(4),
			responses: [Message],
		});
		const definition = service.define({ id: 'echo', path: '/', endpoints: [Echo] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Echo, async ({ input }) => response.create(Message, {
				message: await input.raw.text(),
			}))],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });

		const allowed = await runtime.fetch(new Request('http://localhost/echo', { method: 'POST', body: '1234' }));
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toEqual({ message: '1234' });
		const rejected = await runtime.fetch(new Request('http://localhost/echo', { method: 'POST', body: '12345' }));
		expect(rejected.status).toBe(413);
	});

	it('materializes automatic pagination links with query-defined parameter names', async () => {
		const PageQuery = query.define({
			fields: { id: query.field(schema<string>((value) => String(value)), { sortable: true }) },
			order: [query.asc('id', { tiebreaker: true })],
			pagination: query.cursor({ parameters: { cursor: 'after', limit: 'size' }, defaultLimit: 2 }),
		});
		const Page = response.paginated(MessageSchema, {
			id: 'runtime:page',
			description: 'Runtime paginated response.',
		});
		const List = endpoint.get({
			id: 'runtime.list',
			path: '/pages',
			query: PageQuery,
			responses: [Page],
		});
		const definition = service.define({ id: 'pages', path: '/', endpoints: [List] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(List, async ({ input }) => {
				if (input.query.pagination.kind !== 'cursor') throw new TypeError('Expected cursor pagination.');
				return response.create(Page, {
				kind: 'cursor',
				items: [{ message: 'first' }],
				...(input.query.pagination.cursor !== undefined
					? { cursor: input.query.pagination.cursor }
					: {}),
				limit: input.query.pagination.limit,
				hasMore: true,
				nextCursor: 'next-page',
				});
			})],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });

		const result = await runtime.fetch(new Request('http://localhost/pages?after=current&size=2'));
		expect(result.status).toBe(200);
		expect(result.headers.get('link')).toContain('after=next-page');
		expect(result.headers.get('link')).toContain('size=2');
		expect(await result.json()).toMatchObject({
			data: [{ message: 'first' }],
			links: {
				self: 'http://localhost/pages?after=current&size=2',
				next: 'http://localhost/pages?after=next-page&size=2',
			},
		});
	});

	it('preserves repeated response fields through the Hono response materialization', async () => {
		const Cookies = endpoint.get({ id: 'runtime.cookies', path: '/cookies', responses: [Message] });
		const definition = service.define({ id: 'cookies', path: '/', endpoints: [Cookies] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Cookies, async () => response.create(Message, { message: 'ok' }, {
				headers: [
					['Set-Cookie', 'access=one; Path=/; HttpOnly'],
					['Set-Cookie', 'refresh=two; Path=/; HttpOnly'],
				],
			}))],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });

		const result = await runtime.fetch(new Request('http://localhost/cookies'));
		const cookies = (result.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
		expect(cookies).toEqual([
			'access=one; Path=/; HttpOnly',
			'refresh=two; Path=/; HttpOnly',
		]);
	});


	it('honors declared conditional responses without hiding an undeclared 304', async () => {
		const Cached = response.ok(MessageSchema, { id: 'runtime.cached', description: 'Cached message.' });
		const NotModified = response.notModified({ id: 'runtime.not-modified' });
		const Read = endpoint.get({ id: 'runtime.read-cached', path: '/cached', responses: [Cached, NotModified] });
		const definition = service.define({ id: 'cached', path: '/', endpoints: [Read] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Read, async () => response.create(Cached, { message: 'cached' }, {
				headers: { ETag: '"version-1"', 'Cache-Control': 'private, max-age=0' },
			}))],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });
		const result = await runtime.fetch(new Request('http://localhost/cached', {
			headers: { 'If-None-Match': 'W/"version-1"' },
		}));
		expect(result.status).toBe(304);
		expect(result.headers.get('etag')).toBe('"version-1"');
		expect(await result.text()).toBe('');
	});

	it('returns declared 406 and 415 problems for representation negotiation failures', async () => {
		const Create = endpoint.post({ id: 'runtime.create-json', path: '/json', json: MessageSchema, responses: [Message] });
		const definition = service.define({ id: 'formats', path: '/', endpoints: [Create] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Create, async ({ input }) => response.create(Message, input.json))],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });
		const unsupported = await runtime.fetch(new Request('http://localhost/json', {
			method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello',
		}));
		expect(unsupported.status).toBe(415);
		const unacceptable = await runtime.fetch(new Request('http://localhost/json', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/xml' }, body: '{"message":"hello"}',
		}));
		expect(unacceptable.status).toBe(406);
		expect(unacceptable.headers.get('content-type')).toContain('application/problem+json');
	});

	it('fails closed for delegated resilience and invokes an explicit supporting adapter', async () => {
		const Reliable = endpoint.post({
			id: 'runtime.reliable',
			path: '/reliable',
			json: MessageSchema,
			resiliency: [
				resilience.idempotent(),
				resilience.retry({ maximumAttempts: 2, jitter: false }),
			],
			responses: [Message],
		});
		const definition = service.define({ id: 'reliable', path: '/', endpoints: [Reliable] });
		const compiled = service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Reliable, async ({ input }) => response.create(Message, input.json))],
			resources: resource.implementations(),
		}));
		expect(() => service.create(compiled, { host: Object.freeze({}) })).toThrow(service.ServiceRuntimeConfigurationError);

		const observed: string[] = [];
		await using runtime = service.create(compiled, {
			host: Object.freeze({}),
			concerns: {
				resilience: {
					supports: () => true,
					async execute(policies, state, next) {
						observed.push(...policies.map((policy) => policy.type));
						expect(state.input.json).toEqual({ message: 'safe retry' });
						return await next();
					},
				},
			},
		});
		const result = await runtime.fetch(new Request('http://localhost/reliable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'operation-1' },
			body: '{"message":"safe retry"}',
		}));
		expect(result.status).toBe(200);
		expect(observed).toEqual(['idempotency', 'retry']);
	});

	it('serves isolated one-off HTML routes without changing the Solid renderer', async () => {
		const Html = response.html({ id: 'runtime:html', description: 'One-off HTML response.' });
		const Callback = endpoint.get({ id: 'runtime.callback', path: '/callback', responses: [Html] });
		const definition = service.define({ id: 'callback', path: '/', endpoints: [Callback] });
		await using runtime = service.create(service.compile(service.implement(definition, {
			endpoints: [endpoint.handler(Callback, async () => response.create(Html, '<!doctype html><p>Complete</p>'))],
			resources: resource.implementations(),
		})), { host: Object.freeze({}) });

		const result = await runtime.fetch(new Request('http://localhost/callback'));
		expect(result.headers.get('content-type')).toContain('text/html');
		expect(await result.text()).toContain('<p>Complete</p>');
	});

});
