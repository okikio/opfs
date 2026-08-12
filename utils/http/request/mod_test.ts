import { describe, it } from 'node:test';
import { expect } from '@std/expect';

import * as request from './mod.ts';

describe('request wire parsing', () => {
	it('normalizes bounded headers and redacts credentials', () => {
		const headers = new Headers({ Authorization: 'Bearer secret', 'X-Test': 'value' });
		expect(request.parseHeaders(headers)).toEqual({ authorization: 'Bearer secret', 'x-test': 'value' });
		expect(request.redactHeaders(headers)).toEqual({ authorization: '[REDACTED]', 'x-test': 'value' });
		expect(() => request.parseHeaders(new Headers({ 'X-Large': '12345' }), { maximumHeaderValueBytes: 4 }))
			.toThrow(request.RequestTransportError);
	});

	it('preserves repeated query values and enforces count/value bounds', () => {
		const query = new URLSearchParams();
		query.append('tag', 'one');
		query.append('tag', 'two');
		expect(request.parseQuery(query)).toEqual({ tag: ['one', 'two'] });
		expect(() => request.parseQuery(query, { maximumQueryParameters: 1 })).toThrow('At most 1 query parameters');
		expect(() => request.parseQuery(new URLSearchParams({ q: 'abc' }), { maximumQueryValueLength: 2 }))
			.toThrow('exceeds 2 characters');
	});

	it('decodes canonical path parameters and rejects malformed encodings', () => {
		expect(request.parseParameters('/widgets/:widgetId', '/widgets/widget%201')).toEqual({ widgetId: 'widget 1' });
		expect(() => request.parseParameters('/widgets/:widgetId', '/widgets/%E0%A4%A')).toThrow('percent-encoding');
	});

	it('parses cookies with explicit duplicate and percent-decoding policy', () => {
		expect(request.parseCookies('session=opaque; preference=compact; session=rotated')).toEqual({
			session: ['opaque', 'rotated'],
			preference: 'compact',
		});
		expect(request.parseCookies('name=kaiju%20land', { percentDecode: true })).toEqual({ name: 'kaiju land' });
		expect(() => request.parseCookies('session=one; session=two', { duplicates: 'reject' })).toThrow('occurs more than once');
	});

	it('parses authorization syntax without exposing the credential through logging or JSON', () => {
		const parsed = request.parseAuthorization('Bearer very-secret', { allowedSchemes: ['Bearer'] })!;
		expect(parsed.scheme).toBe('Bearer');
		expect(parsed.normalizedScheme).toBe('bearer');
		expect(parsed.credential.reveal()).toBe('very-secret');
		expect(String(parsed.credential)).toBe('[REDACTED]');
		expect(JSON.stringify(parsed.credential)).toBe('"[REDACTED]"');
		expect(() => request.parseAuthorization('Digest value', { allowedSchemes: ['Bearer'] })).toThrow('not supported');
	});

	it('reads and parses bounded JSON and repeated form values', async () => {
		const json = await request.parseJson(new Request('https://example.test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/problem+json' },
			body: JSON.stringify({ ok: true }),
		}));
		expect(json).toEqual({ ok: true });
		await expect(request.parseJson(new Request('https://example.test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '12345',
		}), { maximumBodyBytes: 4 })).rejects.toThrow('exceeds 4 bytes');

		const form = await request.parseForm(new Request('https://example.test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'tag=one&tag=two&name=kaiju',
		}));
		expect(form).toEqual({ tag: ['one', 'two'], name: 'kaiju' });
	});

	it('accepts browser-scale request input with the default limits', async () => {
		const largeHeaderValue = 'h'.repeat(12 * 1024);
		expect(request.parseHeaders(new Headers({ Authorization: 'Bearer secret', 'X-Large': largeHeaderValue }))).toEqual({
			authorization: 'Bearer secret',
			'x-large': largeHeaderValue,
		});

		const queryValue = 'q'.repeat(6 * 1024);
		expect(request.parseQuery(new URLSearchParams({ search: queryValue }))).toEqual({ search: queryValue });

		const cookieValue = 'c'.repeat(10 * 1024);
		expect(request.parseCookies(`session=${cookieValue}; preference=compact`)).toEqual({
			session: cookieValue,
			preference: 'compact',
		});

		const jsonBody = JSON.stringify({ payload: 'b'.repeat(2 * 1024 * 1024) });
		const parsedJson = await request.parseJson(new Request('https://example.test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: jsonBody,
		}));
		expect(parsedJson).toEqual({ payload: 'b'.repeat(2 * 1024 * 1024) });

		const manyFields = new URLSearchParams();
		for (let index = 0; index < 300; index += 1) manyFields.append(`field${index}`, `${index}`);
		const parsedForm = await request.parseForm(new Request('https://example.test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: manyFields,
		}));
		expect(parsedForm.field0).toBe('0');
		expect(parsedForm.field299).toBe('299');
	});

	it('negotiates media types by quality and specificity', () => {
		expect(request.negotiateContent('text/html;q=0.8, application/json;q=1', ['text/html', 'application/json']))
			.toBe('application/json');
		expect(request.negotiateContent('application/*;q=0.5, text/html;q=0.5', ['application/json', 'text/html']))
			.toBe('text/html');
		expect(() => request.negotiateContent('application/xml', ['application/json'])).toThrow('None of the requested media types');
	});

	it('uses forwarded origin data only under an explicit trust policy', () => {
		const incoming = new Request('http://internal:8000/widgets', {
			headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'api.kaiju.land' },
		});
		expect(request.externalUrl(incoming, { trust: false }).href).toBe('http://internal:8000/widgets');
		expect(request.externalUrl(incoming, {
			trust: true,
			allowedProtocols: ['https:'],
			allowedHosts: ['api.kaiju.land'],
		}).href).toBe('https://api.kaiju.land/widgets');
		expect(() => request.externalUrl(incoming, { trust: true, allowedHosts: ['other.example'] })).toThrow('not allowed');
	});
});

describe('request validation diagnostics', () => {
	it('normalizes transport and schema issues without copying rejected values', () => {
		const details = request.validationDetails('query', [
			{ code: 'query-value-too-large', message: 'The query value is too large.', path: ['filter', 'email'] },
			{ message: 'Expected a number.', path: [{ key: 'limit' }] },
		]);
		expect(details).toEqual([
			{
				source: 'query',
				code: 'query-value-too-large',
				message: 'The query value is too large.',
				path: ['filter', 'email'],
				location: 'query.filter.email',
				field: 'email',
			},
			{
				source: 'query',
				code: 'invalid-value',
				message: 'Expected a number.',
				path: ['limit'],
				location: 'query.limit',
				field: 'limit',
			},
		]);
		expect(JSON.stringify(details)).not.toContain('someone@example.com');
	});
});

describe('request correlation and memo ownership', () => {
	it('continues valid W3C context with a fresh span and sanitized request ID', async () => {
		const incomingTrace = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
		const raw = new Request('https://example.test', {
			headers: {
				traceparent: incomingTrace,
				tracestate: 'vendor=value',
				'x-request-id': 'request_123',
			},
		});
		const first = await request.correlation(raw);
		const second = await request.correlation(raw);
		expect(second).toBe(first);
		expect(first).toMatchObject({
			requestId: 'request_123',
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			parentSpanId: '00f067aa0ba902b7',
			traceFlags: '01',
			traceState: 'vendor=value',
			source: 'continued',
		});
		expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(request.propagationHeaders(first).get('traceparent')).toBe(first.traceparent);
	});

	it('projects redaction-safe structured correlation fields', async () => {
		const value = await request.correlation(new Request('https://example.test'));
		const fields = request.correlationFields(value, {
			service: 'imports',
			operationId: 'imports.list',
			routeId: 'GET /imports',
		});
		expect(fields).toMatchObject({
			request_id: value.requestId,
			trace_id: value.traceId,
			span_id: value.spanId,
			service: 'imports',
			operation_id: 'imports.list',
			route_id: 'GET /imports',
		});
		expect(JSON.stringify(fields)).not.toContain('authorization');
		expect(JSON.stringify(fields)).not.toContain('cookie');
	});

	it('replaces malformed parent context rather than forwarding it', async () => {
		const value = await request.correlation(new Request('https://example.test', {
			headers: { traceparent: '00-not-a-trace', 'x-request-id': 'bad\trequest' },
		}));
		expect(value.source).toBe('replaced-invalid-parent');
		expect(value.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(value.requestId).not.toBe('bad\trequest');
		expect(value.parentSpanId).toBeUndefined();
	});

	it('shares pending work, retries rejected loads, and disposes request-owned values', async () => {
		const owner = {};
		const key = {};
		let calls = 0;
		const load = async () => { calls += 1; await Promise.resolve(); return { value: calls }; };
		const [left, right] = await Promise.all([
			request.memoize(owner, key, load),
			request.memoize(owner, key, load),
		]);
		expect(left).toBe(right);
		expect(calls).toBe(1);

		let failures = 0;
		await expect(request.memoize(owner, 'failure', () => { failures += 1; throw new Error('failed'); })).rejects.toThrow('failed');
		await expect(request.memoize(owner, 'failure', () => { failures += 1; throw new Error('failed again'); })).rejects.toThrow('failed again');
		expect(failures).toBe(2);

		let disposed = false;
		await request.memoize(owner, 'disposable', () => ({ [Symbol.dispose]() { disposed = true; } }));
		await request.disposeMemo(owner);
		expect(disposed).toBe(true);
	});
});
