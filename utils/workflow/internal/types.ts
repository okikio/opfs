/**
 * Host-local iterator types used by the live workflow interpreter.
 *
 * These values never enter durable history. They may own callbacks, promises,
 * timers, or other live handles while one process is running.
 *
 * ```text
 * durable workflow instruction
 *          |
 *          v
 * live interpreter
 *          |
 *          v
 * Branch -> Step -> live handle
 *    |        |
 *    |        +--> discard(done) acknowledges release
 *    v
 *  Scope -> child branches + finalizers
 * ```
 */

/** Why one host-local branch stopped. */
export type Cause =
	| Readonly<{ readonly type: 'failure'; readonly failure: unknown }>
	| Readonly<{ readonly type: 'fault'; readonly fault: unknown }>
	| Readonly<{ readonly type: 'cancelled'; readonly reason: unknown }>
	| Readonly<{ readonly type: 'multiple'; readonly causes: readonly Cause[] }>;

/** Terminal result of one host-local branch. */
export type Exit<Value> =
	| Readonly<{ readonly type: 'success'; readonly value: Value }>
	| Readonly<{ readonly type: 'failure'; readonly cause: Cause }>;

/** Completes one Step exactly once. */
export type Resolve<Value> = (exit: Exit<Value>) => void;

/** Reports whether an active Step released the live state it owns successfully. */
export type DiscardDone = Resolve<void>;

/** Requests that an active Step stop and calls `done` after release completes. */
export type StepExit = (done: DiscardDone) => void;

/** Minimal branch state a Step may observe. */
export interface ChildHandle<Value> {
	cancel(reason: unknown): Promise<void>;
	settled(): Promise<void>;
	result(): Promise<Exit<Value>>;
}

/**
 * Narrow Step-facing view of the Branch that owns the current operation.
 *
 * A Step can observe cancellation, register cleanup, and spawn explicitly
 * supervised children. It cannot advance the generator or mutate branch state
 * directly, which keeps reducer transitions serialized.
 *
 * @internal
 */
export interface BranchView {
	readonly signal: AbortSignal;
	addFinalizer(finalizer: () => void | Promise<void>): () => void;
	spawn<Value>(operation: Operation<Value>, supervision: Supervision): ChildHandle<Value>;
}

/**
 * One cancellable host-local wait.
 *
 * `enter()` starts the wait and returns the exact discard function for that
 * wait. A branch never unwinds its generator until discard calls `done`.
 */
export interface Step<Value> {
	readonly name: string;
	enter(resolve: Resolve<Value>, branch: BranchView): StepExit;
}

/** Iterator program over host-local Steps. */
export interface Operation<Value> {
	[Symbol.iterator](): Generator<Step<unknown>, Value, Exit<unknown>>;
}

/** How a parent reacts when an owned child fails. */
export type Supervision = 'fail-fast' | 'collect' | 'isolate';

/**
 * Pull-based adapter over a synchronous iterator, asynchronous iterator, or
 * ReadableStream.
 *
 * The local iterator protocol reserves generator `yield` for control Steps.
 * Source values therefore remain behind an explicit `next()` operation instead
 * of being emitted through the same channel.
 *
 * ```text
 * host Operation
 *      |
 *      +-- yield* source.next() -> one source item
 *      |
 *      +-- yield* source.next() -> next source item
 *      |
 *      `-- Scope close ----------> source.close()
 * ```
 */
export interface PullSource<Value, Return = unknown> extends AsyncDisposable {
	next(): Operation<IteratorResult<Value, Return>>;
	close(reason?: unknown): Promise<void>;
}
