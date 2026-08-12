import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as response from './mod.ts';

const ItemSchema: StandardSchemaV1<unknown, { readonly id: string }> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
				? { value: Object.freeze({ id: (value as { id: string }).id }) }
				: { issues: [{ message: 'Expected an item.' }] };
		},
	},
};

const BytesSchema: StandardSchemaV1<unknown, Uint8Array> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: (value) => value instanceof Uint8Array
			? { value }
			: { issues: [{ message: 'Expected bytes.' }] },
	},
};

describe('HTTP status contracts', () => {
	it('provides portable Standard Schema status subsets without Zod coupling', async () => {
		expect(response.status.success.is(200)).toBe(true);
		expect(response.status.success.is(404)).toBe(false);
		expect(response.isProblemStatus(429)).toBe(true);
		expect(response.isContentlessStatus(304)).toBe(true);
		expect(response.isContentlessStatus(200)).toBe(false);
		expect((await response.status.problem['~standard'].validate(503))).toEqual({ value: 503 });
		expect('issues' in await response.status.problem['~standard'].validate(200)).toBe(true);
		expect(response.status.problem['~standard-json-schema'].jsonSchema).toMatchObject({
			type: 'integer',
		});
	});
});

describe('response definitions and logical results', () => {
	it('retains exact definition identity without serializing metadata', () => {
		const Detail = response.ok(ItemSchema, { id: 'widgets:detail', description: 'Widget detail.' });
		const result = response.create(Detail, { id: 'widget_1' });
		expect(result).toEqual([{ id: 'widget_1' }, 200, {}]);
		expect(response.definitionOf(result)).toBe(Detail);
		expect(Object.keys(result)).toEqual(['0', '1', '2']);
	});

	it('supports focused empty, conditional, partial, redirect, and HTML definitions', () => {
		const Empty = response.noContent();
		const NotModified = response.notModified();
		const Partial = response.partialContent(BytesSchema, { description: 'Partial artifact bytes.' });
		const Html = response.html({ description: 'Callback complete.' });
		expect(response.create(Empty, undefined)).toEqual([null, 204, {}]);
		expect(response.create(NotModified, undefined)).toEqual([null, 304, {}]);
		expect(response.create(Partial, new Uint8Array([1, 2]))[1]).toBe(206);
		expect(response.create(Html, '<!doctype html><p>Done</p>')[2]).toEqual({
			'Content-Type': 'text/html; charset=utf-8',
		});

		const Redirect = response.redirect(303, { description: 'Continue to the result.' });
		expect(() => response.create(Redirect, undefined)).toThrow('requires a Location');
		expect(response.create(Redirect, undefined, { location: '/result' })[2]).toEqual({ Location: '/result' });
	});

	it('preserves repeated fields and rejects header injection', () => {
		const Detail = response.ok(ItemSchema, { description: 'Widget detail.' });
		const result = response.create(Detail, { id: 'widget_1' }, {
			headers: [
				['Set-Cookie', 'access=one; Path=/'],
				['Set-Cookie', 'refresh=two; Path=/'],
			],
		});
		expect(response.headerValues(result[2], 'set-cookie')).toEqual([
			'access=one; Path=/',
			'refresh=two; Path=/',
		]);
		expect(response.headerEntries(result[2])).toEqual([
			['Set-Cookie', 'access=one; Path=/'],
			['Set-Cookie', 'refresh=two; Path=/'],
		]);
		expect(() => response.headers({ 'X-Test': 'safe\r\nInjected: yes' })).toThrow('forbidden control character');
	});

	it('merges headers and metadata without losing body or definition identity', () => {
		const Detail = response.ok(ItemSchema, { description: 'Widget detail.', envelope: 'data' });
		const base = response.create(Detail, { id: 'widget_1' }, { meta: { source: 'postgres' } });
		const enriched = response.withMeta(response.withHeaders(base, { ETag: '"widget-1"' }), { durationMs: 12 });
		const resolved = response.finalize(enriched);
		expect(resolved.headers).toEqual({ Etag: '"widget-1"' });
		expect(resolved.body).toEqual({
			data: { id: 'widget_1' },
			meta: { source: 'postgres', durationMs: 12 },
		});
		expect(response.definitionOf(enriched)).toBe(Detail);
	});
});

describe('response pagination', () => {
	const Page = response.paginated(ItemSchema, { id: 'widgets:page', description: 'Widget page.' });

	it('automatically generates cursor links from the request URL', () => {
		const logical = response.create(Page, {
			kind: 'cursor',
			items: [{ id: 'a' }],
			cursor: 'current',
			limit: 20,
			hasMore: true,
			nextCursor: 'next',
			previousCursor: 'previous',
			total: 42,
		});
		const resolved = response.finalize(logical, {
			url: 'https://api.kaiju.land/widgets?filter[status]=ready&cursor=current&limit=20#section',
		});
		expect(response.headerValues(resolved.headers, 'link')[0]).toContain('rel="self"');
		expect(response.headerValues(resolved.headers, 'link')[0]).toContain('cursor=next');
		expect(resolved.headers).toMatchObject({
			'X-Total-Count': '42',
			'Preference-Applied': 'count=exact',
		});
		expect(resolved.body).toMatchObject({
			data: [{ id: 'a' }],
			meta: { pagination: { kind: 'cursor', limit: 20, total: 42 } },
			links: {
				self: 'https://api.kaiju.land/widgets?filter%5Bstatus%5D=ready&cursor=current&limit=20#section',
				next: 'https://api.kaiju.land/widgets?filter%5Bstatus%5D=ready&cursor=next&limit=20#section',
			},
		});
	});

	it('uses an explicit URL override when a handler must generate links for another public URL', () => {
		const logical = response.create(Page, {
			kind: 'cursor', items: [], limit: 10, hasMore: true, nextCursor: 'next',
		}, { url: '/public/widgets?view=compact' });
		const resolved = response.finalize(logical, { url: 'https://internal.invalid/widgets' });
		expect((resolved.body as { links: response.PaginationLinks }).links.next).toBe('/public/widgets?view=compact&cursor=next&limit=10');
	});

	it('generates first, previous, next, and last links for exact offset pages', () => {
		const logical = response.create(Page, {
			kind: 'offset',
			items: [{ id: 'c' }],
			offset: 40,
			limit: 20,
			page: 3,
			source: 'page',
			hasMore: true,
			total: 137,
		});
		const resolved = response.finalize(logical, { url: '/widgets?sort=createdAt%3Adesc&page=3&per_page=20' });
		const links = (resolved.body as { links: response.PaginationLinks }).links;
		expect(links).toEqual({
			self: '/widgets?sort=createdAt%3Adesc&page=3&per_page=20',
			first: '/widgets?sort=createdAt%3Adesc&page=1&per_page=20',
			previous: '/widgets?sort=createdAt%3Adesc&page=2&per_page=20',
			next: '/widgets?sort=createdAt%3Adesc&page=4&per_page=20',
			last: '/widgets?sort=createdAt%3Adesc&page=7&per_page=20',
		});
		expect(resolved.headers).toMatchObject({
			'X-Total-Count': '137',
			'X-Per-Page': '20',
			'X-Page': '3',
			'X-Total-Pages': '7',
		});
	});

	it('supports custom link projection without making handlers build ordinary URLs', () => {
		const logical = response.create(Page, {
			kind: 'cursor', items: [], limit: 10, hasMore: true, nextCursor: 'next',
		}, {
			url: '/widgets',
			link: ({ relation, generated }) => relation === 'next' && generated
				? `/signed?target=${encodeURIComponent(generated.pathname + generated.search)}`
				: undefined,
		});
		const links = (response.finalize(logical).body as { links: response.PaginationLinks }).links;
		expect(links.next).toContain('/signed?target=');
		expect(links.self).toBe('/widgets?limit=10');
	});
});


	it('honors independent body/header pagination presentation policies', () => {
		const HeaderTotalsOnly = response.paginated(ItemSchema, {
			id: 'items:header-totals',
			description: 'Totals only in HTTP fields.',
			pagination: { links: 'header', totals: 'headers' },
		});
		const resolved = response.finalize(response.create(HeaderTotalsOnly, {
			kind: 'offset', items: [{ id: 'one' }], offset: 0, limit: 10, hasMore: false, total: 1,
		}), { url: 'https://api.example.test/items?offset=0&limit=10' });
		expect(resolved.headers['X-Total-Count']).toBe('1');
		expect(resolved.body).toMatchObject({
			data: [{ id: 'one' }],
			meta: { pagination: { kind: 'offset', limit: 10, hasMore: false, offset: 0, page: 1, perPage: 10 } },
		});
		expect((resolved.body as { meta: { pagination: Record<string, unknown> } }).meta.pagination.total).toBeUndefined();
		expect((resolved.body as Record<string, unknown>).links).toBeUndefined();
	});

describe('response transport helpers', () => {
	it('evaluates conditional requests with ETag precedence', () => {
		const headers = { ETag: 'W/"abc"', 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT' };
		expect(response.isNotModified(new Request('https://example.test', {
			headers: { 'If-None-Match': '"abc"' },
		}), headers)).toBe(true);
		expect(response.isNotModified(new Request('https://example.test', {
			headers: { 'If-None-Match': '"different"', 'If-Modified-Since': 'Wed, 21 Oct 2030 07:28:00 GMT' },
		}), headers)).toBe(false);
	});

	it('parses open, suffix, bounded, and unsatisfiable byte ranges', () => {
		expect(response.byteRange('bytes=10-19', 100)).toEqual({
			kind: 'satisfiable', start: 10, end: 19, length: 10, contentRange: 'bytes 10-19/100',
		});
		expect(response.byteRange('bytes=90-', 100)).toMatchObject({ kind: 'satisfiable', start: 90, end: 99 });
		expect(response.byteRange('bytes=-5', 100)).toMatchObject({ kind: 'satisfiable', start: 95, end: 99 });
		expect(response.byteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable', contentRange: 'bytes */100' });
		expect(response.byteRange('bytes=0-1,4-5', 100)).toEqual({ kind: 'unsupported-multiple' });
	});

	it('observes complete body delivery and byte count', async () => {
		let observed: response.ResponseCompletion | undefined;
		const wrapped = response.onComplete(new Response('kaiju'), (value) => { observed = value; });
		expect(await wrapped.text()).toBe('kaiju');
		await Promise.resolve();
		expect(observed).toEqual({ outcome: 'completed', bytes: 5 });
	});

	it('observes cancellation exactly once', async () => {
		let calls = 0;
		let observed: response.ResponseCompletion | undefined;
		const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1])); } });
		const wrapped = response.onComplete(new Response(source), (value) => { calls += 1; observed = value; });
		const reader = wrapped.body!.getReader();
		await reader.read();
		await reader.cancel('stop');
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(observed).toMatchObject({ outcome: 'cancelled', bytes: 1, reason: 'stop' });
	});
});
