import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as endpoint from '@utils/server/endpoint';
import * as problem from '@utils/http/problem';
import * as response from '@utils/http/response';
import * as resource from '@utils/resource';
import * as service from '../service/mod.ts';
import * as gateway from './mod.ts';

const Body: StandardSchemaV1<unknown, { ok: boolean }> = {
	'~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as { ok: boolean } }) },
};
const Ok = response.ok(Body, { id: 'test:ok', description: 'Successful response.' });
const Public = endpoint.post({ id: 'test.public', path: '/items', raw: Body, responses: [Ok] });
const serviceDefinition = service.define({ id: 'test-service', path: '/api/v1', endpoints: [Public] });
const serviceHandler = endpoint.handler(Public, async () => response.create(Ok, { ok: true }));
const compiledService = service.compile(service.implement(serviceDefinition, {
	endpoints: [serviceHandler],
	resources: resource.implementations(),
}));
const authentication = Object.freeze({ id: 'gateway.authentication', kind: 'authentication' });
const assertion = Object.freeze({ id: 'gateway.assertion', kind: 'authentication' });
const Observer = gateway.observer.define({
	id: 'gateway.telemetry',
	description: 'Records redacted gateway lifecycle events.',
});

function gatewayDefinition(options: Readonly<{
	readonly credentials?: gateway.GatewayCredentialPolicy;
	readonly redirects?: gateway.GatewayRedirectPolicy;
	readonly timeout?: Temporal.Duration;
	readonly observers?: boolean;
}> = {}) {
	return gateway.define({
		id: 'public-gateway',
		services: [gateway.mount(serviceDefinition, { origin: 'http://127.0.0.1:8787' })],
		policies: [gateway.policy({
			id: 'public-policy',
			endpoints: [Public],
			authenticate: authentication,
			assertion,
			bodyLimit: 16,
			cache: gateway.noStore(),
			...(options.credentials === undefined ? {} : { credentials: options.credentials }),
			...(options.redirects === undefined ? {} : { redirects: options.redirects }),
			...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		})],
		observers: options.observers ? [Observer] : [],
	});
}

function concerns() {
	return {
		authenticate: () => ({ headers: { 'x-kaiju-actor': 'actor_1' } }),
		assert: () => ({ headers: { 'x-kaiju-assertion': 'signed' } }),
	};
}

describe('gateway compiler', () => {
	it('derives route ownership and security policy from compiled service artifacts', () => {
		const compiled = gateway.compile(gatewayDefinition(), { services: [compiledService] });
		expect(compiled.routes[0]).toMatchObject({
			serviceId: 'test-service',
			endpointId: 'test.public',
			path: '/api/v1/items',
			origin: 'http://127.0.0.1:8787',
			credentials: {
				requestCookies: 'strip',
				requestAuthorization: 'strip',
				responseCookies: 'strip',
			},
			redirects: { mode: 'rewrite-origin' },
		});
		expect(compiled.manifest.routes[0]?.authentication).toEqual(['gateway.authentication']);
	});

	it('rejects conflicting credential policies for one route', () => {
		const definition = gateway.define({
			id: 'conflict-gateway',
			services: [gateway.mount(serviceDefinition, { origin: 'http://127.0.0.1:8787' })],
			policies: [
				gateway.policy({ id: 'strip', endpoints: [Public], credentials: gateway.credentials() }),
				gateway.policy({ id: 'preserve', endpoints: [Public], credentials: gateway.credentials({ requestCookies: 'preserve' }) }),
			],
		});
		expect(() => gateway.compile(definition, { services: [compiledService] })).toThrow(gateway.GatewayCompilationError);
	});
});

describe('gateway request and response policy', () => {
	it('strips caller credentials, spoofable trust fields, and replaces trace context', async () => {
		const compiled = gateway.compile(gatewayDefinition({
			credentials: gateway.credentials({
				requestCookies: 'strip',
				requestAuthorization: 'strip-after-authentication',
				responseCookies: 'preserve',
			}),
		}), { services: [compiledService] });
		let forwarded: Request | undefined;
		const runtime = gateway.create(compiled, {
			requestId: () => 'request_1',
			concerns: concerns(),
			fetch: async (input, init) => {
				forwarded = input instanceof Request ? input : new Request(input, init);
				const headers = new Headers();
				headers.append('Set-Cookie', 'first=1; Path=/');
				headers.append('Set-Cookie', 'second=2; Path=/');
				return new Response('ok', { headers });
			},
		});
		const body = new Uint8Array([0, 1, 2, 3]);
		const result = await runtime.fetch(new Request('http://localhost/api/v1/items', {
			method: 'POST',
			headers: {
				'x-kaiju-actor': 'spoofed',
				'x-forwarded-for': 'spoofed',
				Authorization: 'Bearer caller-secret',
				Cookie: 'session=caller-secret',
				traceparent: '00-00000000000000000000000000000000-0000000000000000-01',
			},
			body,
		}));
		expect(forwarded?.headers.get('x-kaiju-actor')).toBe('actor_1');
		expect(forwarded?.headers.get('x-forwarded-for')).toBeNull();
		expect(forwarded?.headers.get('authorization')).toBeNull();
		expect(forwarded?.headers.get('cookie')).toBeNull();
		expect(forwarded?.headers.get('x-request-id')).toBe('request_1');
		expect(forwarded?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		expect(new Uint8Array(await forwarded!.arrayBuffer())).toEqual(body);
		expect(result.headers.get('cache-control')).toBe('no-store');
		const cookies = typeof result.headers.getSetCookie === 'function'
			? result.headers.getSetCookie()
			: [result.headers.get('set-cookie') ?? ''];
		expect(cookies.join('\n')).toContain('first=1');
		expect(cookies.join('\n')).toContain('second=2');
	});

	it('strips response cookies by default', async () => {
		const compiled = gateway.compile(gatewayDefinition(), { services: [compiledService] });
		const runtime = gateway.create(compiled, {
			concerns: concerns(),
			fetch: () => Promise.resolve(new Response('ok', { headers: { 'Set-Cookie': 'secret=1' } })),
		});
		const result = await runtime.fetch(new Request('http://localhost/api/v1/items', { method: 'POST' }));
		expect(result.headers.get('set-cookie')).toBeNull();
	});

	it('rewrites internal redirect origins and can reject unapproved external redirects', async () => {
		const rewrite = gateway.compile(gatewayDefinition(), { services: [compiledService] });
		const rewriteRuntime = gateway.create(rewrite, {
			concerns: concerns(),
			fetch: () => Promise.resolve(new Response(null, {
				status: 302,
				headers: { Location: 'http://127.0.0.1:8787/next?ok=1' },
			})),
		});
		const rewritten = await rewriteRuntime.fetch(new Request('https://api.kaiju.land/api/v1/items', { method: 'POST' }));
		expect(rewritten.headers.get('location')).toBe('https://api.kaiju.land/next?ok=1');

		const reject = gateway.compile(gatewayDefinition({
			redirects: gateway.redirects({ mode: 'reject-cross-origin' }),
		}), { services: [compiledService] });
		const rejectRuntime = gateway.create(reject, {
			concerns: concerns(),
			fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://evil.example/path' } })),
		});
		const rejected = await rejectRuntime.fetch(new Request('https://api.kaiju.land/api/v1/items', { method: 'POST' }));
		expect(rejected.status).toBe(502);
		expect((await rejected.json() as { type: string }).type).toContain('invalid-redirect');
	});

	it('rejects bodies larger than the explicit gateway policy', async () => {
		const compiled = gateway.compile(gatewayDefinition(), { services: [compiledService] });
		const runtime = gateway.create(compiled, {
			concerns: concerns(),
			fetch: () => Promise.resolve(new Response('unexpected')),
		});
		const result = await runtime.fetch(new Request('http://localhost/api/v1/items', {
			method: 'POST',
			body: 'this body exceeds sixteen bytes',
		}));
		expect(result.status).toBe(413);
	});
});

describe('gateway lifecycle', () => {
	it('emits redacted events and waits for response-body completion', async () => {
		const definition = gatewayDefinition({ observers: true, credentials: gateway.credentials({ responseCookies: 'preserve' }) });
		const compiled = gateway.compile(definition, { services: [compiledService] });
		const events: gateway.GatewayObserverEvent[] = [];
		const runtime = gateway.create(compiled, {
			concerns: concerns(),
			observers: [gateway.observer.handler(Observer, (event) => { events.push(event); })],
			fetch: () => Promise.resolve(new Response('streamed')),
		});
		const result = await runtime.fetch(new Request('http://localhost/api/v1/items?token=secret', {
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
		}));
		expect(events.map((event) => event.kind)).toEqual(['forwarding', 'response']);
		expect(await result.text()).toBe('streamed');
		await Promise.resolve();
		expect(events.map((event) => event.kind)).toEqual(['forwarding', 'response', 'completed']);
		expect(events[0]).toMatchObject({
			gatewayId: 'public-gateway',
			serviceId: 'test-service',
			pathname: '/api/v1/items',
		});
		expect(events[0]?.pathname).not.toContain('secret');
		expect(events[2]?.responseBytes).toBe(8);
	});

	it('keeps the total timeout active until the upstream body completes', async () => {
		const compiled = gateway.compile(gatewayDefinition({
			timeout: Temporal.Duration.from({ milliseconds: 10 }),
			observers: true,
		}), { services: [compiledService] });
		const events: gateway.GatewayObserverEvent[] = [];
		const runtime = gateway.create(compiled, {
			concerns: concerns(),
			observers: [gateway.observer.handler(Observer, (event) => { events.push(event); })],
			fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
				pull() { return new Promise<void>(() => undefined); },
			}))),
		});
		const result = await runtime.fetch(new Request('http://localhost/api/v1/items', { method: 'POST' }));
		await expect(result.arrayBuffer()).rejects.toBeDefined();
		await Promise.resolve();
		expect(events.some((event) => event.kind === 'aborted')).toBe(true);
	});

	it('emits denied without exposing query credentials', async () => {
		const definition = gatewayDefinition({ observers: true });
		const compiled = gateway.compile(definition, { services: [compiledService] });
		const events: gateway.GatewayObserverEvent[] = [];
		const runtime = gateway.create(compiled, {
			concerns: concerns(),
			observers: [gateway.observer.handler(Observer, (event) => { events.push(event); })],
		});
		const result = await runtime.fetch(new Request('https://api.kaiju.land/not-mounted?api_key=secret'));
		expect(result.status).toBe(404);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: 'denied', pathname: '/not-mounted' });
	});
});
