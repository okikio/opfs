import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as context from '@utils/context';
import * as pool from './mod.ts';

function deferred<Value = void>(): Readonly<{
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
}> {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((resolved) => resolve = resolved);
	return Object.freeze({ promise, resolve });
}

describe('reusable value pool', () => {
	it('bounds creation and serves waiting acquisitions in order', async () => {
		await using owner = context.create({ id: 'pool-owner', clock: new context.TestClock() });
		let next = 0;
		const values = await pool.create({
			ctx: owner,
			maximum: 1,
			create: () => ({ id: ++next }),
			close: () => {},
		});
		await using first = await values.acquire(owner);
		const secondPromise = values.acquire(owner);
		const thirdPromise = values.acquire(owner);
		expect(values.stats().waiting).toBe(2);
		await first[Symbol.asyncDispose]();
		const second = await secondPromise;
		expect(second.value.id).toBe(1);
		expect(values.stats().waiting).toBe(1);
		await second[Symbol.asyncDispose]();
		const third = await thirdPromise;
		expect(third.value.id).toBe(1);
		await third[Symbol.asyncDispose]();
		await values[Symbol.asyncDispose]();
	});

	it('closes invalid values and creates replacements', async () => {
		await using owner = context.create({ id: 'pool-invalid', clock: new context.TestClock() });
		let next = 0;
		const closed: number[] = [];
		await using values = await pool.create({
			ctx: owner,
			maximum: 1,
			create: () => ({ id: ++next }),
			close: (value) => closed.push(value.id),
		});
		const first = await values.acquire(owner);
		first.invalidate('broken');
		await first[Symbol.asyncDispose]();
		await using second = await values.acquire(owner);
		expect(second.value.id).toBe(2);
		expect(closed).toEqual([1]);
	});

	it('removes cancelled waiters promptly', async () => {
		await using owner = context.create({ id: 'pool-cancel-owner', clock: new context.TestClock() });
		await using values = await pool.create({ ctx: owner, maximum: 1, create: () => ({}), close: () => {} });
		await using first = await values.acquire(owner);
		const controller = new AbortController();
		await using waiterCtx = context.create({ id: 'pool-waiter', signal: controller.signal, clock: owner.clock });
		const waiting = values.acquire(waiterCtx);
		expect(values.stats().waiting).toBe(1);
		controller.abort('cancelled');
		await expect(waiting).rejects.toBe('cancelled');
		expect(values.stats().waiting).toBe(0);
	});

	it('times out acquisition without leaking a waiter', async () => {
		await using owner = context.create({ id: 'pool-timeout', clock: context.SystemClock });
		await using values = await pool.create({
			ctx: owner,
			maximum: 1,
			acquireTimeout: { milliseconds: 5 },
			create: () => ({}),
			close: () => {},
		});
		await using first = await values.acquire(owner);
		await expect(values.acquire(owner)).rejects.toThrow(pool.PoolAcquireTimeoutError);
		expect(values.stats().waiting).toBe(0);
	});

	it('waits for leased values during drain and rejects new acquisition', async () => {
		await using owner = context.create({ id: 'pool-drain', clock: new context.TestClock() });
		const closed = deferred();
		const values = await pool.create({
			ctx: owner,
			minimum: 1,
			maximum: 1,
			create: () => ({}),
			close: () => closed.resolve(),
		});
		const lease = await values.acquire(owner);
		let drained = false;
		const drain = values.drain('shutdown').then(() => drained = true);
		await Promise.resolve();
		expect(drained).toBe(false);
		await expect(values.acquire(owner)).rejects.toThrow(pool.PoolUnavailableError);
		await lease[Symbol.asyncDispose]();
		await drain;
		await closed.promise;
		expect(drained).toBe(true);
		await values[Symbol.asyncDispose]();
	});

	it('retires expired idle values during explicit maintenance while preserving the minimum', async () => {
		const clock = new context.TestClock();
		await using owner = context.create({ id: 'pool-maintain', clock });
		let next = 0;
		const closed: number[] = [];
		await using values = await pool.create({
			ctx: owner,
			minimum: 1,
			maximum: 2,
			maximumIdleAge: { seconds: 5 },
			create: () => ({ id: ++next }),
			close: (value) => closed.push(value.id),
		});
		const first = await values.acquire(owner);
		const second = await values.acquire(owner);
		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		clock.advance({ seconds: 6 });
		await values.maintain();
		expect(values.stats().idle).toBe(1);
		expect(closed).toHaveLength(1);
	});

	it('recovers creation failures without corrupting capacity counters', async () => {
		await using owner = context.create({ id: 'pool-create-failure', clock: new context.TestClock() });
		let calls = 0;
		await using values = await pool.create({
			ctx: owner,
			maximum: 1,
			create() {
				calls += 1;
				if (calls === 1) throw new Error('creation failed');
				return { id: calls };
			},
			close: () => {},
		});
		await expect(values.acquire(owner)).rejects.toThrow('creation failed');
		expect(values.stats().creating).toBe(0);
		await using lease = await values.acquire(owner);
		expect(lease.value.id).toBe(2);
	});

	it('closes a value created after the acquiring context was cancelled', async () => {
		await using owner = context.create({ id: 'pool-cancel-create-owner', clock: new context.TestClock() });
		const controller = new AbortController();
		await using acquiring = context.create({ id: 'pool-cancel-create', signal: controller.signal, clock: owner.clock });
		const created = deferred<Readonly<{ readonly id: number }>>();
		const closed: number[] = [];
		await using values = await pool.create({
			ctx: owner,
			maximum: 1,
			create: () => created.promise,
			close: (value) => closed.push(value.id),
		});
		const acquisition = values.acquire(acquiring);
		controller.abort('caller cancelled during creation');
		created.resolve({ id: 1 });
		await expect(acquisition).rejects.toBe('caller cancelled during creation');
		expect(closed).toEqual([1]);
		expect(values.stats()).toMatchObject({ creating: 0, idle: 0, leased: 0 });
	});

	it('wakes the next waiter and completes drain when closing a released value fails', async () => {
		await using owner = context.create({ id: 'pool-close-failure', clock: new context.TestClock() });
		let next = 0;
		const values = await pool.create({
			ctx: owner,
			maximum: 1,
			maximumIdle: 0,
			create: () => ({ id: ++next }),
			close(value) {
				if (value.id === 1) throw new Error('first close failed');
			},
		});
		const first = await values.acquire(owner);
		const secondPromise = values.acquire(owner);
		await expect(first[Symbol.asyncDispose]()).rejects.toThrow('first close failed');
		const second = await secondPromise;
		expect(second.value.id).toBe(2);
		await second[Symbol.asyncDispose]();
		await expect(values[Symbol.asyncDispose]()).rejects.toThrow(AggregateError);
		expect(values.stats().state).toBe('disposed');
	});

	it('rejects idle and timeout options that contradict pool ownership', async () => {
		await using owner = context.create({ id: 'pool-invalid-options', clock: new context.TestClock() });
		await expect(pool.create({ ctx: owner, minimum: 1, maximum: 1, maximumIdle: 0, create: () => ({}), close: () => {} }))
			.rejects.toThrow('maximumIdle must not be less than minimum');
		await expect(pool.create({ ctx: owner, maximum: 1, acquireTimeout: {}, create: () => ({}), close: () => {} }))
			.rejects.toThrow('acquireTimeout must be positive');
	});

});
