import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import { Branch, Deferred, LocalFinalizerStepError, operation, Reducer, Scope } from './mod.ts';
import type { Cause, Exit, Operation, Step } from './types.ts';

function program<Value>(run: () => Generator<Step<unknown>, Value, Exit<unknown>>): Operation<Value> {
	return Object.freeze({ [Symbol.iterator]: run });
}

async function run<Value>(value: Operation<Value>): Promise<Exit<Value>> {
	return await new Branch(value).start();
}

function causes(value: Cause): readonly Cause[] {
	return value.type === 'multiple' ? value.causes : [value];
}

function tick(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

describe('workflow host-local iterator kernel', () => {
	it('settles Deferred resolvers exactly once for both resolve and reject paths', async () => {
		const resolved = new Deferred<number>();
		resolved.resolve(1);
		resolved.resolve(2);
		expect(await resolved.promise).toBe(1);

		for (const message of ['first rejection', 'second rejection']) {
			const rejected = new Deferred<number>();
			const result = rejected.promise.catch((error) => error);
			rejected.reject(new Error(message));
			rejected.reject(new Error('ignored'));
			expect((await result as Error).message).toBe(message);
		}
	});

	it('runs synchronous Step completions through the reducer without recursive generator advancement', async () => {
		const count = 4_096;
		const value = program(function* () {
			let completed = 0;
			for (let index = 0; index < count; index += 1) {
				yield* operation.action<void>('immediate step', (resolve) => resolve(undefined))[Symbol.iterator]();
				completed += 1;
			}
			return completed;
		});
		expect(await run(value)).toEqual({ type: 'success', value: count });
	});

	it('keeps critical transitions ahead of normal transitions while preserving FIFO order within each priority', async () => {
		const reducer = new Reducer(16);
		const order: string[] = [];
		reducer.enqueue(() => order.push('normal:1'));
		reducer.enqueue(() => order.push('critical:1'), 'critical');
		reducer.enqueue(() => order.push('normal:2'));
		reducer.enqueue(() => order.push('critical:2'), 'critical');
		await tick();
		expect(order).toEqual(['critical:1', 'critical:2', 'normal:1', 'normal:2']);
	});

	it('drains finalizers LIFO and accepts a finalizer registered while closure is already running', async () => {
		const scope = new Scope();
		const order: string[] = [];
		scope.addFinalizer(() => order.push('first'));
		scope.addFinalizer(() => {
			order.push('second');
			scope.addFinalizer(() => order.push('added-during-close'));
		});
		expect(await scope.close('done')).toEqual([]);
		expect(order).toEqual(['second', 'added-during-close', 'first']);
		expect(await scope.close('ignored')).toEqual([]);
	});

	it('withholds a successful branch result until registered asynchronous cleanup completes', async () => {
		const cleanupStarted = new Deferred<void>();
		const releaseCleanup = new Deferred<void>();
		const branch = new Branch(program(function* () {
			yield* operation.ensure(async () => {
				cleanupStarted.resolve();
				await releaseCleanup.promise;
			})[Symbol.iterator]();
			return 'ready';
		}));
		let settled = false;
		const result = branch.start().then((exit) => { settled = true; return exit; });
		await cleanupStarted.promise;
		expect(settled).toBe(false);
		releaseCleanup.resolve();
		expect(await result).toEqual({ type: 'success', value: 'ready' });
	});

	it('EFFECT_CAUSE_001 preserves the primary failure and a cleanup failure', async () => {
		const primary = new Error('primary');
		const cleanup = new Error('cleanup');
		const exit = await run(program(function* () {
			yield* operation.ensure(() => { throw cleanup; })[Symbol.iterator]();
			yield* operation.action<void>('fail', (_resolve, reject) => reject(primary))[Symbol.iterator]();
			return 'unreachable';
		}));
		expect(exit.type).toBe('failure');
		if (exit.type !== 'failure') return;
		const failures = causes(exit.cause);
		expect(failures.length).toBe(2);
		expect(failures[0]).toMatchObject({ type: 'failure', failure: primary });
		expect(failures[1]).toMatchObject({ type: 'failure', failure: cleanup });
	});

	it('preserves a discard failure beside the cancellation cause', async () => {
		const entered = new Deferred<void>();
		const cleanup = new Error('discard failed');
		const branch = new Branch(program(function* () {
			yield* operation.action<void>('owned callback', () => {
				entered.resolve();
				return () => { throw cleanup; };
			})[Symbol.iterator]();
			return 'unreachable';
		}));
		const result = branch.start();
		await entered.promise;
		await branch.cancel('stop');
		const exit = await result;
		expect(exit.type).toBe('failure');
		if (exit.type !== 'failure') return;
		const terminal = causes(exit.cause);
		expect(terminal[0]).toEqual({ type: 'cancelled', reason: 'stop' });
		expect(terminal[1]).toMatchObject({ type: 'failure', failure: cleanup });
	});

	it('EFFECTION_UNWIND_001 rejects a Step yielded by ordinary finally and never resumes the cancelled body', async () => {
		for (const attempt of [1, 2]) {
			const entered = new Deferred<void>();
			let finalizerStepEntered = false;
			let afterFinally = false;
			const branch = new Branch(program(function* () {
				try {
					yield* operation.action<void>(`blocked ${attempt}`, () => { entered.resolve(); })[Symbol.iterator]();
				} finally {
					yield* operation.action<void>(`unsafe async finally ${attempt}`, (resolve) => {
						finalizerStepEntered = true;
						resolve(undefined);
					})[Symbol.iterator]();
				}
				afterFinally = true;
				return 'unreachable';
			}));
			const result = branch.start();
			await entered.promise;
			await branch.cancel('stop');
			const exit = await result;
			expect(afterFinally).toBe(false);
			expect(finalizerStepEntered).toBe(false);
			expect(exit.type).toBe('failure');
			if (exit.type !== 'failure') continue;
			const unwindFailure = causes(exit.cause).find((cause) => cause.type === 'failure' && cause.failure instanceof LocalFinalizerStepError);
			expect(unwindFailure !== undefined).toBe(true);
		}
	});

	it('fail-fast supervision raises a child failure into its owner and still waits for owner cleanup', async () => {
		const childFailure = new Error('child failed');
		const cleanup = new Deferred<void>();
		const parent = new Branch(program(function* () {
			yield* operation.ensure(() => cleanup.resolve())[Symbol.iterator]();
			yield* operation.spawn(
				operation.action<void>('child failure', (_resolve, reject) => reject(childFailure)),
				'fail-fast',
			)[Symbol.iterator]();
			yield* operation.action<void>('parent wait', () => undefined)[Symbol.iterator]();
			return 'unreachable';
		}));
		const exit = await parent.start();
		await cleanup.promise;
		expect(exit.type).toBe('failure');
		if (exit.type !== 'failure') return;
		expect(causes(exit.cause)[0]).toMatchObject({ type: 'failure', failure: childFailure });
	});

	it('collect supervision keeps sibling failures as values for allSettled', async () => {
		const failed = new Error('expected');
		const exit = await run(operation.allSettled([
			operation.value('ok'),
			operation.action<void>('expected failure', (_resolve, reject) => reject(failed)),
		] as const));
		expect(exit.type).toBe('success');
		if (exit.type !== 'success') return;
		expect(exit.value[0]).toEqual({ type: 'success', value: 'ok' });
		expect(exit.value[1].type).toBe('failure');
	});

	it('all cancels an unfinished sibling immediately after the first child failure and waits for cleanup', async () => {
		const slowEntered = new Deferred<void>();
		const cleanupStarted = new Deferred<void>();
		const releaseCleanup = new Deferred<void>();
		const primary = new Error('stop siblings');
		const slow = program(function* () {
			yield* operation.ensure(async () => {
				cleanupStarted.resolve();
				await releaseCleanup.promise;
			})[Symbol.iterator]();
			yield* operation.action<void>('slow child', () => { slowEntered.resolve(); })[Symbol.iterator]();
			return 'slow';
		});
		const fastFailure = program(function* () {
			yield* operation.wait('let sibling enter', async () => { await slowEntered.promise; })[Symbol.iterator]();
			yield* operation.action<void>('fail first', (_resolve, reject) => reject(primary))[Symbol.iterator]();
			return 'unreachable';
		});
		const branch = new Branch(operation.all([slow, fastFailure] as const));
		let settled = false;
		const result = branch.start().then((value) => { settled = true; return value; });
		await cleanupStarted.promise;
		expect(settled).toBe(false);
		releaseCleanup.resolve();
		const exit = await result;
		expect(exit.type).toBe('failure');
		if (exit.type !== 'failure') return;
		expect(causes(exit.cause)[0]).toMatchObject({ type: 'failure', failure: primary });
	});

	it('EFFECTION_RACE_001 withholds the winner until the loser has completed cancellation cleanup', async () => {
		const loserEntered = new Deferred<void>();
		const winnerRelease = new Deferred<void>();
		const cleanupStarted = new Deferred<void>();
		const cleanupRelease = new Deferred<void>();
		const loser = program(function* () {
			yield* operation.ensure(async () => {
				cleanupStarted.resolve();
				await cleanupRelease.promise;
			})[Symbol.iterator]();
			yield* operation.action<void>('loser wait', () => { loserEntered.resolve(); })[Symbol.iterator]();
			return 'loser';
		});
		const winner = program(function* () {
			yield* operation.wait('winner gate', async () => {
				await loserEntered.promise;
				await winnerRelease.promise;
			})[Symbol.iterator]();
			return 'winner';
		});
		const branch = new Branch(operation.race([winner, loser] as const));
		let settled = false;
		const result = branch.start().then((value) => { settled = true; return value; });
		await loserEntered.promise;
		winnerRelease.resolve();
		await cleanupStarted.promise;
		expect(settled).toBe(false);
		cleanupRelease.resolve();
		expect(await result).toEqual({ type: 'success', value: 'winner' });
	});

	it('fromIterator is pull-based and invokes return exactly once when the branch finishes early', async () => {
		let nextCount = 0;
		let returnCount = 0;
		const iterator: Iterator<number, string> = {
			next() { nextCount += 1; return { done: false, value: nextCount }; },
			return() { returnCount += 1; return { done: true, value: 'closed' }; },
		};
		const exit = await run(program(function* () {
			const source = yield* operation.fromIterator(iterator)[Symbol.iterator]();
			expect(nextCount).toBe(0);
			const first = yield* source.next()[Symbol.iterator]();
			return first.done ? -1 : first.value;
		}));
		expect(exit).toEqual({ type: 'success', value: 1 });
		expect(nextCount).toBe(1);
		expect(returnCount).toBe(1);
	});

	it('fromAsyncIterator waits for return during cancellation and invokes it once', async () => {
		const entered = new Deferred<void>();
		const pending = new Deferred<IteratorResult<number, string>>();
		let returnCount = 0;
		const iterator: AsyncIterator<number, string> = {
			next() { entered.resolve(); return pending.promise; },
			async return() {
				returnCount += 1;
				pending.resolve({ done: true, value: 'closed' });
				return { done: true, value: 'closed' };
			},
		};
		const branch = new Branch(program(function* () {
			const source = yield* operation.fromAsyncIterator(iterator)[Symbol.iterator]();
			yield* source.next()[Symbol.iterator]();
			return 'unreachable';
		}));
		const result = branch.start();
		await entered.promise;
		await branch.cancel('stop');
		expect((await result).type).toBe('failure');
		expect(returnCount).toBe(1);
	});

	it('FUTURE_ADAPTER_001 cancels a ReadableStream and releases its reader lock exactly once', async () => {
		const entered = new Deferred<void>();
		let cancelCount = 0;
		const stream = new ReadableStream<number>({
			start() { entered.resolve(); },
			cancel() { cancelCount += 1; },
		});
		await entered.promise;
		const branch = new Branch(program(function* () {
			const source = yield* operation.fromReadableStream(stream)[Symbol.iterator]();
			yield* source.next()[Symbol.iterator]();
			return 'unreachable';
		}));
		const result = branch.start();
		await tick();
		expect(stream.locked).toBe(true);
		await branch.cancel('stop');
		expect((await result).type).toBe('failure');
		expect(cancelCount).toBe(1);
		expect(stream.locked).toBe(false);
	});

	it('repeated cancellation is idempotent and shares the same terminal result', async () => {
		const entered = new Deferred<void>();
		const branch = new Branch(operation.action<void>('wait forever', () => { entered.resolve(); }));
		const result = branch.start();
		await entered.promise;
		await Promise.all([branch.cancel('first'), branch.cancel('second'), branch.cancel('third')]);
		const exit = await result;
		expect(exit.type).toBe('failure');
		if (exit.type !== 'failure') return;
		expect(causes(exit.cause)[0]).toEqual({ type: 'cancelled', reason: 'first' });
	});
});
