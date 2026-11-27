/**
 * Errors the GCS client throws.
 *
 * @module
 */

/** Provider HTTP failure without credential-bearing URLs in its message. */
export class GcsError extends Error {
  readonly status: number;
  readonly response: Response;
  /** Creates the error. */
  constructor(response: Response) {
    super(`Google Cloud Storage request failed with HTTP ${response.status}.`);
    this.name = "GcsError";
    this.status = response.status;
    this.response = response;
  }
}

/** A dispatched publication has no validated acknowledgement; query its session. */
export class GcsPublicationError extends Error {
  readonly key: string;
  /**
   * Creates the error.
   * @param key Key the operation used.
   * @param cause Failure that caused this error.
   */
  constructor(key: string, cause: unknown) {
    super("Google Cloud Storage publication could not be attributed from its acknowledgement.", { cause });
    this.name = "GcsPublicationError";
    this.key = key;
  }
}
