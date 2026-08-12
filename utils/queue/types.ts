import type { EventBus } from '@okikio/observables';
import type { Context } from '@utils/context';
import type { Encoded as EncodedFailure } from '@utils/failure';

/** Stable reference to one queue item. */
export interface Ref {
	readonly id: string;
}

/** Temporary durable ownership of one queue item. */
export interface Claim<Value> {
	readonly id: string;
	readonly itemId: string;
	readonly owner: string;
	readonly value: Value;
	readonly attempt: number;
	readonly claimedAt: Temporal.Instant;
	readonly expiresAt: Temporal.Instant;
}

/** Options used while adding one item. */
export interface AddOptions {
	readonly key?: string;
	readonly priority?: number;
	readonly availableAt?: Temporal.Instant;
}

/** Options used while claiming available items. */
export interface ClaimOptions {
	readonly owner?: string;
	readonly limit?: number;
	readonly duration?: Temporal.Duration | Temporal.DurationLike | string;
	readonly wait?: boolean;
}

/** Options used while releasing a claim for retry. */
export interface RetryOptions {
	readonly delay?: Temporal.Duration | Temporal.DurationLike | string;
	readonly availableAt?: Temporal.Instant;
	readonly priority?: number;
}

/** Authoritative queue event emitted after one committed state change. */
export type Event =
	| Readonly<{ readonly type: 'added'; readonly itemId: string; readonly key?: string }>
	| Readonly<{ readonly type: 'claimed'; readonly itemId: string; readonly claimId: string; readonly owner: string; readonly attempt: number }>
	| Readonly<{ readonly type: 'renewed'; readonly itemId: string; readonly claimId: string; readonly expiresAt: string }>
	| Readonly<{ readonly type: 'completed'; readonly itemId: string; readonly claimId: string }>
	| Readonly<{ readonly type: 'failed'; readonly itemId: string; readonly claimId: string; readonly failureId: string }>
	| Readonly<{ readonly type: 'retried'; readonly itemId: string; readonly claimId: string; readonly availableAt: string }>
	| Readonly<{ readonly type: 'cancelled'; readonly itemId: string }>
	| Readonly<{ readonly type: 'claim-expired'; readonly itemId: string; readonly claimId: string }>
	| Readonly<{ readonly type: 'closed' }>;

/** Current queue counters. */
export interface Stats {
	readonly queued: number;
	readonly claimed: number;
	readonly completed: number;
	readonly failed: number;
	readonly cancelled: number;
	readonly waitingClaims: number;
	readonly waitingResults: number;
}

/** At-least-once work transport with explicit claim ownership. */
export interface Queue<Input, Output> extends AsyncDisposable {
	readonly events: EventBus<Event>['events'];
	add(ctx: Context, input: Input, options?: AddOptions): Promise<Ref>;
	claim(ctx: Context, options?: ClaimOptions): Promise<readonly Claim<Input>[]>;
	complete(ctx: Context, claim: Claim<Input>, output: Output): Promise<void>;
	fail(ctx: Context, claim: Claim<Input>, value: EncodedFailure): Promise<void>;
	retry(ctx: Context, claim: Claim<Input>, options?: RetryOptions): Promise<void>;
	cancel(ctx: Context, ref: Ref, reason?: unknown): Promise<void>;
	result(ctx: Context, ref: Ref): Promise<Output>;
	renew(ctx: Context, claim: Claim<Input>, duration: Temporal.Duration | Temporal.DurationLike | string): Promise<Claim<Input>>;
	stats(): Stats;
	close(reason?: unknown): Promise<void>;
}

/** Inputs accepted by the memory queue. */
export interface MemoryOptions {
	readonly capacity?: number;
	readonly clock?: Context['clock'];
	readonly id?: () => string;
	readonly defaultClaimDuration?: Temporal.Duration | Temporal.DurationLike | string;
}
