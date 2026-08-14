import type {
  AdapterDirectoryEntryType,
  AdapterSignalOptionsType,
  AdapterType,
  FileSystemOptionsType,
} from "./adapter/definition.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "./error.ts";
import { MutationLocks } from "./lock.ts";
import { basename, dirname, isAncestorPath, joinPath, normalizePath, ROOT_PATH, splitPath } from "./path.ts";
import { CoordinationModeSchema, EntryKindSchema, WriteModeSchema } from "./schema.ts";
import type { EntryKindType, WriteModeType } from "./schema.ts";
import {
  collectBytes,
  isAsyncIterable,
  isReadableStream,
  toBytes,
  toByteStream,
  type WriteDataType,
  withAbortSignal,
} from "./stream.ts";
import { ManagedSyncFile, type SyncFileType } from "./sync.ts";
import { ManagedWritableFile, type WritableFileType } from "./writable.ts";
import { DirectoryHandle, FileHandle, type DirectoryHandleType, type FileHandleType } from "./handle.ts";

/** Default lock namespace used when the caller does not provide one. */
const DEFAULT_LOCK_PREFIX = "@okikio/opfs";
/** Default maximum materialization for a stream sent to a value-oriented adapter. */
const DEFAULT_BUFFER_LIMIT = 64 * 1024 * 1024;
/** Default concurrent file-copy count for recursive copy. */
const DEFAULT_COPY_CONCURRENCY = 4;

/** Options for operations that support cancellation. */
export interface SignalOptionsType {
  /** Stops work that has not committed yet. */
  readonly signal?: AbortSignal;
}

/** Options for opening or creating a directory through the facade. */
export interface DirectoryOptionsType extends SignalOptionsType {
  /** Creates the final directory when it does not exist. */
  readonly create?: boolean;
  /** Creates missing parent directories as well. */
  readonly recursive?: boolean;
}

/** Options for opening or creating a file through the facade. */
export interface FileOptionsType extends SignalOptionsType {
  /** Creates the file when it does not exist. */
  readonly create?: boolean;
  /** Creates missing parent directories before the file. */
  readonly parents?: boolean;
}

/** Options for reading a complete file or byte range. */
export interface ReadOptionsType extends SignalOptionsType {
  /** Zero-based byte offset. */
  readonly at?: number;
  /** Maximum bytes to return. */
  readonly length?: number;
}

/** Options for decoding text after a byte read. */
export interface ReadTextOptionsType extends ReadOptionsType {
  /** Encoding passed to TextDecoder. Defaults to UTF-8. */
  readonly encoding?: string;
}

/** Options for writing a file. */
export interface WriteOptionsType extends SignalOptionsType {
  /** Relationship between new and existing bytes. Defaults to `replace`. */
  readonly mode?: WriteModeType;
  /** Zero-based offset used by `update`. */
  readonly at?: number;
  /** Truncates at the final write cursor. */
  readonly truncate?: boolean;
  /** Creates missing parent directories. */
  readonly parents?: boolean;
  /** Media type retained by adapters that persist metadata. */
  readonly mediaType?: string;
}

/** Options for advisory entry existence checks. */
export interface ExistsOptionsType extends SignalOptionsType {
  /** Requires a specific observed entry kind. */
  readonly kind?: EntryKindType;
}

/** Options for creating directories. */
export interface MakeDirectoryOptionsType extends SignalOptionsType {
  /** Creates all missing parent directories. */
  readonly recursive?: boolean;
}

/** Options for lazy recursive traversal. */
export interface WalkOptionsType extends SignalOptionsType {
  /** Maximum depth below the requested root. `0` yields only the root when included. */
  readonly maxDepth?: number;
  /** Includes the requested root. Defaults to false. */
  readonly includeRoot?: boolean;
  /** Includes file entries. Defaults to true. */
  readonly includeFiles?: boolean;
  /** Includes directory entries. Defaults to true. */
  readonly includeDirectories?: boolean;
}

/** Options for recursive copy and move. */
export interface CopyOptionsType extends SignalOptionsType {
  /** Replaces an existing destination. Defaults to false. */
  readonly overwrite?: boolean;
  /** Maximum file bodies copied concurrently. Defaults to four. */
  readonly concurrency?: number;
}

/** Move has the same policy inputs as recursive copy. */
export type MoveOptionsType = CopyOptionsType;

/** Options for removing an entry. */
export interface RemoveOptionsType extends SignalOptionsType {
  /** Removes directory descendants before the directory. */
  readonly recursive?: boolean;
}

/** Options for removing every child of one directory. */
export interface EmptyDirectoryOptionsType extends SignalOptionsType {
  /** Maximum direct-child removals started concurrently. Defaults to four. */
  readonly concurrency?: number;
}

/** Options for opening long-lived asynchronous positional writes. */
export interface OpenWritableFileOptionsType extends SignalOptionsType {
  /** Creates the file when it does not exist. */
  readonly create?: boolean;
  /** Creates missing parent directories when creating the file. */
  readonly parents?: boolean;
}

/** Options for opening synchronous random access. */
export interface OpenSyncFileOptionsType extends SignalOptionsType {
  /** Creates the file when it does not exist. */
  readonly create?: boolean;
  /** Creates missing parent directories when creating the file. */
  readonly parents?: boolean;
}

/** One direct child returned by {@link FileSystemType.readDir}. */
export interface DirectoryEntryType {
  /** Canonical virtual path. */
  readonly path: string;
  /** Final entry name. */
  readonly name: string;
  /** File or directory discriminator. */
  readonly kind: EntryKindType;
  /** OPFS-compatible facade object for code that prefers handle APIs. */
  readonly handle: FileHandleType | DirectoryHandleType;
}

/** One recursive entry returned by {@link FileSystemType.walk}. */
export interface WalkEntryType extends DirectoryEntryType {
  /** Depth below the requested walk root. */
  readonly depth: number;
}

/** Portable file metadata returned by {@link FileSystemType.stat}. */
export interface FileStatType {
  /** Discriminator for file metadata. */
  readonly kind: "file";
  /** Canonical virtual path. */
  readonly path: string;
  /** Final file name. */
  readonly name: string;
  /** File byte length. */
  readonly size: number;
  /** Last-modified Unix epoch milliseconds. */
  readonly lastModified: number;
  /** Media type, or an empty string when unknown. */
  readonly mediaType: string;
}

/** Portable directory metadata returned by {@link FileSystemType.stat}. */
export interface DirectoryStatType {
  /** Discriminator for directory metadata. */
  readonly kind: "directory";
  /** Canonical virtual path. */
  readonly path: string;
  /** Final directory name. Root uses an empty name. */
  readonly name: string;
  /** Last-modified Unix epoch milliseconds when observable. */
  readonly lastModified?: number;
}

/** Portable file or directory metadata. */
export type StatType = FileStatType | DirectoryStatType;

/**
 * Adapter-independent filesystem facade.
 *
 * High-level calls use canonical virtual paths. `root`, `getFileHandle()`, and
 * `getDirectoryHandle()` provide File System API-shaped objects on top of the
 * same adapter. This lets browser-oriented code run against OPFS, Deno, Bun,
 * Node, RxDB, unstorage, db0, Drizzle, or a custom adapter.
 *
 * The facade owns mutation locks. It does not own the adapter unless
 * `disposeAdapter` was enabled at creation time.
 */
export interface FileSystemType extends AsyncDisposable {
  /** Adapter selected for this filesystem. */
  /** Persistence adapter that implements this facade's backend operations. */
  readonly adapter: AdapterType;
  /** OPFS-compatible root directory facade. */
  /** Stable OPFS-shaped handle for the virtual root directory. */
  readonly root: DirectoryHandleType;
  /** Maximum stream bytes materialized for adapters without native streaming writes. */
  /** Hard limit used before a value-oriented adapter may materialize streamed input. */
  readonly maxBufferedWriteBytes: number;

  /** Opens or optionally creates a directory. */
  getDirectoryHandle(path: string, options?: DirectoryOptionsType): Promise<DirectoryHandleType>;
  /** Opens or optionally creates a file. */
  getFileHandle(path: string, options?: FileOptionsType): Promise<FileHandleType>;
  /** Returns a Web File snapshot for one file. */
  getFile(path: string, options?: SignalOptionsType): Promise<File>;
  /** Returns portable entry metadata. */
  stat(path: string, options?: SignalOptionsType): Promise<StatType>;
  /** Performs an advisory existence check that can race later operations. */
  exists(path: string, options?: ExistsOptionsType): Promise<boolean>;
  /** Creates one directory, or its missing parents when recursive is true. */
  mkdir(path: string, options?: MakeDirectoryOptionsType): Promise<void>;
  /** Ensures a complete directory path exists. */
  ensureDir(path: string, options?: SignalOptionsType): Promise<void>;
  /** Ensures a file exists without truncating an existing file. */
  ensureFile(path: string, options?: SignalOptionsType): Promise<void>;
  /** Lazily iterates direct children. */
  readDir(path?: string, options?: SignalOptionsType): AsyncIterableIterator<DirectoryEntryType>;
  /** Lazily traverses a directory tree. */
  walk(path?: string, options?: WalkOptionsType): AsyncIterableIterator<WalkEntryType>;
  /** Materializes a complete file or requested byte range. */
  readFile(path: string, options?: ReadOptionsType): Promise<Uint8Array>;
  /** Reads and decodes text. */
  readText(path: string, options?: ReadTextOptionsType): Promise<string>;
  /** Opens an abortable byte stream. Non-streaming adapters return one buffered chunk. */
  openReadStream(path: string, options?: ReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Writes materialized, streamed, or async-iterable data. */
  writeFile(path: string, data: WriteDataType, options?: WriteOptionsType): Promise<void>;
  /** Copies a file or directory tree. */
  copy(source: string, destination: string, options?: CopyOptionsType): Promise<void>;
  /** Uses a native adapter move when available, otherwise copy-then-remove. */
  move(source: string, destination: string, options?: MoveOptionsType): Promise<void>;
  /** Removes one entry and optionally its descendants. Missing paths are success. */
  remove(path: string, options?: RemoveOptionsType): Promise<void>;
  /** Removes every direct or nested child while preserving the requested directory. */
  emptyDir(path?: string, options?: EmptyDirectoryOptionsType): Promise<void>;
  /** Opens long-lived asynchronous positional writes when the selected adapter supports them. */
  openWritableFile(path: string, options?: OpenWritableFileOptionsType): Promise<WritableFileType>;
  /** Opens synchronous random access when the selected adapter supports it. */
  openSyncFile(path: string, options?: OpenSyncFileOptionsType): Promise<SyncFileType>;
  /** Releases an adapter only when ownership was transferred at creation. */
  close(): Promise<void>;
}

/** Validates byte offsets, lengths, and finite walk depths before an adapter sees them. */
function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer.`);
}

/** Resolves and validates bounded copy/removal concurrency. */
function getConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_COPY_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive safe integer.");
  }
  return concurrency;
}

/** Resolves the maximum safe materialization for value-oriented storage adapters. */
function getBufferLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BUFFER_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("maxBufferedWriteBytes must be a positive safe integer.");
  }
  return limit;
}

/** Projects a facade cancellation signal into the adapter operation contract. */
function getAdapterSignalOptions(signal: AbortSignal | undefined): AdapterSignalOptionsType {
  return signal === undefined ? {} : { signal };
}

/**
 * Waits for every already-started mutation before propagating a failure.
 *
 * Recursive copy and clear must not release their tree lock while sibling writes
 * are still running, even when one sibling has already failed.
 */
async function settleConcurrent(active: Set<Promise<void>>, failures: unknown[], prior?: unknown): Promise<void> {
  await Promise.allSettled([...active]);
  if (prior !== undefined) throw prior;
  if (failures.length > 0) throw failures[0];
}

/** Tracks one bounded child mutation and records its first failure without an unhandled rejection. */
function trackConcurrent(active: Set<Promise<void>>, failures: unknown[], operation: Promise<void>): void {
  let tracked!: Promise<void>;
  tracked = operation.catch((error) => {
    failures.push(error);
    throw error;
  }).finally(() => active.delete(tracked));
  active.add(tracked);
  void tracked.catch(() => undefined);
}

/**
 * Creates missing directory components from root to leaf.
 *
 * The walk checks each component before creation so a file in the middle of the
 * path produces a precise type mismatch instead of a backend-specific failure.
 */
async function ensureParents(adapter: AdapterType, path: string, signal?: AbortSignal): Promise<void> {
  let current = ROOT_PATH;
  for (const part of splitPath(path)) {
    current = joinPath(current, part);
    throwIfAborted(signal, "mkdir", current);
    const stat = await adapter.stat(current, getAdapterSignalOptions(signal));
    if (stat?.kind === "file") {
      throw new FileSystemError(
        "type-mismatch",
        "mkdir",
        current,
        `Cannot create directory '${current}' because a file exists at that path.`,
      );
    }
    if (stat === null) await adapter.createDir(current, getAdapterSignalOptions(signal));
  }
}

/** Projects one adapter child into path metadata plus an OPFS-shaped facade handle. */
function makeDirectoryEntry(
  fileSystem: FileSystemType,
  parent: string,
  entry: AdapterDirectoryEntryType,
): DirectoryEntryType {
  const path = joinPath(parent, entry.name);
  return {
    path,
    name: entry.name,
    kind: entry.kind,
    handle: entry.kind === "file" ? new FileHandle(fileSystem, path) : new DirectoryHandle(fileSystem, path),
  };
}

/**
 * Concrete facade that owns coordination and delegates persistence to one adapter.
 *
 * It is intentionally not exported as a class. Consumers depend on
 * {@link FileSystemType} and create instances through {@link createFileSystem},
 * which keeps adapter selection and lifecycle policy explicit.
 */
class FileSystemFacade implements FileSystemType {
  /** Persistence adapter that implements this facade's backend operations. */
  readonly adapter: AdapterType;
  /** Stable OPFS-shaped handle for the virtual root directory. */
  readonly root: DirectoryHandleType;
  /** Hard limit used before a value-oriented adapter may materialize streamed input. */
  readonly maxBufferedWriteBytes: number;
  /** Coordinates file mutations and structural tree changes for this facade. */
  readonly #locks: MutationLocks;
  /** Records whether facade disposal also transfers disposal to the adapter. */
  readonly #disposeAdapter: boolean;
  /** Terminal facade state. A closed facade never reopens. */
  #closed = false;

  constructor(adapter: AdapterType, options: FileSystemOptionsType) {
    this.adapter = adapter;
    this.maxBufferedWriteBytes = getBufferLimit(options.maxBufferedWriteBytes);
    this.#locks = new MutationLocks(
      CoordinationModeSchema.parse(options.coordination ?? "auto"),
      options.lockPrefix ?? DEFAULT_LOCK_PREFIX,
    );
    this.#disposeAdapter = options.disposeAdapter ?? false;
    this.root = new DirectoryHandle(this, ROOT_PATH);
  }

  /** Rejects all operations after the caller closes this facade. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new FileSystemError(
        "invalid-operation",
        "filesystem",
        undefined,
        "Filesystem is already closed.",
      );
    }
  }

  /**
   * Opens or creates a directory after validating parent and entry-kind invariants.
   *
   * Creation holds the structural tree lock so another facade mutation cannot
   * replace an ancestor while this method creates the requested directory.
   */
  async getDirectoryHandle(path: string, options: DirectoryOptionsType = {}): Promise<DirectoryHandleType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) return this.root;
    throwIfAborted(options.signal, "get-directory", normalized);

    if (options.create || options.recursive) {
      const lock = await this.#locks.acquireTree(options.signal);
      try {
        if (options.recursive) await ensureParents(this.adapter, normalized, options.signal);
        else {
          const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
          if (parent?.kind !== "directory") {
            throw new FileSystemError(
              "not-found",
              "get-directory",
              normalized,
              `Parent directory '${dirname(normalized)}' does not exist.`,
            );
          }
          const existing = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
          if (existing?.kind === "file") {
            throw new FileSystemError(
              "type-mismatch",
              "get-directory",
              normalized,
              `'${normalized}' is a file.`,
            );
          }
          if (existing === null) await this.adapter.createDir(normalized, getAdapterSignalOptions(options.signal));
        }
      } finally {
        lock.release();
      }
      return new DirectoryHandle(this, normalized);
    }

    const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
    if (stat === null) {
      throw new FileSystemError(
        "not-found",
        "get-directory",
        normalized,
        `Directory '${normalized}' does not exist.`,
      );
    }
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "get-directory", normalized, `'${normalized}' is a file.`);
    }
    return new DirectoryHandle(this, normalized);
  }

  /**
   * Opens or creates a file and returns an OPFS-shaped facade handle.
   *
   * File creation takes the file mutation lock and rechecks storage after the
   * lock is acquired so two creators cannot both assume the path is missing.
   */
  async getFileHandle(path: string, options: FileOptionsType = {}): Promise<FileHandleType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "get-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "get-file", normalized);

    let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
    if (stat?.kind === "directory") {
      throw new FileSystemError("type-mismatch", "get-file", normalized, `'${normalized}' is a directory.`);
    }
    if (stat === null && options.create) {
      const lock = await this.#locks.acquireFile(normalized, options.signal);
      try {
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "get-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat === null) {
          await this.adapter.writeFile(normalized, new Uint8Array(), {
            mode: "replace",
            ...getAdapterSignalOptions(options.signal),
          });
        }
      } finally {
        lock.release();
      }
    } else if (stat === null) {
      throw new FileSystemError("not-found", "get-file", normalized, `File '${normalized}' does not exist.`);
    }
    return new FileHandle(this, normalized);
  }

  /** Returns a fresh Web `File` snapshot built from the adapter's current bytes and metadata. */
  async getFile(path: string, options: SignalOptionsType = {}): Promise<File> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "file") {
      throw new FileSystemError("type-mismatch", "get-file", normalized, `'${normalized}' is a directory.`);
    }
    const bytes = await this.readFile(normalized, options);
    return new File([new Uint8Array(bytes)], stat.name, { lastModified: stat.lastModified, type: stat.mediaType });
  }

  /** Returns normalized file or directory metadata and rejects a missing path. */
  async stat(path: string, options: SignalOptionsType = {}): Promise<StatType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    throwIfAborted(options.signal, "stat", normalized);
    if (normalized === ROOT_PATH) return { kind: "directory", path: ROOT_PATH, name: "" };

    try {
      const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat === null) {
        throw new FileSystemError("not-found", "stat", normalized, `Entry '${normalized}' does not exist.`);
      }
      if (stat.kind === "file") {
        return {
          kind: "file",
          path: normalized,
          name: basename(normalized),
          size: stat.size,
          lastModified: stat.lastModified,
          mediaType: stat.mediaType,
        };
      }
      const output: DirectoryStatType = { kind: "directory", path: normalized, name: basename(normalized) };
      if (stat.lastModified !== undefined) return { ...output, lastModified: stat.lastModified };
      return output;
    } catch (error) {
      throw toFileSystemError(error, "stat", normalized);
    }
  }

  /**
   * Performs an advisory existence check.
   *
   * Callers must not use this result as a write precondition because another
   * context can mutate the path before the next operation starts.
   */
  async exists(path: string, options: ExistsOptionsType = {}): Promise<boolean> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    throwIfAborted(options.signal, "exists", normalized);
    const kind = options.kind === undefined ? undefined : EntryKindSchema.parse(options.kind);
    if (normalized === ROOT_PATH) return kind === undefined || kind === "directory";
    try {
      const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      return stat !== null && (kind === undefined || stat.kind === kind);
    } catch (error) {
      const normalizedError = toFileSystemError(error, "exists", normalized);
      if (normalizedError.code === "not-found") return false;
      throw normalizedError;
    }
  }

  /** Creates one directory, optionally creating missing ancestors under the tree lock. */
  async mkdir(path: string, options: MakeDirectoryOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) return;
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      if (options.recursive) {
        await ensureParents(this.adapter, normalized, options.signal);
        return;
      }
      const existing = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (existing !== null) {
        throw new FileSystemError("already-exists", "mkdir", normalized, `Entry '${normalized}' already exists.`);
      }
      const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
      if (parent?.kind !== "directory") {
        throw new FileSystemError(
          "not-found",
          "mkdir",
          normalized,
          `Parent directory '${dirname(normalized)}' does not exist.`,
        );
      }
      await this.adapter.createDir(normalized, getAdapterSignalOptions(options.signal));
    } finally {
      lock.release();
    }
  }

  /** Ensures every directory segment exists without replacing a file at any segment. */
  async ensureDir(path: string, options: SignalOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await ensureParents(this.adapter, normalizePath(path), options.signal);
    } finally {
      lock.release();
    }
  }

  /** Creates an empty file only when the path is missing and never truncates an existing file. */
  async ensureFile(path: string, options: SignalOptionsType = {}): Promise<void> {
    await this.getFileHandle(path, { create: true, parents: true, ...getAdapterSignalOptions(options.signal) });
  }

  /**
   * Lazily yields direct children from the adapter.
   *
   * The iterator does not collect the full directory, which keeps memory use
   * proportional to the adapter's own iteration strategy.
   */
  async *readDir(path = ROOT_PATH, options: SignalOptionsType = {}): AsyncIterableIterator<DirectoryEntryType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "read-dir", normalized, `'${normalized}' is a file.`);
    }

    try {
      for await (const entry of this.adapter.readDir(normalized, getAdapterSignalOptions(options.signal))) {
        throwIfAborted(options.signal, "read-dir", normalized);
        yield makeDirectoryEntry(this, normalized, entry);
      }
    } catch (error) {
      throw toFileSystemError(error, "read-dir", normalized);
    }
  }

  /** Lazily traverses the tree while applying depth and entry-kind filters during traversal. */
  async *walk(path = ROOT_PATH, options: WalkOptionsType = {}): AsyncIterableIterator<WalkEntryType> {
    this.#assertOpen();
    const root = normalizePath(path);
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    if (maxDepth < 0) return;
    if (Number.isFinite(maxDepth)) assertNonNegativeInteger(maxDepth, "maxDepth");
    const includeFiles = options.includeFiles ?? true;
    const includeDirectories = options.includeDirectories ?? true;

    const rootStat = await this.stat(root, options);
    if (options.includeRoot) {
      const include = rootStat.kind === "file" ? includeFiles : includeDirectories;
      if (include) {
        yield {
          path: root,
          name: basename(root),
          kind: rootStat.kind,
          handle: rootStat.kind === "file" ? new FileHandle(this, root) : new DirectoryHandle(this, root),
          depth: 0,
        };
      }
    }
    if (rootStat.kind === "file" || maxDepth === 0) return;

    const visit = async function* (
      fileSystem: FileSystemType,
      directory: string,
      depth: number,
    ): AsyncIterableIterator<WalkEntryType> {
      for await (const entry of fileSystem.readDir(directory, options)) {
        const nextDepth = depth + 1;
        const include = entry.kind === "file" ? includeFiles : includeDirectories;
        if (include) yield { ...entry, depth: nextDepth };
        if (entry.kind === "directory" && nextDepth < maxDepth) yield* visit(fileSystem, entry.path, nextDepth);
      }
    };
    yield* visit(this, root, 0);
  }

  /** Materializes a file or requested byte range after validating offsets and cancellation. */
  async readFile(path: string, options: ReadOptionsType = {}): Promise<Uint8Array> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (options.at !== undefined) assertNonNegativeInteger(options.at, "at");
    if (options.length !== undefined) assertNonNegativeInteger(options.length, "length");
    throwIfAborted(options.signal, "read", normalized);
    try {
      return await this.adapter.readFile(normalized, {
        ...(options.at === undefined ? {} : { at: options.at }),
        ...(options.length === undefined ? {} : { length: options.length }),
        ...getAdapterSignalOptions(options.signal),
      });
    } catch (error) {
      throw toFileSystemError(error, "read", normalized);
    }
  }

  /** Reads bytes and decodes them with the requested `TextDecoder` encoding. */
  async readText(path: string, options: ReadTextOptionsType = {}): Promise<string> {
    const bytes = await this.readFile(path, options);
    return new TextDecoder(options.encoding).decode(bytes);
  }

  /**
   * Opens an abortable byte stream.
   *
   * Streaming adapters stay incremental. Value-oriented adapters expose one
   * materialized chunk because they cannot supply a native byte stream.
   */
  async openReadStream(path: string, options: ReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (options.at !== undefined) assertNonNegativeInteger(options.at, "at");
    if (options.length !== undefined) assertNonNegativeInteger(options.length, "length");
    const adapterOptions = {
      ...(options.at === undefined ? {} : { at: options.at }),
      ...(options.length === undefined ? {} : { length: options.length }),
      ...getAdapterSignalOptions(options.signal),
    };
    try {
      const source = this.adapter.capabilities.streamRead && this.adapter.openReadStream !== undefined
        ? await this.adapter.openReadStream(normalized, adapterOptions)
        : new ReadableStream<Uint8Array>({
          start: async (controller) => {
            controller.enqueue(await this.adapter.readFile(normalized, adapterOptions));
            controller.close();
          },
        });
      return withAbortSignal(source, options.signal, normalized);
    } catch (error) {
      throw toFileSystemError(error, "read", normalized);
    }
  }

  /**
   * Writes bytes under the file mutation lock.
   *
   * Native streaming adapters receive streams directly. Other adapters must
   * materialize them below `maxBufferedWriteBytes` or the operation fails.
   */
  async writeFile(path: string, data: WriteDataType, options: WriteOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "write", normalized, "The virtual root is a directory.");
    }
    const mode = WriteModeSchema.parse(options.mode ?? "replace");
    if (options.at !== undefined) assertNonNegativeInteger(options.at, "at");
    const lock = await this.#locks.acquireFile(normalized, options.signal);

    try {
      if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
      const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
      if (parent?.kind !== "directory") {
        throw new FileSystemError(
          "not-found",
          "write",
          normalized,
          `Parent directory '${dirname(normalized)}' does not exist.`,
        );
      }
      const existing = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (existing?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", normalized, `'${normalized}' is a directory.`);
      }

      const adapterOptions = {
        mode,
        ...(options.at === undefined ? {} : { at: options.at }),
        ...(options.truncate === undefined ? {} : { truncate: options.truncate }),
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...getAdapterSignalOptions(options.signal),
      };

      const isStream = isReadableStream(data) || isAsyncIterable(data);
      if (isStream && this.adapter.capabilities.streamWrite && this.adapter.writeStream !== undefined) {
        await this.adapter.writeStream(normalized, toByteStream(data), adapterOptions);
      } else if (isReadableStream(data) || isAsyncIterable(data)) {
        const bytes = await collectBytes(
          toByteStream(data),
          this.maxBufferedWriteBytes,
          options.signal,
          "write",
          normalized,
        );
        await this.adapter.writeFile(normalized, bytes, adapterOptions);
      } else {
        await this.adapter.writeFile(normalized, await toBytes(data), adapterOptions);
      }
    } catch (error) {
      throw toFileSystemError(error, "write", normalized);
    } finally {
      lock.release();
    }
  }

  /**
   * Copies a file or directory tree while holding the structural tree lock.
   *
   * Recursive file-body work is concurrency-limited. Source/destination overlap
   * is rejected before overwrite removal can destroy source data.
   */
  async copy(source: string, destination: string, options: CopyOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const from = normalizePath(source);
    const to = normalizePath(destination);
    if (from === to || isAncestorPath(from, to) || isAncestorPath(to, from)) {
      throw new FileSystemError(
        "invalid-operation",
        "copy",
        from,
        `Copy source '${from}' and destination '${to}' must not overlap.`,
      );
    }
    const concurrency = getConcurrency(options.concurrency);
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      const sourceStat = await this.stat(from, options);
      const destinationStat = await this.adapter.stat(to, getAdapterSignalOptions(options.signal));
      if (destinationStat !== null) {
        if (!options.overwrite) {
          throw new FileSystemError("already-exists", "copy", to, `Destination '${to}' already exists.`);
        }
        await this.#removeUnlocked(to, true, options.signal);
      }
      await ensureParents(this.adapter, dirname(to), options.signal);

      if (sourceStat.kind === "file") {
        await this.#copyFileUnlocked(from, to, options.signal);
        return;
      }
      await this.adapter.createDir(to, getAdapterSignalOptions(options.signal));
      const active = new Set<Promise<void>>();
      const failures: unknown[] = [];

      try {
        for await (const entry of this.#walkAdapter(from, options.signal)) {
          if (failures.length > 0) break;
          const relative = entry.path.slice(from.length).replace(/^\//, "");
          const target = joinPath(to, relative);
          if (entry.kind === "directory") {
            await this.adapter.createDir(target, getAdapterSignalOptions(options.signal));
          } else {
            while (active.size >= concurrency) await Promise.race(active);
            trackConcurrent(active, failures, this.#copyFileUnlocked(entry.path, target, options.signal));
          }
        }
        await settleConcurrent(active, failures);
      } catch (error) {
        await settleConcurrent(active, failures, error);
      }
    } finally {
      lock.release();
    }
  }

  /** Copies one file after the caller has acquired the structural tree lock. */
  async #copyFileUnlocked(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const stream = this.adapter.capabilities.streamRead && this.adapter.openReadStream !== undefined
      ? await this.adapter.openReadStream(source, getAdapterSignalOptions(signal))
      : new ReadableStream<Uint8Array>({
        start: async (controller) => {
          controller.enqueue(await this.adapter.readFile(source, getAdapterSignalOptions(signal)));
          controller.close();
        },
      });
    if (this.adapter.capabilities.streamWrite && this.adapter.writeStream !== undefined) {
      await this.adapter.writeStream(destination, stream, { mode: "replace", ...getAdapterSignalOptions(signal) });
    } else {
      const bytes = await collectBytes(stream, this.maxBufferedWriteBytes, signal, "copy", source);
      await this.adapter.writeFile(destination, bytes, { mode: "replace", ...getAdapterSignalOptions(signal) });
    }
  }

  /** Traverses raw adapter entries without creating public facade handles. */
  async *#walkAdapter(
    path: string,
    signal?: AbortSignal,
  ): AsyncIterableIterator<{ path: string; kind: EntryKindType }> {
    for await (const entry of this.adapter.readDir(path, getAdapterSignalOptions(signal))) {
      throwIfAborted(signal, "walk", path);
      const child = joinPath(path, entry.name);
      yield { path: child, kind: entry.kind };
      if (entry.kind === "directory") yield* this.#walkAdapter(child, signal);
    }
  }

  /**
   * Moves an entry with the adapter's native move when available.
   *
   * Adapters without native move use copy-then-remove. That fallback is
   * deliberately non-atomic and is documented as such for callers.
   */
  async move(source: string, destination: string, options: MoveOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const from = normalizePath(source);
    const to = normalizePath(destination);
    if (from === to) return;
    if (isAncestorPath(from, to) || isAncestorPath(to, from)) {
      throw new FileSystemError(
        "invalid-operation",
        "move",
        from,
        `Move source '${from}' and destination '${to}' must not overlap.`,
      );
    }

    if (this.adapter.capabilities.nativeMove && this.adapter.move !== undefined) {
      const lock = await this.#locks.acquireTree(options.signal);
      try {
        if (options.overwrite) await this.#removeUnlocked(to, true, options.signal);
        else if (await this.adapter.stat(to, getAdapterSignalOptions(options.signal)) !== null) {
          throw new FileSystemError("already-exists", "move", to, `Destination '${to}' already exists.`);
        }
        await ensureParents(this.adapter, dirname(to), options.signal);
        await this.adapter.move(from, to, {
          overwrite: options.overwrite ?? false,
          ...getAdapterSignalOptions(options.signal),
        });
      } catch (error) {
        throw toFileSystemError(error, "move", from);
      } finally {
        lock.release();
      }
      return;
    }

    // Copy and remove are intentionally separate commits on adapters without a native rename.
    await this.copy(from, to, options);
    await this.remove(from, { recursive: true, ...getAdapterSignalOptions(options.signal) });
  }

  /** Removes a path idempotently and holds the tree lock for recursive structure changes. */
  async remove(path: string, options: RemoveOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError(
        "invalid-operation",
        "remove",
        normalized,
        "The virtual root cannot be removed. Use emptyDir('/') instead.",
      );
    }
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await this.#removeUnlocked(normalized, options.recursive ?? false, options.signal);
    } finally {
      lock.release();
    }
  }

  /** Removes one entry after the caller has acquired the structural tree lock. */
  async #removeUnlocked(path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    const stat = await this.adapter.stat(path, getAdapterSignalOptions(signal));
    if (stat === null) return;
    if (stat.kind === "directory") {
      const children: string[] = [];
      for await (const entry of this.adapter.readDir(path, getAdapterSignalOptions(signal))) {
        children.push(joinPath(path, entry.name));
      }
      if (children.length > 0 && !recursive) {
        throw new FileSystemError(
          "invalid-operation",
          "remove",
          path,
          `Directory '${path}' is not empty. Set recursive to true.`,
        );
      }
      for (const child of children) await this.#removeUnlocked(child, true, signal);
    }
    await this.adapter.remove(path, getAdapterSignalOptions(signal));
  }

  /**
   * Removes every child while preserving the requested directory.
   *
   * Direct-child removals are concurrency-limited, and already-started
   * removals settle before this method releases the structural tree lock.
   */
  async emptyDir(path = ROOT_PATH, options: EmptyDirectoryOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "empty-dir", normalized, `'${normalized}' is a file.`);
    }
    const concurrency = getConcurrency(options.concurrency);
    const lock = await this.#locks.acquireTree(options.signal);
    const active = new Set<Promise<void>>();
    const failures: unknown[] = [];
    try {
      for await (const entry of this.adapter.readDir(normalized, getAdapterSignalOptions(options.signal))) {
        while (active.size >= concurrency) await Promise.race(active);
        trackConcurrent(active, failures, this.#removeUnlocked(joinPath(normalized, entry.name), true, options.signal));
      }
      await settleConcurrent(active, failures);
    } catch (error) {
      await settleConcurrent(active, failures, error);
    } finally {
      lock.release();
    }
  }

  /**
   * Opens long-lived asynchronous positional writes and transfers the file lock to the returned resource.
   *
   * This operation is capability-gated rather than emulated with repeated
   * `writeFile(..., { mode: "update" })` calls. Record-oriented backends would
   * otherwise rematerialize an increasingly large file for each chunk, which
   * can turn a linear media write into quadratic work.
   */
  async openWritableFile(
    path: string,
    options: OpenWritableFileOptionsType = {},
  ): Promise<WritableFileType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "open-writable-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "open-writable-file", normalized);
    if (!this.adapter.capabilities.positionalWrite || this.adapter.openWritableFile === undefined) {
      throw new FileSystemError(
        "not-supported",
        "open-writable-file",
        normalized,
        `Adapter '${this.adapter.name}' does not provide long-lived positional writes.`,
      );
    }

    const lock = await this.#locks.acquireFile(normalized, options.signal);
    try {
      let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "open-writable-file", normalized, `'${normalized}' is a directory.`);
      }
      if (stat === null) {
        if (!options.create) {
          throw new FileSystemError("not-found", "open-writable-file", normalized, `File '${normalized}' does not exist.`);
        }
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "open-writable-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        await this.adapter.writeFile(normalized, new Uint8Array(), {
          mode: "replace",
          ...getAdapterSignalOptions(options.signal),
        });
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat?.kind !== "file") {
          throw new FileSystemError(
            "unknown",
            "open-writable-file",
            normalized,
            `Adapter '${this.adapter.name}' did not expose the file after creating it.`,
          );
        }
      }

      const file = await this.adapter.openWritableFile(normalized);
      return new ManagedWritableFile(normalized, file, lock, options.signal);
    } catch (error) {
      lock.release();
      throw toFileSystemError(error, "open-writable-file", normalized);
    }
  }

  /**
   * Opens synchronous random access and transfers the file mutation lock to the returned resource.
   *
   * The caller must close the returned file. Closing it releases both the
   * adapter-native resource and the facade lock.
   */
  async openSyncFile(path: string, options: OpenSyncFileOptionsType = {}): Promise<SyncFileType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "open-sync-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "open-sync-file", normalized);
    if (!this.adapter.capabilities.syncAccess || this.adapter.openSyncFile === undefined) {
      throw new FileSystemError(
        "not-supported",
        "open-sync-file",
        normalized,
        `Adapter '${this.adapter.name}' does not provide synchronous file access.`,
      );
    }

    const lock = await this.#locks.acquireFile(normalized, options.signal);
    try {
      let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "open-sync-file", normalized, `'${normalized}' is a directory.`);
      }
      if (stat === null) {
        if (!options.create) {
          throw new FileSystemError("not-found", "open-sync-file", normalized, `File '${normalized}' does not exist.`);
        }
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "open-sync-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        await this.adapter.writeFile(normalized, new Uint8Array(), {
          mode: "replace",
          ...getAdapterSignalOptions(options.signal),
        });
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat?.kind !== "file") {
          throw new FileSystemError(
            "unknown",
            "open-sync-file",
            normalized,
            `Adapter '${this.adapter.name}' did not expose the file after creating it.`,
          );
        }
      }

      const file = await this.adapter.openSyncFile(normalized);
      return new ManagedSyncFile(normalized, file, lock);
    } catch (error) {
      lock.release();
      throw toFileSystemError(error, "open-sync-file", normalized);
    }
  }

  /**
   * Closes this facade once and optionally disposes the injected adapter.
   *
   * `disposeAdapter` controls ownership transfer. Borrowed adapters remain live
   * after the facade closes.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#disposeAdapter) await this.adapter.dispose?.();
  }

  /** Enables `await using` to apply the same ownership rules as {@link close}. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Creates the OPFS-shaped facade over any filesystem adapter.
 *
 * @example Deno-backed frontend
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
 *
 * const fs = createFileSystem(createDenoAdapter({ root: "./data" }));
 * const file = await fs.root.getFileHandle("hello.txt", { create: true });
 * const writable = await file.createWritable();
 * await writable.write("hello");
 * await writable.close();
 * ```
 */
export function createFileSystem(adapter: AdapterType, options: FileSystemOptionsType = {}): FileSystemType {
  return new FileSystemFacade(adapter, options);
}
