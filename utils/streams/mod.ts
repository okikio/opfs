/**
 * Small adapters between Web Streams and async iterables, plus bounded collection.
 *
 * The module preserves streaming and cancellation unless the caller explicitly
 * chooses materialization through {@link collect}.
 *
 * @module
 */
import type { BatchOptions, IterableOptions, LimitOptions } from './types.ts';

/** Materialization or batching exceeded an explicit item or byte limit. */
export class StreamLimitError extends Error {
	readonly limit: 'items' | 'bytes';
	readonly maximum: number;
	readonly actual: number;

	constructor(limit: 'items' | 'bytes', maximum: number, actual: number) {
		super(`Stream ${limit} limit ${maximum} was exceeded by ${actual}.`);
		this.name = 'StreamLimitError';
		this.limit = limit;
		this.maximum = maximum;
		this.actual = actual;
	}
}

/** Convert an iterable into a Web ReadableStream while retaining source cancellation. */
export function readable<Value>(source: Iterable<Value | PromiseLike<Value>> | AsyncIterable<Value>): ReadableStream<Value> {
	const iterator = toAsyncIterator(source);
	return new ReadableStream<Value>({
		/**
		 * Pulls the next value only when stream and async-iterator adaptation is ready to accept it.
		 *
		 * @internal
		 */
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		/**
		 * Checks whether cel is currently allowed by stream and async-iterator adaptation.
		 *
		 * @internal
		 */
		async cancel(reason) {
			await iterator.return?.(reason);
		},
	});
}

/** Iterate a Web ReadableStream with explicit early-return cancellation policy. */
export async function* iterable<Value>(
	source: ReadableStream<Value>,
	options: IterableOptions = {},
): AsyncIterableIterator<Value> {
	const reader = source.getReader();
	let completed = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				completed = true;
				return;
			}
			yield next.value;
		}
	} finally {
		if (completed || options.preventCancel === true) reader.releaseLock();
		else void reader.cancel('ReadableStream iteration ended early.').catch(() => {}).finally(() => reader.releaseLock());
	}
}

/** Pipe iterable values into a Web WritableStream with native pressure and cancellation. */
export async function pipe<Value>(
	source: Iterable<Value | PromiseLike<Value>> | AsyncIterable<Value>,
	destination: WritableStream<Value>,
	options: StreamPipeOptions = {},
): Promise<void> {
	await readable(source).pipeTo(destination, options);
}

/** Materialize a finite iterable only within explicit optional item and byte limits. */
export async function collect<Value>(
	source: Iterable<Value> | AsyncIterable<Value>,
	options: LimitOptions<Value> = {},
): Promise<readonly Value[]> {
	const limits = normalizeLimits(options, false);
	const values: Value[] = [];
	let bytes = 0;
	for await (const value of source) {
		throwIfAborted(options.signal);
		const nextItems = values.length + 1;
		if (limits.maximumItems !== undefined && nextItems > limits.maximumItems) {
			throw new StreamLimitError('items', limits.maximumItems, nextItems);
		}
		bytes += estimateSize(value, limits);
		if (limits.maximumBytes !== undefined && bytes > limits.maximumBytes) {
			throw new StreamLimitError('bytes', limits.maximumBytes, bytes);
		}
		values.push(value);
	}
	throwIfAborted(options.signal);
	return Object.freeze(values);
}

/** Group source values into bounded immutable batches without materializing the full source. */
export async function* batch<Value>(
	source: Iterable<Value> | AsyncIterable<Value>,
	options: BatchOptions<Value>,
): AsyncIterableIterator<readonly Value[]> {
	const limits = normalizeLimits(options, true);
	let values: Value[] = [];
	let bytes = 0;
	for await (const value of source) {
		throwIfAborted(options.signal);
		const size = estimateSize(value, limits);
		if (limits.maximumBytes !== undefined && size > limits.maximumBytes) {
			throw new StreamLimitError('bytes', limits.maximumBytes, size);
		}
		const reachesItemLimit = limits.maximumItems !== undefined && values.length >= limits.maximumItems;
		const reachesByteLimit = limits.maximumBytes !== undefined && values.length > 0 && bytes + size > limits.maximumBytes;
		if (reachesItemLimit || reachesByteLimit) {
			yield Object.freeze(values);
			values = [];
			bytes = 0;
			throwIfAborted(options.signal);
		}
		values.push(value);
		bytes += size;
	}
	throwIfAborted(options.signal);
	if (values.length > 0) yield Object.freeze(values);
}

/**
 * Converts the source value to async iterator expected by stream and async-iterator adaptation.
 *
 * Stream internals preserve cancellation and pull pressure unless the caller explicitly requests bounded materialization.
 *
 * @internal
 */
function toAsyncIterator<Value>(
	source: Iterable<Value | PromiseLike<Value>> | AsyncIterable<Value>,
): AsyncIterator<Value> {
	if (Symbol.asyncIterator in Object(source)) return (source as AsyncIterable<Value>)[Symbol.asyncIterator]();
	const iterator = (source as Iterable<Value | PromiseLike<Value>>)[Symbol.iterator]();
	return {
		/**
		 * Advances to the next value without crossing ownership between independent consumers of stream and async-iterator adaptation.
		 *
		 * @internal
		 */
		async next() {
			const result = iterator.next();
			return result.done ? { done: true, value: undefined } : { done: false, value: await result.value };
		},
		/**
		 * Returns from iteration and triggers the cleanup required by stream and async-iterator adaptation.
		 *
		 * @internal
		 */
		async return(value?: unknown) {
			const result = iterator.return?.(value as never) ?? { done: true, value: value as never };
			return { done: true, value: await result.value };
		},
	};
}

interface NormalizedLimits<Value> {
	readonly maximumItems?: number;
	readonly maximumBytes?: number;
	readonly size?: (value: Value) => number;
}

/**
 * Normalizes limits into the canonical internal form used by later phases.
 *
 * It preserves streaming cancellation and pressure unless the caller explicitly chooses bounded materialization.
 *
 * @internal
 */
function normalizeLimits<Value>(options: LimitOptions<Value>, required: boolean): NormalizedLimits<Value> {
	const maximumItems = options.maximumItems === undefined ? undefined : positiveInteger(options.maximumItems, 'maximumItems');
	const maximumBytes = options.maximumBytes === undefined ? undefined : positiveInteger(options.maximumBytes, 'maximumBytes');
	if (required && maximumItems === undefined && maximumBytes === undefined) {
		throw new TypeError('Batching requires maximumItems or maximumBytes.');
	}
	if (maximumBytes !== undefined && options.size === undefined) {
		throw new TypeError('A size estimator is required when maximumBytes is configured.');
	}
	return Object.freeze({
		...(maximumItems === undefined ? {} : { maximumItems }),
		...(maximumBytes === undefined ? {} : { maximumBytes }),
		...(options.size === undefined ? {} : { size: options.size }),
	});
}

/**
 * Estimates the size used for bounded admission in stream and async-iterator adaptation.
 *
 * @internal
 */
function estimateSize<Value>(value: Value, limits: NormalizedLimits<Value>): number {
	if (limits.maximumBytes === undefined) return 0;
	const size = limits.size!(value);
	if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Stream size estimates must be non-negative safe integers.');
	return size;
}

/**
 * Validates positive integer before it is used by stream and async-iterator adaptation.
 *
 * @internal
 */
function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
	return value;
}

/**
 * Propagates if aborted through the controlled iterator path used by stream and async-iterator adaptation.
 *
 * @internal
 */
function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason ?? new DOMException('The stream operation was cancelled.', 'AbortError');
}

export type * from './types.ts';
