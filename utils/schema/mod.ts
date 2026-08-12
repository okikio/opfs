/**
 * Shared Standard Schema V1 validation and issue helpers.
 *
 * The module preserves provider issue data while giving callers one parse error
 * and one path-prefixing operation for composed structures.
 *
 * @module
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Failure, Output, Schema, Success, ValidationResult } from './types.ts';

/** Error raised when a value does not satisfy a Standard Schema contract. */
export class SchemaValidationError extends TypeError {
	readonly issues: readonly StandardSchemaV1.Issue[];

	constructor(issues: readonly StandardSchemaV1.Issue[], message?: string) {
		const details = issues.map((issue) => issue.message).filter((value) => value.length > 0).join('; ');
		super(message ?? (details.length === 0
			? 'Value does not satisfy the required schema.'
			: `Value does not satisfy the required schema: ${details}`));
		this.name = 'SchemaValidationError';
		this.issues = Object.freeze([...issues]);
	}
}

/** Return whether a value implements Standard Schema V1. */
export function is(value: unknown): value is Schema {
	if (typeof value !== 'object' || value === null) return false;
	const standard = (value as { readonly '~standard'?: unknown })['~standard'];
	return typeof standard === 'object' && standard !== null &&
		(standard as { readonly version?: unknown }).version === 1 &&
		typeof (standard as { readonly vendor?: unknown }).vendor === 'string' &&
		typeof (standard as { readonly validate?: unknown }).validate === 'function';
}

/** Validate an unknown value and normalize the Standard Schema result. */
export async function validate<Definition extends Schema>(
	definition: Definition,
	value: unknown,
): Promise<ValidationResult<Output<Definition>>> {
	assert(definition);
	const result = await definition['~standard'].validate(value);
	if (result.issues !== undefined) return failure(result.issues);
	return success(result.value as Output<Definition>);
}

/** Validate an unknown value or throw {@link SchemaValidationError}. */
export async function parse<Definition extends Schema>(
	definition: Definition,
	value: unknown,
): Promise<Output<Definition>> {
	const result = await validate(definition, value);
	if (result.issues !== undefined) throw new SchemaValidationError(result.issues);
	return result.value;
}

/** Assert that a value implements Standard Schema V1. */
export function assert(value: unknown, name = 'schema'): asserts value is Schema {
	if (!is(value)) throw new TypeError(`${name} must implement Standard Schema V1.`);
}

/** Prefix validation issue paths while preserving vendor-specific issue fields. */
export function prefixIssues(
	issues: readonly StandardSchemaV1.Issue[],
	...path: readonly PropertyKey[]
): readonly StandardSchemaV1.Issue[] {
	return Object.freeze(issues.map((issue) => Object.freeze({
		...issue,
		path: [...path, ...(issue.path ?? [])],
	})));
}

/**
 * Creates the successful success shape used by the surrounding module.
 *
 * @internal
 */
function success<Value>(value: Value): Success<Value> {
	return Object.freeze({ value });
}

/**
 * Builds the failure used when the surrounding module cannot complete as intended.
 *
 * @internal
 */
function failure(issues: readonly StandardSchemaV1.Issue[]): Failure {
	return Object.freeze({ issues: Object.freeze([...issues]) });
}

export type * from './types.ts';
