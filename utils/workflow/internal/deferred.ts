/**
 * One externally completed promise used only inside the host-local kernel.
 *
 * Durable waits use workflow instructions. This helper is for in-process
 * ownership such as reducer tests, Step adapters, and protocol correlation.
 */
export class Deferred<Value> {
	readonly promise: Promise<Value>;
	#resolve!: (value: Value | PromiseLike<Value>) => void;
	#reject!: (reason?: unknown) => void;
	#settled = false;

	constructor() {
		this.promise = new Promise<Value>((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
	}

	/** Resolve once. Later completion attempts are ignored. */
	resolve(value: Value | PromiseLike<Value>): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#resolve(value);
	}

	/** Reject once. Later completion attempts are ignored. */
	reject(reason?: unknown): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#reject(reason);
	}
}