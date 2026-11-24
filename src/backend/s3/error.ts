/**
 * Errors the S3 client throws.
 *
 * @module
 */

/** Parsed S3 service failure with provider request identities retained. */
export class S3Error extends Error {
  /** HTTP status returned by the provider. */
  readonly status: number;
  /** S3 service error code when the response included one. */
  readonly code?: string;
  /** S3 request identity when available. */
  readonly requestId?: string;
  /** S3 host identity when available. */
  readonly hostId?: string;
  /** Original response. */
  readonly response: Response;

  /** Creates a provider-aware S3 failure without discarding the original response. */
  constructor(
    message: string,
    response: Response,
    details: {
      code?: string;
      requestId?: string;
      hostId?: string;
      /** Secondary response-body read or XML parse failure, including undefined and null. */
      cause?: unknown;
    } = {},
  ) {
    super(message, Object.hasOwn(details, "cause") ? { cause: details.cause } : undefined);
    this.name = "S3Error";
    this.status = response.status;
    this.response = response;
    if (details.code !== undefined) this.code = details.code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
    if (details.hostId !== undefined) this.hostId = details.hostId;
  }
}

/** A dispatched publication lost its acknowledgement; inspect before retrying. */
export class S3CommitError extends Error {
  /** The provider may have published the requested object. */
  readonly effect = "unknown";
  /** Exact object whose publication needs reconciliation. */
  readonly key: string;
  /**
   * Creates the error.
   * @param key Key the operation used.
   * @param cause Failure that caused this error.
   */
  constructor(key: string, cause: unknown) {
    super(`Publication of '${key}' has an unknown outcome.`, { cause });
    this.name = "S3CommitError";
    this.key = key;
  }
}
