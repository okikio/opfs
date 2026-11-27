/**
 * Errors the Netlify Blobs client throws.
 *
 * @module
 */
import type { NetlifyReceiptType } from "./types.ts";

/** Library-owned messages exclude credentials, capability queries and response text. */
export class NetlifyError extends Error {
  /** Stable local policy, format, authorization or native HTTP failure category. */
  readonly code: "invalid-response" | "budget-exceeded" | "http" | "capability-refused";
  /** Account API or credential-free data capability phase. */
  readonly phase: "api" | "data";
  /** Native status when a response was received. */
  readonly status: number | undefined;
  /** Preserve structured observations without embedding sensitive response text or URLs. */
  constructor(code: NetlifyError["code"], phase: "api" | "data", status?: number) {
    super(`Netlify ${phase} request ${code}${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "NetlifyError";
    this.code = code;
    this.phase = phase;
    this.status = status;
  }
}

/** A dispatched mutation lacks an admitted completion. Reconcile before any caller-owned retry. */
export class NetlifyPublicationError extends Error {
  /** No rollback, absence or safe replay follows from this failure. */
  readonly outcome = "unknown";
  /** The dispatched mutation requiring caller reconciliation. */
  readonly operation: "put" | "delete";
  /** Original key to reconcile. */
  readonly key: string;
  /** Retain the original failure, including an undefined rejection reason. */
  constructor(operation: "put" | "delete", key: string, cause: unknown) {
    super("Netlify mutation outcome is unknown; reconcile the key before retrying.", { cause });
    this.name = "NetlifyPublicationError";
    this.operation = operation;
    this.key = key;
  }
}

/** Preserve an already-known acknowledgement beside a later parsing, abort or cleanup failure. */
export class NetlifyCompletionError extends Error {
  /** Known final observation, updated with work through the later failure. */
  readonly receipt: NetlifyReceiptType;
  /** A cleanup/admission failure does not revoke the already-known receipt. */
  constructor(receipt: NetlifyReceiptType, cause: unknown) {
    super("Netlify acknowledged the mutation before completion or cleanup failed.", { cause });
    this.name = "NetlifyCompletionError";
    this.receipt = receipt;
  }
}
