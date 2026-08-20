import type { FileBackendType, FileDriverType } from "./file.ts";
import { defineFileDriver } from "./file.ts";
import type {
  FileDriverDirectoryEntryType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverSyncFileType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
} from "./file.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { basename, dirname, type PathType, ROOT_PATH, splitPath } from "../path.ts";
import { toByteStream } from "../stream.ts";

/**
 * Staged writable operations used by the OPFS driver.
 *
 * This structural contract intentionally models only the methods the driver
 * calls. It avoids requiring consumers, Deno, Node, or Bun to install ambient
 * File System Access API declarations merely to import or type-check the
 * package.
 *
 * A browser-native `FileSystemWritableFileStream` satisfies this shape.
 */
export interface OpfsWritableFileStreamType {
  /** Writes ArrayBuffer-backed bytes or one explicit-position byte write into the staged file. */
  write(
    data:
      | Uint8Array<ArrayBuffer>
      | {
        readonly type: "write";
        readonly position: number;
        readonly data: Uint8Array<ArrayBuffer>;
      },
  ): Promise<void>;
  /** Moves the staged stream cursor to an absolute byte position. */
  seek(position: number): Promise<void>;
  /** Changes the staged file length. */
  truncate(size: number): Promise<void>;
  /** Commits the staged file and releases the browser file lock. */
  close(): Promise<void>;
  /** Discards the staged file when possible and releases the browser file lock. */
  abort(reason?: unknown): Promise<void>;
}

/**
 * File handle operations required by the OPFS driver.
 *
 * The contract is structural rather than an alias to the browser-global
 * `FileSystemFileHandle`. This keeps the package importable in runtimes whose
 * TypeScript libraries do not declare the File System Access API while still
 * accepting the real browser handle without wrapping it.
 */
export interface OpfsFileHandleType {
  /** Native File System API discriminator. */
  readonly kind: "file";
  /** Native direct-entry name. */
  readonly name: string;
  /** Returns the browser's immutable file snapshot. */
  getFile(): Promise<File>;
  /** Opens the browser's staged writable stream. */
  createWritable(options?: { readonly keepExistingData?: boolean }): Promise<OpfsWritableFileStreamType>;
  /** Opens worker-only synchronous access when this realm exposes it. */
  createSyncAccessHandle?: () => Promise<FileDriverSyncFileType>;
}

/**
 * Common child-handle fields consumed while enumerating one OPFS directory.
 *
 * This intentionally excludes file- and directory-specific methods because
 * `readDir()` only needs each child's name and discriminator.
 */
export interface OpfsDirectoryChildHandleType {
  /** Native File System API discriminator used while enumerating children. */
  readonly kind: "file" | "directory";
  /** Native direct-entry name. */
  readonly name: string;
}

/**
 * Directory handle operations required by the OPFS driver.
 *
 * The real browser `FileSystemDirectoryHandle` is structurally compatible with
 * this type. Enumeration intentionally requires only the child fields consumed
 * by `readDir()`, because TypeScript versions have represented `entries()` with
 * both `FileSystemHandle` and the narrower file/directory union. Generic factory
 * return types retain the caller's more specific root type on `nativeRoot`.
 */
export interface OpfsDirectoryHandleType {
  /** Native File System API discriminator. */
  readonly kind: "directory";
  /** Native direct-entry name. */
  readonly name: string;
  /** Opens or creates one direct child file. */
  getFileHandle(name: string, options?: { readonly create?: boolean }): Promise<OpfsFileHandleType>;
  /** Opens or creates one direct child directory. */
  getDirectoryHandle(name: string, options?: { readonly create?: boolean }): Promise<OpfsDirectoryHandleType>;
  /** Removes one direct child using browser-native filesystem semantics. */
  removeEntry(name: string, options?: { readonly recursive?: boolean }): Promise<void>;
  /** Lazily iterates the direct-child fields used by directory reads. */
  entries(): AsyncIterable<readonly [string, OpfsDirectoryChildHandleType]>;
}

/**
 * Native OPFS file driver with the root retained for browser interop.
 *
 * `RootType` preserves the exact root shape supplied by the caller. A browser
 * consumer that passes its concrete `FileSystemDirectoryHandle` therefore
 * keeps any additional native methods on `nativeRoot`, while server-side
 * checkers only need the structural OPFS contract above.
 */
export interface OpfsDriverType<RootType extends OpfsDirectoryHandleType = OpfsDirectoryHandleType>
  extends FileDriverType {
  readonly nativeRoot: RootType;
}

/** Resolves a canonical virtual directory path one native handle at a time. */
async function getDirectory(root: OpfsDirectoryHandleType, path: string): Promise<OpfsDirectoryHandleType> {
  let current = root;
  for (const part of splitPath(path)) current = await current.getDirectoryHandle(part);
  return current;
}

/** Resolves a file through its parent directory and optionally creates the final entry. */
async function getFile(root: OpfsDirectoryHandleType, path: string, create = false): Promise<OpfsFileHandleType> {
  const parent = await getDirectory(root, dirname(path));
  return await parent.getFileHandle(basename(path), { create });
}

/** Slices a file snapshot before streaming so a range never exposes unrelated bytes. */
function getStream(file: File, options: FileDriverReadOptionsType): ReadableStream<Uint8Array> {
  const at = options.at ?? 0;
  const end = options.length === undefined ? file.size : Math.min(file.size, at + options.length);
  return file.slice(at, end).stream() as ReadableStream<Uint8Array>;
}

/**
 * Returns bytes backed by an `ArrayBuffer`, as required by asynchronous OPFS writes.
 *
 * Portable streams can carry views backed by `SharedArrayBuffer`, while the File
 * System API's `BufferSource` deliberately accepts only `ArrayBuffer`-backed
 * views. Reusing an ArrayBuffer-backed chunk avoids a copy. Shared backing is
 * copied once before the value reaches the native writable stream.
 */
function toOpfsWriteBytes(value: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  if (value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Uint8Array.from(value);
}

/**
 * Determines entry kind without creating anything.
 *
 * Browser OPFS has separate file and directory lookup methods. A type mismatch
 * from the first lookup is therefore a normal branch. The second lookup must
 * run before the driver can classify the path as absent.
 */
async function getStat(root: OpfsDirectoryHandleType, path: string): Promise<FileDriverStatType | null> {
  if (path === ROOT_PATH) return { kind: "directory" };
  try {
    const handle = await getFile(root, path);
    const file = await handle.getFile();
    return { kind: "file", size: file.size, lastModified: file.lastModified, mediaType: file.type };
  } catch (error) {
    const mapped = toFileSystemError(error, "stat", path);
    if (mapped.code !== "not-found" && mapped.code !== "type-mismatch") throw mapped;
  }

  try {
    await getDirectory(root, path);
    return { kind: "directory" };
  } catch (error) {
    const mapped = toFileSystemError(error, "stat", path);
    if (mapped.code === "not-found" || mapped.code === "type-mismatch") return null;
    throw mapped;
  }
}

/**
 * Streams bytes into one native OPFS staged writable.
 *
 * `createWritable()` commits when it closes. If source reading, cancellation,
 * or writing fails, the producer is cancelled and the native writable is
 * aborted so the partially staged image does not become the visible file.
 */
async function writeToNative(
  handle: OpfsFileHandleType,
  source: ReadableStream<Uint8Array>,
  options: FileDriverWriteOptionsType,
  path: string,
): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: options.mode !== "replace" });
  let cursor = 0;
  try {
    if (options.mode === "append") {
      cursor = (await handle.getFile()).size;
      await writable.seek(cursor);
    } else if (options.mode === "update") {
      cursor = options.at ?? 0;
      await writable.seek(cursor);
    }

    const reader = source.getReader();
    try {
      while (true) {
        throwIfAborted(options.signal, "write", path);
        const next = await reader.read();
        if (next.done) break;
        await writable.write(toOpfsWriteBytes(next.value));
        cursor += next.value.byteLength;
      }
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

    if (options.truncate) await writable.truncate(cursor);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // The first write failure is more useful if abort also fails.
    }
    throw error;
  }
}

/** Returns whether this realm exposes the worker-only sync access method. */
function supportsSyncAccessHandle(): boolean {
  const constructor = Reflect.get(globalThis, "FileSystemFileHandle");
  if (typeof constructor !== "function") return false;
  const prototype = Reflect.get(constructor, "prototype");
  return typeof prototype === "object" &&
    prototype !== null &&
    typeof Reflect.get(prototype, "createSyncAccessHandle") === "function";
}

/** Long-lived native OPFS positional writable with explicit close/abort state. */
class OpfsWritableFile implements FileDriverWritableFileType {
  /** Canonical path used in post-close diagnostics. */
  readonly #path: PathType;
  /** Native staged writable owned until close or abort. */
  readonly #writable: OpfsWritableFileStreamType;
  /** Prevents writes after terminal resource settlement. */
  #closed = false;

  /** Takes ownership of one native staged writable for a canonical path. */
  constructor(path: PathType, writable: OpfsWritableFileStreamType) {
    this.#path = path;
    this.#writable = writable;
  }

  /** Returns the live writable or rejects operations after settlement. */
  #getWritable(): OpfsWritableFileStreamType {
    if (this.#closed) throw new Error(`Writable file '${this.#path}' is closed.`);
    return this.#writable;
  }

  /** Writes one byte view at its explicit file position. */
  async write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    await this.#getWritable().write({ type: "write", position: options.at, data: toOpfsWriteBytes(view) });
  }

  /** Changes the staged file size. */
  async truncate(size: number): Promise<void> {
    await this.#getWritable().truncate(size);
  }

  /** Verifies that the resource is still live; OPFS has no separate flush primitive. */
  async flush(): Promise<void> {
    this.#getWritable();
  }

  /** Commits the staged image and closes the native writable exactly once. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writable.close();
  }

  /** Discards the staged image when possible and closes exactly once. */
  async abort(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writable.abort(reason);
  }
}

/** Native browser OPFS implementation of the portable file-driver contract. */
class OpfsBackend<RootType extends OpfsDirectoryHandleType> implements FileBackendType {
  /** Stable driver identity used in diagnostics. */
  readonly name = "opfs";
  /** Native origin-private root retained for advanced browser interop. */
  readonly nativeRoot: RootType;
  /** Native operations exposed without facade emulation. */
  readonly capabilities;
  /** Narrow native root shape used by internal traversal helpers. */
  readonly #root: OpfsDirectoryHandleType;

  /** Borrows the native root and probes only actual API exposure in this realm. */
  constructor(root: RootType) {
    this.nativeRoot = root;
    this.#root = root;
    this.capabilities = {
      read: true,
      write: true,
      streamRead: true,
      streamWriteModes: ["replace", "append", "update"],
      rangeRead: true,
      copy: false,
      move: false,
      positionalWrite: true,
      syncAccess: supportsSyncAccessHandle(),
    } as const;
  }

  /** Returns native metadata or `null` when neither file nor directory exists. */
  async stat(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<FileDriverStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    return await getStat(this.#root, path);
  }

  /** Materializes the requested file snapshot or byte range. */
  async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    const file = await (await getFile(this.#root, path)).getFile();
    return new Uint8Array(await new Response(getStream(file, options)).arrayBuffer());
  }

  /** Streams the requested immutable snapshot or range without facade buffering. */
  async openReadStream(path: PathType, options: FileDriverReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    return getStream(await (await getFile(this.#root, path)).getFile(), options);
  }

  /** Writes one materialized buffer through OPFS commit-on-close staging. */
  async writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void> {
    await writeToNative(await getFile(this.#root, path, true), toByteStream(data), options, path);
  }

  /** Streams bytes through the browser's native staged writable. */
  async writeStream(
    path: PathType,
    source: ReadableStream<Uint8Array>,
    options: FileDriverWriteOptionsType,
  ): Promise<void> {
    await writeToNative(await getFile(this.#root, path, true), source, options, path);
  }

  /** Lazily yields direct native children while honoring cancellation between entries. */
  async *readDir(
    path: PathType,
    options: FileDriverSignalOptionsType = {},
  ): AsyncIterableIterator<FileDriverDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    const directory = await getDirectory(this.#root, path);
    for await (const [name, handle] of directory.entries()) {
      throwIfAborted(options.signal, "read-dir", path);
      yield { name, kind: handle.kind };
    }
  }

  /** Creates one direct native directory after facade parent resolution. */
  async createDir(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "mkdir", path);
    const parent = await getDirectory(this.#root, dirname(path));
    await parent.getDirectoryHandle(basename(path), { create: true });
  }

  /** Removes one direct child. Recursive removal is owned by the facade. */
  async remove(path: PathType, options: FileDriverSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "remove", path);
    const parent = await getDirectory(this.#root, dirname(path));
    await parent.removeEntry(basename(path));
  }

  /** Opens one staged positional writable and transfers its lifetime to the wrapper. */
  async openWritableFile(path: PathType): Promise<FileDriverWritableFileType> {
    const handle = await getFile(this.#root, path, true);
    const writable = await handle.createWritable({ keepExistingData: true });
    return new OpfsWritableFile(path, writable);
  }

  /** Opens worker-only synchronous access when the native handle exposes it. */
  async openSyncFile(path: PathType): Promise<FileDriverSyncFileType> {
    const handle = await getFile(this.#root, path);
    if (handle.createSyncAccessHandle === undefined) {
      throw new FileSystemError(
        "not-supported",
        "open-sync-file",
        path,
        "This browser context does not expose createSyncAccessHandle().",
      );
    }
    return await handle.createSyncAccessHandle();
  }
}

/**
 * Creates a native browser OPFS driver over an already acquired root.
 *
 * The driver borrows the browser root. Browser storage has no root-close
 * operation, so driver disposal never closes the origin-private filesystem.
 */
export function createOpfsDriver<RootType extends OpfsDirectoryHandleType>(
  root: RootType,
): OpfsDriverType<RootType> {
  const backend = new OpfsBackend(root);
  return {
    ...defineFileDriver(backend, {
      name: "opfs",
      ownership: "borrowed",
      requirements: [{ code: "opfs-root", state: "available" }],
      limits: [{
        code: "quota-bytes",
        kind: "dynamic",
        source: "probe",
        unit: "bytes",
        detail: "Current origin quota is runtime-dependent and must be probed.",
      }],
      optimizations: [],
    }),
    nativeRoot: root,
  };
}
