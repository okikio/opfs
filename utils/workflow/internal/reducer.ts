/**
 * Reentrancy-safe scheduler for host-local branch transitions.
 *
 * Step callbacks can resolve synchronously while `Step.enter()` is still on
 * the stack. The reducer defers the next generator transition until the
 * current transition has returned.
 *
 * ```text
 * Step callback
 *    |
 *    v
 * enqueue transition
 *    |
 *    +--> current drain still active -> queue only
 *    |
 *    v
 * FIFO drain, at most `stepBudget` actions
 *    |
 *    +--> more work -> next microtask
 * ```
 */
export class Reducer {
	readonly stepBudget: number;
	#critical: (() => void)[] = [];
	#normal: (() => void)[] = [];
	#scheduled = false;
	#draining = false;

	constructor(stepBudget = 256) {
		if (!Number.isSafeInteger(stepBudget) || stepBudget < 1) throw new TypeError('Reducer stepBudget must be a positive safe integer.');
		this.stepBudget = stepBudget;
	}

	/** Schedule one transition. Critical cleanup can move ahead of normal work. */
	enqueue(action: () => void, priority: 'normal' | 'critical' = 'normal'): void {
		if (priority === 'critical') this.#critical.push(action);
		else this.#normal.push(action);
		this.#schedule();
	}

	/**
	 * Queues one reducer transition by priority and schedules a single microtask drain instead of re-entering the generator stack.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#schedule(): void {
		if (this.#scheduled || this.#draining) return;
		this.#scheduled = true;
		queueMicrotask(() => this.#drain());
	}

	/**
	 * Drains owned work before the host-local structured-concurrency kernel reports terminal completion.
	 *
	 * The kernel gives every branch one active Step and child Scope while the Reducer serializes generator advancement, cancellation, and cleanup.
	 *
	 * @internal
	 */
	#drain(): void {
		if (this.#draining) return;
		this.#scheduled = false;
		this.#draining = true;
		try {
			let steps = 0;
			while (steps < this.stepBudget) {
				const action = this.#critical.shift() ?? this.#normal.shift();
				if (action === undefined) return;
				steps += 1;
				action();
			}
		} finally {
			this.#draining = false;
			if (this.#critical.length > 0 || this.#normal.length > 0) this.#schedule();
		}
	}
}
