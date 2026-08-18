/// <reference types="deno" />
import type { FileBackendType, FileDriverType } from "./file.ts";
import { defineFileDriver } from "./file.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverDirectoryEntryType,
  FileDriverMoveOptionsType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverSyncFileType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
} from "./file.ts";
import { createLocalPath } from "./local.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import type { PathType } from "../path.ts";

/**
 * Options for the Deno-native file driver.
 *
 * The configured `root` is the lexical host namespace represented by virtual
 * `/`. Deno-specific I/O semantics stay in the driver rather than being
 * flattened into the adapter or facade layers. Native Deno calls follow
 * symbolic links already present below that root, so the root must be trusted
 * when filesystem access is a security concern.
 */
export interface DenoDriverOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during driver creation. Defaults to true. */
  readonly createRoot?: boolean;
}

/** Maximum bytes retained by one finite Deno range-stream pull. */
export const RANGE_CHUNK_BYTES = 64 * 1024;

/**
 * Incrementally reads one finite range from an already-positioned Deno file.
 *
 * `Deno.FsFile.readable` is ideal for an unbounded tail because Deno owns the
 * stream lifecycle. A finite virtual range needs an explicit remaining-byte
 * counter, otherwise the old implementation first materializes the complete
 * range through `readFile()` and only then wraps it in a `Blob`. This source
 * keeps active memory bounded to one small chunk and closes the native file on
 * EOF, cancellation, or read failure.
 */
export class DenoRangeSource {
  /** Native file positioned at the first requested byte. */
  #file: Deno.FsFile | undefined;
  /** Bytes still allowed to leave this source. */
  #remaining: number;

  /** Takes ownership of one positioned Deno file for exactly `remaining` bytes. */
  constructor(file: Deno.FsFile, remaining: number) {
    this.#file = file;
    this.#remaining = remaining;
  }

  /** Closes the native file once before the stream reaches a terminal state. */
  #close(): void {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    file.close();
  }

  /** Reads at most one bounded chunk and closes exactly at the requested range end. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const file = this.#file;
    if (file === undefined) {
      controller.close();
      return;
    }
    if (this.#remaining === 0) {
      this.#close();
      controller.close();
      return;
    }

    const buffer = new Uint8Array(Math.min(RANGE_CHUNK_BYTES, this.#remaining));
    try {
      const count = await file.read(buffer);
      if (count === null) {
        this.#remaining = 0;
        this.#close();
        controller.close();
        return;
      }
      if (count === 0) return;

      this.#remaining -= count;
      controller.enqueue(count === buffer.byteLength ? buffer : buffer.subarray(0, count));
      if (this.#remaining === 0) {
        this.#close();
        controller.close();
      }
    } catch (error) {
      this.#close();
      controller.error(error);
    }
  }

  /** Releases the file when a downstream consumer stops before the requested range ends. */
  cancel(): void {
    this.#remaining = 0;
    this.#close();
  }
}

/**
 * Streams bytes into one already-open Deno file.
 *
 * The helper preserves the caller's replace/append/update cursor and cancels
 * the source producer when writing fails. It does not close the file because
 * the caller owns the surrounding acquisition/finalization block.
 */
export async function writeStreamToFile(
  file: Deno.FsFile,
  path: PathType,
  source: ReadableStream<Uint8Array>,
  options: FileDriverWriteOptionsType,
): Promise<number> {
  let position = options.mode === "append" ? (await file.stat()).size : options.mode === "update" ? options.at ?? 0 : 0;
  await file.seek(position, Deno.SeekMode.Start);

  const reader = source.getReader();
  try {
    while (true) {
      throwIfAborted(options.signal, "write", path);
      const next = await reader.read();
      if (next.done) break;

      let offset = 0;
      while (offset < next.value.byteLength) {
        const count = await file.write(next.value.subarray(offset));
        if (count <= 0) throw new Error(`Deno stream write made no progress for '${path}'.`);
        offset += count;
      }
      position += next.value.byteLength;
    }
    return position;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the first write or cancellation failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Long-lived Deno positional file used by the driver's asynchronous random
 * access capability.
 *
 * Normal Deno files cannot roll back bytes already written. `abort()` therefore
 * means release without additional commit work, not transactional rollback.
 */
export class DenoWritableFile implements FileDriverWritableFileType {
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
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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

/** Synchronous random-access wrapper over one Deno file. */
export class DenoSyncFile implements FileDriverSyncFileType {
  /** Canonical virtual path used in post-close diagnostics. */
  readonly #path: PathType;
  /** Native Deno file, cleared after close. */
  #file: Deno.FsFile | undefined;
  /** Logical cursor for operations without an explicit `at`. */
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
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const at = options.at ?? this.#cursor;
    const file = this.#getFile();
    file.seekSync(at, Deno.SeekMode.Start);
    const count = file.readSync(target) ?? 0;
    this.#cursor = at + count;
    return count;
  }

  /** Writes synchronously and advances the wrapper cursor. */
  write(buffer: ArrayBufferView, options: { readonly at?: number } = {}): number {
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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

/**
 * Deno host-filesystem implementation of the portable file-driver contract.
 *
 * Deno owns the native file and directory operations. `@std/path` is used only
 * by the shared host-path mapper so Deno, Node, and Bun apply the same host-root
 * containment rule.
 */
export class DenoBackend implements FileBackendType {
  /** Stable driver identity used in diagnostics. */
  readonly name = "deno";
  /** Native Deno filesystem operations exposed without facade emulation. */
  readonly capabilities = {
    read: true,
    write: true,
    streamRead: true,
    streamWriteModes: ["replace", "append", "update"],
    rangeRead: true,
    copy: true,
    move: true,
    positionalWrite: true,
    syncAccess: true,
  } as const;
  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;

  /** Resolves the host root once and optionally creates it. */
  constructor(options: DenoDriverOptionsType) {
    this.#hostPath = createLocalPath(options.root);
    if (options.createRoot ?? true) Deno.mkdirSync(this.#hostPath("/"), { recursive: true });
  }

  /** Returns Deno file/directory metadata or `null` for an absent path. */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await Deno.stat(this.#hostPath(path));
      return info.isDirectory
        ? { kind: "directory", ...(info.mtime === null ? {} : { lastModified: info.mtime.getTime() }) }
        : { kind: "file", size: info.size, lastModified: info.mtime?.getTime() ?? 0, mediaType: "" };
    } catch (error) {
      const mapped = toFileSystemError(error, "stat", path);
      if (mapped.code === "not-found") return null;
      throw mapped;
    }
  }

  /** Reads complete bytes or performs positioned reads for one range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.at === undefined && options.length === undefined) return await Deno.readFile(this.#hostPath(path));

    const file = await Deno.open(this.#hostPath(path), { read: true });
    try {
      const info = await file.stat();
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      const length = Math.max(0, Math.min(options.length ?? info.size - start, info.size - start));
      await file.seek(start, Deno.SeekMode.Start);
      const output = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const count = await file.read(output.subarray(offset));
        if (count === null) break;
        offset += count;
      }
      return offset === output.byteLength ? output : output.slice(0, offset);
    } finally {
      file.close();
    }
  }

  /** Opens Deno's native stream, or a bounded incremental stream for one finite range. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const file = await Deno.open(this.#hostPath(path), { read: true });
    if (options.at === undefined && options.length === undefined) return file.readable;

    try {
      const info = await file.stat();
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      await file.seek(start, Deno.SeekMode.Start);
      if (options.length === undefined) return file.readable;
      if (options.length === 0) {
        file.close();
        return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      }
      return new ReadableStream(new DenoRangeSource(file, options.length));
    } catch (error) {
      file.close();
      throw error;
    }
  }

  /** Writes materialized bytes with replace, append, or positioned update semantics. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    if (options.mode === "replace") {
      await Deno.writeFile(this.#hostPath(path), data, { create: true });
      return;
    }

    const file = await Deno.open(this.#hostPath(path), { read: true, write: true, create: true });
    try {
      const position = options.mode === "append" ? (await file.stat()).size : options.at ?? 0;
      await file.seek(position, Deno.SeekMode.Start);
      let offset = 0;
      while (offset < data.byteLength) {
        const count = await file.write(data.subarray(offset));
        if (count <= 0) throw new Error(`Deno write made no progress for '${path}'.`);
        offset += count;
      }
      if (options.truncate) await file.truncate(position + data.byteLength);
    } finally {
      file.close();
    }
  }

  /** Streams directly into one Deno file without facade materialization. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    const file = await Deno.open(this.#hostPath(path), {
      read: true,
      write: true,
      create: true,
      truncate: options.mode === "replace",
    });
    try {
      const position = await writeStreamToFile(file, path, source, options);
      if (options.truncate) await file.truncate(position);
    } finally {
      file.close();
    }
  }

  /** Lazily yields direct file and directory children from Deno. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for await (const entry of Deno.readDir(this.#hostPath(path))) {
      throwIfAborted(options.signal, "read-dir", path);
      if (entry.isDirectory) yield { name: entry.name, kind: "directory" };
      else if (entry.isFile) yield { name: entry.name, kind: "file" };
    }
  }

  /** Creates one directory after facade parent resolution. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "mkdir", path);
    await Deno.mkdir(this.#hostPath(path));
  }

  /** Removes one file or empty directory. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "remove", path);
    await Deno.remove(this.#hostPath(path));
  }

  /** Copies one host file through Deno's native copy operation. */
  async copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    throwIfAborted(options.signal, "copy", source);
    await Deno.copyFile(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Moves one host path through Deno's native rename operation. */
  async move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void> {
    throwIfAborted(options.signal, "move", source);
    await Deno.rename(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Opens one long-lived asynchronous positional Deno file. */
  async openWritableFile(path: PathType): Promise<FileDriverWritableFileType> {
    return new DenoWritableFile(path, await Deno.open(this.#hostPath(path), { read: true, write: true }));
  }

  /** Opens one synchronous Deno file and transfers ownership to the wrapper. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    return new DenoSyncFile(path, Deno.openSync(this.#hostPath(path), { read: true, write: true }));
  }
}

/**
 * Creates a file driver backed by Deno file APIs.
 *
 * The driver remains Deno-native for filesystem work while sharing only the
 * portable `@std/path` host-root mapper with Node and Bun.
 *
 * @example Persist below one Deno host directory.
 * ```ts
 * const driver = createDenoDriver({ root: "./data" });
 * const adapter = createFileAdapter(driver);
 * const fs = createFileSystem(adapter, { coordination: "local" });
 * await fs.writeFile("/cache/result.json", "{}", { parents: true });
 * ```
 */
export function createDenoDriver(options: DenoDriverOptionsType): FileDriverType {
  const backend = new DenoBackend(options);
  return defineFileDriver(backend, {
    name: "deno",
    requirements: [{ code: "deno-filesystem", state: "available" }],
    limits: [],
    // Deno already exposes the required file semantics directly, so the driver
    // does not need additional behavior-changing optimization toggles here.
    optimizations: [],
  });
}
