/**
 * Errors the Azure Blob client throws.
 *
 * @module
 */

/** Structured Azure Blob REST failure with provider request identity retained. */
export class AzureError extends Error {
  /** HTTP status returned by Azure. */
  readonly status: number;
  /** Azure service error code when present. */
  readonly code?: string;
  /** Azure request identity when present. */
  readonly requestId?: string;
  /** Original response. */
  readonly response: Response;

  /** Creates a provider-aware error without discarding the original response. */
  constructor(
    message: string,
    response: Response,
    details: {
      code?: string;
      requestId?: string;
      /** Secondary response-body read or XML parse failure, including undefined and null. */
      cause?: unknown;
    } = {},
  ) {
    super(message, Object.hasOwn(details, "cause") ? { cause: details.cause } : undefined);
    this.name = "AzureError";
    this.status = response.status;
    this.response = response;
    if (details.code !== undefined) this.code = details.code;
    if (details.requestId !== undefined) this.requestId = details.requestId;
  }
}

/** A dispatched publication lost its acknowledgement; inspect before retrying. */
export class AzureCommitError extends Error {
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
    this.name = "AzureCommitError";
    this.key = key;
  }
}
