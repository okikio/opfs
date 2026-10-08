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
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
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
import { withAbortSignal } from "../stream.ts";

/** Node built-in filesystem module shape used through `process.getBuiltinModule()`. */
export type NodeFsType = typeof import("node:fs");
/** Node promise-based filesystem module shape used through `process.getBuiltinModule()`. */
export type NodeFsPromisesType = typeof import("node:fs/promises");
/** Node stream module shape used only to convert native streams to Web Streams. */
export type NodeStreamType = typeof import("node:stream");

/**
 * Options for the Node filesystem driver.
 *
 * The configured `root` is the lexical host namespace represented by virtual
 * `/`. Virtual `..` escape is rejected, but native Node calls follow symbolic
 * links already present below that root. Treat the configured root as trusted
 * host storage rather than a process-level security isolation mechanism.
 */
export interface NodeDriverOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during driver creation. Defaults to true. */
  readonly createRoot?: boolean;
  /** Explicit root deployment facts. Defaults to the ordinary native-host assumption. */
  readonly profile?: HostProfileInputType;
}

/** Opens one update-mode file, creating it only when the path was absent. */
export async function openUpdateFile(
  fs: NodeFsPromisesType,
  path: string,
  virtualPath: string,
  signal?: AbortSignal,
): Promise<NodeFileHandle> {
  try {
    return await fs.open(path, "r+");
  } catch (error) {
    throwIfAborted(signal, "write", virtualPath);
    if (toFileSystemError(error, "write", virtualPath).code !== "not-found") throw error;
    return await fs.open(path, "w+");
  }
}

/**
 * Drains a Web byte stream into one Node file descriptor.
 *
 * The descriptor stays open for the full stream. Partial writes advance the
 * explicit cursor until every chunk is committed. If writing fails, the source
 * producer is cancelled before the file closes so upstream work does not keep
 * producing bytes for a terminal operation.
 */
export async function writeStreamToFile(
  fs: NodeFsPromisesType,
  hostPath: string,
  virtualPath: string,
  source: ReadableStream<Uint8Array>,
  options: FileDriverWriteOptionsType,
): Promise<void> {
  throwIfAborted(options.signal, "write", virtualPath);
  let file: NodeFileHandle | undefined;
  try {
    file = options.mode === "update"
      ? await openUpdateFile(fs, hostPath, virtualPath, options.signal)
      : await fs.open(hostPath, options.mode === "replace" ? "w+" : "a+");

    const reader = withAbortSignal(source, options.signal, virtualPath, "write").getReader();
    let position = 0;
    try {
      throwIfAborted(options.signal, "write", virtualPath);
      position = options.mode === "replace"
        ? 0
        : options.mode === "append"
        ? (await file.stat()).size
        : options.at ?? 0;
      throwIfAborted(options.signal, "write", virtualPath);
      while (true) {
        throwIfAborted(options.signal, "write", virtualPath);
        const next = await reader.read();
        throwIfAborted(options.signal, "write", virtualPath);
        if (next.done) break;

        let offset = 0;
        while (offset < next.value.byteLength) {
          throwIfAborted(options.signal, "write", virtualPath);
          const result = await file.write(next.value, offset, next.value.byteLength - offset, position);
          throwIfAborted(options.signal, "write", virtualPath);
          if (result.bytesWritten <= 0) throw new Error(`Node write made no progress for '${virtualPath}'.`);
          offset += result.bytesWritten;
          position += result.bytesWritten;
        }
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // The original write/cancellation failure is the useful terminal cause.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    throwIfAborted(options.signal, "write", virtualPath);
    if (options.truncate) await file.truncate(position);
  } finally {
    await file?.close();
  }
}

/**
 * Long-lived Node positional file used by {@link NodeAdapter.openWritableFile}.
 *
 * The class keeps one descriptor open for rewrites and treats `#file ===
 * undefined` as the only closed-state marker. `abort()` cannot roll back bytes
 * already written to a normal host file; it only releases the descriptor.
 */
class NodeFile implements FileDriverWritableFileType {
  /** Canonical virtual path used in lifecycle diagnostics. */
  readonly #path: PathType;
  /** Native file descriptor, cleared before terminal close/abort. */
  #file: NodeFileHandle | undefined;

  /** Takes ownership of the already-open Node file descriptor. */
  constructor(path: PathType, file: NodeFileHandle) {
    this.#path = path;
    this.#file = file;
  }

  /** Returns the live descriptor and rejects ordinary work after termination. */
  #getFile(): NodeFileHandle {
    if (this.#file === undefined) throw new Error(`Writable file '${this.#path}' is closed.`);
    return this.#file;
  }

  /** Writes every source byte at one explicit position, including partial native writes. */
  async write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;
    while (offset < source.byteLength) {
      const result = await this.#getFile().write(source, offset, source.byteLength - offset, options.at + offset);
      if (result.bytesWritten <= 0) throw new Error(`Node positional write made no progress for '${this.#path}'.`);
      offset += result.bytesWritten;
    }
  }

  /** Changes the current native file length without closing it. */
  async truncate(size: number): Promise<void> {
    await this.#getFile().truncate(size);
  }

  /** Requests `fsync` through Node's promise file handle. */
  async flush(): Promise<void> {
    await this.#getFile().sync();
  }

  /** Closes once and clears the descriptor before awaiting native close. */
  async close(): Promise<void> {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    await file.close();
  }

  /** Releases the descriptor without claiming rollback of bytes already written. */
  async abort(): Promise<void> {
    await this.close();
  }
}

/** Ordered native resource; direct construction obeys the same admission contract as drivers. */
export class NodeWritableFile extends QueuedWritableFile {
  constructor(path: PathType, file: NodeFileHandle, options: WritableOptionsType = {}) {
    super(new NodeFile(path, file), options);
  }
}

/**
 * Synchronous random-access wrapper over one Node file descriptor.
 *
 * Cursor state is local to this wrapper. Passing `at` on a read/write performs
 * that operation at the explicit position and moves the wrapper cursor to the
 * end of the operation, matching the package sync-file contract.
 */
export class NodeSyncFile implements FileDriverSyncFileType {
  /** Node sync API used for descriptor operations. */
  readonly #fs: NodeFsType;
  /** Canonical virtual path used in lifecycle diagnostics. */
  readonly #path: PathType;
  /** Native descriptor, cleared after close. */
  #descriptor: number | undefined;
  /** Logical cursor used when an operation omits `at`. */
  #cursor = 0;

  /** Takes ownership of one already-open descriptor. */
  constructor(fs: NodeFsType, path: PathType, descriptor: number) {
    this.#fs = fs;
    this.#path = path;
    this.#descriptor = descriptor;
  }

  /** Returns the live descriptor and rejects access after close. */
  #getDescriptor(): number {
    if (this.#descriptor === undefined) throw new Error(`Sync file '${this.#path}' is closed.`);
    return this.#descriptor;
  }

  /** Reads synchronously into the caller buffer and advances the local cursor. */
  read(buffer: ArrayBufferView, options: { readonly at?: number } = {}): number {
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const position = options.at ?? this.#cursor;
    const count = this.#fs.readSync(this.#getDescriptor(), target, 0, target.byteLength, position);
    this.#cursor = Math.min(position + count, this.getSize());
    return count;
  }

  /** Writes synchronously and advances the local cursor by native progress. */
  write(buffer: ArrayBufferView, options: { readonly at?: number } = {}): number {
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const position = options.at ?? this.#cursor;
    const count = this.#fs.writeSync(this.#getDescriptor(), source, 0, source.byteLength, position);
    this.#cursor = position + count;
    return count;
  }

  /** Returns the current native file size. */
  getSize(): number {
    return this.#fs.fstatSync(this.#getDescriptor()).size;
  }

  /** Truncates the file and clamps the local cursor to the new end. */
  truncate(size: number): void {
    this.#fs.ftruncateSync(this.#getDescriptor(), size);
    if (this.#cursor > size) this.#cursor = size;
  }

  /** Requests native filesystem durability for current descriptor writes. */
  flush(): void {
    this.#fs.fsyncSync(this.#getDescriptor());
  }

  /** Closes the native descriptor exactly once. */
  close(): void {
    const descriptor = this.#descriptor;
    if (descriptor === undefined) return;
    this.#descriptor = undefined;
    this.#fs.closeSync(descriptor);
  }
}

/**
 * Node host-filesystem implementation of the portable file-driver contract.
 *
 * Runtime-specific modules are resolved through `process.getBuiltinModule()` in
 * the constructor. The package root and unrelated runtime subpaths therefore do not
 * load Node built-ins merely because this source exists in the package.
 */
export class NodeBackend implements FileBackendType {
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
  readonly name = "node";

  /** Node synchronous filesystem module. */
  readonly #fs: NodeFsType;
  /** Node promise-based filesystem module. */
  readonly #fsp: NodeFsPromisesType;
  /** Node stream module used only for native-to-Web stream conversion. */
  readonly #stream: NodeStreamType;
  /** Maps canonical virtual paths below the configured host root. */
  readonly #hostPath: (path: string) => string;

  /** Resolves Node built-ins and optionally creates the configured host root. */
  constructor(options: NodeDriverOptionsType) {
    this.hostProfile = resolveHostProfile(options.profile);
    this.publication = getHostPublication(this.hostProfile);
    this.capabilities = getHostCapabilities(this.hostProfile);
    if (this.hostProfile.readOnly && options.createRoot === true) {
      throw new TypeError("Read-only host profile cannot createRoot.");
    }
    this.#fs = globalThis.process.getBuiltinModule("node:fs") as NodeFsType;
    this.#fsp = globalThis.process.getBuiltinModule("node:fs/promises") as NodeFsPromisesType;
    this.#stream = globalThis.process.getBuiltinModule("node:stream") as NodeStreamType;
    this.#hostPath = createLocalPath(options.root);
    if (options.createRoot ?? !this.hostProfile.readOnly) this.#fs.mkdirSync(this.#hostPath("/"), { recursive: true });
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
      const info = await this.#fsp.lstat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "foreign";
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
    for (const entry of await this.#fsp.readdir(this.#hostPath(path), { withFileTypes: true })) {
      throwIfAborted(options.signal, "read-dir", path);
      yield {
        name: entry.name,
        kind: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "foreign",
      };
    }
  }

  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await this.#fsp.stat(this.#hostPath(path));
      throwIfAborted(options.signal, "stat", path);
      return info.isDirectory()
        ? { kind: "directory", lastModified: info.mtimeMs }
        : { kind: "file", size: info.size, lastModified: info.mtimeMs, mediaType: "" };
    } catch (error) {
      throwIfAborted(options.signal, "stat", path);
      const mapped = toFileSystemError(error, "stat", path);
      if (mapped.code === "not-found") return null;
      throw mapped;
    }
  }

  /** Reads the complete file or performs positioned reads for one requested range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.at === undefined && options.length === undefined) {
      try {
        const bytes = await this.#fsp.readFile(this.#hostPath(path), { signal: options.signal });
        throwIfAborted(options.signal, "read", path);
        return new Uint8Array(bytes);
      } catch (error) {
        throwIfAborted(options.signal, "read", path);
        throw error;
      }
    }

    const file = await this.#fsp.open(this.#hostPath(path), "r");
    try {
      throwIfAborted(options.signal, "read", path);
      const info = await file.stat();
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory()) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      const start = options.at ?? 0;
      const length = Math.max(0, Math.min(options.length ?? info.size - start, info.size - start));
      const output = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        throwIfAborted(options.signal, "read", path);
        const result = await file.read(output, offset, length - offset, start + offset);
        throwIfAborted(options.signal, "read", path);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return offset === output.byteLength ? output : output.slice(0, offset);
    } finally {
      await file.close();
    }
  }

  /** Opens a native Node read stream and projects it as a Web byte stream. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    const target = this.#hostPath(path);
    if (options.length === 0) {
      // `createReadStream({ start, end: start })` yields one byte because Node's
      // `end` is inclusive. Stat once to preserve not-found/type failures, then
      // return the exact empty range requested by the portable contract.
      const info = await this.#fsp.stat(target);
      throwIfAborted(options.signal, "read", path);
      if (info.isDirectory()) throw new FileSystemError("type-mismatch", "read", path, `'${path}' is a directory.`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    }
    const start = options.at ?? 0;
    const end = options.length === undefined ? undefined : start + options.length - 1;
    const stream = this.#fs.createReadStream(target, { start, ...(end === undefined ? {} : { end }) });
    return withAbortSignal(
      this.#stream.Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
      options.signal,
      path,
    );
  }

  /** Preserves replace, append, and positioned update semantics with native Node APIs. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "bytes" });
    throwIfAborted(options.signal, "write", path);
    const target = this.#hostPath(path);
    if (options.mode === "replace") {
      try {
        await this.#fsp.writeFile(target, data, { signal: options.signal });
        throwIfAborted(options.signal, "write", path);
        return;
      } catch (error) {
        throwIfAborted(options.signal, "write", path);
        throw error;
      }
    }
    if (options.mode === "append") {
      if (options.signal === undefined) await this.#fsp.appendFile(target, data);
      else {
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        });
        await writeStreamToFile(this.#fsp, target, path, source, options);
      }
      return;
    }

    const file = await openUpdateFile(this.#fsp, target, path, options.signal);
    try {
      throwIfAborted(options.signal, "write", path);
      const position = options.at ?? 0;
      let offset = 0;
      while (offset < data.byteLength) {
        throwIfAborted(options.signal, "write", path);
        const result = await file.write(data, offset, data.byteLength - offset, position + offset);
        throwIfAborted(options.signal, "write", path);
        if (result.bytesWritten <= 0) throw new Error(`Node write made no progress for '${path}'.`);
        offset += result.bytesWritten;
      }
      throwIfAborted(options.signal, "write", path);
      if (options.truncate) await file.truncate(position + data.byteLength);
    } finally {
      await file.close();
    }
  }

  /** Streams bytes directly to one native file without facade materialization. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    this.#admit({ operation: "write", path, mode: options.mode, source: "stream" });
    await writeStreamToFile(this.#fsp, this.#hostPath(path), path, source, options);
  }

  /** Lazily yields native direct children that are files or directories. */
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

  /** Creates exactly one host directory. Parent creation belongs to the facade. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "write", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "mkdir", path);
    await this.#fsp.mkdir(this.#hostPath(path));
  }

  /**
   * Removes exactly one host file, symbolic link, or empty directory.
   *
   * A plain host `rm(path)` is not a portable one-entry directory primitive:
   * supported Node/Bun runs can report `ERR_FS_EISDIR` for a directory. The
   * driver must nevertheless remove one already-empty directory because recursive policy
   * lives in the filesystem facade. `lstat()` also keeps a final symbolic link
   * distinct from the directory it may reference, so deletion removes the link
   * itself instead of following it.
   */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    this.#admit({ operation: "remove", path });
    await this.#parents(path, options);
    throwIfAborted(options.signal, "remove", path);
    const target = this.#hostPath(path);
    const info = await this.#fsp.lstat(target);
    throwIfAborted(options.signal, "remove", path);
    if (info.isDirectory()) await this.#fsp.rmdir(target);
    else await this.#fsp.unlink(target);
  }

  /** Uses `copyFile()` so source bytes do not route through JavaScript buffers. */
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
    const reservation = await this.#fsp.open(stage, "wx");
    try {
      await reservation.close();
      throwIfAborted(options.signal, "copy", source);
      await this.#fsp.copyFile(from, stage);
      throwIfAborted(options.signal, "copy", source);
      if (options.overwrite) await this.#fsp.rename(stage, to);
      else await this.#fsp.link(stage, to);
    } finally {
      await this.#fsp.unlink(stage).catch(() => undefined);
    }
  }

  /** Uses native rename for the driver's move capability. */
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
    await this.#fsp.rename(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Reserves a private sibling before any fallback can write or clean it up. */
  async reserve(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    assertHostPrimitive(this.hostProfile, "reserve", path);
    await this.#parents(path, options);
    throwIfAborted(options.signal, "reserve", path);
    const file = await this.#fsp.open(this.#hostPath(path), "wx");
    await file.close();
  }

  /** Opens one long-lived asynchronous positional file descriptor. */
  async openWritableFile(path: PathType, options?: WritableOptionsType): Promise<FileDriverWritableFileType> {
    assertHostPrimitive(this.hostProfile, "positionalWrite", path);
    validateWritableOptions(options);
    return new NodeWritableFile(path, await this.#fsp.open(this.#hostPath(path), "r+"), options);
  }

  /** Opens one synchronous random-access descriptor and transfers ownership to the wrapper. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    assertHostPrimitive(this.hostProfile, "syncAccess", path);
    return new NodeSyncFile(this.#fs, path, this.#fs.openSync(this.#hostPath(path), "r+"));
  }
}

/**
 * Creates a file driver over Node's native filesystem APIs.
 *
 * The driver maps virtual `/` to `root` and never exposes host paths through
 * the public facade. Importing the root OPFS package does not import this
 * driver; Node-specific behavior remains on the explicit `driver/node`
 * subpath.
 *
 * @example Use OPFS-shaped handles over a host directory.
 * ```ts
 * const driver = createNodeDriver({ root: "./data" });
 * await fs.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createNodeDriver(options: NodeDriverOptionsType): FileDriverType {
  const backend = new NodeBackend(options);
  return defineFileDriver(backend, {
    name: "node",
    requirements: [{ code: "node-filesystem", state: "available" }],
    limits: [],
    // The immutable profile owns deployment semantics; no native mount probing occurs.
    optimizations: [],
  });
}
