import {
  admitHost,
  assertHostAdmission,
  assertHostPrimitive,
  getHostCapabilities,
  getHostPublication,
  type HostProfileInputType,
  type HostProfileType,
  resolveHostProfile,
} from "./host.ts";
import type { DriverPlanInputType, DriverPlanType } from "./definition.ts";
import { QueuedWritableFile, validateWritableOptions, type WritableOptionsType } from "./writable.ts";
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
  FileEntryKindType,
  FileEntryType,
} from "./file.ts";
import { createLocalPath } from "./local.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { dirname, joinPath, type PathType } from "../path.ts";
import { openBytes, withAbortSignal } from "../stream.ts";
import { aggregate, close } from "../close.ts";
import { isBytes, toView } from "../bytes.ts";

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
  /** Explicit root deployment facts. Defaults to the ordinary native-host assumption. */
  readonly profile?: HostProfileInputType;
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
  /** At most one admitted native read, with both outcomes observed immediately. */
  #pending:
    | Promise<{ readonly ok: true; readonly count: number | null } | { readonly ok: false; readonly reason: unknown }>
    | undefined;
  /** Already observed read outcome, used only to preserve event order at cancellation. */
  #observed:
    | { readonly ok: true; readonly count: number | null }
    | { readonly ok: false; readonly reason: unknown }
    | undefined;
  /** Consumer cancellation prevents any later controller publication. */
  #stopping = false;
  /** One terminal cancellation result, assigned before native retirement effects. */
  #cancel: Promise<void> | undefined;

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

  /** Reads one bounded chunk; an owned cancellation joins it without late publication. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#stopping) return;
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
    // Publish pending ownership before invoking a native method that can reenter cancellation.
    const pending = Promise.resolve().then(() => file.read(buffer)).then(
      (count) => {
        const outcome = { ok: true as const, count };
        this.#observed = outcome;
        return outcome;
      },
      (reason: unknown) => {
        const outcome = { ok: false as const, reason };
        this.#observed = outcome;
        return outcome;
      },
    );
    this.#pending = pending;
    try {
      const outcome = await pending;
      if (this.#stopping) return;
      if (!outcome.ok) throw outcome.reason;
      const count = outcome.count;
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
      let failure = error;
      try {
        this.#close();
      } catch (reason) {
        failure = aggregate([error, reason], "Range read and native file close failed.");
      }
      controller.error(failure);
    } finally {
      if (this.#pending === pending) {
        this.#pending = undefined;
        this.#observed = undefined;
      }
    }
  }

  /**
   * Closes the descriptor, then joins the exact admitted read before cancellation settles.
   *
   * A close-induced native read rejection is actual retirement evidence. It is
   * neither discarded by error class nor published into a canceled stream. A
   * read fault already observed before cancellation retains primary position.
   */
  cancel(): Promise<void> {
    if (this.#cancel !== undefined) return this.#cancel;
    this.#stopping = true;
    this.#remaining = 0;
    const pending = this.#pending;
    const observed = this.#observed;
    const primary: readonly unknown[] = observed !== undefined && !observed.ok ? [observed.reason] : [];
    this.#cancel = Promise.resolve().then(async () => {
      await close([
        () => this.#close(),
        async () => {
          if (pending === undefined) return;
          const outcome = await pending;
          if (!outcome.ok && primary.length === 0) throw outcome.reason;
        },
      ], primary);
    });
    return this.#cancel;
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
  const reader = openBytes(withAbortSignal(source, options.signal, path, "write"));
  let terminal = false;
  let primary: readonly unknown[] = [];
  try {
    throwIfAborted(options.signal, "write", path);
    let position = options.mode === "append"
      ? (await file.stat()).size
      : options.mode === "update"
      ? options.at ?? 0
      : 0;
    throwIfAborted(options.signal, "write", path);
    await file.seek(position, Deno.SeekMode.Start);
    throwIfAborted(options.signal, "write", path);
    while (true) {
      throwIfAborted(options.signal, "write", path);
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        terminal = true;
        throw reason;
      }
      if (next.done) terminal = true;
      throwIfAborted(options.signal, "write", path);
      if (next.done) break;
      if (!isBytes(next.value)) throw new TypeError("A file stream chunk must be a Uint8Array.");
      const bytes = toView(next.value);

      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(options.signal, "write", path);
        const count = await file.write(bytes.subarray(offset));
        throwIfAborted(options.signal, "write", path);
        if (count <= 0) throw new Error(`Deno stream write made no progress for '${path}'.`);
        offset += count;
      }
      position += bytes.byteLength;
    }
    return position;
  } catch (reason) {
    primary = [reason];
    throw reason;
  } finally {
    await close([
      async () => {
        if (!terminal) await reader.cancel(primary[0]);
      },
      () => reader.releaseLock(),
    ], primary);
  }
}

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
  constructor(path: PathType, file: Deno.FsFile, options: WritableOptionsType = {}) {
    super(new DenoFile(path, file), options);
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

/**
 * Deno host-filesystem implementation of the portable file-driver contract.
 *
 * Deno owns the native file and directory operations. `@std/path` is used only
 * by the shared host-path mapper so Deno, Node, and Bun apply the same host-root
 * containment rule.
 */
export class DenoBackend implements FileBackendType {
  /** Validated immutable root facts, separate from live mount/permission observations. */
  readonly hostProfile: HostProfileType;
  /** Native operation-specific guarantees derived from the selected profile. */
  readonly publication: ReturnType<typeof getHostPublication>;
  /** Admitted native feature surface for this root deployment. */
  readonly capabilities: ReturnType<typeof getHostCapabilities>;

  /** One hard policy shared by native entrypoints and pure planning. */
  admit(input: DriverPlanInputType): DriverPlanType {
    return admitHost(this.hostProfile, input);
  }

  /** Enforces declared policy before parent probes or descriptor acquisition. */
  #admit(input: DriverPlanInputType): void {
    assertHostAdmission(this.admit(input), input.path);
  }

  /** Stable driver identity used in diagnostics. */
  readonly name = "deno";

  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;

  /** Resolves the host root once and optionally creates it. */
  constructor(options: DenoDriverOptionsType) {
    this.hostProfile = resolveHostProfile(options.profile);
    this.publication = getHostPublication(this.hostProfile);
    this.capabilities = getHostCapabilities(this.hostProfile);
    if (this.hostProfile.readOnly && options.createRoot === true) {
      throw new TypeError("Read-only host profile cannot createRoot.");
    }
    this.#hostPath = createLocalPath(options.root);
    if (options.createRoot ?? !this.hostProfile.readOnly) Deno.mkdirSync(this.#hostPath("/"), { recursive: true });
  }

  /** Rejects stable alias ancestors before structural work; hostile path swaps remain a host boundary. */
  async #parents(path: PathType, options: FileDriverSignalOptionsType): Promise<void> {
    for (let parent = dirname(path); parent !== "/"; parent = dirname(parent)) {
      const kind = await this.entry(parent, options);
      if (kind === "link" || kind === "foreign") {
        throw new FileSystemError(
          "not-supported",
          "structure",
          path,
          "Structural paths cannot traverse a link or foreign ancestor.",
        );
      }
    }
  }

  /** Returns physical identity; destructive traversal must never use followed target metadata. */
  async entry(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileEntryKindType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await Deno.lstat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isSymlink ? "link" : info.isDirectory ? "directory" : info.isFile ? "file" : "foreign";
    } catch (error) {
      throwIfAborted(options.signal, "stat", path);
      if (toFileSystemError(error, "stat", path).code === "not-found") return null;
      throw error;
    }
  }

  /** Lists every physical child, including links, for no-follow removal. */
  async *entries(path: PathType, options: FileDriverSignalOptionsType = {}): AsyncIterableIterator<FileEntryType> {
    await this.#parents(path, options);
    if (await this.entry(path, options) !== "directory") {
      throw new FileSystemError(
        "type-mismatch",
        "read-dir",
        path,
        "Physical traversal requires an ordinary directory.",
      );
    }
    throwIfAborted(options.signal, "read-dir", path);
    for await (const entry of Deno.readDir(this.#hostPath(path))) {
      throwIfAborted(options.signal, "read-dir", path);
      yield {
        name: entry.name,
        kind: entry.isSymlink ? "link" : entry.isDirectory ? "directory" : entry.isFile ? "file" : "foreign",
      };
    }
  }

  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await Deno.stat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isDirectory
        ? { kind: "directory", ...(info.mtime === null ? {} : { lastModified: info.mtime.getTime() }) }
        : { kind: "file", size: info.size, lastModified: info.mtime?.getTime() ?? 0, mediaType: "" };
    } catch (error) {
      throwIfAborted(options.signal, "stat", path);
      const mapped = toFileSystemError(error, "stat", path);
      if (mapped.code === "not-found") return null;
      throw mapped;
    }
  }

  /** Reads complete bytes or performs positioned reads for one range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.at === undefined && options.length === undefined) {
      try {
        const bytes = await Deno.readFile(this.#hostPath(path), {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        throwIfAborted(options.signal, "read", path);
        return bytes;
      } catch (error) {
        throwIfAborted(options.signal, "read", path);
        throw error;
      }
    }

    const file = await Deno.open(this.#hostPath(path), { read: true });
    let primary: readonly unknown[] = [];
    try {
      throwIfAborted(options.signal, "read", path);
      const info = await file.stat();
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      const length = Math.max(0, Math.min(options.length ?? info.size - start, info.size - start));
      throwIfAborted(options.signal, "read", path);
      await file.seek(start, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "read", path);
      const output = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        throwIfAborted(options.signal, "read", path);
        const count = await file.read(output.subarray(offset));
        throwIfAborted(options.signal, "read", path);
        if (count === null) break;
        offset += count;
      }
      return offset === output.byteLength ? output : output.slice(0, offset);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Opens Deno's native stream, or a bounded incremental stream for one finite range. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const file = await Deno.open(this.#hostPath(path), { read: true });
    let closing = false;
    try {
      throwIfAborted(options.signal, "read", path);
      if (options.at === undefined && options.length === undefined) {
        return withAbortSignal(file.readable, options.signal, path);
      }
      throwIfAborted(options.signal, "read", path);
      const info = await file.stat();
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      throwIfAborted(options.signal, "read", path);
      await file.seek(start, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "read", path);
      if (options.length === undefined) return withAbortSignal(file.readable, options.signal, path);
      if (options.length === 0) {
        closing = true;
        file.close();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      }
      return withAbortSignal(new ReadableStream(new DenoRangeSource(file, options.length)), options.signal, path);
    } catch (error) {
      await close([() => {
        if (!closing) file.close();
      }], [error]);
      throw error;
    }
  }

  /** Writes materialized bytes with replace, append, or positioned update semantics. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "bytes" });
    throwIfAborted(options.signal, "write", path);
    if (!isBytes(data)) throw new TypeError("A file write must use a Uint8Array.");
    data = toView(data);
    if (options.mode === "replace") {
      try {
        await Deno.writeFile(this.#hostPath(path), data, {
          create: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        throwIfAborted(options.signal, "write", path);
        return;
      } catch (error) {
        throwIfAborted(options.signal, "write", path);
        throw error;
      }
    }

    const file = await Deno.open(this.#hostPath(path), { read: true, write: true, create: true });
    let primary: readonly unknown[] = [];
    try {
      throwIfAborted(options.signal, "write", path);
      const position = options.mode === "append" ? (await file.stat()).size : options.at ?? 0;
      throwIfAborted(options.signal, "write", path);
      await file.seek(position, Deno.SeekMode.Start);
      throwIfAborted(options.signal, "write", path);
      let offset = 0;
      while (offset < data.byteLength) {
        throwIfAborted(options.signal, "write", path);
        const count = await file.write(data.subarray(offset));
        throwIfAborted(options.signal, "write", path);
        if (count <= 0) throw new Error(`Deno write made no progress for '${path}'.`);
        offset += count;
      }
      throwIfAborted(options.signal, "write", path);
      if (options.truncate) await file.truncate(position + data.byteLength);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Streams directly into one Deno file without facade materialization. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "stream" });
    throwIfAborted(options.signal, "write", path);
    const file = await Deno.open(this.#hostPath(path), {
      read: true,
      write: true,
      create: true,
      truncate: options.mode === "replace",
    });
    let primary: readonly unknown[] = [];
    try {
      const position = await writeStreamToFile(file, path, source, options);
      throwIfAborted(options.signal, "write", path);
      if (options.truncate) await file.truncate(position);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => file.close()], primary);
    }
  }

  /** Lazily yields direct file and directory children from Deno. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for await (const entry of this.entries(path, options)) {
      if (entry.kind !== "file" && entry.kind !== "directory") {
        throw new FileSystemError(
          "not-supported",
          "read-dir",
          path,
          `Entry '${entry.name}' is ${entry.kind}; use explicit remove to unlink it without following its target.`,
        );
      }
      yield { name: entry.name, kind: entry.kind };
    }
  }

  /** Creates one directory after facade parent resolution. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "write", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "mkdir", path);
    await Deno.mkdir(this.#hostPath(path));
  }

  /** Removes one file or empty directory. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "remove", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "remove", path);
    await Deno.remove(this.#hostPath(path));
  }

  /** Copies one host file through Deno's native copy operation. */
  async copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    this.#admit({
      operation: "copy",
      path: source,
      destination,
      overwrite: options.overwrite,
      preserve: options.preserve,
      exclusive: options.exclusive,
    });
    await this.#parents(source, options);
    await this.#parents(destination, options);
    if (await this.entry(source, options) !== "file") {
      throw new FileSystemError("type-mismatch", "copy", source, "Native file copy requires an ordinary source file.");
    }
    throwIfAborted(options.signal, "copy", source);
    const from = this.#hostPath(source);
    const to = this.#hostPath(destination);
    const stage = this.#hostPath(joinPath(dirname(destination), `.opfs-${crypto.randomUUID()}.part`));
    // Reserve before copying; cleanup must never remove an unowned collision.
    const reservation = await Deno.open(stage, { write: true, createNew: true });
    let consumed = false;
    let primary: readonly unknown[] = [];
    try {
      reservation.close();
      throwIfAborted(options.signal, "copy", source);
      await Deno.copyFile(from, stage);
      throwIfAborted(options.signal, "copy", source);
      if (options.overwrite) {
        await Deno.rename(stage, to);
        consumed = true;
      } else await Deno.link(stage, to);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      // A successful rename consumed this name. Never remove a later entry there.
      await close([async () => {
        if (!consumed) await Deno.remove(stage);
      }], primary);
    }
  }

  /** Moves one host path through Deno's native rename operation. */
  async move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void> {
    this.#admit({
      operation: "move",
      path: source,
      destination,
      overwrite: options.overwrite,
      preserve: options.preserve,
      exclusive: options.exclusive,
    });
    await this.#parents(source, options);
    await this.#parents(destination, options);
    throwIfAborted(options.signal, "move", source);
    if (options.exclusive && !options.overwrite) {
      throw new FileSystemError(
        "not-supported",
        "move",
        destination,
        "Portable host rename has no atomic no-replace primitive; omit exclusive for a cooperating-owner precheck.",
      );
    }
    if (await this.entry(source, options) === null) {
      throw new FileSystemError("not-found", "move", source, `Source '${source}' does not exist.`);
    }
    if (!options.overwrite && await this.entry(destination, options) !== null) {
      throw new FileSystemError("already-exists", "move", destination, `Destination '${destination}' already exists.`);
    }
    throwIfAborted(options.signal, "move", source);
    await Deno.rename(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Reserves a private sibling before any fallback can write or clean it up. */
  async reserve(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    assertHostPrimitive(this.hostProfile, "reserve", path);
    await this.#parents(path, options);
    throwIfAborted(options.signal, "reserve", path);
    const file = await Deno.open(this.#hostPath(path), { write: true, createNew: true });
    try {
      file.close();
    } catch (reason) {
      await close([() => Deno.remove(this.#hostPath(path))], [reason]);
    }
  }

  /** Opens one long-lived asynchronous positional Deno file. */
  async openWritableFile(path: PathType, options?: WritableOptionsType): Promise<FileDriverWritableFileType> {
    assertHostPrimitive(this.hostProfile, "positionalWrite", path);
    validateWritableOptions(options);
    const file = await Deno.open(this.#hostPath(path), { read: true, write: true });
    try {
      return new DenoWritableFile(path, file, options);
    } catch (reason) {
      await close([() => file.close()], [reason]);
      throw reason;
    }
  }

  /** Opens one synchronous Deno file and transfers ownership to the wrapper. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    assertHostPrimitive(this.hostProfile, "syncAccess", path);
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
