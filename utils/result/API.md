@utils/result public API usage
==============================

Purpose
-------

This reference maps every public export target declared by `@utils/result` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/result
-------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `fail` | function | Create an immutable failed result. | `fail(...)` | `utils/activity/mod.ts:142` uses `fail`. |
| `Failure` | interface | Failed result variant. | `value: Failure` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `getOr` | function | Return the success value or a caller-provided fallback. | `getOr(...)` | `.agents/tests/public-api-matrix.test.ts:335` uses `getOr`. |
| `isFailure` | function | Return whether a result is failed. | `isFailure(...)` | `.agents/tests/production-e2e.test.ts:152` uses `isFailure`. |
| `isOk` | function | Return whether a result is successful. | `isOk(...)` | `.agents/tests/production-e2e.test.ts:151` uses `isOk`. |
| `match` | function | Transform either result variant without losing explicit control flow. | `match(...)` | `.agents/tests/public-api-matrix.test.ts:334` uses `match`. |
| `ok` | function | Create an immutable successful result. | `ok(...)` | `utils/activity/mod.ts:140` uses `ok`. |
| `Result` | type | Explicit success-or-failure result. | `value: Result` | `utils/activity/types.ts:124` uses `Result`. |
| `Success` | interface | Successful result variant. | `value: Success` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `unwrap` | function | Return the success value or throw the supplied failure. | `unwrap(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`Result` appears in `utils/activity/types.ts:124`:

~~~~ typescript
export type TryResult<ActivityDefinition extends Definition> = ExplicitResult<Result<ActivityDefinition>, Failures<ActivityDefinition>>;

/** Yieldable activity execution operation. */
export type RunOperation<ActivityDefinition extends Definition> = Operation<Result<ActivityDefinition>, Failures<ActivityDefinition>>;
~~~~

`ok` appears in `utils/activity/mod.ts:140`:

~~~~ typescript
return resultCore.ok(yield* run(definition, input, options));
			} catch (reason) {
				if (isDeclaredFailure(definition, reason)) return resultCore.fail(reason as Failures<ActivityDefinition>);
				throw reason;
~~~~

`fail` appears in `utils/activity/mod.ts:142`:

~~~~ typescript
if (isDeclaredFailure(definition, reason)) return resultCore.fail(reason as Failures<ActivityDefinition>);
				throw reason;
			}
		},
~~~~

`isOk` appears in `.agents/tests/production-e2e.test.ts:151`:

~~~~ typescript
assert.equal(result.isOk(result.ok('ok')), true);
		assert.equal(result.isFailure(result.fail('no')), true);
		assert.equal(schema.is(Text), true);
		assert.deepEqual(runtime.document(runtime.compose(runtime.define({ id: 'validation.inline', description: 'Inline runtime.' }))), [
~~~~

`isFailure` appears in `.agents/tests/production-e2e.test.ts:152`:

~~~~ typescript
assert.equal(result.isFailure(result.fail('no')), true);
		assert.equal(schema.is(Text), true);
		assert.deepEqual(runtime.document(runtime.compose(runtime.define({ id: 'validation.inline', description: 'Inline runtime.' }))), [
			{ id: 'validation.inline', description: 'Inline runtime.' },
~~~~

`match` appears in `.agents/tests/public-api-matrix.test.ts:334`:

~~~~ typescript
assert.equal(result.match(result.ok('ok'), { ok: (value) => value, failure: () => 'bad' }), 'ok');
			assert.equal(result.getOr(result.fail('failure'), () => 'fallback'), 'fallback');
			assert.equal(classifyCsvHeader(index === 0 ? 'website_url' : 'company domain'), index === 0 ? 'website' : 'domain');
			const readable = streams.readable([1, 2, 3]);
~~~~

`getOr` appears in `.agents/tests/public-api-matrix.test.ts:335`:

~~~~ typescript
assert.equal(result.getOr(result.fail('failure'), () => 'fallback'), 'fallback');
			assert.equal(classifyCsvHeader(index === 0 ? 'website_url' : 'company domain'), index === 0 ? 'website' : 'domain');
			const readable = streams.readable([1, 2, 3]);
			const values: number[] = [];
~~~~

Coverage note
-------------

This generated map contains 10 public names across 1 package export targets. 7 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

