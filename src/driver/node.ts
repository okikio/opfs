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
} from "./file.ts";
import { createLocalPath } from "./local.ts";
import { throwIfAborted, toFileSystemError } from "../error.ts";
import type { PathType } from "../path.ts";

/** Node built-in filesystem module shape used through `process.getBuiltinModule()`. */
type NodeFsType = typeof import("node:fs");
/** Node promise-based filesystem module shape used through `process.getBuiltinModule()`. */
type NodeFsPromisesType = typeof import("node:fs/promises");
/** Node stream module shape used only to convert native streams to Web Streams. */
type NodeStreamType = typeof import("node:stream");

/** Options for the Node filesystem driver. */
export interface NodeDriverOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during driver creation. Defaults to true. */
  readonly createRoot?: boolean;
}

/** Opens one update-mode file, creating it only when the path was absent. */
async function openUpdateFile(
  fs: NodeFsPromisesType,
  path: string,
  virtualPath: string,
): Promise<NodeFileHandle> {
  try {
    return await fs.open(path, "r+");
  } catch (error) {
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
async function writeStreamToFile(
  fs: NodeFsPromisesType,
  hostPath: string,
  virtualPath: string,
  source: ReadableStream<Uint8Array>,
  options: FileDriverWriteOptionsType,
): Promise<void> {
  let file: NodeFileHandle | undefined;
  try {
    file = options.mode === "update"
      ? await openUpdateFile(fs, hostPath, virtualPath)
      : await fs.open(hostPath, options.mode === "replace" ? "w+" : "a+");

    let position = options.mode === "replace"
      ? 0
      : options.mode === "append"
      ? (await file.stat()).size
      : options.at ?? 0;

    const reader = source.getReader();
    try {
      while (true) {
        throwIfAborted(options.signal, "write", virtualPath);
        const next = await reader.read();
        if (next.done) break;

        let offset = 0;
        while (offset < next.value.byteLength) {
          const result = await file.write(next.value, offset, next.value.byteLength - offset, position);
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
class NodeWritableFile implements FileDriverWritableFileType {
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

/**
 * Synchronous random-access wrapper over one Node file descriptor.
 *
 * Cursor state is local to this wrapper. Passing `at` on a read/write performs
 * that operation at the explicit position and moves the wrapper cursor to the
 * end of the operation, matching the package sync-file contract.
 */
class NodeSyncFile implements FileDriverSyncFileType {
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
    this.#cursor = position + count;
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
class NodeBackend implements FileBackendType {
  /** Stable driver identity used in diagnostics. */
  readonly name = "node";
  /** Native Node filesystem operations exposed without facade emulation. */
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
    this.#fs = globalThis.process.getBuiltinModule("node:fs") as NodeFsType;
    this.#fsp = globalThis.process.getBuiltinModule("node:fs/promises") as NodeFsPromisesType;
    this.#stream = globalThis.process.getBuiltinModule("node:stream") as NodeStreamType;
    this.#hostPath = createLocalPath(options.root);
    if (options.createRoot ?? true) this.#fs.mkdirSync(this.#hostPath("/"), { recursive: true });
  }

  /** Returns host metadata or `null` when the virtual path is absent. */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    try {
      const info = await this.#fsp.stat(this.#hostPath(path));
      return info.isDirectory()
        ? { kind: "directory", lastModified: info.mtimeMs }
        : { kind: "file", size: info.size, lastModified: info.mtimeMs, mediaType: "" };
    } catch (error) {
      const mapped = toFileSystemError(error, "stat", path);
      if (mapped.code === "not-found") return null;
      throw mapped;
    }
  }

  /** Reads the complete file or performs positioned reads for one requested range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    if (options.at === undefined && options.length === undefined) {
      return new Uint8Array(await this.#fsp.readFile(this.#hostPath(path)));
    }

    const file = await this.#fsp.open(this.#hostPath(path), "r");
    try {
      const info = await file.stat();
      const start = options.at ?? 0;
      const length = Math.max(0, Math.min(options.length ?? info.size - start, info.size - start));
      const output = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        const result = await file.read(output, offset, length - offset, start + offset);
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
    const start = options.at ?? 0;
    const end = options.length === undefined ? undefined : Math.max(start, start + options.length - 1);
    const stream = this.#fs.createReadStream(this.#hostPath(path), { start, ...(end === undefined ? {} : { end }) });
    return this.#stream.Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  }

  /** Preserves replace, append, and positioned update semantics with native Node APIs. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    throwIfAborted(options.signal, "write", path);
    const target = this.#hostPath(path);
    if (options.mode === "replace") {
      await this.#fsp.writeFile(target, data);
      return;
    }
    if (options.mode === "append") {
      await this.#fsp.appendFile(target, data);
      return;
    }

    const file = await openUpdateFile(this.#fsp, target, path);
    try {
      const position = options.at ?? 0;
      let offset = 0;
      while (offset < data.byteLength) {
        const result = await file.write(data, offset, data.byteLength - offset, position + offset);
        if (result.bytesWritten <= 0) throw new Error(`Node write made no progress for '${path}'.`);
        offset += result.bytesWritten;
      }
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
    await writeStreamToFile(this.#fsp, this.#hostPath(path), path, source, options);
  }

  /** Lazily yields native direct children that are files or directories. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    for (const entry of await this.#fsp.readdir(this.#hostPath(path), { withFileTypes: true })) {
      throwIfAborted(options.signal, "read-dir", path);
      if (entry.isDirectory()) yield { name: entry.name, kind: "directory" };
      else if (entry.isFile()) yield { name: entry.name, kind: "file" };
    }
  }

  /** Creates exactly one host directory. Parent creation belongs to the facade. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "mkdir", path);
    await this.#fsp.mkdir(this.#hostPath(path));
  }

  /** Removes one host file or empty directory. Recursive policy belongs to the facade. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "remove", path);
    await this.#fsp.rm(this.#hostPath(path));
  }

  /** Uses `copyFile()` so source bytes do not route through JavaScript buffers. */
  async copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void> {
    throwIfAborted(options.signal, "copy", source);
    await this.#fsp.copyFile(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Uses native rename for the driver's move capability. */
  async move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void> {
    throwIfAborted(options.signal, "move", source);
    await this.#fsp.rename(this.#hostPath(source), this.#hostPath(destination));
  }

  /** Opens one long-lived asynchronous positional file descriptor. */
  async openWritableFile(path: PathType): Promise<FileDriverWritableFileType> {
    return new NodeWritableFile(path, await this.#fsp.open(this.#hostPath(path), "r+"));
  }

  /** Opens one synchronous random-access descriptor and transfers ownership to the wrapper. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
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
    optimizations: [],
  });
}
