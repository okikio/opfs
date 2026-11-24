/**
 * Archive refusals: one error class with a stable code, and two constructors that format readers throw.
 *
 * Every archive reader in this package reports format, profile, budget and integrity refusals with
 * `ArchiveError`. A failure from the byte source or a codec keeps its own error instead.
 *
 * @module
 */
/** Stable failure categories for bounded archive inspection. */
export type ArchiveErrorCodeType = "invalid-archive" | "unsupported-profile" | "budget-exceeded" | "checksum-mismatch";

/** A format or policy failure; original source/codec failures retain their own errors. */
export class ArchiveError extends Error {
  /** Machine-readable refusal category, independent of explanatory message text. */
  readonly code: ArchiveErrorCodeType;

  /** Retain a format, profile, policy or integrity refusal without wrapping source failures. */
  constructor(code: ArchiveErrorCodeType, message: string) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

/**
 * Creates the `invalid-archive` error for bytes that break the format: a truncated header, a bad checksum
 * field, an offset outside the file.
 *
 * Call it with `throw` where parsing must stop, so the exit is visible at the call site:
 *
 * ```ts
 * if (header.length < 30) throw invalid("ZIP local header is truncated.");
 * ```
 *
 * Name the format and the broken rule in `message`; it reaches the caller unchanged.
 */
export function invalid(message: string): ArchiveError {
  return new ArchiveError("invalid-archive", message);
}

/**
 * Creates the `unsupported-profile` error for valid input that this reader does not implement, such as an
 * unknown compression method or a feature outside the selected profile.
 *
 * Call it with `throw`, like {@link invalid}: `throw unsupported("ZIP method 99 is not supported.");`. The
 * distinction tells a caller that another tool may read the file, while `invalid-archive` means no correct
 * reader can.
 */
export function unsupported(message: string): ArchiveError {
  return new ArchiveError("unsupported-profile", message);
}
