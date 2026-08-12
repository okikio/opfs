@utils/context public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/context` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/context
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `cancel` | function | Cancel an owned context. | `cancel(...)` | `utils/resource/mod.ts:436` uses `cancel`. |
| `cause` | function | Return the cancellation reason without changing control flow. | `cause(...)` | `.agents/tests/public-api-repetition.test.ts:64` uses `cause`. |
| `check` | function | Throw the appropriate cancellation or deadline error when work must stop. | `check(...)` | `utils/pool/mod.ts:215` uses `check`. |
| `child` | function | Derive a child context that inherits identity, cancellation, and the parent deadline. | `child(...)` | `utils/activity/mod.ts:162` uses `child`. |
| `ChildOptions` | interface | Inputs accepted while deriving a child context. | `value: ChildOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Clock` | interface | Provider-neutral clock used by requests, activities, workflows, and tests. | `value: Clock` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `combineSignals` | function | Compose cancellation signals for an unowned view. | `combineSignals(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Context` | interface | Cancellation, deadline, identity, and clock carried through one operation. | `value: Context` | `.agents/support/production-fixture.ts:47` uses `Context`. |
| `ContextCancelledError` | class | Error raised when a context has been cancelled. | `new ContextCancelledError(...)` | `utils/pool/mod.ts:283` uses `ContextCancelledError`. |
| `ContextDeadlineExceededError` | class | Error raised when a context deadline has elapsed. | `new ContextDeadlineExceededError(...)` | `utils/pool/mod.ts:137` uses `ContextDeadlineExceededError`. |
| `create` | function | Create one independently owned context. | `create(...)` | `.agents/support/production-fixture.ts:380` uses `create`. |
| `CreateOptions` | interface | Inputs accepted while creating one owned operation context. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `deadline` | function | Derive a child with an absolute deadline that cannot exceed its parent's deadline. | `deadline(...)` | `utils/pool/mod.ts:261` uses `deadline`. |
| `Owned` | interface | Independently owned context with deterministic cancellation and timer cleanup. | `value: Owned` | `utils/resource/mod.ts:327` uses `Owned`. |
| `remaining` | function | Return the non-negative time remaining before the deadline. | `remaining(...)` | `.agents/tests/public-api-matrix.test.ts:332` uses `remaining`. |
| `restore` | function | Restore a snapshot into a new local context and cancellation controller. | `restore(...)` | `utils/worker/mod.ts:228` uses `restore`. |
| `RestoreOptions` | interface | Inputs accepted while restoring a serializable snapshot. | `value: RestoreOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `snapshot` | function | Create a serializable context snapshot. | `snapshot(...)` | `utils/worker/mod.ts:399` uses `snapshot`. |
| `Snapshot` | interface | Serializable identity and timing data for one operation context. | `value: Snapshot` | `utils/worker/mod.ts:629` uses `Snapshot`. |
| `SystemClock` | value | Clock backed by the runtime's native Temporal implementation. | `SystemClock` | `utils/queue/mod.ts:144` uses `SystemClock`. |
| `TestClock` | class | Mutable deterministic clock intended for tests and simulations. | `new TestClock(...)` | `.agents/tests/public-api-matrix.test.ts:329` uses `TestClock`. |
| `timeout` | function | Derive a child with a relative timeout that cannot exceed its parent's deadline. | `timeout(...)` | `.agents/tests/public-api-repetition.test.ts:62` uses `timeout`. |

Detected uses
~~~~~~~~~~~~~

`ContextCancelledError` appears in `utils/pool/mod.ts:283`:

~~~~ typescript
if (ctx.signal.aborted) throw ctx.signal.reason ?? new contextCore.ContextCancelledError();
		contextCore.check(ctx);
	}
~~~~

`ContextDeadlineExceededError` appears in `utils/pool/mod.ts:137`:

~~~~ typescript
if (acquisition.timeout !== undefined && error instanceof contextCore.ContextDeadlineExceededError) {
					throw new PoolAcquireTimeoutError(acquisition.timeout);
				}
				throw error;
~~~~

`SystemClock` appears in `utils/queue/mod.ts:144`:

~~~~ typescript
const clock = options.clock ?? contextCore.SystemClock;
	const createId = options.id ?? defaultId;
	const defaultClaimDuration = positiveDuration(options.defaultClaimDuration ?? { seconds: 30 }, 'default claim duration');
	const events = new EventBus<Event>();
~~~~

`TestClock` appears in `.agents/tests/public-api-matrix.test.ts:329`:

~~~~ typescript
const clock = new context.TestClock('2026-08-05T00:00:00Z');
			clock.set(`2026-08-05T00:00:0${index}Z`);
			const owned = context.create({ id: `matrix-context-${index}`, clock, deadline: clock.now().add({ seconds: 5 }) });
			assert.ok(context.remaining(owned)?.total({ unit: 'seconds', relativeTo: Temporal.PlainDate.from('2000-01-01') }) ?? 0 > 0);
~~~~

`create` appears in `.agents/support/production-fixture.ts:380`:

~~~~ typescript
const bootstrapContext = context.create({ id: 'validation-bootstrap' });
	const records = new Map<string, ImportRecord>();
	const persistenceCounts = new Map<string, number>();
	const repository: ImportRepositoryValue = Object.freeze({
~~~~

`child` appears in `utils/activity/mod.ts:162`:

~~~~ typescript
await using owned = contextCore.child(options.ctx, { id: options.jobId });
	const ctx: Context<ActivityDefinition> = Object.freeze({
		id: owned.id,
		...(owned.traceId === undefined ? {} : { traceId: owned.traceId }),
~~~~

`deadline` appears in `utils/pool/mod.ts:261`:

~~~~ typescript
const timed = contextCore.deadline(borrowed, borrowed.clock.now().add(acquireTimeout));
		return Object.freeze({
			ctx: timed,
			timeout: acquireTimeout,
~~~~

`timeout` appears in `.agents/tests/public-api-repetition.test.ts:62`:

~~~~ typescript
await using firstTimeout = context.timeout(parent, { seconds: 2 });
		await using secondTimeout = context.timeout(parent, { seconds: 3 });
		assert.equal(context.cause(firstTimeout), undefined);
		const cancellation = new Error('repetition cancellation');
~~~~

`cancel` appears in `utils/resource/mod.ts:436`:

~~~~ typescript
context.cancel(this.#ctx, new CollectionDisposedError());
		this.#disposalPromise = this.#dispose();
		return this.#disposalPromise;
	}
~~~~

`check` appears in `utils/pool/mod.ts:215`:

~~~~ typescript
contextCore.check(startupCtx);
			} catch (error) {
				await closeRejectedValue(value, error);
			}
~~~~

`cause` appears in `.agents/tests/public-api-repetition.test.ts:64`:

~~~~ typescript
assert.equal(context.cause(firstTimeout), undefined);
		const cancellation = new Error('repetition cancellation');
		context.cancel(secondTimeout, cancellation);
		assert.equal(context.cause(secondTimeout), cancellation);
~~~~

`remaining` appears in `.agents/tests/public-api-matrix.test.ts:332`:

~~~~ typescript
assert.ok(context.remaining(owned)?.total({ unit: 'seconds', relativeTo: Temporal.PlainDate.from('2000-01-01') }) ?? 0 > 0);
			await owned[Symbol.asyncDispose]();
			assert.equal(result.match(result.ok('ok'), { ok: (value) => value, failure: () => 'bad' }), 'ok');
			assert.equal(result.getOr(result.fail('failure'), () => 'fallback'), 'fallback');
~~~~

`snapshot` appears in `utils/worker/mod.ts:399`:

~~~~ typescript
context: contextCore.snapshot(requestCtx),
				request: validated,
			});
			const response = new Promise<Response>((resolve, reject) => {
~~~~

`restore` appears in `utils/worker/mod.ts:228`:

~~~~ typescript
requestCtx = contextCore.restore(message.context);
			contextCore.check(requestCtx);
		} catch (error) {
			post(Object.freeze({ type: 'fault', id: requestId, fault: serializeFault(error) }));
~~~~

`Snapshot` appears in `utils/worker/mod.ts:629`:

~~~~ typescript
function isSnapshot(value: unknown): value is contextCore.Snapshot {
	return isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.startedAt === 'string' &&
~~~~

`Context` appears in `.agents/support/production-fixture.ts:47`:

~~~~ typescript
start(id: string, request: ImportRequest, ctx: context.Context): Promise<ImportRecord>;
}

interface Host {
~~~~

`Owned` appears in `utils/resource/mod.ts:327`:

~~~~ typescript
readonly #ctx: context.Owned;
	readonly #acquisitions = new Map<Definition, Promise<unknown>>();
	readonly #values = new Map<Definition, unknown>();
	readonly #disposalOrder: unknown[] = [];
~~~~

@utils/context/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `ChildOptions` | interface | Inputs accepted while deriving a child context. | `value: ChildOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Clock` | interface | Provider-neutral clock used by requests, activities, workflows, and tests. | `value: Clock` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Context` | interface | Cancellation, deadline, identity, and clock carried through one operation. | `value: Context` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CreateOptions` | interface | Inputs accepted while creating one owned operation context. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Owned` | interface | Independently owned context with deterministic cancellation and timer cleanup. | `value: Owned` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RestoreOptions` | interface | Inputs accepted while restoring a serializable snapshot. | `value: RestoreOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Snapshot` | interface | Serializable identity and timing data for one operation context. | `value: Snapshot` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 29 public names across 2 package export targets. 17 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

