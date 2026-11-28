/// <reference types="deno" />
/** Queued positional access owns one Deno file until the winning close or abort retires it. @module */
import { toView } from "../../bytes.ts";
import type { FileDriverWritableFileType } from "../../driver/file.ts";
import { QueuedWritableFile, type WritableOptionsType } from "../../driver/writable.ts";
import type { PathType } from "../../path.ts";

/**
 * Long-lived Deno positional file used by the driver's asynchronous random
 * access capability.
 *
 * Normal Deno files cannot roll back bytes already written. `abort()` therefore
 * means release without additional commit work, not transactional rollback.
 */
class DenoFile implements FileDriverWritableFileType {
  /** Canonical virtual path used in lifecycle diagnostics. */
  readonly #path: PathType;
  /** Native Deno file, cleared before terminal close/abort. */
  #file: Deno.FsFile | undefined;

  /** Takes ownership of one already-open Deno file. */
  constructor(path: PathType, file: Deno.FsFile) {
    this.#path = path;
    this.#file = file;
  }

  /** Returns the live Deno file or rejects access after termination. */
  #getFile(): Deno.FsFile {
    if (this.#file === undefined) throw new Error(`Writable file '${this.#path}' is closed.`);
    return this.#file;
  }

  /** Writes all bytes at one explicit position, including partial native writes. */
  async write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    const source = toView(buffer);
    const file = this.#getFile();
    await file.seek(options.at, Deno.SeekMode.Start);
    let offset = 0;
    while (offset < source.byteLength) {
      const count = await file.write(source.subarray(offset));
      if (count <= 0) throw new Error(`Deno positional write made no progress for '${this.#path}'.`);
      offset += count;
    }
  }

  /** Changes native file length without releasing the resource. */
  async truncate(size: number): Promise<void> {
    await this.#getFile().truncate(size);
  }

  /** Requests Deno's file sync operation. */
  async flush(): Promise<void> {
    await this.#getFile().sync();
  }

  /** Closes once and clears the native resource before close returns. */
  async close(): Promise<void> {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    file.close();
  }

  /** Releases the file without claiming rollback of already-written host bytes. */
  async abort(): Promise<void> {
    await this.close();
  }
}

/** Ordered native resource; direct construction preserves complete seek/write admission order. */
export class DenoWritableFile extends QueuedWritableFile {
  /**
   * Wraps an open Deno file for one writable session.
   * @param path Path of the file in the driver's root.
   * @param file The open file handle. The session closes it.
   * @param options Write mode and size limits.
   */
  constructor(path: PathType, file: Deno.FsFile, options: WritableOptionsType = {}) {
    super(new DenoFile(path, file), options);
  }
}
