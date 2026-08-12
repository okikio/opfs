import type { Cause } from './types.ts';

/** Child lifecycle used by Scope without exposing the concrete Branch class. */
export interface ScopeChild {
	cancel(reason: unknown): Promise<void>;
	settled(): Promise<void>;
}

/**
 * Owns child branches and asynchronous finalizers for one host-local branch.
 *
 * Closure is single-flight. Children stop before finalizers run. Finalizers run
 * last-in-first-out, and a finalizer may register another finalizer while the
 * scope is closing.
 */
export class Scope {
	#children = new Set<ScopeChild>();
	#finalizers: (() => void | Promise<void>)[] = [];
	#closing?: Promise<readonly Cause[]>;
	#closed: boolean;

	/** Create an open scope with no owned children or registered finalizers. */
	constructor() {
		this.#closed = false;
	}

	/** Add an owned child that must be terminal before this scope can close. */
	addChild(child: ScopeChild): void {
		if (this.#closed || this.#closing !== undefined) throw new Error('Cannot add a child after scope closure starts.');
		this.#children.add(child);
		void child.settled().finally(() => this.#children.delete(child));
	}

	/** Register cleanup that runs in reverse registration order. */
	addFinalizer(finalizer: () => void | Promise<void>): () => void {
		if (this.#closed) throw new Error('Cannot add a finalizer after scope closure completed.');
		const entry = finalizer;
		this.#finalizers.push(entry);
		return () => {
			const index = this.#finalizers.lastIndexOf(entry);
			if (index >= 0) this.#finalizers.splice(index, 1);
		};
	}

	/** Cancel all children, await them, then drain finalizers. */
	close(reason: unknown): Promise<readonly Cause[]> {
		if (this.#closing !== undefined) return this.#closing;
		this.#closing = this.#close(reason);
		return this.#closing;
	}

	/**
	 * Closes owned state and waits for the cleanup that the current owner is responsible for.
	 *
	 * It implements host-local structured concurrency: a Branch owns one active Step and child Scope, while the Reducer serializes state transitions.
	 *
	 * @internal
	 */
	async #close(reason: unknown): Promise<readonly Cause[]> {
		const causes: Cause[] = [];
		const children = [...this.#children];
		await Promise.all(children.map(async (child) => {
			try { await child.cancel(reason); }
			catch (failure) { causes.push(Object.freeze({ type: 'failure', failure })); }
		}));
		await Promise.all(children.map((child) => child.settled()));

		while (this.#finalizers.length > 0) {
			const finalizer = this.#finalizers.pop()!;
			try { await finalizer(); }
			catch (failure) { causes.push(Object.freeze({ type: 'failure', failure })); }
		}
		this.#closed = true;
		return Object.freeze(causes);
	}
}
