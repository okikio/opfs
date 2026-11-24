/**
 * Errors the Deno KV driver throws.
 *
 * @module
 */
import { FileSystemError } from "../../error.ts";

/** A dispatched visibility commit whose outcome could not be reconciled from its own generation state. */
export class DenoKvCommitError extends FileSystemError {
  /** A lost response can follow an applied commit; retry requires application reconciliation. */
  readonly effect = "unknown" as const;
  /**
   * Creates the error.
   * @param operation Operation that failed.
   * @param path Path the operation used.
   * @param cause Failure that caused this error.
   */
  constructor(operation: string, path: string, cause: unknown) {
    super(
      "unknown",
      operation,
      path,
      "Deno KV visibility commit outcome is unknown; inspect logical state before replaying publication.",
      cause,
    );
  }
}
