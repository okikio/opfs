import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as streams from './mod.ts';

async function* values(...items: number[]): AsyncIterableIterator<number> {
	for (const item of items) yield item;
}

describe('stream adapters and limits', () => {
	it('batches by item count without changing order', async () => {
		const result = await Array.fromAsync(streams.batch(values(1, 2, 3, 4, 5), { maximumItems: 2 }));
		expect(result).toEqual([[1, 2], [3, 4], [5]]);
		expect(Object.isFrozen(result[0])).toBe(true);
	});

	it('batches before crossing the configured byte estimate', async () => {
		const result = await Array.fromAsync(streams.batch(['aa', 'bbb', 'c'], {
			maximumBytes: 4,
			size: (value) => value.length,
		}));
		expect(result).toEqual([['aa'], ['bbb', 'c']]);
	});

	it('rejects one oversized item instead of violating the advertised limit', async () => {
		await expect(Array.fromAsync(streams.batch(['large'], {
			maximumBytes: 4,
			size: (value) => value.length,
		}))).rejects.toThrow(streams.StreamLimitError);
	});

	it('stops materialization at item and byte limits', async () => {
		await expect(streams.collect(values(1, 2, 3), { maximumItems: 2 })).rejects.toThrow(streams.StreamLimitError);
		await expect(streams.collect(['one', 'two'], {
			maximumBytes: 5,
			size: (value) => value.length,
		})).rejects.toThrow(streams.StreamLimitError);
	});

	it('propagates cancellation and closes an async generator on failure', async () => {
		let closed = false;
		async function* source() {
			try {
				yield 1;
				yield 2;
			} finally {
				closed = true;
			}
		}
		const controller = new AbortController();
		const batches = streams.batch(source(), { maximumItems: 1, signal: controller.signal });
		expect((await batches.next()).value).toEqual([1]);
		controller.abort('stop batching');
		await expect(batches.next()).rejects.toBe('stop batching');
		expect(closed).toBe(true);
	});

	it('uses ReadableStream iteration cancellation unless explicitly prevented', async () => {
		let cancelled = 0;
		const source = new ReadableStream<number>({
			pull(controller) { controller.enqueue(1); },
			cancel() { cancelled += 1; },
		});
		for await (const _ of streams.iterable(source)) break;
		expect(cancelled).toBe(1);

		let preserved = 0;
		const retained = new ReadableStream<number>({
			pull(controller) { controller.enqueue(1); },
			cancel() { preserved += 1; },
		});
		for await (const _ of streams.iterable(retained, { preventCancel: true })) break;
		expect(preserved).toBe(0);
		await retained.cancel();
	});

	it('pipes iterable values through native Web Stream pressure handling', async () => {
		const written: number[] = [];
		await streams.pipe(values(1, 2, 3), new WritableStream<number>({ write(value) { written.push(value); } }));
		expect(written).toEqual([1, 2, 3]);
	});
});
