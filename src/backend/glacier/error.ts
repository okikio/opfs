/**
 * Errors the Glacier client throws.
 *
 * @module
 */
import type { GlacierReceiptType } from "./types.ts";

/** A failed provider response retains its request identity; no credential or payload is copied into the error. */
export class GlacierError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly code: string | undefined;
  /** Creates the error. */
  constructor(response: Response, code?: string) {
    super(`Glacier request failed with HTTP ${response.status}${code === undefined ? "" : ` (${code})`}.`);
    this.name = "GlacierError";
    this.status = response.status;
    this.requestId = response.headers.get("x-amzn-requestid") ?? undefined;
    this.code = code;
  }
}

/** A dispatched mutation may have succeeded even when its receipt was lost. A known receipt survives cleanup failure. */
export class GlacierPublicationError extends Error {
  readonly operation: string;
  readonly outcome: "unknown" | "confirmed";
  readonly receipt: GlacierReceiptType | undefined;
  /**
   * Creates the error.
   * @param operation Operation that failed.
   * @param cause Failure that caused this error.
   */
  constructor(operation: string, cause: unknown, receipt?: GlacierReceiptType) {
    super(
      `Glacier ${operation} ${
        receipt === undefined
          ? "has an unknown publication outcome"
          : "returned a publication identity but validation or retirement failed"
      }.`,
      { cause },
    );
    this.name = "GlacierPublicationError";
    this.operation = operation;
    this.outcome = receipt === undefined ? "unknown" : "confirmed";
    this.receipt = receipt;
  }
}
