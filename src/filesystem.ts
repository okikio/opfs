import type {
  AdapterDirectoryEntryType,
  AdapterSignalOptionsType,
  AdapterType,
  FileSystemOptionsType,
} from "./adapter/definition.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "./error.ts";
import { MutationLocks } from "./lock.ts";
import { basename, dirname, isAncestorPath, joinPath, normalizePath, ROOT_PATH, splitPath } from "./path.ts";
import {
  CoordinationModeSchema,
  EntryKindSchema,
  MetricsModeSchema,
  OptimizationSchema,
  WriteModeSchema,
} from "./schema.ts";
import type { EntryKindType, MetricsModeType, OptimizationType, SupportModeType, WriteModeType } from "./schema.ts";
import { getSupport, type InspectionType } from "./capability.ts";
import { Metrics, type MetricsType } from "./metrics.ts";
import { createPlan, type PlanInputType, type PlanType } from "./plan.ts";
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
/** Native performance routes enabled unless the caller deliberately disables one. */
const DEFAULT_OPTIMIZATIONS: OptimizationType = {
  streamRead: true,
  streamWrite: true,
  rangeRead: true,
  nativeCopy: true,
  nativeMove: true,
};

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
  /** Persistence adapter that implements this facade's backend operations. */
  readonly adapter: AdapterType;
  /** Stable OPFS-shaped handle for the virtual root directory. */
  readonly root: DirectoryHandleType;
  /** Hard limit used before a value-oriented adapter may materialize streamed input. */
  readonly maxBufferedWriteBytes: number;
  /** Resolved native-route policy. Every route defaults to enabled. */
  readonly optimizations: OptimizationType;
  /** Configured instrumentation detail. */
  readonly metricsMode: MetricsModeType;

  /** Returns native, emulated, partitioned, limits, policy, and current metrics without performing I/O. */
  inspect(): InspectionType;
  /** Preflights a known operation against effective capabilities and limits without performing I/O. */
  plan(input: PlanInputType): PlanType;
  /** Returns a detached metrics snapshot. */
  getMetrics(): MetricsType;

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

/** Resolves a partial optimization policy to the strict public shape. */
function getOptimizations(value: FileSystemOptionsType["optimizations"]): OptimizationType {
  return OptimizationSchema.parse({ ...DEFAULT_OPTIMIZATIONS, ...value });
}

/** Parses one public enum-like option and normalizes schema failures to TypeError. */
function getValidatedOption<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(error instanceof Error ? error.message : String(error));
  }
}

/** Computes the logical file size produced by one materialized write. */
function getWriteSize(
  current: number,
  input: number,
  mode: WriteModeType,
  at: number | undefined,
  truncate: boolean,
): number {
  if (mode === "replace") return input;
  const position = mode === "append" ? current : at ?? 0;
  const end = position + input;
  return truncate ? end : Math.max(current, end);
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

/** Resolved traversal policy shared by every recursive directory visit. */
interface WalkStateType {
  /** Original operation options, including the caller cancellation signal. */
  readonly options: WalkOptionsType;
  /** Whether file entries are emitted. */
  readonly includeFiles: boolean;
  /** Whether directory entries are emitted. */
  readonly includeDirectories: boolean;
  /** Maximum depth below the requested walk root. */
  readonly maxDepth: number;
}

/**
 * Traverses descendants without hiding recursion inside `FileSystemFacade.walk`.
 *
 * The helper delegates each directory read back through the public facade. This
 * keeps cancellation, error normalization, and adapter semantics identical to a
 * direct `readDir()` call while the traversal itself remains lazy.
 */
async function* walkChildren(
  fileSystem: FileSystemType,
  directory: string,
  depth: number,
  state: WalkStateType,
): AsyncIterableIterator<WalkEntryType> {
  for await (const entry of fileSystem.readDir(directory, state.options)) {
    const nextDepth = depth + 1;
    const include = entry.kind === "file" ? state.includeFiles : state.includeDirectories;
    if (include) yield { ...entry, depth: nextDepth };

    if (entry.kind === "directory" && nextDepth < state.maxDepth) {
      yield* walkChildren(fileSystem, entry.path, nextDepth, state);
    }
  }
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
  /** Resolved native-route policy. Every route defaults to enabled. */
  readonly optimizations: OptimizationType;
  /** Configured instrumentation detail. */
  readonly metricsMode: MetricsModeType;

  /** Mutable metrics book hidden behind detached public snapshots. */
  readonly #metrics: Metrics;
  /** Coordinates file mutations and structural tree changes for this facade. */
  readonly #locks: MutationLocks;
  /** Records whether facade disposal also transfers disposal to the adapter. */
  readonly #disposeAdapter: boolean;
  /** Terminal facade state. A closed facade never reopens. */
  #closed = false;

  /** Acquires facade coordination state while borrowing or owning the selected adapter as configured. */
  constructor(adapter: AdapterType, options: FileSystemOptionsType) {
    this.adapter = adapter;
    this.maxBufferedWriteBytes = getBufferLimit(options.maxBufferedWriteBytes);
    this.optimizations = getOptimizations(options.optimizations);
    this.metricsMode = getValidatedOption(() => MetricsModeSchema.parse(options.metrics ?? "basic"));
    this.#metrics = new Metrics(this.metricsMode);
    this.#locks = new MutationLocks(
      getValidatedOption(() => CoordinationModeSchema.parse(options.coordination ?? "auto")),
      options.lockPrefix ?? DEFAULT_LOCK_PREFIX,
    );
    this.#disposeAdapter = options.disposeAdapter ?? false;
    this.root = new DirectoryHandle(this, ROOT_PATH);
  }


  /** Returns effective support, configured limits, policy, and a current metrics snapshot. */
  inspect(): InspectionType {
    this.#assertOpen();
    return {
      adapter: this.adapter.name,
      native: this.adapter.capabilities,
      support: getSupport(this.adapter, this.optimizations),
      limits: this.adapter.limits ?? {},
      ...(this.adapter.partition === undefined ? {} : { partition: this.adapter.partition }),
      optimizations: this.optimizations,
      maxBufferedWriteBytes: this.maxBufferedWriteBytes,
      metricsMode: this.metricsMode,
      metrics: this.#metrics.snapshot(),
    };
  }

  /** Creates a deterministic preflight plan without touching the backend. */
  plan(input: PlanInputType): PlanType {
    this.#assertOpen();
    return createPlan(input, {
      adapter: this.adapter,
      optimizations: this.optimizations,
      maxBufferedWriteBytes: this.maxBufferedWriteBytes,
    });
  }

  /** Returns a detached metrics snapshot suitable for diagnostics and benchmark output. */
  getMetrics(): MetricsType {
    return this.#metrics.snapshot();
  }

  /** Selects partitioned accounting when a configured physical layout will split a known logical value. */
  #support(route: SupportModeType, bytes?: number): SupportModeType {
    const partition = this.adapter.partition;
    if (partition === undefined || partition.mode === "never" || bytes === undefined) return route;
    return partition.mode === "always" || bytes > (partition.thresholdBytes ?? partition.partBytes) ? "partitioned" : route;
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
    const started = this.#metrics.start();
    if (normalized === ROOT_PATH) {
      this.#metrics.record("stat", { support: "native", started });
      return { kind: "directory", path: ROOT_PATH, name: "" };
    }

    try {
      const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat === null) {
        throw new FileSystemError("not-found", "stat", normalized, `Entry '${normalized}' does not exist.`);
      }
      if (stat.kind === "file") {
        const output: FileStatType = {
          kind: "file",
          path: normalized,
          name: basename(normalized),
          size: stat.size,
          lastModified: stat.lastModified,
          mediaType: stat.mediaType,
        };
        this.#metrics.record("stat", { support: "native", started });
        return output;
      }
      const output: DirectoryStatType = { kind: "directory", path: normalized, name: basename(normalized) };
      const result = stat.lastModified !== undefined ? { ...output, lastModified: stat.lastModified } : output;
      this.#metrics.record("stat", { support: "native", started });
      return result;
    } catch (error) {
      this.#metrics.record("stat", { support: "native", started, failed: true });
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

    yield* walkChildren(this, root, 0, { options, includeFiles, includeDirectories, maxDepth });
  }

  /** Materializes a file or requested byte range after validating offsets and cancellation. */
  async readFile(path: string, options: ReadOptionsType = {}): Promise<Uint8Array> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (options.at !== undefined) assertNonNegativeInteger(options.at, "at");
    if (options.length !== undefined) assertNonNegativeInteger(options.length, "length");
    throwIfAborted(options.signal, "read", normalized);
    const ranged = options.at !== undefined || options.length !== undefined;
    const support = ranged ? getSupport(this.adapter, this.optimizations).rangeRead : "native";
    const started = this.#metrics.start();
    try {
      let bytes: Uint8Array;
      if (ranged && this.adapter.capabilities.rangeRead && !this.optimizations.rangeRead) {
        const complete = await this.adapter.readFile(normalized, getAdapterSignalOptions(options.signal));
        const at = options.at ?? 0;
        const end = options.length === undefined ? complete.byteLength : Math.min(complete.byteLength, at + options.length);
        bytes = complete.subarray(Math.min(at, complete.byteLength), end);
      } else {
        bytes = await this.adapter.readFile(normalized, {
          ...(options.at === undefined ? {} : { at: options.at }),
          ...(options.length === undefined ? {} : { length: options.length }),
          ...getAdapterSignalOptions(options.signal),
        });
      }
      this.#metrics.record("read", { support, bytes: bytes.byteLength, started });
      return bytes;
    } catch (error) {
      this.#metrics.record("read", { support, started, failed: true });
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
      const nativeStream = this.optimizations.streamRead && this.adapter.capabilities.streamRead &&
        this.adapter.openReadStream !== undefined;
      const source = nativeStream
        ? await this.adapter.openReadStream!(normalized, adapterOptions)
        : new ReadableStream<Uint8Array>({
          start: async (controller) => {
            controller.enqueue(await this.adapter.readFile(normalized, adapterOptions));
            controller.close();
          },
        });
      this.#metrics.record("read-stream", { support: nativeStream ? "native" : "emulated" });
      return withAbortSignal(source, options.signal, normalized);
    } catch (error) {
      this.#metrics.record("read-stream", {
        support: this.optimizations.streamRead && this.adapter.capabilities.streamRead ? "native" : "emulated",
        failed: true,
      });
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
    const started = this.#metrics.start();
    let metricSupport: SupportModeType = "native";
    let metricBytes: number | undefined;
    let buffered = 0;

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
      const currentSize = existing?.kind === "file" ? existing.size : 0;

      const adapterOptions = {
        mode,
        ...(options.at === undefined ? {} : { at: options.at }),
        ...(options.truncate === undefined ? {} : { truncate: options.truncate }),
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...getAdapterSignalOptions(options.signal),
      };

      const stream = isReadableStream(data) || isAsyncIterable(data);
      const nativeStream = stream && this.optimizations.streamWrite &&
        this.adapter.capabilities.streamWriteModes.includes(mode) && this.adapter.writeStream !== undefined;
      if (nativeStream) {
        metricSupport = getSupport(this.adapter, this.optimizations).streamWrite[mode];
        let source = toByteStream(data);
        if (this.metricsMode !== "none") {
          source = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              metricBytes = (metricBytes ?? 0) + chunk.byteLength;
              controller.enqueue(chunk);
            },
          }));
        }
        await this.adapter.writeStream!(normalized, source, adapterOptions);
      } else if (stream) {
        metricSupport = "emulated";
        const bytes = await collectBytes(
          toByteStream(data),
          this.maxBufferedWriteBytes,
          options.signal,
          "write",
          normalized,
        );
        metricBytes = bytes.byteLength;
        buffered = bytes.byteLength;
        this.#metrics.buffer(buffered);
        await this.adapter.writeFile(normalized, bytes, adapterOptions);
      } else {
        const bytes = await toBytes(data);
        metricBytes = bytes.byteLength;
        metricSupport = this.#support(
          "native",
          getWriteSize(currentSize, bytes.byteLength, mode, options.at, options.truncate ?? false),
        );
        await this.adapter.writeFile(normalized, bytes, adapterOptions);
      }
      this.#metrics.record("write", {
        support: metricSupport,
        ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
        started,
      });
    } catch (error) {
      this.#metrics.record("write", {
        support: metricSupport,
        ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
        started,
        failed: true,
      });
      throw toFileSystemError(error, "write", normalized);
    } finally {
      if (buffered > 0) this.#metrics.buffer(-buffered);
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
    const started = this.#metrics.start();
    const metricSupport = getSupport(this.adapter, this.optimizations).copy;
    let metricBytes: number | undefined;
    let failed = true;
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      const sourceStat = await this.stat(from, options);
      if (sourceStat.kind === "file") metricBytes = sourceStat.size;
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
        failed = false;
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
      failed = false;
    } finally {
      this.#metrics.record("copy", {
        support: metricSupport,
        ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
        started,
        failed,
      });
      lock.release();
    }
  }

  /** Copies one file after the caller has acquired the structural tree lock. */
  async #copyFileUnlocked(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    if (this.optimizations.nativeCopy && this.adapter.capabilities.nativeCopy && this.adapter.copy !== undefined) {
      await this.adapter.copy(source, destination, { overwrite: true, ...getAdapterSignalOptions(signal) });
      return;
    }

    const stat = await this.adapter.stat(source, getAdapterSignalOptions(signal));
    if (stat?.kind !== "file") {
      throw new FileSystemError("type-mismatch", "copy", source, `Copy source '${source}' is not a file.`);
    }
    const writeOptions = {
      mode: "replace" as const,
      ...(stat.mediaType.length === 0 ? {} : { mediaType: stat.mediaType }),
      ...getAdapterSignalOptions(signal),
    };
    const streamRead = this.optimizations.streamRead && this.adapter.capabilities.streamRead &&
      this.adapter.openReadStream !== undefined;
    const streamWrite = this.optimizations.streamWrite && this.adapter.capabilities.streamWriteModes.includes("replace") &&
      this.adapter.writeStream !== undefined;

    if (streamRead) {
      if (!streamWrite && stat.size > this.maxBufferedWriteBytes) {
        throw new FileSystemError(
          "too-large",
          "copy",
          source,
          `Copy fallback must materialize ${stat.size} bytes, above maxBufferedWriteBytes ${this.maxBufferedWriteBytes}.`,
        );
      }
      const stream = await this.adapter.openReadStream!(source, getAdapterSignalOptions(signal));
      if (streamWrite) {
        await this.adapter.writeStream!(destination, stream, writeOptions);
        return;
      }

      const bytes = await collectBytes(stream, this.maxBufferedWriteBytes, signal, "copy", source);
      this.#metrics.buffer(bytes.byteLength);
      try {
        await this.adapter.writeFile(destination, bytes, writeOptions);
      } finally {
        this.#metrics.buffer(-bytes.byteLength);
      }
      return;
    }

    if (stat.size > this.maxBufferedWriteBytes) {
      throw new FileSystemError(
        "too-large",
        "copy",
        source,
        `Copy fallback must materialize ${stat.size} bytes, above maxBufferedWriteBytes ${this.maxBufferedWriteBytes}.`,
      );
    }
    const bytes = await this.adapter.readFile(source, getAdapterSignalOptions(signal));
    this.#metrics.buffer(bytes.byteLength);
    try {
      await this.adapter.writeFile(destination, bytes, writeOptions);
    } finally {
      this.#metrics.buffer(-bytes.byteLength);
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

    const started = this.#metrics.start();
    const support = getSupport(this.adapter, this.optimizations).move;
    try {
      if (this.optimizations.nativeMove && this.adapter.capabilities.nativeMove && this.adapter.move !== undefined) {
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
        } finally {
          lock.release();
        }
      } else {
        // Copy and remove are intentionally separate commits on adapters without a native rename.
        await this.copy(from, to, options);
        await this.remove(from, { recursive: true, ...getAdapterSignalOptions(options.signal) });
      }
      this.#metrics.record("move", { support, started });
    } catch (error) {
      this.#metrics.record("move", { support, started, failed: true });
      throw toFileSystemError(error, "move", from);
    }
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
    const started = this.#metrics.start();
    let failed = true;
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await this.#removeUnlocked(normalized, options.recursive ?? false, options.signal);
      failed = false;
    } finally {
      this.#metrics.record("remove", { support: "native", started, failed });
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
