/**
 * Integer and limit checks for caller options and protocol values.
 *
 * Sizes, offsets, counts and limits in this package are JavaScript numbers.
 * A number above 2^53 - 1 or with a fraction loses precision silently, so a
 * later bound check could pass on the wrong value. These helpers refuse such
 * values up front with a `RangeError` that names the value.
 *
 * | Call                                          | Use it for                                   |
 * | --------------------------------------------- | -------------------------------------------- |
 * | `assertInteger(value, label, maximum?)`       | a statement that stops on a bad value        |
 * | `toInteger(value, label, maximum?)`           | an expression that passes the value on       |
 * | `resolveLimit(value, fallback, max, label)`   | an optional caller limit with a default      |
 *
 * @module
 */

/** Builds the error message for a value outside `[minimum, maximum]`. */
function describe(label: string, minimum: number, maximum: number): string {
  if (maximum === Number.MAX_SAFE_INTEGER) {
    if (minimum === 0) return `${label} must be a nonnegative safe integer.`;
    if (minimum === 1) return `${label} must be a positive safe integer.`;
  }
  return `${label} must be an integer from ${minimum} to ${maximum}.`;
}

/**
 * Throws a `RangeError` unless `value` is a safe integer from `minimum` to
 * `maximum`.
 *
 * @param label Names the value in the error, such as `"Box part size"`.
 * @param maximum Largest accepted value. Default `Number.MAX_SAFE_INTEGER`.
 * @param minimum Smallest accepted value. Default `0`.
 *
 * @example
 * ```ts
 * assertInteger(offset, "Read offset");
 * assertInteger(parts, "Part count", 10_000, 1);
 * ```
 */
export function assertInteger(
  value: number,
  label: string,
  maximum: number = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(describe(label, minimum, maximum));
  }
}

/**
 * Returns `value` after the {@link assertInteger} check.
 *
 * @example
 * ```ts
 * const size = toInteger(Number(header), "Dropbox content length", maxBytes);
 * ```
 */
export function toInteger(
  value: number,
  label: string,
  maximum: number = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  assertInteger(value, label, maximum, minimum);
  return value;
}

/**
 * Returns the caller's limit, or `fallback` when it is `undefined`, after
 * checking that it is a safe integer from `minimum` to `maximum`.
 *
 * Use it for options such as `maxEntries` where the caller may lower or raise
 * a default but never pass the implementation's ceiling.
 *
 * @example
 * ```ts
 * const maxFrames = resolveLimit(options.maxFrames, 1024, 65_536, "NATS frame limit", 1);
 * ```
 */
export function resolveLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
  minimum = 0,
): number {
  return toInteger(value ?? fallback, label, maximum, minimum);
}
