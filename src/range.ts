/** Finite byte-range admission shared by the direct object protocol clients. @module */
import type { ObjectGetOptionsType } from "./driver/object.ts";

/** One operation owns range settings; it continues to borrow the actual caller signal. */
export interface RangeType {
  /** A zero-length read has no remote object acquisition or existence evidence. */
  readonly empty: boolean;
  /** Inclusive HTTP byte range, or absence for a complete object. */
  readonly header: string | undefined;
  /** Captured caller authority; no credential/transport is acquired during admission. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Admit complete safe-integer offsets before credentials or Fetch. A requested
 * length of zero returns an empty local stream, including beyond EOF. Nonzero
 * ranges retain the provider's ordinary status and EOF behavior. End arithmetic
 * is checked before addition; no rounding or clamping repairs an invalid input.
 */
export function range(options: ObjectGetOptionsType): RangeType {
  const signal = options.signal;
  if (signal?.aborted) throw signal.reason;
  const { at, length } = options;
  for (const value of [at, length]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("Object range offsets and lengths must be nonnegative safe integers.");
    }
  }
  const start = at ?? 0;
  if (length !== undefined && length > 0 && length - 1 > Number.MAX_SAFE_INTEGER - start) {
    throw new RangeError("Object range end exceeds the safe integer boundary.");
  }
  if (signal?.aborted) throw signal.reason;
  return Object.freeze({
    empty: length === 0,
    header: length === 0 || (at === undefined && length === undefined)
      ? undefined
      : `bytes=${start}-${length === undefined ? "" : start + length - 1}`,
    signal,
  });
}
