/**
 * Bounded reusable-value pooling with explicit disposable leases.
 *
 * The caller supplies value creation, health checks, and close behavior. The
 * pool owns admission, waiting, leasing, return, drain, and cleanup.
 *
 * @module
 */
import { EventBus } from '@okikio/observables';
import * as contextCore from '@utils/context';
import type { Context } from '@utils/context';

import type { CreateOptions, Event, Lease, Pool, Stats } from './types.ts';

/** Acquisition attempted while a pool is draining or disposed. */
export class PoolUnavailableError extends Error {
	readonly state: 'draining' | 'disposed';
	readonly reason: unknown;

	constructor(state: 'draining' | 'disposed', reason?: unknown) {
		super(`Pool is ${state}.`, reason === undefined ? undefined : { cause: reason });
		this.name = 'PoolUnavailableError';
		this.state = state;
		this.reason = reason;
	}
}

/** Pool acquisition exceeded its configured timeout. */
export class PoolAcquireTimeoutError extends Error {
	readonly duration: Temporal.Duration;

	constructor(duration: Temporal.Duration) {
		super(`Pool acquisition exceeded ${duration.toString()}.`);
		this.name = 'PoolAcquireTimeoutError';
		this.duration = duration;
	}
}

interface IdleValue<Value> {
	readonly value: Value;
	readonly returnedAt: Temporal.Instant;
}

interface Waiter {
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
	readonly unlink: () => void;
}

interface LeaseState {
	invalid: boolean;
	reason?: unknown;
	released: boolean;
}

/**
 * Create a bounded reusable-value pool with explicit ownership and fair acquisition waits.
 *
 * ```text
 * acquire(ctx)
 *    |
 *    +-- idle value -------------------------------> Lease
 *    |
 *    +-- capacity available -> create(value) ------> Lease
 *    |
 *    `-- saturated -> FIFO waiter -> release ------> retry acquire
 *
 * Lease.release() -> idle queue or destroy(value)
 * Lease.invalidate(reason) -> destroy(value)
 * Pool.dispose() -> stop admission -> wait leases -> destroy idle
 * ```
 *
 * The pool owns created values. A lease only borrows one value until it releases
 * or invalidates that value.
 */
export async function create<Value>(options: CreateOptions<Value>): Promise<Pool<Value>> {
	const minimum = nonNegativeInteger(options.minimum ?? 0, 'pool minimum');
	const maximum = positiveInteger(options.maximum, 'pool maximum');
	if (minimum > maximum) throw new TypeError('Pool minimum must not exceed maximum.');
	const maximumIdle = nonNegativeInteger(options.maximumIdle ?? maximum, 'pool maximumIdle');
	if (maximumIdle > maximum) throw new TypeError('Pool maximumIdle must not exceed maximum.');
	if (maximumIdle < minimum) throw new TypeError('Pool maximumIdle must not be less than minimum.');
	const maximumIdleAge = options.maximumIdleAge === undefined
		? undefined
		: nonNegativeDuration(options.maximumIdleAge, 'pool maximumIdleAge');
	const acquireTimeout = options.acquireTimeout === undefined
		? undefined
		: positiveDuration(options.acquireTimeout, 'pool acquireTimeout');
	await using startupCtx = contextCore.child(options.ctx, { id: `${options.ctx.id}:pool-startup` });
	const ownerCtx = contextCore.child(options.ctx, { id: `${options.ctx.id}:pool` });
	const events = new EventBus<Event>();
	const idle: IdleValue<Value>[] = [];
	const leased = new Map<Value, LeaseState>();
	const waiters: Waiter[] = [];
	let creating = 0;
	let state: 'active' | 'draining' | 'disposed' = 'active';
	let stopReason: unknown;
	let drainPromise: Promise<void> | undefined;
	let resolveDrain: (() => void) | undefined;
	const disposalFailures: unknown[] = [];

	const pool: Pool<Value> = Object.freeze({
		events: events.events,
		/**
		 * Acquires a reusable value through the capacity, health, cancellation, and waiter rules of the bounded reusable-resource pool.
		 *
		 * Pool internals keep acquisition, validation, leases, draining, waiter wake-up, and reverse cleanup under one owner.
		 *
		 * @internal
		 */
		async acquire(ctx: Context) {
			const acquisition = acquisitionContext(ctx);
			try {
				while (true) {
					checkAcquisition(acquisition.ctx);
					assertActive();
					if (idle.length === 0 && totalOwned() >= maximum) {
						await waitForAvailability(acquisition.ctx);
						continue;
					}
					await removeExpiredIdle();
					const reused = await takeHealthyIdle();
					if (reused !== undefined) return createLease(reused);
					if (totalOwned() < maximum) {
						const value = await createValue(acquisition.ctx);
						try {
							checkAcquisition(acquisition.ctx);
							assertActive();
						} catch (error) {
							await closeRejectedValue(value, error);
						}
						return createLease(value);
					}
					await waitForAvailability(acquisition.ctx);
				}
			} catch (error) {
				if (acquisition.timeout !== undefined && error instanceof contextCore.ContextDeadlineExceededError) {
					throw new PoolAcquireTimeoutError(acquisition.timeout);
				}
				throw error;
			} finally {
				await acquisition.dispose();
			}
		},
		/**
		 * Calculates the stats snapshot reported by the bounded reusable-resource pool.
		 *
		 * @internal
		 */
		stats() {
			return snapshotStats();
		},
		/**
		 * Maintains minimum idle capacity and retires stale idle values for the bounded reusable-resource pool.
		 *
		 * @internal
		 */
		async maintain() {
			assertActive();
			await removeExpiredIdle();
		},
		/**
		 * Drains owned work before the bounded reusable-resource pool reports terminal completion.
		 *
		 * Pool internals keep acquisition, validation, leases, draining, waiter wake-up, and reverse cleanup under one owner.
		 *
		 * @internal
		 */
		async drain(reason?: unknown) {
			if (state === 'disposed') return;
			if (drainPromise === undefined) {
				state = 'draining';
				stopReason = reason;
				events.emit(Object.freeze({ type: 'draining', ...(reason === undefined ? {} : { reason }) }));
				rejectWaiters(new PoolUnavailableError('draining', reason));
				drainPromise = new Promise<void>((resolve) => resolveDrain = resolve);
				const values = idle.splice(0).map((entry) => entry.value);
				const settled = await Promise.allSettled(values.map((value) => closeValue(value, reason)));
				for (const result of settled) if (result.status === 'rejected') disposalFailures.push(result.reason);
				resolveDrainIfComplete();
			}
			await drainPromise;
			throwDisposalFailures();
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			if (state === 'disposed') return;
			let drainFailed = false;
			let drainFailure: unknown;
			try {
				await pool.drain('Pool was disposed.');
			} catch (error) {
				drainFailed = true;
				drainFailure = error;
			} finally {
				state = 'disposed';
				await ownerCtx[Symbol.asyncDispose]();
				events.emit(Object.freeze({ type: 'disposed' }));
				events[Symbol.dispose]();
			}
			if (drainFailed) throw drainFailure;
		},
	});

	try {
		for (let index = 0; index < minimum; index += 1) {
			const value = await createValue(startupCtx);
			try {
				contextCore.check(startupCtx);
			} catch (error) {
				await closeRejectedValue(value, error);
			}
			idle.push({ value, returnedAt: options.ctx.clock.now() });
		}
		return pool;
	} catch (error) {
		state = 'draining';
		const settled = await Promise.allSettled(idle.splice(0).map((entry) => closeValue(entry.value, error)));
		await ownerCtx[Symbol.asyncDispose]();
		events[Symbol.dispose]();
		const closeFailures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
		if (closeFailures.length > 0) throw new AggregateError([error, ...closeFailures], 'Pool startup and cleanup failed.');
		throw error;
	}

	/**
	 * Creates the acquisition context that carries ownership and cancellation through the bounded reusable-resource pool.
	 *
	 * Pool internals keep acquisition, validation, leases, draining, waiter wake-up, and reverse cleanup under one owner.
	 *
	 * @internal
	 */
	function acquisitionContext(ctx: Context): Readonly<{
		readonly ctx: Context;
		readonly timeout?: Temporal.Duration;
		readonly dispose: () => Promise<void>;
	}> {
		const borrowed = contextCore.child(ownerCtx, { id: ctx.id, signal: ctx.signal, deadline: ctx.deadline, clock: ctx.clock });
		if (acquireTimeout === undefined) {
			return Object.freeze({
				ctx: borrowed,
				/**
				 * Releases the borrowed acquisition context after the provider finishes acquisition.
				 *
				 * This path has no acquisition deadline, so it owns only the child context created
				 * for the provider call.
				 *
				 * @internal
				 */
				async dispose() {
					await borrowed[Symbol.asyncDispose]();
				},
			});
		}
		const timed = contextCore.deadline(borrowed, borrowed.clock.now().add(acquireTimeout));
		return Object.freeze({
			ctx: timed,
			timeout: acquireTimeout,
			/**
			 * Disposes owned state exactly once and releases all module-owned resources.
			 *
			 * @internal
			 */
			async dispose() {
				await timed[Symbol.asyncDispose]();
				await borrowed[Symbol.asyncDispose]();
			},
		});
	}

	/**
	 * Checks the acquisition before the bounded reusable-resource pool performs side effects.
	 *
	 * @internal
	 */
	function checkAcquisition(ctx: Context): void {
		if (ctx.signal.aborted) throw ctx.signal.reason ?? new contextCore.ContextCancelledError();
		contextCore.check(ctx);
	}

	/**
	 * Rejects invalid active before it can enter authoritative module state.
	 *
	 * @internal
	 */
	function assertActive(): void {
		if (state === 'active') return;
		throw new PoolUnavailableError(state, stopReason);
	}

	/**
	 * Converts the source value to tal owned expected by the bounded reusable-resource pool.
	 *
	 * @internal
	 */
	function totalOwned(): number {
		return idle.length + leased.size + creating;
	}

	/**
	 * Creates value while preserving the module's ownership rules.
	 *
	 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
	 *
	 * @internal
	 */
	async function createValue(ctx: Context): Promise<Value> {
		creating += 1;
		events.emit(Object.freeze({ type: 'creating' }));
		try {
			const value = await options.create(ctx);
			events.emit(Object.freeze({ type: 'created' }));
			return value;
		} finally {
			creating -= 1;
			resolveDrainIfComplete();
		}
	}

	/**
	 * Takes the healthy idle from the bounded reusable-resource pool without leaving it available to another owner.
	 *
	 * @internal
	 */
	async function takeHealthyIdle(): Promise<Value | undefined> {
		while (idle.length > 0) {
			const entry = idle.shift()!;
			if (await healthy(entry.value)) return entry.value;
			await closeValue(entry.value, 'Pool health check failed.');
		}
		return undefined;
	}

	/**
	 * Creates lease while preserving the module's ownership rules.
	 *
	 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
	 *
	 * @internal
	 */
	function createLease(value: Value): Lease<Value> {
		const acquiredAt = options.ctx.clock.now();
		const leaseState: LeaseState = { invalid: false, released: false };
		leased.set(value, leaseState);
		events.emit(Object.freeze({ type: 'acquired', acquiredAt: acquiredAt.toString() }));
		const lease: Lease<Value> = {
			value,
			acquiredAt,
			get invalid() { return leaseState.invalid; },
			/**
			 * Marks the current owned value invalid so the bounded reusable-resource pool cannot return it to reusable state.
			 *
			 * @internal
			 */
			invalidate(reason?: unknown) {
				if (leaseState.released || leaseState.invalid) return;
				leaseState.invalid = true;
				leaseState.reason = reason;
				events.emit(Object.freeze({ type: 'invalidated', ...(reason === undefined ? {} : { reason }) }));
			},
			/**
			 * Releases owned state and waits for cleanup completion when used with `await using`.
			 *
			 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
			 *
			 * @internal
			 */
			async [Symbol.asyncDispose]() {
				if (leaseState.released) return;
				leaseState.released = true;
				leased.delete(value);
				let reusable = false;
				let releaseFailed = false;
				let releaseFailure: unknown;
				try {
					reusable = !leaseState.invalid && state === 'active' && await healthy(value);
					if (reusable && idle.length < maximumIdle) idle.push({ value, returnedAt: options.ctx.clock.now() });
					else {
						reusable = false;
						await closeValue(value, leaseState.reason ?? stopReason);
					}
				} catch (error) {
					releaseFailed = true;
					releaseFailure = error;
					disposalFailures.push(error);
				} finally {
					events.emit(Object.freeze({ type: 'released', reusable }));
					wakeNextWaiter();
					resolveDrainIfComplete();
				}
				if (releaseFailed) throw releaseFailure;
			},
		};
		return Object.freeze(lease);
	}

	/**
	 * Checks whether the current value remains healthy enough for reuse by the bounded reusable-resource pool.
	 *
	 * @internal
	 */
	async function healthy(value: Value): Promise<boolean> {
		if (options.check === undefined) return true;
		try { return await options.check(value); }
		catch { return false; }
	}

	/**
	 * Closes value and waits for the cleanup that the current owner is responsible for.
	 *
	 * @internal
	 */
	async function closeValue(value: Value, reason?: unknown): Promise<void> {
		try { await options.close(value, reason); }
		finally { events.emit(Object.freeze({ type: 'closed-value', ...(reason === undefined ? {} : { reason }) })); }
	}

	/**
	 * Closes rejected value and waits for the cleanup that the current owner is responsible for.
	 *
	 * @internal
	 */
	async function closeRejectedValue(value: Value, primaryFailure: unknown): Promise<never> {
		try {
			await closeValue(value, primaryFailure);
		} catch (closeFailure) {
			throw new AggregateError([primaryFailure, closeFailure], 'Pool acquisition and cleanup failed.');
		}
		throw primaryFailure;
	}

	/**
	 * Propagates disposal failures through the controlled iterator path used by the bounded reusable-resource pool.
	 *
	 * @internal
	 */
	function throwDisposalFailures(): void {
		if (disposalFailures.length === 0) return;
		throw new AggregateError([...disposalFailures], 'One or more pooled values could not be closed.');
	}

	/**
	 * Removes expired idle while preserving the remaining module invariants.
	 *
	 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
	 *
	 * @internal
	 */
	async function removeExpiredIdle(): Promise<void> {
		if (maximumIdleAge === undefined || idle.length === 0) return;
		const now = options.ctx.clock.now();
		const retained: IdleValue<Value>[] = [];
		const expired: Value[] = [];
		for (const entry of idle) {
			const age = entry.returnedAt.until(now);
			if (Temporal.Duration.compare(age, maximumIdleAge) >= 0 && idle.length - expired.length > minimum) expired.push(entry.value);
			else retained.push(entry);
		}
		idle.splice(0, idle.length, ...retained);
		await Promise.allSettled(expired.map((value) => closeValue(value, 'Pool idle timeout elapsed.')));
	}

	/**
	 * Waits for for availability without transferring ownership to the waiter.
	 *
	 * It keeps one owner for reusable values and makes acquisition, draining, validation, and disposal order explicit.
	 *
	 * @internal
	 */
	function waitForAvailability(ctx: Context): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let waiter!: Waiter;
			const abort = () => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				reject(ctx.signal.reason ?? new contextCore.ContextCancelledError());
			};
			const unlink = () => ctx.signal.removeEventListener('abort', abort);
			waiter = { resolve, reject, unlink };
			if (ctx.signal.aborted) {
				reject(ctx.signal.reason ?? new contextCore.ContextCancelledError());
				return;
			}
			waiters.push(waiter);
			ctx.signal.addEventListener('abort', abort, { once: true });
		});
	}

	/**
	 * Wakes next waiter after a state change may allow the bounded reusable-resource pool to make progress.
	 *
	 * @internal
	 */
	function wakeNextWaiter(): void {
		while (waiters.length > 0) {
			const waiter = waiters.shift()!;
			waiter.unlink();
			waiter.resolve();
			return;
		}
	}

	/**
	 * Rejects waiters when the bounded reusable-resource pool can no longer satisfy their wait.
	 *
	 * @internal
	 */
	function rejectWaiters(reason: unknown): void {
		while (waiters.length > 0) {
			const waiter = waiters.shift()!;
			waiter.unlink();
			waiter.reject(reason);
		}
	}

	/**
	 * Resolves drain if complete from already validated module inputs.
	 *
	 * @internal
	 */
	function resolveDrainIfComplete(): void {
		if (state !== 'draining' || leased.size > 0 || creating > 0) return;
		resolveDrain?.();
		resolveDrain = undefined;
	}

	/**
	 * Calculates the snapshot stats snapshot reported by the bounded reusable-resource pool.
	 *
	 * @internal
	 */
	function snapshotStats(): Stats {
		return Object.freeze({ state, minimum, maximum, idle: idle.length, leased: leased.size, creating, waiting: waiters.length });
	}
}

/**
 * Validates positive integer before it is used by the bounded reusable-resource pool.
 *
 * @internal
 */
function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
	return value;
}

/**
 * Validates non negative integer before it is used by the bounded reusable-resource pool.
 *
 * @internal
 */
function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
	return value;
}

/**
 * Validates and normalizes positive duration for the timing rules used by the bounded reusable-resource pool.
 *
 * @internal
 */
function positiveDuration(value: Temporal.Duration | Temporal.DurationLike | string, label: string): Temporal.Duration {
	const duration = Temporal.Duration.from(value);
	if (compareDuration(duration, Temporal.Duration.from({})) <= 0) throw new TypeError(`${label} must be positive.`);
	return duration;
}

/**
 * Validates and normalizes non negative duration for the timing rules used by the bounded reusable-resource pool.
 *
 * @internal
 */
function nonNegativeDuration(value: Temporal.Duration | Temporal.DurationLike | string, label: string): Temporal.Duration {
	const duration = Temporal.Duration.from(value);
	if (compareDuration(duration, Temporal.Duration.from({})) < 0) throw new TypeError(`${label} must not be negative.`);
	return duration;
}

/**
 * Compares duration using the stable ordering required by the bounded reusable-resource pool.
 *
 * @internal
 */
function compareDuration(left: Temporal.Duration, right: Temporal.Duration): number {
	const relativeTo = Temporal.PlainDate.from('2000-01-01');
	return Math.sign(left.total({ unit: 'millisecond', relativeTo }) - right.total({ unit: 'millisecond', relativeTo }));
}

export type * from './types.ts';
