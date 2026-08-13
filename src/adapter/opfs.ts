import type {
  AdapterDirectoryEntryType,
  AdapterReadOptionsType,
  AdapterStatType,
  AdapterSyncFileType,
  AdapterType,
  AdapterWriteOptionsType,
  FileSystemOptionsType,
} from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { createFileSystem, type FileSystemType } from "../filesystem.ts";
import { basename, dirname, ROOT_PATH, splitPath } from "../path.ts";

/** Minimal file handle shape needed from browser OPFS. */
interface NativeFileHandleType {
  /** Native File System API discriminator. */
  readonly kind: "file";
  /** Native direct-entry name. */
  readonly name: string;
  /** Returns the browser's immutable File snapshot. */
  getFile(): Promise<File>;
  /** Opens the browser's staged writable stream. */
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  /** Opens worker-only synchronous access when this context exposes it. */
  createSyncAccessHandle?: () => Promise<AdapterSyncFileType>;
}

/** Minimal directory handle shape needed from browser OPFS. */
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

/** OPFS adapter with its native root retained for advanced browser interop. */
export interface OpfsAdapterType extends AdapterType {
  /** Native origin-private directory root. */
  readonly nativeRoot: FileSystemDirectoryHandle;
}

/** Options for opening the browser's current origin-private filesystem. */
export type OpenFileSystemOptionsType = FileSystemOptionsType;

/** Resolves a canonical virtual directory path one OPFS handle at a time. */
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

/** Slices a File snapshot before streaming so range reads do not expose unrelated bytes. */
function getStream(file: File, options: AdapterReadOptionsType): ReadableStream<Uint8Array> {
  const at = options.at ?? 0;
  const end = options.length === undefined ? file.size : Math.min(file.size, at + options.length);
  return file.slice(at, end).stream() as ReadableStream<Uint8Array>;
}

/**
 * Determines entry kind without creating anything.
 *
 * OPFS has separate file and directory lookup methods. A type mismatch from the
 * first lookup is therefore a normal branch, not a failure: the adapter tries
 * the other kind before concluding that the path is absent.
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
 * Streams bytes into one native OPFS writable and preserves native staging.
 *
 * `createWritable()` commits on close. If reading the producer or writing a
 * chunk fails, this function cancels the producer and aborts the writable so a
 * partially staged image never becomes the visible file.
 */
async function writeToNative(
  handle: NativeFileHandleType,
  source: ReadableStream<Uint8Array>,
  options: AdapterWriteOptionsType,
  path: string,
): Promise<void> {
  const keepExistingData = options.mode !== "replace";
  const writable = await handle.createWritable({ keepExistingData });
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
        await writable.write(next.value);
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
      // The write failure is the useful diagnostic if abort also fails.
    }
    throw error;
  }
}


/** Returns whether the current runtime exposes the dedicated-worker sync file method. */
function supportsSyncAccessHandle(): boolean {
  const constructor = Reflect.get(globalThis, "FileSystemFileHandle");
  if (typeof constructor !== "function") return false;
  const prototype = Reflect.get(constructor, "prototype");
  return typeof prototype === "object" &&
    prototype !== null &&
    typeof Reflect.get(prototype, "createSyncAccessHandle") === "function";
}

/**
 * Creates an adapter over an already acquired native OPFS root.
 *
 * The adapter borrows `root`; disposing the adapter does not dispose browser
 * storage because the File System API has no root-close operation. `nativeRoot`
 * remains available for advanced code that must interoperate with a real browser
 * handle outside the facade.
 *
 * @example Wrap an already-acquired native root.
 * ```ts
 * const root = await navigator.storage.getDirectory();
 * const fileSystem = createFileSystem(createOpfsAdapter(root));
 * await fileSystem.writeFile("/state.json", "{}", { parents: true });
 * ```
 */
export function createOpfsAdapter(root: FileSystemDirectoryHandle): OpfsAdapterType {
  const nativeRoot = root as unknown as NativeDirectoryHandleType;
  return defineAdapter({
    name: "opfs",
    nativeRoot: root,
    capabilities: {
      read: true,
      write: true,
      streamRead: true,
      streamWrite: true,
      rangeRead: true,
      nativeMove: false,
      syncAccess: supportsSyncAccessHandle(),
    },
    async stat(path, options) {
      throwIfAborted(options?.signal, "stat", path);
      return await getStat(nativeRoot, path);
    },
    async readFile(path, options = {}) {
      throwIfAborted(options.signal, "read", path);
      const file = await (await getFile(nativeRoot, path)).getFile();
      return new Uint8Array(await new Response(getStream(file, options)).arrayBuffer());
    },
    async openReadStream(path, options = {}) {
      throwIfAborted(options.signal, "read", path);
      return getStream(await (await getFile(nativeRoot, path)).getFile(), options);
    },
    async writeFile(path, data, options) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      await writeToNative(await getFile(nativeRoot, path, true), stream, options, path);
    },
    async writeStream(path, source, options) {
      await writeToNative(await getFile(nativeRoot, path, true), source, options, path);
    },
    async *readDir(path, options) {
      throwIfAborted(options?.signal, "read-dir", path);
      const directory = await getDirectory(nativeRoot, path);
      for await (const [name, handle] of directory.entries()) {
        throwIfAborted(options?.signal, "read-dir", path);
        yield { name, kind: handle.kind } satisfies AdapterDirectoryEntryType;
      }
    },
    async createDir(path, options) {
      throwIfAborted(options?.signal, "mkdir", path);
      const parent = await getDirectory(nativeRoot, dirname(path));
      await parent.getDirectoryHandle(basename(path), { create: true });
    },
    async remove(path, options) {
      throwIfAborted(options?.signal, "remove", path);
      const parent = await getDirectory(nativeRoot, dirname(path));
      await parent.removeEntry(basename(path));
    },
    async openSyncFile(path) {
      const handle = await getFile(nativeRoot, path);
      if (handle.createSyncAccessHandle === undefined) {
        throw new FileSystemError(
          "not-supported",
          "open-sync-file",
          path,
          "This browser context does not expose createSyncAccessHandle().",
        );
      }
      return await handle.createSyncAccessHandle();
    },
  });
}

/**
 * Opens the current origin-private filesystem and returns the adapter-independent facade.
 *
 * Importing this module performs no storage access. The browser root is acquired
 * only when this function runs, so unsupported/private/opaque contexts fail at
 * the call site and can be inspected with `probeOpfs()` first. No browser-name
 * or private-mode detection is used; the call reports the capability the current
 * storage context actually grants.
 *
 * @example Open native OPFS from a secure browser context.
 * ```ts
 * const fileSystem = await openFileSystem({ coordination: "auto" });
 * await fileSystem.ensureDir("/cache");
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
