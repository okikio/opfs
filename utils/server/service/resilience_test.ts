import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import * as requestContext from '@utils/context';
import * as resilience from '@utils/resilience';

import { composeRuntimes, RetryableOperationError, standardRetry } from './resilience.ts';
import type { ServiceRequestState, ServiceResilienceRuntime } from './types.ts';

const ctx = requestContext.create({
	id: 'request_test',
	signal: new AbortController().signal,
	clock: { now: () => Temporal.Instant.from('2026-08-02T00:00:00Z') },
});

const state = {
	request: new Request('https://api.kaiju.test/imports'),
	host: {},
	ctx,
	input: {},
	resources: {} as ServiceRequestState['resources'],
	values: {} as ServiceRequestState['values'],
	operation: {} as ServiceRequestState['operation'],
} satisfies ServiceRequestState;

describe('service resilience runtimes', () => {
	it('retries only explicitly classified failures', async () => {
		let attempts = 0;
		const runtime = standardRetry();
		const result = await runtime.execute([
			resilience.retry({ maximumAttempts: 3, initialDelay: { milliseconds: 1 }, maximumDelay: { milliseconds: 1 }, jitter: false }),
		], state, () => {
			attempts += 1;
			if (attempts < 3) throw new RetryableOperationError(new Error('temporary'));
			return Promise.resolve(new Response('ok'));
		});
		expect(result).toBeInstanceOf(Response);
		expect(attempts).toBe(3);
	});

	it('does not retry ordinary failures', async () => {
		let attempts = 0;
		const runtime = standardRetry();
		await expect(runtime.execute([
			resilience.retry({ maximumAttempts: 3, initialDelay: { milliseconds: 1 }, maximumDelay: { milliseconds: 1 }, jitter: false }),
		], state, () => {
			attempts += 1;
			throw new Error('not classified');
		})).rejects.toThrow('not classified');
		expect(attempts).toBe(1);
	});

	it('composes focused runtimes in policy order', async () => {
		const events: string[] = [];
		const runtime = (type: 'idempotency' | 'retry'): ServiceResilienceRuntime => ({
			supports: (policy) => policy.type === type,
			async execute(_policies, _state, next) {
				events.push(`${type}:before`);
				const result = await next();
				events.push(`${type}:after`);
				return result;
			},
		});
		const combined = composeRuntimes(runtime('idempotency'), runtime('retry'));
		await combined.execute([resilience.idempotent(), resilience.retry()], state, async () => {
			events.push('operation');
			return new Response('ok');
		});
		expect(events).toEqual([
			'idempotency:before',
			'retry:before',
			'operation',
			'retry:after',
			'idempotency:after',
		]);
	});
});
