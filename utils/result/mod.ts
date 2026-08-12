/**
 * Minimal immutable success-or-failure values for explicit caller branching.
 *
 * This module deliberately has no schema, transport, retry, or failure-identity
 * dependency. The failure value can be any exact caller-defined reason type.
 *
 * @module
 */
/** Successful result variant. */
export interface Success<Value> {
	readonly ok: true;
	readonly value: Value;
}

/** Failed result variant. */
export interface Failure<Reason> {
	readonly ok: false;
	readonly failure: Reason;
}

/** Explicit success-or-failure result. */
export type Result<Value, Reason> = Success<Value> | Failure<Reason>;

/** Create an immutable successful result. */
export function ok<Value>(value: Value): Success<Value> {
	return Object.freeze({ ok: true, value });
}

/** Create an immutable failed result. */
export function fail<Reason>(failure: Reason): Failure<Reason> {
	return Object.freeze({ ok: false, failure });
}

/** Return whether a result is successful. */
export function isOk<Value, Reason>(value: Result<Value, Reason>): value is Success<Value> {
	return value.ok;
}

/** Return whether a result is failed. */
export function isFailure<Value, Reason>(value: Result<Value, Reason>): value is Failure<Reason> {
	return !value.ok;
}

/** Transform either result variant without losing explicit control flow. */
export function match<Value, Reason, SuccessResult, FailureResult>(
	value: Result<Value, Reason>,
	cases: Readonly<{
		readonly ok: (value: Value) => SuccessResult;
		readonly failure: (failure: Reason) => FailureResult;
	}>,
): SuccessResult | FailureResult {
	return value.ok ? cases.ok(value.value) : cases.failure(value.failure);
}

/** Return the success value or throw the supplied failure. */
export function unwrap<Value, Reason>(value: Result<Value, Reason>): Value {
	if (value.ok) return value.value;
	throw value.failure;
}

/** Return the success value or a caller-provided fallback. */
export function getOr<Value, Reason>(value: Result<Value, Reason>, fallback: Value | (() => Value)): Value {
	if (value.ok) return value.value;
	return typeof fallback === 'function' ? (fallback as () => Value)() : fallback;
}
