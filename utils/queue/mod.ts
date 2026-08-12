/**
 * Generic claimed-work queue contracts and a process-local implementation.
 *
 * Durable queue providers belong in concrete packages. The local queue keeps
 * the same claim, expiry, retry, result, and cancellation semantics.
 *
 * @module
 */
import { EventBus } from '@okikio/observables';
import * as contextCore from '@utils/context';
import type { Context } from '@utils/context';
import type { Encoded as EncodedFailure } from '@utils/failure';

import type {
	AddOptions,
	Claim,
	ClaimOptions,
	Event,
	MemoryOptions,
	Queue,
	Ref,
	RetryOptions,
	Stats,
} from './types.ts';

/** Operation attempted after a queue stopped accepting work. */
export class QueueClosedError extends Error {
	readonly reason: unknown;

	constructor(reason?: unknown) {
		super('Queue is closed.', reason === undefined ? undefined : { cause: reason });
		this.name = 'QueueClosedError';
		this.reason = reason;
	}
}

/** Queue active-item capacity was exhausted. */
export class QueueCapacityError extends Error {
	readonly capacity: number;

	constructor(capacity: number) {
		super(`Queue reached its active-item capacity of ${capacity}.`);
		this.name = 'QueueCapacityError';
		this.capacity = capacity;
	}
}

/** A queue reference does not identify a known item. */
export class QueueItemNotFoundError extends Error {
	readonly itemId: string;

	constructor(itemId: string) {
		super(`Queue item ${JSON.stringify(itemId)} was not found.`);
		this.name = 'QueueItemNotFoundError';
		this.itemId = itemId;
	}
}

/** A queue claim no longer owns the referenced item. */
export class StaleClaimError extends Error {
	readonly itemId: string;
	readonly claimId: string;

	constructor(itemId: string, claimId: string) {
		super(`Queue claim ${JSON.stringify(claimId)} no longer owns item ${JSON.stringify(itemId)}.`);
		this.name = 'StaleClaimError';
		this.itemId = itemId;
		this.claimId = claimId;
	}
}

/** Result wait failed because the queue item reached a failed state. */
export class QueueItemFailedError extends Error {
	readonly itemId: string;
	readonly failure: EncodedFailure;

	constructor(itemId: string, failure: EncodedFailure) {
		super(`Queue item ${JSON.stringify(itemId)} failed: ${failure.message}`);
		this.name = 'QueueItemFailedError';
		this.itemId = itemId;
		this.failure = failure;
	}
}

/** Result wait failed because the queue item was cancelled. */
export class QueueItemCancelledError extends Error {
	readonly itemId: string;
	readonly reason: unknown;

	constructor(itemId: string, reason?: unknown) {
		super(`Queue item ${JSON.stringify(itemId)} was cancelled.`, reason === undefined ? undefined : { cause: reason });
		this.name = 'QueueItemCancelledError';
		this.itemId = itemId;
		this.reason = reason;
	}
}

type ItemState = 'queued' | 'claimed' | 'completed' | 'failed' | 'cancelled';

interface Item<Input, Output> {
	readonly id: string;
	readonly key?: string;
	readonly input: Input;
	readonly order: number;
	state: ItemState;
	priority: number;
	availableAt: Temporal.Instant;
	attempt: number;
	claim?: Claim<Input>;
	output?: Output;
	failure?: EncodedFailure;
	cancellation?: unknown;
}

interface Waiter {
	readonly resolve: () => void;
	readonly reject: (reason: unknown) => void;
	readonly unlink: () => void;
}

/**
 * Create a process-local queue that implements the same ownership contract as durable adapters.
 *
 * ```text
 * add(input)
 *    |
 *    v
 * ready --claim(owner, lease)--> claimed
 *   ^                              |
 *   |                              +-- complete(output) --> completed
 *   |                              +-- fail(failure) -----> failed
 *   |                              +-- cancel(reason) ----> cancelled
 *   `---------- retry(delay) <-----+
 *
 * expired claim -> ready for a new owner
 * stale owner   -> completion is rejected
 * ```
 *
 * The memory implementation is process-local, but it deliberately preserves
 * claim identity, expiry, and stale-owner rules required by durable adapters.
 */
export function memory<Input, Output>(options: MemoryOptions = {}): Queue<Input, Output> {
	const capacity = options.capacity === undefined ? Number.POSITIVE_INFINITY : positiveInteger(options.capacity, 'queue capacity');
	const clock = options.clock ?? contextCore.SystemClock;
	const createId = options.id ?? defaultId;
	const defaultClaimDuration = positiveDuration(options.defaultClaimDuration ?? { seconds: 30 }, 'default claim duration');
	const events = new EventBus<Event>();
	const items = new Map<string, Item<Input, Output>>();
	const itemIdsByKey = new Map<string, string>();
	const claimWaiters = new Set<Waiter>();
	const resultWaiters = new Map<string, Set<Waiter>>();
	let order = 0;
	let closed = false;
	let closeReason: unknown;

	const queue: Queue<Input, Output> = Object.freeze({
		events: events.events,
		/**
		 * Adds state through the ownership rules of the claimed-work queue.
		 *
		 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
		 *
		 * @internal
		 */
		async add(ctx: Context, input: Input, addOptions: AddOptions = {}) {
			contextCore.check(ctx);
			assertOpen();
			if (addOptions.key !== undefined) {
				assertKey(addOptions.key);
				const existingId = itemIdsByKey.get(addOptions.key);
				if (existingId !== undefined) return Object.freeze({ id: existingId });
			}
			if (activeCount() >= capacity) throw new QueueCapacityError(capacity);
			const id = uniqueId(createId, items);
			const item: Item<Input, Output> = {
				id,
				...(addOptions.key === undefined ? {} : { key: addOptions.key }),
				input,
				order: order++,
				state: 'queued',
				priority: integer(addOptions.priority ?? 0, 'queue priority'),
				availableAt: addOptions.availableAt ?? clock.now(),
				attempt: 0,
			};
			items.set(id, item);
			if (item.key !== undefined) itemIdsByKey.set(item.key, id);
			events.emit(Object.freeze({ type: 'added', itemId: id, ...(item.key === undefined ? {} : { key: item.key }) }));
			wakeClaimWaiters();
			return Object.freeze({ id });
		},
		/**
		 * Claims the highest-priority eligible queue item and records a lease token that later commits must still own.
		 *
		 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
		 *
		 * @internal
		 */
		async claim(ctx: Context, claimOptions: ClaimOptions = {}) {
			const owner = claimOptions.owner ?? ctx.id;
			assertOwner(owner);
			const limit = positiveInteger(claimOptions.limit ?? 1, 'claim limit');
			const duration = positiveDuration(claimOptions.duration ?? defaultClaimDuration, 'claim duration');
			while (true) {
				contextCore.check(ctx);
				assertOpen();
				expireClaims();
				const now = clock.now();
				const available = [...items.values()]
					.filter((item) => item.state === 'queued' && Temporal.Instant.compare(item.availableAt, now) <= 0)
					.sort(compareItems)
					.slice(0, limit);
				if (available.length > 0) {
					return Object.freeze(available.map((item) => claimItem(item, owner, duration)));
				}
				if (claimOptions.wait !== true) return Object.freeze([]);
				const wakeAt = nextClaimWakeAt();
				await waitForChange(ctx, claimWaiters, wakeAt === undefined ? undefined : millisecondsUntil(wakeAt, clock.now()));
			}
		},
		/**
		 * Commits a claimed item result only when the supplied claim still owns that item.
		 *
		 * @internal
		 */
		async complete(ctx: Context, claim: Claim<Input>, output: Output) {
			contextCore.check(ctx);
			const item = currentClaim(claim);
			item.state = 'completed';
			item.output = output;
			item.claim = undefined;
			events.emit(Object.freeze({ type: 'completed', itemId: item.id, claimId: claim.id }));
			settleResultWaiters(item);
			wakeClaimWaiters();
		},
		/**
		 * Commits a declared failure only for the current claim so a stale consumer cannot overwrite newer work.
		 *
		 * @internal
		 */
		async fail(ctx: Context, claim: Claim<Input>, failure: EncodedFailure) {
			contextCore.check(ctx);
			const item = currentClaim(claim);
			item.state = 'failed';
			item.failure = Object.freeze({ ...failure });
			item.claim = undefined;
			events.emit(Object.freeze({ type: 'failed', itemId: item.id, claimId: claim.id, failureId: failure.id }));
			settleResultWaiters(item);
			wakeClaimWaiters();
		},
		/**
		 * Returns a claimed item to the queue with the next availability time while preserving its attempt history.
		 *
		 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
		 *
		 * @internal
		 */
		async retry(ctx: Context, claim: Claim<Input>, retryOptions: RetryOptions = {}) {
			contextCore.check(ctx);
			if (retryOptions.availableAt !== undefined && retryOptions.delay !== undefined) {
				throw new TypeError('Queue retry accepts either availableAt or delay, not both.');
			}
			const item = currentClaim(claim);
			const now = clock.now();
			const delay = nonNegativeDuration(retryOptions.delay ?? {}, 'retry delay');
			item.state = 'queued';
			item.claim = undefined;
			item.availableAt = retryOptions.availableAt ?? now.add(delay);
			if (retryOptions.priority !== undefined) item.priority = integer(retryOptions.priority, 'queue priority');
			events.emit(Object.freeze({ type: 'retried', itemId: item.id, claimId: claim.id, availableAt: item.availableAt.toString() }));
			wakeClaimWaiters();
		},
		/**
		 * Moves a non-terminal queue item to cancelled state and wakes claim and result waiters.
		 *
		 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
		 *
		 * @internal
		 */
		async cancel(ctx: Context, ref: Ref, reason?: unknown) {
			contextCore.check(ctx);
			const item = getItem(ref.id);
			if (item.state === 'cancelled') return;
			if (item.state === 'completed' || item.state === 'failed') return;
			item.state = 'cancelled';
			item.claim = undefined;
			item.cancellation = reason;
			events.emit(Object.freeze({ type: 'cancelled', itemId: item.id }));
			settleResultWaiters(item);
			wakeClaimWaiters();
		},
		/**
		 * Waits for one queue item to become terminal without taking ownership of the item or its claim.
		 *
		 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
		 *
		 * @internal
		 */
		async result(ctx: Context, ref: Ref) {
			while (true) {
				contextCore.check(ctx);
				const item = getItem(ref.id);
				if (item.state === 'completed') return item.output as Output;
				if (item.state === 'failed') throw new QueueItemFailedError(item.id, item.failure!);
				if (item.state === 'cancelled') throw new QueueItemCancelledError(item.id, item.cancellation);
				if (closed) throw new QueueClosedError(closeReason);
				let waiters = resultWaiters.get(item.id);
				if (waiters === undefined) {
					waiters = new Set();
					resultWaiters.set(item.id, waiters);
				}
				await waitForChange(ctx, waiters);
			}
		},
		/**
		 * Extends the current claim expiry only when the caller still owns that claim.
		 *
		 * @internal
		 */
		async renew(ctx: Context, claim: Claim<Input>, duration: Temporal.Duration | Temporal.DurationLike | string) {
			contextCore.check(ctx);
			const item = currentClaim(claim);
			const renewed = Object.freeze({ ...claim, expiresAt: clock.now().add(positiveDuration(duration, 'claim renewal duration')) });
			item.claim = renewed;
			events.emit(Object.freeze({ type: 'renewed', itemId: item.id, claimId: claim.id, expiresAt: renewed.expiresAt.toString() }));
			return renewed;
		},
		/**
		 * Returns a snapshot of queue state counts without exposing mutable item records.
		 *
		 * @internal
		 */
		stats() {
			expireClaims();
			const counts: Record<ItemState, number> = { queued: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
			for (const item of items.values()) counts[item.state] += 1;
			return Object.freeze({
				...counts,
				waitingClaims: claimWaiters.size,
				waitingResults: [...resultWaiters.values()].reduce((total, waiters) => total + waiters.size, 0),
			});
		},
		/**
		 * Closes owned state and waits for the cleanup that the current owner is responsible for.
		 *
		 * @internal
		 */
		async close(reason?: unknown) {
			if (closed) return;
			closed = true;
			closeReason = reason;
			const error = new QueueClosedError(reason);
			rejectWaiters(claimWaiters, error);
			for (const waiters of resultWaiters.values()) rejectWaiters(waiters, error);
			resultWaiters.clear();
			events.emit(Object.freeze({ type: 'closed' }));
			events[Symbol.dispose]();
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			await queue.close('Queue was disposed.');
		},
	});
	return queue;

	/**
	 * Rejects invalid open before it can enter authoritative module state.
	 *
	 * @internal
	 */
	function assertOpen(): void {
		if (closed) throw new QueueClosedError(closeReason);
	}

	/**
	 * Counts queued and claimed items that still consume queue capacity.
	 *
	 * @internal
	 */
	function activeCount(): number {
		let count = 0;
		for (const item of items.values()) if (item.state === 'queued' || item.state === 'claimed') count += 1;
		return count;
	}

	/**
	 * Gets the authoritative item record for a queue reference or fails when the reference is unknown.
	 *
	 * @internal
	 */
	function getItem(id: string): Item<Input, Output> {
		const item = items.get(id);
		if (item === undefined) throw new QueueItemNotFoundError(id);
		return item;
	}

	/**
	 * Requires the claim token that currently owns an item before a mutating claim operation proceeds.
	 *
	 * @internal
	 */
	function currentClaim(claim: Claim<Input>): Item<Input, Output> {
		expireClaims();
		const item = getItem(claim.itemId);
		if (item.state !== 'claimed' || item.claim?.id !== claim.id || item.claim.owner !== claim.owner) {
			throw new StaleClaimError(claim.itemId, claim.id);
		}
		return item;
	}

	/**
	 * Transitions one eligible item to claimed state and creates its new claim identity and expiry.
	 *
	 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
	 *
	 * @internal
	 */
	function claimItem(item: Item<Input, Output>, owner: string, duration: Temporal.Duration): Claim<Input> {
		const claimedAt = clock.now();
		const claim = Object.freeze({
			id: uniqueClaimId(createId, items),
			itemId: item.id,
			owner,
			value: item.input,
			attempt: item.attempt + 1,
			claimedAt,
			expiresAt: claimedAt.add(duration),
		});
		item.state = 'claimed';
		item.attempt = claim.attempt;
		item.claim = claim;
		events.emit(Object.freeze({ type: 'claimed', itemId: item.id, claimId: claim.id, owner, attempt: claim.attempt }));
		return claim;
	}

	/**
	 * Returns expired claims to queued state before new claims or statistics observe queue ownership.
	 *
	 * Queue internals preserve claim identity, expiry, retry, cancellation, and stale-owner rejection so at-least-once delivery remains safe.
	 *
	 * @internal
	 */
	function expireClaims(): void {
		const now = clock.now();
		for (const item of items.values()) {
			if (item.state !== 'claimed' || item.claim === undefined) continue;
			if (Temporal.Instant.compare(item.claim.expiresAt, now) > 0) continue;
			const expired = item.claim;
			item.state = 'queued';
			item.claim = undefined;
			item.availableAt = now;
			events.emit(Object.freeze({ type: 'claim-expired', itemId: item.id, claimId: expired.id }));
		}
	}

	/**
	 * Advances to claim wake at without crossing ownership between independent consumers of the claimed-work queue.
	 *
	 * @internal
	 */
	function nextClaimWakeAt(): Temporal.Instant | undefined {
		let next: Temporal.Instant | undefined;
		for (const item of items.values()) {
			const candidate = item.state === 'queued' ? item.availableAt : item.state === 'claimed' ? item.claim?.expiresAt : undefined;
			if (candidate !== undefined && (next === undefined || Temporal.Instant.compare(candidate, next) < 0)) next = candidate;
		}
		return next;
	}

	/**
	 * Wakes result waiters after an item reaches a terminal state.
	 *
	 * @internal
	 */
	function settleResultWaiters(item: Item<Input, Output>): void {
		const waiters = resultWaiters.get(item.id);
		if (waiters === undefined) return;
		resultWaiters.delete(item.id);
		for (const waiter of waiters) {
			waiter.unlink();
			waiter.resolve();
		}
	}

	/**
	 * Wakes blocked claimers after queue state changes may have made work eligible.
	 *
	 * @internal
	 */
	function wakeClaimWaiters(): void {
		for (const waiter of claimWaiters) {
			claimWaiters.delete(waiter);
			waiter.unlink();
			waiter.resolve();
		}
	}
}

/**
 * Waits for for change without transferring ownership to the waiter.
 *
 * It preserves at-least-once claim identity and prevents stale consumers from committing work after ownership changes.
 *
 * @internal
 */
function waitForChange(ctx: contextCore.Context, waiters: Set<Waiter>, delayMilliseconds?: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let waiter!: Waiter;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unlink = () => {
			ctx.signal.removeEventListener('abort', abort);
			if (timer !== undefined) clearTimeout(timer);
		};
		const settle = (action: () => void) => {
			if (!waiters.delete(waiter)) return;
			unlink();
			action();
		};
		const abort = () => settle(() => reject(ctx.signal.reason ?? new contextCore.ContextCancelledError()));
		waiter = { resolve, reject, unlink };
		if (ctx.signal.aborted) {
			reject(ctx.signal.reason ?? new contextCore.ContextCancelledError());
			return;
		}
		waiters.add(waiter);
		ctx.signal.addEventListener('abort', abort, { once: true });
		if (delayMilliseconds !== undefined) timer = setTimeout(() => settle(resolve), Math.max(0, delayMilliseconds));
	});
}

/**
 * Rejects waiters when the claimed-work queue can no longer satisfy their wait.
 *
 * @internal
 */
function rejectWaiters(waiters: Set<Waiter>, reason: unknown): void {
	for (const waiter of waiters) {
		waiters.delete(waiter);
		waiter.unlink();
		waiter.reject(reason);
	}
}

/**
 * Orders eligible items by priority, availability, and insertion order for deterministic claims.
 *
 * @internal
 */
function compareItems<Input, Output>(left: Item<Input, Output>, right: Item<Input, Output>): number {
	return right.priority - left.priority || left.order - right.order;
}

/**
 * Creates the fallback id used when the claimed-work queue receives no explicit value.
 *
 * @internal
 */
function defaultId(): string {
	return crypto.randomUUID();
}

/**
 * Generates the unique id without colliding with identities already owned by the claimed-work queue.
 *
 * @internal
 */
function uniqueId<Input, Output>(createId: () => string, items: ReadonlyMap<string, Item<Input, Output>>): string {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = createId();
		assertKey(id);
		if (!items.has(id)) return id;
	}
	throw new Error('Queue ID source produced too many collisions.');
}

/**
 * Generates the unique claim id without colliding with identities already owned by the claimed-work queue.
 *
 * @internal
 */
function uniqueClaimId<Input, Output>(createId: () => string, items: ReadonlyMap<string, Item<Input, Output>>): string {
	const active = new Set([...items.values()].flatMap((item) => item.claim === undefined ? [] : [item.claim.id]));
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const id = createId();
		assertKey(id);
		if (!active.has(id)) return id;
	}
	throw new Error('Queue claim ID source produced too many collisions.');
}

/**
 * Rejects invalid owner before it can enter authoritative module state.
 *
 * @internal
 */
function assertOwner(value: string): void {
	if (value.trim().length === 0) throw new TypeError('Queue claim owner must not be empty.');
}

/**
 * Rejects invalid key before it can enter authoritative module state.
 *
 * @internal
 */
function assertKey(value: string): void {
	if (value.trim().length === 0) throw new TypeError('Queue keys and identifiers must not be empty.');
	if (value.length > 512) throw new TypeError('Queue keys and identifiers must not exceed 512 characters.');
}

/**
 * Validates positive integer before it is used by the claimed-work queue.
 *
 * @internal
 */
function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
	return value;
}

/**
 * Validates integer before it is used by the claimed-work queue.
 *
 * @internal
 */
function integer(value: number, label: string): number {
	if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`);
	return value;
}

/**
 * Validates and normalizes positive duration for the timing rules used by the claimed-work queue.
 *
 * @internal
 */
function positiveDuration(value: Temporal.Duration | Temporal.DurationLike | string, label: string): Temporal.Duration {
	const duration = Temporal.Duration.from(value);
	if (durationMilliseconds(duration) <= 0) throw new TypeError(`${label} must be positive.`);
	return duration;
}

/**
 * Validates and normalizes non negative duration for the timing rules used by the claimed-work queue.
 *
 * @internal
 */
function nonNegativeDuration(value: Temporal.Duration | Temporal.DurationLike | string, label: string): Temporal.Duration {
	const duration = Temporal.Duration.from(value);
	if (durationMilliseconds(duration) < 0) throw new TypeError(`${label} must not be negative.`);
	return duration;
}

/**
 * Converts duration into the millisecond value used by the claimed-work queue.
 *
 * @internal
 */
function durationMilliseconds(value: Temporal.Duration): number {
	return value.total({ unit: 'millisecond', relativeTo: Temporal.PlainDate.from('2000-01-01') });
}

/**
 * Calculates the milliseconds until value used by timers and deadlines in the claimed-work queue.
 *
 * @internal
 */
function millisecondsUntil(instant: Temporal.Instant, now: Temporal.Instant): number {
	return Math.max(0, Math.min(instant.epochMilliseconds - now.epochMilliseconds, 2_147_483_647));
}

export type * from './types.ts';
