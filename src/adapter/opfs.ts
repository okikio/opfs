import type {
  AdapterDirectoryEntryType,
  AdapterReadOptionsType,
  AdapterSignalOptionsType,
  AdapterStatType,
  AdapterSyncFileType,
  AdapterType,
  AdapterWritableFileType,
  AdapterWriteOptionsType,
  FileSystemOptionsType,
} from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { createFileSystem, type FileSystemType } from "../filesystem.ts";
import { basename, dirname, type PathType, ROOT_PATH, splitPath } from "../path.ts";
import { toByteStream } from "../stream.ts";

/** Minimal file handle contract required from browser OPFS. */
interface NativeFileHandleType {
  /** Native File System API discriminator. */
  readonly kind: "file";
  /** Native direct-entry name. */
  readonly name: string;
  /** Returns the browser's immutable file snapshot. */
  getFile(): Promise<File>;
  /** Opens the browser's staged writable stream. */
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  /** Opens worker-only synchronous access when this realm exposes it. */
  createSyncAccessHandle?: () => Promise<AdapterSyncFileType>;
}

/** Minimal directory handle contract required from browser OPFS. */
interface NativeDirectoryHandleType {
  /** Native File System API discriminator. */
  readonly kind: "directory";
  /** Native direct-entry name. */
  readonly name: string;
  /** Opens or creates one direct child file. */
  getFileHandle(name: string, options?: { create?: boolean }): Promise<NativeFileHandleType>;
  /** Opens or creates one direct child directory. */
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<NativeDirectoryHandleType>;
  /** Removes one direct child using browser-native filesystem semantics. */
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  /** Lazily iterates native direct-child handles. */
  entries(): AsyncIterableIterator<[string, NativeFileHandleType | NativeDirectoryHandleType]>;
}

/** OPFS adapter with the native root retained for advanced browser interop. */
export interface OpfsAdapterType extends AdapterType {
  /** Native origin-private directory root borrowed from the caller. */
  readonly nativeRoot: FileSystemDirectoryHandle;
}

/** Options for opening the current origin-private filesystem. */
export type OpenFileSystemOptionsType = FileSystemOptionsType;

/** Resolves a canonical virtual directory path one native handle at a time. */
async function getDirectory(root: NativeDirectoryHandleType, path: string): Promise<NativeDirectoryHandleType> {
  let current = root;
  for (const part of splitPath(path)) current = await current.getDirectoryHandle(part);
  return current;
}

/** Resolves a file through its parent directory and optionally creates the final entry. */
async function getFile(root: NativeDirectoryHandleType, path: string, create = false): Promise<NativeFileHandleType> {
  const parent = await getDirectory(root, dirname(path));
  return await parent.getFileHandle(basename(path), { create });
}

/** Slices a file snapshot before streaming so a range never exposes unrelated bytes. */
function getStream(file: File, options: AdapterReadOptionsType): ReadableStream<Uint8Array> {
  const at = options.at ?? 0;
  const end = options.length === undefined ? file.size : Math.min(file.size, at + options.length);
  return file.slice(at, end).stream() as ReadableStream<Uint8Array>;
}

/**
 * Determines entry kind without creating anything.
 *
 * Browser OPFS has separate file and directory lookup methods. A type mismatch
 * from the first lookup is therefore a normal branch. The second lookup must
 * run before the adapter can classify the path as absent.
 */
async function getStat(root: NativeDirectoryHandleType, path: string): Promise<AdapterStatType | null> {
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
  handle: NativeFileHandleType,
  source: ReadableStream<Uint8Array>,
  options: AdapterWriteOptionsType,
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
        await writable.write(next.value as BufferSource);
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
class OpfsWritableFile implements AdapterWritableFileType {
  /** Canonical path used in post-close diagnostics. */
  readonly #path: PathType;
  /** Native staged writable owned until close or abort. */
  readonly #writable: FileSystemWritableFileStream;
  /** Prevents writes after terminal resource settlement. */
  #closed = false;

  /** Takes ownership of one native staged writable for a canonical path. */
  constructor(path: PathType, writable: FileSystemWritableFileStream) {
    this.#path = path;
    this.#writable = writable;
  }

  /** Returns the live writable or rejects operations after settlement. */
  #getWritable(): FileSystemWritableFileStream {
    if (this.#closed) throw new Error(`Writable file '${this.#path}' is closed.`);
    return this.#writable;
  }

  /** Writes one byte view at its explicit file position. */
  async write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const data = buffer.buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : Uint8Array.from(view);
    await this.#getWritable().write({ type: "write", position: options.at, data });
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

/** Native browser OPFS implementation of the portable adapter contract. */
class OpfsAdapter implements OpfsAdapterType {
  /** Stable adapter identity used in diagnostics. */
  readonly name = "opfs";
  /** Native origin-private root retained for advanced browser interop. */
  readonly nativeRoot: FileSystemDirectoryHandle;
  /** Native operations exposed without facade emulation. */
  readonly capabilities;
  /** Narrow native root shape used by internal traversal helpers. */
  readonly #root: NativeDirectoryHandleType;

  /** Borrows the native root and probes only actual API exposure in this realm. */
  constructor(root: FileSystemDirectoryHandle) {
    this.nativeRoot = root;
    this.#root = root as unknown as NativeDirectoryHandleType;
    this.capabilities = {
      read: true,
      write: true,
      streamRead: true,
      streamWriteModes: ["replace", "append", "update"],
      rangeRead: true,
      nativeCopy: false,
      nativeMove: false,
      positionalWrite: true,
      syncAccess: supportsSyncAccessHandle(),
    } as const;
  }

  /** Returns native metadata or `null` when neither file nor directory exists. */
  async stat(path: PathType, options: AdapterSignalOptionsType = {}): Promise<AdapterStatType | null> {
    throwIfAborted(options.signal, "stat", path);
    return await getStat(this.#root, path);
  }

  /** Materializes the requested file snapshot or byte range. */
  async readFile(path: PathType, options: AdapterReadOptionsType = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal, "read", path);
    const file = await (await getFile(this.#root, path)).getFile();
    return new Uint8Array(await new Response(getStream(file, options)).arrayBuffer());
  }

  /** Streams the requested immutable snapshot or range without facade buffering. */
  async openReadStream(path: PathType, options: AdapterReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    throwIfAborted(options.signal, "read", path);
    return getStream(await (await getFile(this.#root, path)).getFile(), options);
  }

  /** Writes one materialized buffer through OPFS commit-on-close staging. */
  async writeFile(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void> {
    await writeToNative(await getFile(this.#root, path, true), toByteStream(data), options, path);
  }

  /** Streams bytes through the browser's native staged writable. */
  async writeStream(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void> {
    await writeToNative(await getFile(this.#root, path, true), source, options, path);
  }

  /** Lazily yields direct native children while honoring cancellation between entries. */
  async *readDir(path: PathType, options: AdapterSignalOptionsType = {}): AsyncIterableIterator<AdapterDirectoryEntryType> {
    throwIfAborted(options.signal, "read-dir", path);
    const directory = await getDirectory(this.#root, path);
    for await (const [name, handle] of directory.entries()) {
      throwIfAborted(options.signal, "read-dir", path);
      yield { name, kind: handle.kind };
    }
  }

  /** Creates one direct native directory after facade parent resolution. */
  async createDir(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "mkdir", path);
    const parent = await getDirectory(this.#root, dirname(path));
    await parent.getDirectoryHandle(basename(path), { create: true });
  }

  /** Removes one direct child. Recursive removal is owned by the facade. */
  async remove(path: PathType, options: AdapterSignalOptionsType = {}): Promise<void> {
    throwIfAborted(options.signal, "remove", path);
    const parent = await getDirectory(this.#root, dirname(path));
    await parent.removeEntry(basename(path));
  }

  /** Opens one staged positional writable and transfers its lifetime to the wrapper. */
  async openWritableFile(path: PathType): Promise<AdapterWritableFileType> {
    const handle = await getFile(this.#root, path, true);
    const writable = await handle.createWritable({ keepExistingData: true });
    return new OpfsWritableFile(path, writable);
  }

  /** Opens worker-only synchronous access when the native handle exposes it. */
  async openSyncFile(path: PathType): Promise<AdapterSyncFileType> {
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
 * Creates an adapter over an already acquired native OPFS root.
 *
 * The adapter borrows `root`; disposing the facade cannot close browser storage
 * because the File System API has no root-close operation. `nativeRoot` remains
 * available when advanced browser code must interoperate with the actual handle.
 *
 * @example Wrap an already acquired native root.
 * ```ts
 * const root = await navigator.storage.getDirectory();
 * const fs = createFileSystem(createOpfsAdapter(root));
 * await fs.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createOpfsAdapter(root: FileSystemDirectoryHandle): OpfsAdapterType {
  return defineAdapter(new OpfsAdapter(root));
}

/**
 * Opens the current origin-private filesystem and returns the portable facade.
 *
 * Importing this module performs no storage access. The browser root is acquired
 * only when this function runs, so unsupported, private, or opaque contexts fail
 * at the call site. The implementation probes API exposure rather than guessing
 * from a browser name or private-mode label.
 *
 * @example Open native OPFS from a secure browser context.
 * ```ts
 * const fs = await openFileSystem({ coordination: "auto" });
 * await fs.ensureDir("/cache");
 * ```
 */
export async function openFileSystem(options: OpenFileSystemOptionsType = {}): Promise<FileSystemType> {
  const navigatorValue = Reflect.get(globalThis, "navigator") as
    | { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } }
    | undefined;
  if (typeof navigatorValue?.storage?.getDirectory !== "function") {
    throw new FileSystemError(
      "unavailable",
      "open",
      undefined,
      "navigator.storage.getDirectory() is unavailable in this context.",
    );
  }

  try {
    const root = await navigatorValue.storage.getDirectory();
    return createFileSystem(createOpfsAdapter(root), options);
  } catch (error) {
    throw toFileSystemError(error, "open");
  }
}
