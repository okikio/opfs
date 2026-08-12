@utils/streams public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/streams` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/streams
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `batch` | function | Group source values into bounded immutable batches without materializing the full source. | `batch(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `BatchOptions` | interface | Required batch limits. | `value: BatchOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `collect` | function | Materialize a finite iterable only within explicit optional item and byte limits. | `collect(...)` | `.agents/tests/production-e2e.test.ts:165` uses `collect`. |
| `iterable` | function | Iterate a Web ReadableStream with explicit early-return cancellation policy. | `iterable(...)` | `.agents/tests/public-api-matrix.test.ts:339` uses `iterable`. |
| `IterableOptions` | interface | ReadableStream iteration policy. | `value: IterableOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `LimitOptions` | interface | Shared size limits for stream materialization and batching. | `value: LimitOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `pipe` | function | Pipe iterable values into a Web WritableStream with native pressure and cancellation. | `pipe(...)` | `.agents/tests/public-api-matrix.test.ts:342` uses `pipe`. |
| `readable` | function | Convert an iterable into a Web ReadableStream while retaining source cancellation. | `readable(...)` | `.agents/tests/public-api-matrix.test.ts:337` uses `readable`. |
| `StreamLimitError` | class | Materialization or batching exceeded an explicit item or byte limit. | `new StreamLimitError(...)` | `.agents/tests/production-e2e.test.ts:190` uses `StreamLimitError`. |

Detected uses
~~~~~~~~~~~~~

`StreamLimitError` appears in `.agents/tests/production-e2e.test.ts:190`:

~~~~ typescript
await assert.rejects(() => streams.collect([1, 2], { maximumItems: 1 }), streams.StreamLimitError);
		await using ctx = context.create({ id: 'cross-utility-pathological' });
		await using valuesPool = await pool.create({
			ctx,
~~~~

`readable` appears in `.agents/tests/public-api-matrix.test.ts:337`:

~~~~ typescript
const readable = streams.readable([1, 2, 3]);
			const values: number[] = [];
			for await (const value of streams.iterable(readable)) values.push(value);
			assert.deepEqual(values, [1, 2, 3]);
~~~~

`iterable` appears in `.agents/tests/public-api-matrix.test.ts:339`:

~~~~ typescript
for await (const value of streams.iterable(readable)) values.push(value);
			assert.deepEqual(values, [1, 2, 3]);
			const sink: number[] = [];
			await streams.pipe([1, 2], new WritableStream({ write(value) { sink.push(value); } }));
~~~~

`pipe` appears in `.agents/tests/public-api-matrix.test.ts:342`:

~~~~ typescript
await streams.pipe([1, 2], new WritableStream({ write(value) { sink.push(value); } }));
			assert.deepEqual(sink, [1, 2]);
			const buffer = new Uint8Array([index]);
			const reply = worker.reply(buffer, [buffer.buffer]);
~~~~

`collect` appears in `.agents/tests/production-e2e.test.ts:165`:

~~~~ typescript
const values = await streams.collect([1, 2, 3], { maximumItems: 3 });
		assert.deepEqual(values, [1, 2, 3]);
		await using ctx = context.create({ id: 'cross-utility-happy' });
		let created = 0;
~~~~

@utils/streams/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `BatchOptions` | interface | Required batch limits. | `value: BatchOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `IterableOptions` | interface | ReadableStream iteration policy. | `value: IterableOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `LimitOptions` | interface | Shared size limits for stream materialization and batching. | `value: LimitOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 12 public names across 2 package export targets. 5 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

