import type { ErrorCodeType } from "./_schema_types.ts";
import { ErrorCodeSchema } from "./schema.ts";
import { getPrimary } from "./close.ts";
import { getCancellation } from "./abort.ts";

/**
 * Error returned by the high-level filesystem and first-party adapters.
 *
 * `code` is stable package vocabulary. `operation` identifies the public or
 * adapter operation. `path` identifies the affected virtual path when one
 * exists. The original runtime failure remains available through `cause`.
 * When an operation and its owned retirement both fail, normalization keeps
 * the actual primary category and exposes every event in the aggregate cause.
 * Equal-valued events remain separate. A supplied undefined cause is retained
 * as an own property; an omitted cause stays absent.
 */
export class FileSystemError extends Error {
  /** Stable category for programmatic branching. */
  readonly code: ErrorCodeType;
  /** Operation that failed, such as `read`, `write`, or `move`. */
  readonly operation: string;
  /** Canonical virtual path associated with the failure. */
  readonly path?: string;
  /** Original runtime or adapter failure. */
  declare readonly cause?: unknown;

  /** Creates one normalized filesystem failure. */
  constructor(code: ErrorCodeType, operation: string, path: string | undefined, message: string, cause?: unknown) {
    super(message, arguments.length >= 5 ? { cause } : undefined);
    this.name = "FileSystemError";
    this.code = code;
    this.operation = operation;
    if (path !== undefined) this.path = path;
  }
}

/** Returns an Error-like name without relying on same-realm `instanceof`. */
export function getErrorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = Reflect.get(error, "name");
    if (typeof name === "string") return name;
  }
  return "Error";
}

/**
 * Reconstructs a package error thrown by another worker or iframe realm.
 *
 * `instanceof` is realm-specific. The public error fields are deliberately
 * serializable, so the normalizer recognizes that stable shape and creates a
 * local {@link FileSystemError} without degrading its code to `unknown`.
 */
function fromForeignFileSystemError(error: unknown): FileSystemError | undefined {
  if (typeof error !== "object" || error === null || getErrorName(error) !== "FileSystemError") return undefined;
  const code = ErrorCodeSchema.safeParse(Reflect.get(error, "code"));
  const operation = Reflect.get(error, "operation");
  const path = Reflect.get(error, "path");
  if (!code.success || typeof operation !== "string") return undefined;
  if (path !== undefined && typeof path !== "string") return undefined;
  const cause = Reflect.get(error, "cause");
  return new FileSystemError(
    code.data,
    operation,
    path,
    getErrorMessage(error),
    Object.hasOwn(error, "cause") ? cause : error,
  );
}

/** Returns a runtime error code such as `ENOENT` when one is exposed. */
function getRuntimeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** Returns an Error-like message without relying on same-realm `instanceof`. */
export function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string") return message;
  }
  return String(error);
}

/**
 * Maps common browser and server filesystem failures into {@link FileSystemError}.
 *
 * Adapters can call this function for native errors. Database adapters should
 * wrap provider-specific failures with the most precise category they can prove.
 * Only the internal release owner can identify an aggregate's primary event.
 * An arbitrary aggregate's cause or first member does not assign its category.
 */
export function toFileSystemError(error: unknown, operation: string, path?: string): FileSystemError {
  if (error instanceof FileSystemError) return error;
  // Only an attempt-owned abort winner grants this category. A concrete
  // operation rejection beside a caller event keeps its own primary category,
  // even when both observations have the same value.
  const cancellation = getCancellation(error);
  if (cancellation?.primary.kind === "abort") {
    const location = path === undefined ? "" : ` for '${path}'`;
    return new FileSystemError("aborted", operation, path, `${operation} was aborted${location}.`, error);
  }
  // Only our release owner can identify a primary event in an aggregate. A
  // foreign AggregateError's cause or first member grants no such authority.
  // Keep the primary category for callers, while the complete aggregate remains
  // the cause so an independently failed release cannot disappear.
  const primary = getPrimary(error);
  if (primary !== undefined) {
    const mapped = toFileSystemError(primary.reason, operation, path);
    return new FileSystemError(mapped.code, mapped.operation, mapped.path, mapped.message, error);
  }
  const foreign = fromForeignFileSystemError(error);
  if (foreign !== undefined) return foreign;

  const name = getErrorName(error);
  const runtimeCode = getRuntimeErrorCode(error);
  let code: FileSystemError["code"] = "unknown";
  switch (runtimeCode ?? name) {
    case "AbortError":
      code = "aborted";
      break;
    case "NotFoundError":
    case "ENOENT":
      code = "not-found";
      break;
    case "AlreadyExists":
    case "EEXIST":
      code = "already-exists";
      break;
    case "TypeMismatchError":
    case "ENOTDIR":
    case "EISDIR":
      code = "type-mismatch";
      break;
    case "NoModificationAllowedError":
    case "EBUSY":
      code = "locked";
      break;
    case "QuotaExceededError":
    case "ENOSPC":
      code = "quota-exceeded";
      break;
    case "NotAllowedError":
    case "SecurityError":
    case "EACCES":
    case "EPERM":
      code = "permission-denied";
      break;
    case "NotSupportedError":
    case "ENOTSUP":
      code = "not-supported";
      break;
    case "InvalidModificationError":
    case "InvalidStateError":
      code = "invalid-operation";
      break;
    case "UnknownError":
      code = operation === "open" ? "unavailable" : "unknown";
      break;
  }

  const location = path === undefined ? "" : ` '${path}'`;
  return new FileSystemError(code, operation, path, `${operation} failed${location}: ${getErrorMessage(error)}`, error);
}

/** Throws a stable cancellation failure when the supplied signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string, path?: string): void {
  if (!signal?.aborted) return;
  const suffix = path === undefined ? "" : ` for '${path}'`;
  throw new FileSystemError("aborted", operation, path, `${operation} was aborted${suffix}.`, signal.reason);
}
