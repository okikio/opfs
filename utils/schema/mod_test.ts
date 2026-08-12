import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import { SchemaValidationError, is, parse, prefixIssues, validate } from './mod.ts';

const PositiveInteger = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value: unknown) {
			return Number.isInteger(value) && Number(value) > 0
				? { value: value as number }
				: { issues: [{ message: 'Expected a positive integer.' }] };
		},
	},
} as const satisfies StandardSchemaV1<unknown, number>;

describe('schema', () => {
	it('recognizes and parses Standard Schema V1 contracts', async () => {
		expect(is(PositiveInteger)).toBe(true);
		expect(await parse(PositiveInteger, 3)).toBe(3);
	});

	it('returns structured issues and throws a typed parse error', async () => {
		const result = await validate(PositiveInteger, 0);
		expect(result.issues?.[0]?.message).toBe('Expected a positive integer.');
		await expect(parse(PositiveInteger, 0)).rejects.toBeInstanceOf(SchemaValidationError);
	});

	it('prefixes nested issue paths without mutating the original issue', () => {
		const issue = { message: 'Invalid value.', path: ['field'] } satisfies StandardSchemaV1.Issue;
		const prefixed = prefixIssues([issue], 'items', 2);
		expect(prefixed[0]?.path).toEqual(['items', 2, 'field']);
		expect(issue.path).toEqual(['field']);
	});
});
