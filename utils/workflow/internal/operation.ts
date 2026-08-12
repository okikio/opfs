import type { BranchView, Cause, ChildHandle, Exit, Operation, PullSource, Resolve, Step, StepExit, Supervision } from './types.ts';

/**
 * Owns the internal cause error state used by the host-local structured-concurrency kernel.
 *
 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
 *
 * @internal
 */
class CauseError extends Error {
	readonly cause_: Cause;

	constructor(cause: Cause) {
		super('Host-local operation failed.');
		this.cause_ = cause;
	}
}

/** Create an operation that returns an already available value. */
export function value<Value>(result: Value): Operation<Value> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, Value, Exit<unknown>> { return result; },
	});
}

/**
 * Adapt one AbortSignal-aware Promise producer into an owned Step.
 *
 * Cancellation does not pretend to force-stop an arbitrary Promise. The branch
 * aborts its signal, calls the Step discard function, and waits until the
 * producer settles before unwind can continue.
 */
export function wait<Value>(name: string, producer: (signal: AbortSignal) => Promise<Value>): Operation<Value> {
	if (name.trim().length === 0) throw new TypeError('Host-local wait name must not be empty.');
	return stepOperation<Value>(Object.freeze({
		name,
		/**
		 * Enters the operation and returns the cleanup/discard path owned by the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		enter(resolve: Resolve<Value>, branch: BranchView): StepExit {
			let settled = false;
			let discardDone: Resolve<void> | undefined;
			const settleDiscard = (): void => {
				if (discardDone === undefined) return;
				const done = discardDone;
				discardDone = undefined;
				done(Object.freeze({ type: 'success', value: undefined }));
			};
			void producer(branch.signal).then(
				(value) => {
					if (!settled) {
						settled = true;
						resolve(Object.freeze({ type: 'success', value }));
					}
					settleDiscard();
				},
				(failure) => {
					if (!settled) {
						settled = true;
						const cause: Cause = Object.freeze({ type: 'failure', failure });
						resolve(Object.freeze({ type: 'failure', cause }));
					}
					settleDiscard();
				},
			);
			return (done) => {
				if (settled) done(Object.freeze({ type: 'success', value: undefined }));
				else discardDone = done;
			};
		},
	}));
}

/** Adapt a callback source with an explicit discard operation. */
export function action<Value>(
	name: string,
	start: (resolve: (value: Value) => void, reject: (failure: unknown) => void, signal: AbortSignal) => void | (() => void | Promise<void>),
): Operation<Value> {
	if (name.trim().length === 0) throw new TypeError('Host-local action name must not be empty.');
	return stepOperation<Value>(Object.freeze({
		name,
		/**
		 * Enters the operation and returns the cleanup/discard path owned by the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		enter(resolve: Resolve<Value>, branch: BranchView): StepExit {
			let settled = false;
			const finish = (exit: Exit<Value>): void => {
				if (settled) return;
				settled = true;
				resolve(exit);
			};
			const discard = start(
				(value) => finish(Object.freeze({ type: 'success', value })),
				(failure) => {
					const cause: Cause = Object.freeze({ type: 'failure', failure });
					finish(Object.freeze({ type: 'failure', cause }));
				},
				branch.signal,
			);
			return (done) => {
				if (discard === undefined) return done(Object.freeze({ type: 'success', value: undefined }));
				let released: void | Promise<void>;
				try { released = discard(); }
				catch (failure) {
					const cause: Cause = Object.freeze({ type: 'failure', failure });
					done(Object.freeze({ type: 'failure', cause }));
					return;
				}
				void Promise.resolve(released).then(
					() => done(Object.freeze({ type: 'success', value: undefined })),
					(failure) => done(Object.freeze({ type: 'failure', cause: Object.freeze({ type: 'failure', failure }) })),
				);
			};
		},
	}));
}

/** Register asynchronous cleanup on the current branch Scope. */
export function ensure(finalizer: () => void | Promise<void>): Operation<() => void> {
	return stepOperation(Object.freeze({
		name: 'register finalizer',
		/**
		 * Enters the operation and returns the cleanup/discard path owned by the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		enter(resolve: Resolve<() => void>, branch: BranchView): StepExit {
			const remove = branch.addFinalizer(finalizer);
			resolve(Object.freeze({ type: 'success', value: remove }));
			return (done) => done(Object.freeze({ type: 'success', value: undefined }));
		},
	}));
}

/** Spawn one owned child branch without exposing it outside the local kernel. */
export function spawn<Value>(child: Operation<Value>, supervision: Supervision): Operation<ChildHandle<Value>> {
	return stepOperation(Object.freeze({
		name: 'spawn child branch',
		/**
		 * Enters the operation and returns the cleanup/discard path owned by the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		enter(resolve: Resolve<ChildHandle<Value>>, branch: BranchView): StepExit {
			const handle = branch.spawn(child, supervision);
			resolve(Object.freeze({ type: 'success', value: handle }));
			return (done) => done(Object.freeze({ type: 'success', value: undefined }));
		},
	}));
}

/** Run one child in an owned child Scope and return only after it is terminal. */
export function scoped<Value>(child: Operation<Value>): Operation<Value> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, Value, Exit<unknown>> {
			const handle = yield* spawn(child, 'isolate')[Symbol.iterator]();
			const exit = yield* wait('join scoped child', async () => await handle.result())[Symbol.iterator]();
			if (exit.type === 'success') return exit.value;
			throw new CauseError(exit.cause);
		},
	});
}

/**
 * Run owned children fail-fast and preserve input order.
 *
 * The first failed child stops admission, cancels every unfinished sibling, and
 * waits for those siblings before the failure reaches the caller. Promise.race
 * observes child terminal promises only; Branch and Scope retain ownership.
 */
export function all<const Values extends readonly Operation<unknown>[]>(operations: Values): Operation<{ readonly [Key in keyof Values]: OperationValue<Values[Key]> }> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, { readonly [Key in keyof Values]: OperationValue<Values[Key]> }, Exit<unknown>> {
			const handles: ChildHandle<unknown>[] = [];
			for (const child of operations) handles.push(yield* spawn(child, 'isolate')[Symbol.iterator]());
			const exits = new Array<Exit<unknown>>(handles.length);
			const pending = new Set(handles.map((_handle, index) => index));
			while (pending.size > 0) {
				const next = yield* wait('wait for next child', async () => await Promise.race(
					[...pending].map(async (index) => ({ index, exit: await handles[index]!.result() })),
				))[Symbol.iterator]();
				exits[next.index] = next.exit;
				pending.delete(next.index);
				if (next.exit.type !== 'failure') continue;
				const primaryCause = next.exit.cause;

				const cancellations = [...pending].map((index) => handles[index]!.cancel(primaryCause));
				yield* wait('cancel failed siblings', async () => await Promise.all(cancellations).then(() => undefined))[Symbol.iterator]();
				const terminal = yield* wait('join failed siblings', async () => await Promise.all(handles.map((handle) => handle.result())))[Symbol.iterator]();
				const cleanupCauses = terminal
					.filter((_exit, index) => index !== next.index)
					.filter((exit): exit is Extract<Exit<unknown>, { readonly type: 'failure' }> => exit.type === 'failure')
					.map((exit) => exit.cause)
					.filter((cause) => cause.type !== 'cancelled');
				const causes = cleanupCauses.length === 0 ? [primaryCause] : [primaryCause, ...cleanupCauses];
				throw new CauseError(causes.length === 1 ? causes[0]! : Object.freeze({ type: 'multiple', causes: Object.freeze(causes) }));
			}
			return exits.map((exit) => (exit as Extract<Exit<unknown>, { readonly type: 'success' }>).value) as { readonly [Key in keyof Values]: OperationValue<Values[Key]> };
		},
	});
}

/** Run owned children without sibling cancellation and return every Exit. */
export function allSettled<const Values extends readonly Operation<unknown>[]>(operations: Values): Operation<{ readonly [Key in keyof Values]: Exit<OperationValue<Values[Key]>> }> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, { readonly [Key in keyof Values]: Exit<OperationValue<Values[Key]>> }, Exit<unknown>> {
			const handles: ChildHandle<unknown>[] = [];
			for (const child of operations) handles.push(yield* spawn(child, 'collect')[Symbol.iterator]());
			return (yield* wait('join all settled children', async () => await Promise.all(handles.map((handle) => handle.result())))[Symbol.iterator]()) as {
				readonly [Key in keyof Values]: Exit<OperationValue<Values[Key]>>;
			};
		},
	});
}

/**
 * Return the first terminal owned child after every loser has stopped.
 *
 * Promise.race is only an observer over child `result()` promises. It does not
 * own or cancel those branches. The explicit cancellation and join phase keeps
 * the structured-concurrency guarantee intact.
 */
export function race<const Values extends readonly Operation<unknown>[]>(operations: Values): Operation<OperationValue<Values[number]>> {
	if (operations.length === 0) throw new TypeError('Host-local race requires at least one operation.');
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, OperationValue<Values[number]>, Exit<unknown>> {
			const handles: ChildHandle<unknown>[] = [];
			for (const child of operations) handles.push(yield* spawn(child, 'isolate')[Symbol.iterator]());
			const first = yield* wait('wait for first child', async () => await Promise.race(
				handles.map(async (handle, index) => ({ index, exit: await handle.result() })),
			))[Symbol.iterator]();
			const cancellations = handles.map((handle, index) => index === first.index ? Promise.resolve() : handle.cancel(first.exit));
			yield* wait('cancel race losers', async () => await Promise.all(cancellations).then(() => undefined))[Symbol.iterator]();
			const settled = yield* wait('join race children', async () => await Promise.all(handles.map((handle) => handle.result())))[Symbol.iterator]();
			const cleanupCauses = settled
				.filter((_exit, index) => index !== first.index)
				.filter((exit): exit is Extract<Exit<unknown>, { readonly type: 'failure' }> => exit.type === 'failure')
				.map((exit) => exit.cause)
				.filter((cause) => cause.type !== 'cancelled');
			if (first.exit.type === 'failure') {
				const causes = cleanupCauses.length === 0 ? [first.exit.cause] : [first.exit.cause, ...cleanupCauses];
				throw new CauseError(causes.length === 1 ? causes[0]! : Object.freeze({ type: 'multiple', causes: Object.freeze(causes) }));
			}
			if (cleanupCauses.length > 0) throw new CauseError(Object.freeze({ type: 'multiple', causes: Object.freeze(cleanupCauses) }));
			return first.exit.value as OperationValue<Values[number]>;
		},
	});
}

/**
 * Adapt a synchronous iterator without materializing its values.
 *
 * The returned source is owned by the current branch Scope. Each call to
 * `next()` is one local operation. Scope closure invokes `iterator.return()` at
 * most once when the source did not finish normally.
 */
export function fromIterator<Value, Return = unknown>(iterator: Iterator<Value, Return>): Operation<PullSource<Value, Return>> {
	return sourceOperation(iterator, 'iterator');
}

/**
 * Adapt an asynchronous iterator without cross-feeding values between branches.
 *
 * Cancellation calls `return()` and waits for it before branch unwind.
 */
export function fromAsyncIterator<Value, Return = unknown>(iterator: AsyncIterator<Value, Return>): Operation<PullSource<Value, Return>> {
	return sourceOperation(iterator, 'async iterator');
}

/**
 * Adapt a WHATWG ReadableStream into a pull source with exact reader ownership.
 *
 * A read error cancels the reader before surfacing the failure. Normal stream
 * completion releases the reader lock. Branch cancellation cancels the reader
 * and waits for `releaseLock()` before unwind.
 */
export function fromReadableStream<Value>(stream: ReadableStream<Value>): Operation<PullSource<Value, undefined>> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, PullSource<Value, undefined>, Exit<unknown>> {
			const source = yield* action<PullSource<Value, undefined>>('acquire readable stream', (resolve, reject, signal) => {
				let reader: ReadableStreamDefaultReader<Value>;
				try { reader = stream.getReader(); }
				catch (error) { reject(error); return; }
				const handle = readableSource(reader);
				if (signal.aborted) {
					void handle.close(signal.reason).then(() => reject(signal.reason), reject);
					return;
				}
				resolve(handle);
				return () => handle.close(signal.reason);
			})[Symbol.iterator]();
			yield* ensure(() => source.close())[Symbol.iterator]();
			return source;
		},
	});
}

/**
 * Adapts a Step factory into a host-local Operation whose settlement remains owned by the executing Branch.
 *
 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
 *
 * @internal
 */
function stepOperation<Value>(step: Step<Value>): Operation<Value> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, Value, Exit<unknown>> {
			const exit = yield step as Step<unknown>;
			if (exit.type === 'success') return exit.value as Value;
			throw new CauseError(exit.cause);
		},
	});
}

/** Convert an internal operation exception back into a structured Cause. */
export function causeFromError(error: unknown): Cause {
	return error instanceof CauseError ? error.cause_ : Object.freeze({ type: 'failure', failure: error });
}

/** Extract the concrete failure value when callers need to bridge to Promise code. */
export function failureFromCause(cause: Cause): unknown {
	if (cause.type === 'failure') return cause.failure;
	if (cause.type === 'fault') return cause.fault;
	if (cause.type === 'cancelled') return cause.reason;
	const failures = cause.causes.map(failureFromCause);
	return new AggregateError(failures, 'Host-local operation failed for multiple reasons.');
}

/**
 * Builds the source operation adapter consumed by the host-local structured-concurrency kernel.
 *
 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
 *
 * @internal
 */
function sourceOperation<Value, Return>(
	iterator: Iterator<Value, Return> | AsyncIterator<Value, Return>,
	name: string,
): Operation<PullSource<Value, Return>> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Step<unknown>, PullSource<Value, Return>, Exit<unknown>> {
			const source = iteratorSource(iterator, name);
			yield* ensure(() => source.close())[Symbol.iterator]();
			return source;
		},
	});
}

/**
 * Wraps an iterator as a pull source whose `return()` cleanup is owned and invoked exactly once.
 *
 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
 *
 * @internal
 */
function iteratorSource<Value, Return>(
	iterator: Iterator<Value, Return> | AsyncIterator<Value, Return>,
	name: string,
): PullSource<Value, Return> {
	let done = false;
	let closing: Promise<void> | undefined;
	const close = (_reason?: unknown): Promise<void> => {
		if (done) return Promise.resolve();
		if (closing !== undefined) return closing;
		closing = Promise.resolve(iterator.return?.()).then(
			() => { done = true; },
			(error) => { done = true; throw error; },
		);
		return closing;
	};
	const source: PullSource<Value, Return> = Object.freeze({
		/**
		 * Advances to the next value without crossing ownership between independent consumers of the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		next(): Operation<IteratorResult<Value, Return>> {
			return action(`${name} next`, (resolve, reject, signal) => {
				if (done) {
					resolve(Object.freeze({ done: true, value: undefined as Return }));
					return;
				}
				void Promise.resolve(iterator.next()).then((result) => {
					if (result.done) done = true;
					resolve(result);
				}, reject);
				return () => close(signal.reason);
			});
		},
		close,
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose](): Promise<void> { await close(); },
	});
	return source;
}

/**
 * Reads a ReadableStream source under the module's cancellation and ownership rules.
 *
 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
 *
 * @internal
 */
function readableSource<Value>(reader: ReadableStreamDefaultReader<Value>): PullSource<Value, undefined> {
	let released = false;
	let done = false;
	let closing: Promise<void> | undefined;
	const release = (): void => {
		if (released) return;
		released = true;
		reader.releaseLock();
	};
	const close = (reason?: unknown): Promise<void> => {
		if (released) return Promise.resolve();
		if (closing !== undefined) return closing;
		closing = (done ? Promise.resolve() : Promise.resolve(reader.cancel(reason)))
			.then(
				() => { done = true; release(); },
				(error) => { done = true; release(); throw error; },
			);
		return closing;
	};
	return Object.freeze({
		/**
		 * Advances to the next value without crossing ownership between independent consumers of the host-local structured-concurrency kernel.
		 *
		 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
		 *
		 * @internal
		 */
		next(): Operation<IteratorResult<Value, undefined>> {
			return action('read stream chunk', (resolve, reject, signal) => {
				if (done || released) {
					resolve(Object.freeze({ done: true, value: undefined }));
					return;
				}
				void reader.read().then((result) => {
					if (result.done) {
						done = true;
						release();
						resolve(Object.freeze({ done: true, value: undefined }));
						return;
					}
					resolve(Object.freeze({ done: false, value: result.value }));
				}, (error) => {
					void close(error).then(
						() => reject(error),
						(cleanupError) => reject(new AggregateError([error, cleanupError], 'ReadableStream read and cleanup both failed.')),
					);
				});
				return () => close(signal.reason);
			});
		},
		close,
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose](): Promise<void> { await close(); },
	});
}

type OperationValue<Value> = Value extends Operation<infer Output> ? Output : never;
