/** Provider-neutral clock used by requests, activities, workflows, and tests. */
export interface Clock {
	/** Return the current absolute instant. */
	now(): Temporal.Instant;
}

/**
 * Serializable identity and timing data for one operation context.
 *
 * A snapshot can cross a queue, process, or Worker message. Cancellation does
 * not cross with it. The receiving host creates a new local `AbortSignal`.
 */
export interface Snapshot {
	/** Stable identity of the operation represented by this context. */
	readonly id: string;
	readonly traceId?: string;
	readonly deploymentId?: string;
	readonly idempotencyKey?: string;
	readonly startedAt: string;
	readonly deadline?: string;
}

/**
 * Cancellation, deadline, identity, and clock carried through one operation.
 *
 * `id` names the current operation. The caller decides what the operation is,
 * such as an HTTP request, activity job, queue claim, workflow run, or process
 * command. Protocol-specific code can keep a more specific name such as
 * `requestId` and copy that value into `id` when it creates the context.
 */
export interface Context {
	/** Stable identity of the operation represented by this context. */
	readonly id: string;
	readonly traceId?: string;
	readonly deploymentId?: string;
	readonly idempotencyKey?: string;
	readonly startedAt: Temporal.Instant;
	readonly deadline?: Temporal.Instant;
	readonly signal: AbortSignal;
	readonly clock: Clock;
}

/** Independently owned context with deterministic cancellation and timer cleanup. */
export interface Owned extends Context, Disposable, AsyncDisposable {
	/** Resolves after the context has been disposed. */
	readonly closed: Promise<void>;
}

/** Inputs accepted while creating one owned operation context. */
export interface CreateOptions {
	/** Stable identity of the operation represented by the new context. */
	readonly id: string;
	readonly traceId?: string;
	readonly deploymentId?: string;
	readonly idempotencyKey?: string;
	readonly startedAt?: Temporal.Instant;
	readonly deadline?: Temporal.Instant;
	readonly signal?: AbortSignal;
	readonly clock?: Clock;
}


/** Inputs accepted while deriving a child context. */
export interface ChildOptions extends Partial<Omit<CreateOptions, 'startedAt'>> {
	/** Override the inherited operation identity for a new nested operation. */
	readonly id?: string;
}

/** Inputs accepted while restoring a serializable snapshot. */
export interface RestoreOptions {
	readonly signal?: AbortSignal;
	readonly clock?: Clock;
}
