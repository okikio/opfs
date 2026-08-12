import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as failure from './mod.ts';

const Timeout = failure.define({
	id: 'capture.timeout',
	description: 'Capture exceeded its deadline.',
	data: {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate(value: unknown) {
				return typeof value === 'object' && value !== null && typeof (value as { milliseconds?: unknown }).milliseconds === 'number'
					? { value: Object.freeze({ milliseconds: (value as { milliseconds: number }).milliseconds }) }
					: { issues: [{ message: 'Expected timeout data.' }] };
			},
		},
	} satisfies StandardSchemaV1<unknown, Readonly<{ milliseconds: number }>>,
});

const Failures = failure.catalog('capture', { Timeout });

describe('failure', () => {
	it('creates occurrences with exact definition identity', async () => {
		const occurrence = await failure.create(Timeout, { data: { milliseconds: 50 }, cause: new Error('socket') });
		expect(failure.is(occurrence, Timeout)).toBe(true);
		expect(occurrence.data.milliseconds).toBe(50);
	});

	it('round-trips durable data without serializing the cause', async () => {
		const occurrence = await failure.create(Timeout, { data: { milliseconds: 50 }, cause: new Error('socket') });
		const encoded = await failure.encode(occurrence);
		expect('cause' in encoded).toBe(false);
		const decoded = await failure.decode(encoded, Failures);
		expect(decoded.definition).toBe(Timeout);
		expect(decoded.data).toEqual({ milliseconds: 50 });
	});

	it('rejects invalid data and unknown durable failure IDs', async () => {
		await expect(failure.create(Timeout, { data: { milliseconds: 'bad' } })).rejects.toThrow();
		await expect(failure.decode({ id: 'unknown', message: 'no', data: {} }, Failures)).rejects.toBeInstanceOf(
			failure.UnknownFailureDefinitionError,
		);
	});
});
