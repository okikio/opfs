import { FileSystemError, toFileSystemError } from "./error.ts";
import type { FileDriverSyncFileType } from "./driver/file.ts";
import type { HeldLockType } from "./lock.ts";

/**
 * Synchronous file facade returned by `openSyncFile()` and handle-compatible
 * `createSyncAccessHandle()`.
 *
 * The caller owns this resource. Close it explicitly or use `using` so the
 * adapter's native file lock and the facade mutation lock are both released.
 */
export interface SyncFileType extends Disposable {
  /** Canonical virtual path whose mutation lock is owned by this resource. */
  readonly path: string;
  /** True after the underlying adapter file has been closed. */
  readonly closed: boolean;
  /** Reads into `buffer` and returns bytes read. */
  read(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Writes from `buffer` and returns bytes written. */
  write(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Repeats partial writes until all bytes are written. */
  writeAll(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Returns current file byte length. */
  getSize(): number;
  /** Changes current file byte length. */
  truncate(size: number): void;
  /** Requests backend durability for current writes. */
  flush(): void;
  /** Releases the adapter file and mutation lock. */
  close(): void;
}

/** Owns one adapter synchronous file for the complete lock lifetime. */
export class ManagedSyncFile implements SyncFileType {
  /** Canonical virtual path whose mutation lock is owned by this resource. */
  readonly path: string;
  /** Native adapter resource. `undefined` is the sole closed-state marker. */
  #file: FileDriverSyncFileType | undefined;
  /** Facade mutation lock held for exactly the same lifetime as `#file`. */
  readonly #lock: HeldLockType;

  /** Takes ownership of the adapter file and matching facade lock as one lifetime. */
  constructor(path: string, file: FileDriverSyncFileType, lock: HeldLockType) {
    this.path = path;
    this.#file = file;
    this.#lock = lock;
  }

  /** Reports closure from the single native-resource marker instead of duplicating state. */
  get closed(): boolean {
    return this.#file === undefined;
  }

  /** Returns the live native file or rejects use after close. */
  #getFile(): FileDriverSyncFileType {
    if (this.#file === undefined) {
      throw new FileSystemError(
        "invalid-operation",
        "sync-file",
        this.path,
        `Sync file '${this.path}' is already closed.`,
      );
    }
    return this.#file;
  }

  /** Reads synchronously and normalizes backend errors to package error categories. */
  read(buffer: ArrayBufferView, options?: { readonly at?: number }): number {
    try {
      return this.#getFile().read(buffer, options);
    } catch (error) {
      throw toFileSystemError(error, "sync-read", this.path);
    }
  }

  /** Writes one synchronous chunk and returns the backend-reported progress. */
  write(buffer: ArrayBufferView, options?: { readonly at?: number }): number {
    try {
      return this.#getFile().write(buffer, options);
    } catch (error) {
      throw toFileSystemError(error, "sync-write", this.path);
    }
  }

  /** Repeats partial synchronous writes and fails if the backend stops making progress. */
  writeAll(buffer: ArrayBufferView, options?: { readonly at?: number }): number {
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const start = options?.at;
    let written = 0;

    while (written < source.byteLength) {
      const remaining = source.subarray(written);
      const count = start === undefined ? this.write(remaining) : this.write(remaining, { at: start + written });
      if (count <= 0) {
        throw new FileSystemError(
          "invalid-operation",
          "sync-write",
          this.path,
          `Sync write made no progress for '${this.path}'.`,
        );
      }
      written += count;
    }
    return written;
  }

  /** Returns the current backend file size. */
  getSize(): number {
    try {
      return this.#getFile().getSize();
    } catch (error) {
      throw toFileSystemError(error, "sync-size", this.path);
    }
  }

  /** Validates the requested length and then resizes the backend file synchronously. */
  truncate(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("truncate size must be a non-negative safe integer.");
    }
    try {
      this.#getFile().truncate(size);
    } catch (error) {
      throw toFileSystemError(error, "sync-truncate", this.path);
    }
  }

  /** Requests backend durability without releasing either owned resource. */
  flush(): void {
    try {
      this.#getFile().flush();
    } catch (error) {
      throw toFileSystemError(error, "sync-flush", this.path);
    }
  }

  /** Closes once and always releases the facade lock even when backend close throws. */
  close(): void {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    try {
      file.close();
    } finally {
      this.#lock.release();
    }
  }

  /** Enables `using` to release the same resources as {@link close}. */
  [Symbol.dispose](): void {
    this.close();
  }
}
