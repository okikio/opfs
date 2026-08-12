@utils/schema public API usage
==============================

Purpose
-------

This reference maps every public export target declared by `@utils/schema` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/schema
-------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `assert` | function | Assert that a value implements Standard Schema V1. | `assert(...)` | `utils/activity/mod.ts:60` uses `assert`. |
| `Failure` | type | Failed Standard Schema validation result. | `value: Failure` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input type accepted by a Standard Schema contract. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value implements Standard Schema V1. | `is(...)` | `utils/codec/mod.ts:41` uses `is`. |
| `Output` | type | Validated output type produced by a Standard Schema contract. | `value: Output` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parse` | function | Validate an unknown value or throw {@link SchemaValidationError}. | `parse(...)` | `utils/activity/mod.ts:161` uses `parse`. |
| `prefixIssues` | function | Prefix validation issue paths while preserving vendor-specific issue fields. | `prefixIssues(...)` | `utils/codec/mod.ts:163` uses `prefixIssues`. |
| `Schema` | type | Standard Schema contract accepted by reusable utility packages. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SchemaValidationError` | class | Error raised when a value does not satisfy a Standard Schema contract. | `new SchemaValidationError(...)` | `.agents/tests/production-e2e.test.ts:187` uses `SchemaValidationError`. |
| `Success` | type | Successful Standard Schema validation result. | `value: Success` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validate` | function | Validate an unknown value and normalize the Standard Schema result. | `validate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationResult` | type | Validation result normalized by this package. | `value: ValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`SchemaValidationError` appears in `.agents/tests/production-e2e.test.ts:187`:

~~~~ typescript
await assert.rejects(() => codec.decode(codec.define({ decode: Text, encode: Text }), 42), schema.SchemaValidationError);
		assert.throws(() => resilience.retry({ maximumAttempts: 0 }), TypeError);
		assert.throws(() => query.define({ fields: {}, pagination: query.cursor() }), TypeError);
		await assert.rejects(() => streams.collect([1, 2], { maximumItems: 1 }), streams.StreamLimitError);
~~~~

`is` appears in `utils/codec/mod.ts:41`:

~~~~ typescript
schema.is((value as { readonly decode?: unknown }).decode) &&
		schema.is((value as { readonly encode?: unknown }).encode);
}
~~~~

`parse` appears in `utils/activity/mod.ts:161`:

~~~~ typescript
const input = await schema.parse(definition.input, options.input) as Input<ActivityDefinition>;
	await using owned = contextCore.child(options.ctx, { id: options.jobId });
	const ctx: Context<ActivityDefinition> = Object.freeze({
		id: owned.id,
~~~~

`assert` appears in `utils/activity/mod.ts:60`:

~~~~ typescript
schema.assert(input.input, 'activity input schema');
	schema.assert(input.result, 'activity result schema');
	const runtimes = catalogCore.compose(input.runtimes);
	if (runtimes.length === 0) throw new TypeError('Activity definitions must allow at least one runtime.');
~~~~

`prefixIssues` appears in `utils/codec/mod.ts:163`:

~~~~ typescript
if (child.issues !== undefined) issues.push(...schema.prefixIssues(child.issues, key));
					else output[key] = child.value;
				}
				return issues.length > 0
~~~~

@utils/schema/types
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Failure` | type | Failed Standard Schema validation result. | `value: Failure` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input type accepted by a Standard Schema contract. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Output` | type | Validated output type produced by a Standard Schema contract. | `value: Output` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Schema` | type | Standard Schema contract accepted by reusable utility packages. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Success` | type | Successful Standard Schema validation result. | `value: Success` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationResult` | type | Validation result normalized by this package. | `value: ValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 18 public names across 2 package export targets. 5 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

