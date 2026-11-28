/// <reference types="deno" />
/** Synchronous random access owns one Deno descriptor and its logical byte cursor. @module */
import { toView } from "../../bytes.ts";
import type { FileDriverSyncFileType } from "../../driver/file.ts";
import type { PathType } from "../../path.ts";

/** Synchronous random-access wrapper over one Deno file. */
export class DenoSyncFile implements FileDriverSyncFileType {
  /** Canonical virtual path used in post-close diagnostics. */
  readonly #path: PathType;
  /** Owned native file, cleared before attempting close so it cannot be closed twice. */
  #file: Deno.FsFile | undefined;
  /** Byte offset used when an operation omits `at`; starts at zero. */
  #cursor = 0;

  /** Takes ownership of one Deno file opened for sync access. */
  constructor(path: PathType, file: Deno.FsFile) {
    this.#path = path;
    this.#file = file;
  }

  /** Returns the live file or rejects access after close. */
  #getFile(): Deno.FsFile {
    if (this.#file === undefined) throw new Error(`Sync file '${this.#path}' is closed.`);
    return this.#file;
  }

  /** Reads synchronously and advances the wrapper cursor. */
  read(buffer: ArrayBufferView, options: { readonly at?: number } = {}): number {
    const target = toView(buffer);
    const at = options.at ?? this.#cursor;
    const file = this.#getFile();
    file.seekSync(at, Deno.SeekMode.Start);
    const count = file.readSync(target) ?? 0;
    this.#cursor = Math.min(at + count, this.getSize());
    return count;
  }

  /** Writes synchronously and advances the wrapper cursor. */
  write(buffer: ArrayBufferView, options: { readonly at?: number } = {}): number {
    const source = toView(buffer);
    const at = options.at ?? this.#cursor;
    const file = this.#getFile();
    file.seekSync(at, Deno.SeekMode.Start);
    const count = file.writeSync(source);
    this.#cursor = at + count;
    return count;
  }

  /** Returns current native file size. */
  getSize(): number {
    return this.#getFile().statSync().size;
  }

  /** Truncates and clamps the local cursor to the new file end. */
  truncate(size: number): void {
    this.#getFile().truncateSync(size);
    if (this.#cursor > size) this.#cursor = size;
  }

  /** Requests synchronous durability for current writes. */
  flush(): void {
    this.#getFile().syncSync();
  }

  /** Closes the native Deno file exactly once. */
  close(): void {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    file.close();
  }
}
