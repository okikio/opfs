/**
 * Option, entry and stat types for the filesystem facade, and the `FileSystemType` contract it implements.
 *
 * @module
 */
import type { WritableOptionsType } from "../driver/file.ts";
import type { AdapterType } from "../adapter/definition.ts";
import type { RevisionType } from "../driver/file.ts";
import type { EntryKindType, MetricsModeType, OptimizationType, WriteModeType } from "../schema/types.ts";
import { type InspectionType } from "../capability.ts";
import { type MetricsType } from "../metrics.ts";
import { type PlanInputType, type PlanType } from "../plan.ts";
import { type WriteDataType } from "../stream.ts";
import { type SyncFileType } from "../sync.ts";
import { type WritableFileType } from "../writable.ts";
import { type DirectoryHandleType, type FileHandleType } from "../handle.ts";

/**
 * Options for operations that support cancellation.
 *
 * Cancellation is best-effort across every backend. Work that already committed
 * at the provider or host runtime may still be visible after an abort.
 */
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
  /**
   * Replace only the version with this revision, read from {@link FileStatType.revision}. A missing file or a
   * different revision throws `locked`, and nothing is written. The adapter holds the condition atomically, so this
   * is a compare-and-swap. An adapter without `capabilities.revisions` throws `not-supported`.
   */
  readonly ifRevision?: RevisionType;
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
  /** Requires failure-preserving single-file replacement. Defaults to true. */
  readonly preserve?: boolean;
  /** Requires atomic no-replace rather than a cooperating-owner precheck. */
  readonly exclusive?: boolean;
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
export interface OpenWritableFileOptionsType extends SignalOptionsType, WritableOptionsType {
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
  /**
   * This exact content version, when the backend names versions: an ETag, a generation or a version ID. Pass it
   * back as `writeFile(path, data, { ifRevision })` to replace only this version; that works where
   * `inspect().adapter.native.revisions` is true. A backend that reports versions but cannot condition a write, such
   * as native Backblaze B2, still reports it here, so its client can act on that exact version.
   */
  readonly revision?: RevisionType;
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
export interface FileSystemType<Backend = unknown> extends AsyncDisposable {
  /** Persistence adapter that implements this facade's backend operations. */
  readonly adapter: AdapterType<Backend>;
  /**
   * The client, database or store behind this filesystem, typed by the adapter that made it, or undefined when its
   * driver exposes none.
   *
   * File work goes through the filesystem methods. Use this for provider operations with no file meaning, where the
   * adapter has nothing to translate: `fs.backend.deleteVersion(file)` on Backblaze B2, for example. It is the same
   * object the caller passed in, still owned by the caller.
   */
  readonly backend: Backend;
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
