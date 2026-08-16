import { AdapterCapabilitiesSchema, AdapterLimitsSchema, AdapterNameSchema, AdapterPartitionSchema } from "../schema.ts";
import type {
  AdapterCapabilitiesType,
  AdapterLimitsType,
  AdapterPartitionType,
  CoordinationModeType,
  EntryKindType,
  MetricsModeType,
  OptimizationType,
  WriteModeType,
} from "../schema.ts";
import type { PathType } from "../path.ts";

/** Options shared by adapter operations that can stop early. */
export interface AdapterSignalOptionsType {
  /** Stops work that has not committed yet. */
  readonly signal?: AbortSignal;
}

/** Byte-range options for an adapter read. */
export interface AdapterReadOptionsType extends AdapterSignalOptionsType {
  /** Zero-based byte offset. */
  readonly at?: number;
  /** Maximum bytes to return after `at`. */
  readonly length?: number;
}

/** Write semantics that an adapter must preserve. */
export interface AdapterWriteOptionsType extends AdapterSignalOptionsType {
  /** Relationship between new bytes and an existing file. */
  readonly mode: WriteModeType;
  /** Zero-based offset used by `update`. */
  readonly at?: number;
  /** Truncates the file at the final write cursor. */
  readonly truncate?: boolean;
  /** Media type to retain when the adapter stores metadata. */
  readonly mediaType?: string;
}

/** Options for an adapter-native copy. */
export interface AdapterCopyOptionsType extends AdapterSignalOptionsType {
  /** Replaces an existing destination when the backend operation supports it. */
  readonly overwrite: boolean;
}

/** Options for an adapter-native move. */
export interface AdapterMoveOptionsType extends AdapterSignalOptionsType {
  /** Removes an existing destination before the move when required. */
  readonly overwrite: boolean;
}

/** One direct child returned by an adapter directory iterator. */
export interface AdapterDirectoryEntryType {
  /** Child entry name without parent path components. */
  readonly name: string;
  /** Child entry kind. */
  readonly kind: EntryKindType;
}

/** Portable file metadata required by the facade. */
export interface AdapterFileStatType {
  /** Discriminator for file metadata. */
  readonly kind: "file";
  /** File byte length. */
  readonly size: number;
  /** Last-modified time as Unix epoch milliseconds. */
  readonly lastModified: number;
  /** Media type when known. Empty string means unknown. */
  readonly mediaType: string;
}

/** Portable directory metadata required by the facade. */
export interface AdapterDirectoryStatType {
  /** Discriminator for directory metadata. */
  readonly kind: "directory";
  /** Last-modified time when the adapter can observe one. */
  readonly lastModified?: number;
}

/** Portable entry metadata returned by an adapter. */
export type AdapterStatType = AdapterFileStatType | AdapterDirectoryStatType;

/**
 * Long-lived asynchronous positional file owned by an adapter.
 *
 * This contract exists for callers such as media muxers and database engines
 * that rewrite earlier byte ranges while a file stays open. It is deliberately
 * separate from `writeFile()`, which represents one complete write operation.
 *
 * `abort()` may discard staged changes when the backend can do so. Backends
 * without transactional staging still close the native resource, so callers
 * that need rollback should write to a staging path and remove it after abort.
 */
export interface AdapterWritableFileType {
  /** Writes bytes at one explicit zero-based file position. */
  write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void>;
  /** Changes current byte length. */
  truncate(size: number): Promise<void>;
  /** Requests backend durability without closing the file. */
  flush(): Promise<void>;
  /** Commits staged backend state where the backend uses staging, then closes. */
  close(): Promise<void>;
  /** Discards staged state when possible, then releases the native resource. */
  abort(reason?: unknown): Promise<void>;
}

/**
 * Synchronous random-access file owned by an adapter.
 *
 * The adapter owns the native runtime object. The caller owns the returned
 * resource and must call `close()`. `flush()` asks the backend to make current
 * writes durable; the exact storage guarantee remains backend-specific.
 */
export interface AdapterSyncFileType {
  /** Reads bytes into `buffer` and returns the number of bytes read. */
  read(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Writes bytes from `buffer` and returns the number of bytes written. */
  write(buffer: ArrayBufferView, options?: { readonly at?: number }): number;
  /** Returns current byte length. */
  getSize(): number;
  /** Changes current byte length. */
  truncate(size: number): void;
  /** Requests backend durability for current writes. */
  flush(): void;
  /** Releases the native file resource and any native file lock. */
  close(): void;
}

/**
 * Backend contract consumed by {@link createFileSystem}.
 *
 * Adapters receive canonical virtual paths. They own translation to browser
 * handles, host paths, key-value keys, documents, or SQL rows. Required methods
 * cover the smallest filesystem primitive set. Optional methods advertise a
 * faster native path through `capabilities`.
 *
 * An adapter must not configure application logging or read process environment
 * variables at import time. An adapter can own an injected resource only when
 * its creation options say so explicitly.
 */
export interface AdapterType {
  /** Stable diagnostic name such as `opfs`, `deno`, or `unstorage`. */
  readonly name: string;
  /** Native operations available without facade emulation. */
  readonly capabilities: AdapterCapabilitiesType;
  /** Portable hard limits known for this configured backend. Missing values mean unknown, not unlimited. */
  readonly limits?: AdapterLimitsType;
  /** Physical partition layout when this adapter can split one logical value across provider records. */
  readonly partition?: AdapterPartitionType;

  /** Returns portable metadata, or `null` when the path does not exist. */
  stat(path: PathType, options?: AdapterSignalOptionsType): Promise<AdapterStatType | null>;
  /** Returns one materialized file or byte range. */
  readFile(path: PathType, options?: AdapterReadOptionsType): Promise<Uint8Array>;
  /** Commits materialized bytes with the requested write semantics. */
  writeFile(path: PathType, data: Uint8Array, options: AdapterWriteOptionsType): Promise<void>;
  /** Lazily returns direct children of one directory. */
  readDir(path: PathType, options?: AdapterSignalOptionsType): AsyncIterableIterator<AdapterDirectoryEntryType>;
  /** Creates exactly one directory. Its parent must already exist. */
  createDir(path: PathType, options?: AdapterSignalOptionsType): Promise<void>;
  /** Removes one file or one empty directory. */
  remove(path: PathType, options?: AdapterSignalOptionsType): Promise<void>;

  /** Opens a native streaming read when `capabilities.streamRead` is true. */
  openReadStream?(path: PathType, options?: AdapterReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Commits a stream without facade materialization for a mode listed in `streamWriteModes`. */
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: AdapterWriteOptionsType): Promise<void>;
  /** Copies one file without routing its bytes through the facade. */
  copy?(source: PathType, destination: PathType, options: AdapterCopyOptionsType): Promise<void>;
  /** Performs an adapter-native move when `capabilities.nativeMove` is true. */
  move?(source: PathType, destination: PathType, options: AdapterMoveOptionsType): Promise<void>;
  /** Opens long-lived asynchronous positional writes when `capabilities.positionalWrite` is true. */
  openWritableFile?(path: PathType): Promise<AdapterWritableFileType>;
  /** Opens synchronous random access when `capabilities.syncAccess` is true. */
  openSyncFile?(path: PathType): Promise<AdapterSyncFileType>;
  /** Releases resources that this adapter explicitly owns. */
  dispose?(): void | Promise<void>;
}

/** Options that control the adapter-independent filesystem facade. */
export interface FileSystemOptionsType {
  /** Mutation coordination. `auto` prefers Web Locks and otherwise uses an in-realm FIFO lock. */
  readonly coordination?: CoordinationModeType;
  /** Prefix used for Web Lock names. Use a stable application-specific value. */
  readonly lockPrefix?: string;
  /**
   * Maximum bytes materialized when a non-streaming adapter receives a stream.
   *
   * The default is 64 MiB. Set a lower value for memory-constrained workers or
   * a higher value only when the selected record/database backend can accept it.
   */
  readonly maxBufferedWriteBytes?: number;
  /**
   * Performance routes that may be bypassed for differential testing or policy.
   *
   * Every omitted field defaults to true. Turning off native move is observable
   * because the safe fallback is copy then remove and is therefore not atomic.
   */
  readonly optimizations?: Partial<OptimizationType>;
  /** Metrics detail. Defaults to `basic`; use `none` for the lowest benchmark overhead. */
  readonly metrics?: MetricsModeType;
  /** Closes the adapter when the filesystem facade is disposed. */
  readonly disposeAdapter?: boolean;
}

/**
 * Identity helper for custom adapters.
 *
 * The function performs no registration and no import-time mutation. It exists
 * to make custom adapter exports self-documenting while preserving the concrete
 * adapter type. It also verifies required primitive methods and rejects any
 * enabled optional capability whose corresponding method is absent. A method
 * may still exist while its capability is false so a configured adapter can
 * deliberately disable that route without changing its class shape.
 *
 * @example Define the minimum materialized adapter contract.
 * ```ts
 * const adapter = defineAdapter({
 *   name: "provider",
 *   capabilities: {
 *     read: true,
 *     write: true,
 *     streamRead: false,
 *     streamWriteModes: [],
 *     rangeRead: false,
 *     nativeCopy: false,
 *     nativeMove: false,
 *     positionalWrite: false,
 *     syncAccess: false,
 *   },
 *   async stat(path) { return null; },
 *   async readFile(path) { return new Uint8Array(); },
 *   async writeFile(path, data, options) {},
 *   async *readDir(path) {},
 *   async createDir(path) {},
 *   async remove(path) {},
 * });
 * ```
 */
export function defineAdapter<T extends AdapterType>(adapter: T): T {
  AdapterNameSchema.parse(adapter.name);
  AdapterCapabilitiesSchema.parse(adapter.capabilities);
  if (adapter.limits !== undefined) AdapterLimitsSchema.parse(adapter.limits);
  if (adapter.partition !== undefined) AdapterPartitionSchema.parse(adapter.partition);

  for (const name of ["stat", "readFile", "writeFile", "readDir", "createDir", "remove"] as const) {
    if (typeof adapter[name] !== "function") {
      throw new TypeError(`Adapter '${adapter.name}' is missing required method '${name}'.`);
    }
  }

  const pairs = [
    ["streamRead", adapter.capabilities.streamRead, adapter.openReadStream !== undefined],
    ["nativeCopy", adapter.capabilities.nativeCopy, adapter.copy !== undefined],
    ["nativeMove", adapter.capabilities.nativeMove, adapter.move !== undefined],
    ["positionalWrite", adapter.capabilities.positionalWrite, adapter.openWritableFile !== undefined],
    ["syncAccess", adapter.capabilities.syncAccess, adapter.openSyncFile !== undefined],
  ] as const;
  for (const [name, capability, method] of pairs) {
    if (capability && !method) {
      throw new TypeError(`Adapter '${adapter.name}' capability '${name}' does not match its implementation method.`);
    }
  }
  if (adapter.capabilities.streamWriteModes.length > 0 && adapter.writeStream === undefined) {
    throw new TypeError(
      `Adapter '${adapter.name}' streamWriteModes do not match its writeStream implementation.`,
    );
  }
  return adapter;
}
