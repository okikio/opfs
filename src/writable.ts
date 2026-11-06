import type { WritableInspectionType } from "./driver/file.ts";
import type { FileDriverWritableFileType } from "./driver/file.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "./error.ts";
import type { HeldLockType } from "./lock.ts";

/**
 * Long-lived asynchronous positional file returned by `openWritableFile()`.
 *
 * The resource owns the facade mutation lock for its complete lifetime. Calls
 * can therefore rewrite earlier byte ranges without reopening the backend file
 * and without racing another mutation through the same filesystem facade.
 *
 * `close()` commits backend staging where the adapter supports it. `abort()`
 * discards staged changes when possible. A host filesystem cannot generally
 * roll back bytes already written, so callers that need all-or-nothing output
 * should write to a staging path and move it only after a successful close.
 */
export interface WritableFileType {
  /** Canonical virtual path whose mutation lock is owned by this resource. */
  readonly path: string;
  /** True once terminal admission stops ordinary operations; inspection reports pending native settlement. */
  readonly closed: boolean;
  /** Detached resource admission budgets and pending work. */
  inspect?(): WritableInspectionType | undefined;
  /** Writes all bytes at one explicit zero-based position. */
  write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void>;
  /** Changes current byte length. */
  truncate(size: number): Promise<void>;
  /** Requests backend durability without releasing the resource. */
  flush(): Promise<void>;
  /** Commits backend staging when applicable and releases the mutation lock. */
  close(): Promise<void>;
  /** Discards backend staging when possible and releases the mutation lock. */
  abort(reason?: unknown): Promise<void>;
}

/** Owns one adapter writable file for the same lifetime as one facade lock. */
export class ManagedWritableFile implements WritableFileType {
  /** Canonical virtual path whose exclusive mutation ownership lasts until settlement. */
  readonly path: string;
  /** Adapter positional file. `undefined` is the sole terminal-state marker. */
  #file: FileDriverWritableFileType | undefined;
  /** Retains only the resource object for detached inspection after terminal admission. */
  readonly #resource: FileDriverWritableFileType;
  #terminal: Promise<void> | undefined;
  /** Facade mutation lock released exactly when the adapter file settles. */
  readonly #lock: HeldLockType;
  /** Optional operation signal checked before and after mutable backend work. */
  readonly #signal: AbortSignal | undefined;

  /** Takes ownership of one adapter positional file and its matching facade lock. */
  constructor(
    path: string,
    file: FileDriverWritableFileType,
    lock: HeldLockType,
    signal?: AbortSignal,
  ) {
    this.path = path;
    this.#file = file;
    this.#resource = file;
    this.#lock = lock;
    this.#signal = signal;
  }

  inspect(): WritableInspectionType | undefined {
    return this.#resource.inspect?.();
  }

  /** Reports terminal state from the adapter-resource marker without duplicating lifecycle state. */
  get closed(): boolean {
    return this.#file === undefined;
  }

  /** Returns the live backend file and rejects ordinary work after termination. */
  #getFile(operation: string): FileDriverWritableFileType {
    if (this.#file === undefined) {
      throw new FileSystemError(
        "invalid-operation",
        operation,
        this.path,
        `Writable file '${this.path}' is already closed.`,
      );
    }
    throwIfAborted(this.#signal, operation, this.path);
    return this.#file;
  }

  /** Writes one complete byte view at an explicit position and rejects partial facade semantics. */
  async write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    if (!Number.isSafeInteger(options.at) || options.at < 0) {
      throw new RangeError("write position must be a non-negative safe integer.");
    }
    try {
      await this.#getFile("positional-write").write(buffer, options);
      throwIfAborted(this.#signal, "positional-write", this.path);
    } catch (error) {
      throw toFileSystemError(error, "positional-write", this.path);
    }
  }

  /** Changes file length while preserving the same adapter resource and mutation lock. */
  async truncate(size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("truncate size must be a non-negative safe integer.");
    }
    try {
      await this.#getFile("positional-truncate").truncate(size);
      throwIfAborted(this.#signal, "positional-truncate", this.path);
    } catch (error) {
      throw toFileSystemError(error, "positional-truncate", this.path);
    }
  }

  /** Requests backend durability without ending positional-write ownership. */
  async flush(): Promise<void> {
    try {
      await this.#getFile("positional-flush").flush();
      throwIfAborted(this.#signal, "positional-flush", this.path);
    } catch (error) {
      throw toFileSystemError(error, "positional-flush", this.path);
    }
  }

  /** Reserves the winning terminal result and releases ownership after native settlement. */
  #finish(operation: "close" | "abort", reason?: unknown): Promise<void> {
    if (this.#terminal !== undefined) return this.#terminal;
    const file = this.#file!;
    this.#file = undefined;
    this.#terminal = Promise.resolve().then(() => operation === "close" ? file.close() : file.abort(reason))
      .catch((error) => {
        throw toFileSystemError(error, `positional-${operation}`, this.path);
      })
      .finally(() => this.#lock.release());
    return this.#terminal;
  }

  /** Waits for accepted operations, commits staging where applicable, then releases the lock. */
  close(): Promise<void> {
    return this.#finish("close");
  }

  /** Waits for accepted operations and discards supported staging; ignores an already-aborted signal. */
  abort(reason?: unknown): Promise<void> {
    return this.#finish("abort", reason);
  }
}
