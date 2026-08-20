import { z } from "zod";

import type { PathType } from "../path.ts";
import { WriteModeSchema, type WriteModeType } from "../schema.ts";
import type { DriverType } from "./definition.ts";

/** Native operations implemented by a file-shaped backend driver. */
export const FileDriverCapabilitiesSchema: z.ZodType<FileDriverCapabilitiesType, FileDriverCapabilitiesType> = z.object({
  /** Backend can materialize file bytes through `readFile()`. */
  read: z.boolean(),
  /** Backend can commit materialized file bytes through `writeFile()`. */
  write: z.boolean(),
  /** Backend can open a native read stream. */
  streamRead: z.boolean(),
  /** Write modes that `writeStream()` can perform natively. */
  streamWriteModes: z.array(WriteModeSchema).readonly(),
  /** Backend can satisfy byte ranges without whole-file materialization. */
  rangeRead: z.boolean(),
  /** Backend can copy one entry through a native route. */
  copy: z.boolean(),
  /** Backend can move or rename one entry through a native route. */
  move: z.boolean(),
  /** Backend exposes a long-lived asynchronous positional writer. */
  positionalWrite: z.boolean(),
  /** Backend exposes a synchronous random-access file resource. */
  syncAccess: z.boolean(),
}).strict();

/** A validated native file-driver capability description. */
export type FileDriverCapabilitiesType = import("../_schema_types.ts").FileDriverCapabilitiesType;

/** Options shared by file-driver operations that can stop early. */
export interface FileDriverSignalOptionsType {
  /** Stops driver work before the backend commits more changes. */
  readonly signal?: AbortSignal;
}

/** Byte-range options for a file-driver read. */
export interface FileDriverReadOptionsType extends FileDriverSignalOptionsType {
  /** Zero-based byte offset. */
  readonly at?: number;
  /** Maximum bytes to return. */
  readonly length?: number;
}

/** Write semantics that a file driver must preserve. */
export interface FileDriverWriteOptionsType extends FileDriverSignalOptionsType {
  /** Relationship between incoming bytes and any existing file body. */
  readonly mode: WriteModeType;
  /** Zero-based write offset used by update-style writes. */
  readonly at?: number;
  /** Truncates the file at the final write cursor when supported. */
  readonly truncate?: boolean;
  /** Media type retained when the backend tracks it. */
  readonly mediaType?: string;
}

/** Options for a file-driver native copy. */
export interface FileDriverCopyOptionsType extends FileDriverSignalOptionsType {
  /** Replaces an existing destination when true. */
  readonly overwrite: boolean;
}

/** Options for a file-driver native move. */
export interface FileDriverMoveOptionsType extends FileDriverSignalOptionsType {
  /** Replaces an existing destination when true. */
  readonly overwrite: boolean;
}

/** One direct child returned by a file-driver directory iterator. */
export interface FileDriverDirectoryEntryType {
  /** Final entry name relative to the requested parent. */
  readonly name: string;
  /** Portable discriminator used by the adapter and facade. */
  readonly kind: "file" | "directory";
}

/** Portable file metadata returned by a file driver. */
interface FileDriverFileStatType {
  /** Portable discriminator for file metadata. */
  readonly kind: "file";
  /** File length in bytes. */
  readonly size: number;
  /** Last-modified Unix epoch milliseconds. */
  readonly lastModified: number;
  /** Media type, or an empty string when the backend does not know one. */
  readonly mediaType: string;
}

/** Portable directory metadata returned by a file driver. */
interface FileDriverDirectoryStatType {
  /** Portable discriminator for directory metadata. */
  readonly kind: "directory";
  /** Last-modified Unix epoch milliseconds when the backend can observe it. */
  readonly lastModified?: number;
}

/**
 * Portable file or directory metadata returned by a file driver.
 *
 * The union stays small because callers only need the portable metadata needed
 * by adapters and filesystem planning, not every runtime-specific detail from a
 * host stat structure.
 */
export type FileDriverStatType =
  | {
    /** Portable discriminator for file metadata. */
    readonly kind: "file";
    /** File length in bytes. */
    readonly size: number;
    /** Last-modified Unix epoch milliseconds. */
    readonly lastModified: number;
    /** Media type, or an empty string when the backend does not know one. */
    readonly mediaType: string;
  }
  | {
    /** Portable discriminator for directory metadata. */
    readonly kind: "directory";
    /** Last-modified Unix epoch milliseconds when the backend can observe it. */
    readonly lastModified?: number | undefined;
  };

/**
 * Long-lived asynchronous positional file owned by a file driver.
 *
 * This exists for backends that can keep a write handle open across several
 * writes without routing every chunk through `writeFile()`.
 */
export interface FileDriverWritableFileType {
  /** Writes one chunk at a specific byte offset. */
  write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void>;
  /** Shrinks or expands the file to one exact size. */
  truncate(size: number): Promise<void>;
  /** Flushes buffered writes to the backend when that concept exists. */
  flush(): Promise<void>;
  /** Closes the long-lived file handle after successful work. */
  close(): Promise<void>;
  /** Aborts the long-lived file handle after failed or cancelled work. */
  abort(reason?: unknown): Promise<void>;
}

/**
 * Synchronous random-access file owned by a file driver.
 *
 * This contract exists for environments such as OPFS sync access handles where
 * the backend can expose low-latency random access without async round-trips.
 */
export interface FileDriverSyncFileType {
  /** Reads into the provided buffer and returns bytes read. */
  read(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Writes from the provided buffer and returns bytes written. */
  write(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Returns the current byte length. */
  getSize(): number;
  /** Shrinks or expands the file to one exact size. */
  truncate(size: number): void;
  /** Flushes any pending writes to the backend when that concept exists. */
  flush(): void;
  /** Closes the sync file handle. */
  close(): void;
}

/**
 * Independently useful backend-native file contract.
 *
 * File drivers own real file mechanics. They do not own OPFS path normalization,
 * recursive traversal, facade locks, or higher-level filesystem fallback logic.
 */
export interface FileDriverType extends DriverType {
  readonly kind: "file";
  /** Native file behaviors the backend can expose directly. */
  readonly capabilities: FileDriverCapabilitiesType;
  /** Returns native metadata for one path, or `null` when it is missing. */
  stat(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileDriverStatType | null>;
  /** Materializes a file body or byte range. */
  readFile(path: PathType, options?: FileDriverReadOptionsType): Promise<Uint8Array>;
  /** Writes one complete file body or update request. */
  writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void>;
  /** Lists direct children without facade recursion. */
  readDir(path: PathType, options?: FileDriverSignalOptionsType): AsyncIterableIterator<FileDriverDirectoryEntryType>;
  /** Creates one directory node. */
  createDir(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Removes one file or directory entry. */
  remove(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Opens a native read stream when the backend supports it. */
  openReadStream?(path: PathType, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Writes a stream natively when the backend supports it. */
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType): Promise<void>;
  /** Copies one backend-native entry when the backend supports it. */
  copy?(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void>;
  /** Moves one backend-native entry when the backend supports it. */
  move?(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void>;
  /** Opens long-lived asynchronous positional writes when the backend supports them. */
  openWritableFile?(path: PathType): Promise<FileDriverWritableFileType>;
  /** Opens synchronous random access when the backend supports it. */
  openSyncFile?(path: PathType): Promise<FileDriverSyncFileType>;
}

import {
  defineDriver,
  type DefineDriverOptionsType,
  DriverPlanInputSchema,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
} from "./definition.ts";

/**
 * File mechanics before configured driver metadata is attached.
 *
 * This lets a concrete runtime implementation focus on backend behavior first.
 * `defineFileDriver()` then adds stable inspection, planning, ownership, and
 * optimization metadata around that behavior.
 */
export interface FileBackendType {
  readonly name: string;
  readonly capabilities: FileDriverCapabilitiesType;
  stat(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileDriverStatType | null>;
  readFile(path: PathType, options?: FileDriverReadOptionsType): Promise<Uint8Array>;
  writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void>;
  readDir(path: PathType, options?: FileDriverSignalOptionsType): AsyncIterableIterator<FileDriverDirectoryEntryType>;
  createDir(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  remove(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  openReadStream?(path: PathType, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType): Promise<void>;
  copy?(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void>;
  move?(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void>;
  openWritableFile?(path: PathType): Promise<FileDriverWritableFileType>;
  openSyncFile?(path: PathType): Promise<FileDriverSyncFileType>;
  dispose?(): void | Promise<void>;
}

/** Construction options for a configured file driver. */
export interface DefineFileDriverOptionsType extends Omit<DefineDriverOptionsType, "kind" | "plan" | "dispose"> {
  /** Optional backend-native planner override. */
  readonly plan?: (input: DriverPlanInputType) => DriverPlanType;
  /** Transfers backend disposal ownership from the caller to the driver. */
  readonly disposeBackend?: boolean;
}

/** Creates the default file-driver preflight result. */
function createFilePlan(input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported: true,
    support: "native",
    problems: [],
    actions: [],
  });
}

/**
 * Creates an independently usable file driver over native file mechanics.
 *
 * Adapters can delegate their primitive methods to this driver while retaining
 * adapter-specific route declarations and facade policy above it.
 *
 * @example Wrap native file mechanics before creating a filesystem adapter.
 * ```ts
 * import { defineFileDriver } from "@okikio/opfs/driver/file";
 *
 * const driver = defineFileDriver(backend, {
 *   name: "custom-node-like",
 *   limits: [],
 * });
 * ```
 */
export function defineFileDriver(backend: FileBackendType, options: DefineFileDriverOptionsType): FileDriverType {
  const capabilities = FileDriverCapabilitiesSchema.parse(backend.capabilities);
  const base = defineDriver({
    ...options,
    name: options.name || backend.name,
    kind: "file",
    provides: options.provides ?? [
      "stat",
      "read",
      "write",
      "list",
      "mkdir",
      "remove",
      ...(backend.openReadStream === undefined ? [] : ["stream-read"]),
      ...(backend.writeStream === undefined ? [] : ["stream-write"]),
      ...(backend.copy === undefined ? [] : ["copy"]),
      ...(backend.move === undefined ? [] : ["move"]),
      ...(backend.openWritableFile === undefined ? [] : ["positional-write"]),
      ...(backend.openSyncFile === undefined ? [] : ["sync-access"]),
    ],
    ownership: options.ownership ??
      (backend.dispose === undefined ? "none" : options.disposeBackend ? "owned" : "borrowed"),
    plan: options.plan ?? createFilePlan,
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  });
  return {
    ...base,
    kind: "file",
    capabilities,
    stat: (path, requestOptions) => backend.stat(path, requestOptions),
    readFile: (path, requestOptions) => backend.readFile(path, requestOptions),
    writeFile: (path, data, requestOptions) => backend.writeFile(path, data, requestOptions),
    readDir: (path, requestOptions) => backend.readDir(path, requestOptions),
    createDir: (path, requestOptions) => backend.createDir(path, requestOptions),
    remove: (path, requestOptions) => backend.remove(path, requestOptions),
    ...(backend.openReadStream === undefined ? {} : {
      openReadStream: (path: PathType, requestOptions?: FileDriverReadOptionsType) =>
        backend.openReadStream!(path, requestOptions),
    }),
    ...(backend.writeStream === undefined ? {} : {
      writeStream: (path: PathType, source: ReadableStream<Uint8Array>, requestOptions: FileDriverWriteOptionsType) =>
        backend.writeStream!(path, source, requestOptions),
    }),
    ...(backend.copy === undefined ? {} : {
      copy: (source: PathType, destination: PathType, requestOptions: FileDriverCopyOptionsType) =>
        backend.copy!(source, destination, requestOptions),
    }),
    ...(backend.move === undefined ? {} : {
      move: (source: PathType, destination: PathType, requestOptions: FileDriverMoveOptionsType) =>
        backend.move!(source, destination, requestOptions),
    }),
    ...(backend.openWritableFile === undefined
      ? {}
      : { openWritableFile: (path: PathType) => backend.openWritableFile!(path) }),
    ...(backend.openSyncFile === undefined ? {} : { openSyncFile: (path: PathType) => backend.openSyncFile!(path) }),
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  };
}
