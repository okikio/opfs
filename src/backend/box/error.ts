/**
 * Errors the Box client throws.
 *
 * @module
 */

/** Fixed messages exclude signed URLs, tokens and raw provider bodies. */
export class BoxError extends Error {
  readonly status: number;
  /**
   * Creates the error.
   * @param status HTTP status the service returned.
   */
  constructor(status: number) {
    super(`Box request failed with HTTP ${status}.`);
    this.name = "BoxError";
    this.status = status;
  }
}

/** A dispatched mutation without a validated receipt must not be blindly repeated. */
export class BoxPublicationError extends Error {
  /**
   * Creates the error.
   * @param cause Failure that caused this error.
   */
  constructor(cause: unknown) {
    super("Box mutation has no validated acknowledgement; reconcile before retrying.", { cause });
    this.name = "BoxPublicationError";
  }
}

/** A version may exist while its download capability is not ready yet. */
export class BoxPendingError extends Error {
  readonly retryAfterSeconds: number;
  /** Creates the error. */
  constructor(seconds: number) {
    super("Box file content is not ready.");
    this.name = "BoxPendingError";
    this.retryAfterSeconds = seconds;
  }
}
