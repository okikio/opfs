import type { EventBus } from '@okikio/observables';
import type { Context } from '@utils/context';

/** Pool lifecycle event emitted after one state transition. */
export type Event =
	| Readonly<{ readonly type: 'creating' }>
	| Readonly<{ readonly type: 'created' }>
	| Readonly<{ readonly type: 'acquired'; readonly acquiredAt: string }>
	| Readonly<{ readonly type: 'released'; readonly reusable: boolean }>
	| Readonly<{ readonly type: 'invalidated'; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'closed-value'; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'draining'; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'disposed' }>;

/** Current bounded-capacity counters. */
export interface Stats {
	readonly state: 'active' | 'draining' | 'disposed';
	readonly minimum: number;
	readonly maximum: number;
	readonly idle: number;
	readonly leased: number;
	readonly creating: number;
	readonly waiting: number;
}

/** Caller-owned borrow of one reusable value. */
export interface Lease<Value> extends AsyncDisposable {
	readonly value: Value;
	readonly acquiredAt: Temporal.Instant;
	readonly invalid: boolean;
	invalidate(reason?: unknown): void;
}

/** Bounded process-local owner of reusable values. */
export interface Pool<Value> extends AsyncDisposable {
	readonly events: EventBus<Event>['events'];
	acquire(ctx: Context): Promise<Lease<Value>>;
	stats(): Stats;
	/** Close idle values older than the configured maximum age while preserving the minimum. */
	maintain(): Promise<void>;
	drain(reason?: unknown): Promise<void>;
}

/** Inputs accepted while creating a pool. */
export interface CreateOptions<Value> {
	readonly ctx: Context;
	readonly minimum?: number;
	readonly maximum: number;
	readonly maximumIdle?: number;
	/** Maximum idle age enforced before reuse and by explicit maintenance. */
	readonly maximumIdleAge?: Temporal.Duration | Temporal.DurationLike | string;
	readonly acquireTimeout?: Temporal.Duration | Temporal.DurationLike | string;
	readonly create: (ctx: Context) => Value | Promise<Value>;
	readonly check?: (value: Value) => boolean | Promise<boolean>;
	readonly close: (value: Value, reason?: unknown) => void | Promise<void>;
}
