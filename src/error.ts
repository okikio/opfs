import type { ErrorCodeType } from "./schema.ts";

/**
 * Error returned by the high-level filesystem and first-party adapters.
 *
 * `code` is stable package vocabulary. `operation` identifies the public or
 * adapter operation. `path` identifies the affected virtual path when one
 * exists. The original runtime failure remains available through `cause`.
 */
export class FileSystemError extends Error {
  /** Stable category for programmatic branching. */
  readonly code: ErrorCodeType;
  /** Operation that failed, such as `read`, `write`, or `move`. */
  readonly operation: string;
  /** Canonical virtual path associated with the failure. */
  readonly path?: string;
  /** Original runtime or adapter failure. */
  override readonly cause?: unknown;

  /** Creates one normalized filesystem failure. */
  constructor(code: ErrorCodeType, operation: string, path: string | undefined, message: string, cause?: unknown) {
    super(message);
    this.name = "FileSystemError";
    this.code = code;
    this.operation = operation;
    if (path !== undefined) this.path = path;
    if (cause !== undefined) this.cause = cause;
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
 */
export function toFileSystemError(error: unknown, operation: string, path?: string): FileSystemError {
  if (error instanceof FileSystemError) return error;

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
