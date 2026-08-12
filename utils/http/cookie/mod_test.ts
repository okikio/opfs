import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as cookie from './mod.ts';

const Token: StandardSchemaV1<string, string> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			return typeof value === 'string' && value.startsWith('guest_')
				? { value }
				: { issues: [{ message: 'Invalid guest token.' }] };
		},
	},
};

const Guest = cookie.define({
	id: 'workspace.guest-session',
	description: 'Application guest session.',
	name: '__Host-kaiju-guest',
	value: Token,
	attributes: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
});

describe('cookie definitions', () => {
	it('enforces browser prefix and SameSite security invariants', () => {
		expect(() => cookie.define({
			id: 'invalid.host',
			description: 'Invalid host cookie.',
			name: '__Host-invalid',
			value: Token,
			attributes: { path: '/' },
		})).toThrow(TypeError);
		expect(() => cookie.define({
			id: 'invalid.none',
			description: 'Invalid SameSite cookie.',
			name: 'invalid',
			value: Token,
			attributes: { sameSite: 'none' },
		})).toThrow(TypeError);
	});

	it('validates reads and appends non-destructive Set-Cookie fields', async () => {
		const headers = new Headers({ Cookie: '__Host-kaiju-guest=guest_123; other=value' });
		expect(await cookie.get(headers, Guest)).toBe('guest_123');
		const invalid = await cookie.safeGet(new Headers({ Cookie: '__Host-kaiju-guest=bad' }), Guest);
		expect(invalid.success).toBe(false);

		const responseHeaders = new Headers();
		cookie.set(responseHeaders, Guest, 'guest_456');
		cookie.delete(responseHeaders, Guest);
		const values = typeof responseHeaders.getSetCookie === 'function'
			? responseHeaders.getSetCookie()
			: [responseHeaders.get('set-cookie') ?? ''];
		expect(values.join('\n')).toContain('__Host-kaiju-guest=guest_456');
		expect(values.join('\n')).toContain('Max-Age=0');
	});
});
