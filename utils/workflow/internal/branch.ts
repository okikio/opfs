import { Reducer } from './reducer.ts';
import { Scope } from './scope.ts';
import { causeFromError } from './operation.ts';
import type { BranchView, Cause, ChildHandle, Exit, Operation, Step, StepExit, Supervision } from './types.ts';

/** Error used when ordinary generator finally code yields a Step during unwind. */
export class LocalFinalizerStepError extends Error {
	readonly step: Step<unknown>;

	constructor(step: Step<unknown>) {
		super('Host-local generator finalizers must not yield Steps. Register asynchronous cleanup on the branch scope.');
		this.name = 'LocalFinalizerStepError';
		this.step = step;
	}
}

/**
 * Owns one host-local iterator, its active Step, cancellation, and child Scope.
 *
 * ```text
 * ready -> running -> waiting -> ready ... -> closing -> terminal
 *                     |
 * cancellation -------+
 *                     v
 *              abort branch signal
 *                     |
 *              discard active Step
 *                     |
 *              wait for discard done
 *                     |
 *               iterator.return()
 *                     |
 *                 close Scope
 * ```
 */
export class Branch<Value> implements BranchView {
	readonly signal: AbortSignal;
	readonly scope = new Scope();
	readonly #controller = new AbortController();
	readonly #iterator: Generator<Step<unknown>, Value, Exit<unknown>>;
	readonly #reducer: Reducer;
	readonly #result: Promise<Exit<Value>>;
	#resolveResult!: (exit: Exit<Value>) => void;
	#activeExit?: StepExit;
	#state: 'ready' | 'running' | 'waiting' | 'closing' | 'terminal' = 'ready';
	#cancelReason: unknown;
	#cancelRequested = false;
	#discarding = false;
	#started = false;

	constructor(operation: Operation<Value>, reducer = new Reducer()) {
		this.#iterator = operation[Symbol.iterator]();
		this.#reducer = reducer;
		this.signal = this.#controller.signal;
		this.#result = new Promise((resolve) => this.#resolveResult = resolve);
	}

	/** Start the branch exactly once and return its terminal Exit. */
	start(): Promise<Exit<Value>> {
		if (this.#started) return this.#result;
		this.#started = true;
		this.#reducer.enqueue(() => this.#advance(undefined));
		return this.#result;
	}

	/** Request cancellation and resolve only after active work and scope cleanup stop. */
	async cancel(reason: unknown): Promise<void> {
		if (this.#state === 'terminal') return;
		if (!this.#cancelRequested) {
			this.#cancelRequested = true;
			this.#cancelReason = reason;
			this.#controller.abort(reason);
		}
		this.#reducer.enqueue(() => this.#beginCancellation(), 'critical');
		await this.#result;
	}

	/** Resolve when the branch becomes terminal. */
	async settled(): Promise<void> {
		await this.#result;
	}

	/** Return the branch terminal Exit. */
	result(): Promise<Exit<Value>> {
		return this.#result;
	}

	/** Register asynchronous cleanup on this branch Scope. */
	addFinalizer(finalizer: () => void | Promise<void>): () => void {
		return this.scope.addFinalizer(finalizer);
	}

	/**
	 * Create an owned child that shares this branch reducer and Scope.
	 *
	 * `fail-fast` raises an unhandled child failure into the owner. `collect`
	 * and `isolate` leave the terminal Exit on the returned handle so a
	 * combinator or explicit owner can decide what to do with it. All modes
	 * still keep the child inside this Scope; none creates detached work.
	 */
	spawn<ChildValue>(operation: Operation<ChildValue>, supervision: Supervision): ChildHandle<ChildValue> {
		const child = new Branch(operation, this.#reducer);
		this.scope.addChild(child);
		void child.start().then((exit) => {
			if (supervision === 'fail-fast' && exit.type === 'failure') {
				this.#reducer.enqueue(() => this.#beginFailure(exit.cause), 'critical');
			}
		});
		return child;
	}

	/**
	 * Advances state by one controlled transition under the host-local structured-concurrency kernel.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#advance(resume: Exit<unknown> | undefined): void {
		if (this.#state === 'terminal' || this.#state === 'closing') return;
		if (this.#cancelRequested) return this.#beginCancellation();
		this.#state = 'running';
		let next: IteratorResult<Step<unknown>, Value>;
		try {
			next = resume === undefined ? this.#iterator.next() : this.#iterator.next(resume);
		} catch (error) {
			return void this.#close(causeFromError(error));
		}
		if (next.done) return void this.#closeSuccess(next.value);
		this.#state = 'waiting';
		let resolved = false;
		try {
			this.#activeExit = next.value.enter((exit) => {
				if (resolved) return;
				resolved = true;
				this.#reducer.enqueue(() => {
					this.#activeExit = undefined;
					if (this.#cancelRequested) this.#beginCancellation();
					else this.#advance(exit);
				});
			}, this);
		} catch (error) {
			this.#activeExit = undefined;
			this.#reducer.enqueue(() => this.#close(Object.freeze({ type: 'failure', failure: error })));
		}
	}

	/**
	 * Marks the branch as cancelling, aborts its active Step, and waits for discard acknowledgement before generator unwind.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#beginCancellation(): void {
		if (this.#state === 'terminal' || this.#state === 'closing' || this.#discarding) return;
		const activeExit = this.#activeExit;
		if (activeExit !== undefined) {
			this.#discarding = true;
			try {
				activeExit((discardExit) => this.#reducer.enqueue(() => {
					this.#discarding = false;
					this.#activeExit = undefined;
					this.#unwind(discardExit.type === 'failure' ? discardExit.cause : undefined);
				}));
			} catch (failure) {
				this.#discarding = false;
				this.#activeExit = undefined;
				this.#unwind(Object.freeze({ type: 'failure', failure }));
			}
			return;
		}
		this.#unwind();
	}

	/**
	 * Raise an unhandled child failure into this branch without converting the
	 * failure into a cancellation cause.
	 *
	 * The active Step still gets its discard handshake first. After that, the
	 * generator enters return-mode and the original child cause remains the
	 * primary terminal cause for this owner.
	 */
	#beginFailure(cause: Cause): void {
		if (this.#state === 'terminal' || this.#state === 'closing' || this.#discarding) return;
		this.#controller.abort(cause);
		const activeExit = this.#activeExit;
		if (activeExit !== undefined) {
			this.#discarding = true;
			try {
				activeExit((discardExit) => this.#reducer.enqueue(() => {
					this.#discarding = false;
					this.#activeExit = undefined;
					this.#unwindFailure(cause, discardExit.type === 'failure' ? discardExit.cause : undefined);
				}));
			} catch (failure) {
				this.#discarding = false;
				this.#activeExit = undefined;
				this.#unwindFailure(cause, Object.freeze({ type: 'failure', failure }));
			}
			return;
		}
		this.#unwindFailure(cause);
	}

	/**
	 * Calls `iterator.return()` after cancellation is armed and rejects any later yield so cancelled body code cannot resume.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#unwind(discardCause?: Cause): void {
		if (this.#state === 'terminal' || this.#state === 'closing') return;
		this.#state = 'closing';
		let unwindFailure: unknown;
		try {
			const step = this.#iterator.return?.(undefined as never);
			if (step !== undefined && !step.done) unwindFailure = new LocalFinalizerStepError(step.value);
		} catch (error) {
			unwindFailure = error;
		}
		const cancellation: Cause = Object.freeze({ type: 'cancelled', reason: this.#cancelReason });
		void this.scope.close(this.#cancelReason).then((cleanupCauses) => {
			const causes: Cause[] = [cancellation];
			if (discardCause !== undefined) causes.push(discardCause);
			if (unwindFailure !== undefined) causes.push(Object.freeze({ type: 'failure', failure: unwindFailure }));
			causes.push(...cleanupCauses);
			this.#settleFailure(causes.length === 1 ? causes[0]! : Object.freeze({ type: 'multiple', causes: Object.freeze(causes) }));
		});
	}

	/**
	 * Builds the unwind failure used when the host-local structured-concurrency kernel cannot complete as intended.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#unwindFailure(cause: Cause, discardCause?: Cause): void {
		if (this.#state === 'terminal' || this.#state === 'closing') return;
		this.#state = 'closing';
		let unwindFailure: unknown;
		try {
			const step = this.#iterator.return?.(undefined as never);
			if (step !== undefined && !step.done) unwindFailure = new LocalFinalizerStepError(step.value);
		} catch (error) {
			unwindFailure = error;
		}
		void this.scope.close(cause).then((cleanupCauses) => {
			const causes: Cause[] = [cause];
			if (discardCause !== undefined) causes.push(discardCause);
			if (unwindFailure !== undefined) causes.push(Object.freeze({ type: 'failure', failure: unwindFailure }));
			causes.push(...cleanupCauses);
			this.#settleFailure(causes.length === 1 ? causes[0]! : Object.freeze({ type: 'multiple', causes: Object.freeze(causes) }));
		});
	}

	/**
	 * Closes success and waits for the cleanup that the current owner is responsible for.
	 *
	 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
	 *
	 * @internal
	 */
	#closeSuccess(value: Value): void {
		if (this.#state === 'terminal' || this.#state === 'closing') return;
		this.#state = 'closing';
		void this.scope.close(undefined).then((cleanupCauses) => {
			if (cleanupCauses.length === 0) this.#settle(Object.freeze({ type: 'success', value }));
			else this.#settleFailure(cleanupCauses.length === 1 ? cleanupCauses[0]! : Object.freeze({ type: 'multiple', causes: cleanupCauses }));
		});
	}

	/**
	 * Closes owned state and waits for the cleanup that the current owner is responsible for.
	 *
	 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
	 *
	 * @internal
	 */
	#close(cause: Cause): void {
		if (this.#state === 'terminal' || this.#state === 'closing') return;
		this.#state = 'closing';
		void this.scope.close(cause).then((cleanupCauses) => {
			const causes = cleanupCauses.length === 0 ? [cause] : [cause, ...cleanupCauses];
			this.#settleFailure(causes.length === 1 ? causes[0]! : Object.freeze({ type: 'multiple', causes: Object.freeze(causes) }));
		});
	}

	/**
	 * Sets tle failure on the internal builder or record used by the host-local structured-concurrency kernel.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#settleFailure(cause: Cause): void {
		this.#settle(Object.freeze({ type: 'failure', cause }));
	}

	/**
	 * Sets tle on the internal builder or record used by the host-local structured-concurrency kernel.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#settle(exit: Exit<Value>): void {
		if (this.#state === 'terminal') return;
		this.#state = 'terminal';
		this.#resolveResult(exit);
	}
}
