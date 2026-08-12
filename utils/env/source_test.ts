import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import * as fc from 'fast-check';

import * as env from './mod.ts';

describe('environment value sources', () => {
	it('captures records instead of observing later mutation', () => {
		const values: Record<string, string | undefined> = { VALUE: 'first' };
		const source = env.record(values);

		values.VALUE = 'second';

		expect(source.get('VALUE')).toBe('first');
	});

	it('treats prototype-shaped keys as ordinary data', () => {
		const values = Object.fromEntries([
			['__proto__', 'prototype-value'],
			['constructor', 'constructor-value'],
			['toString', 'to-string-value'],
		]);
		const source = env.record(values);

		expect(source.get('__proto__')).toBe('prototype-value');
		expect(source.get('constructor')).toBe('constructor-value');
		expect(source.get('toString')).toBe('to-string-value');
		expect(source.get('hasOwnProperty')).toBeUndefined();
	});

	it('round-trips arbitrary external string keys', () => {
		fc.assert(fc.property(
			fc.array(fc.tuple(fc.string(), fc.string())),
			(entries) => {
				const expected = new Map(entries);
				const source = env.record(Object.fromEntries(entries));

				for (const [key, value] of expected) {
					expect(source.get(key)).toBe(value);
				}
			},
		));
	});

	it('merges sparse sources from lowest to highest precedence', () => {
		const source = env.merge(
			{ DATABASE_URL: 'postgres://base', PORT: '8787' },
			{ PORT: '4321' },
		);

		expect(source.get('DATABASE_URL')).toBe('postgres://base');
		expect(source.get('PORT')).toBe('4321');
	});

	it('lets source-only consumers select a bounded record', () => {
		const selected = env.select(
			env.merge({ BUNNY_API_KEY: 'secret', UNUSED: 'ignored' }, { BUNNY_RELEASE_ID: 'release-1' }),
			['BUNNY_API_KEY', 'BUNNY_RELEASE_ID'],
		);

		expect(selected).toEqual({
			BUNNY_API_KEY: 'secret',
			BUNNY_RELEASE_ID: 'release-1',
		});
	});

	it('reads ambient values lazily through env.env', () => {
		const key = `KAIJU_ENV_TEST_${crypto.randomUUID().replaceAll('-', '_')}`;
		try {
			Deno.env.set(key, 'runtime-value');
			expect(env.env.get(key)).toBe('runtime-value');
		} finally {
			Deno.env.delete(key);
		}
	});
});
