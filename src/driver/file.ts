import { FileSystemError } from "../error.ts";
import type { HostProfileType } from "./host.ts";
import {
  QueuedWritableFile,
  validateWritableOptions,
  type WritableInspectionType,
  type WritableOptionsType,
} from "./writable.ts";
export type { WritableInspectionType, WritableOptionsType } from "./writable.ts";
import { z } from "zod";

import type { PathType } from "../path.ts";
import type { FileDriverCapabilitiesType, WriteModeType } from "../_schema_types.ts";
import { WriteModeSchema } from "../schema.ts";
import type { DriverType } from "./definition.ts";

/** Native operations implemented by a file-shaped backend driver. */
export const FileDriverCapabilitiesSchema: z.ZodType<FileDriverCapabilitiesType, FileDriverCapabilitiesType> = z.object(
  {
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
  },
).strict();

export type { FileDriverCapabilitiesType } from "../_schema_types.ts";

/** Options shared by file-driver operations that can stop early. */
export interface FileDriverSignalOptionsType {
  /**
   * Stops admission of further native work and cancels an open read stream.
   * Already dispatched host operations can complete or leave partial writes;
   * cancellation does not roll back bytes, namespace changes, or publication.
   */
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
  /** Native host copy retains staging; use facade preserve:false for an admitted direct-write fallback. */
  readonly preserve?: boolean;
  /** Requires cross-process no-replace. Host rename can only enforce a cooperative precheck. */
  readonly exclusive?: boolean;
}

/** Options for a file-driver native move. */
export interface FileDriverMoveOptionsType extends FileDriverSignalOptionsType {
  /** Replaces an existing destination when true. */
  readonly overwrite: boolean;
  /** Explicitly permits a declared best-effort move; native copy still uses its preserving stage route. */
  readonly preserve?: boolean;
  /** Requires cross-process no-replace. Host rename can only enforce a cooperative precheck. */
  readonly exclusive?: boolean;
}

/** Physical entry identity used by structural operations without following aliases. */
export type FileEntryKindType = "file" | "directory" | "link" | "foreign";

/** One no-follow physical child; portable listing rejects unprojectable entries. */
export interface FileEntryType {
  /** Direct child name; traversal resolves it relative to the requested parent. */
  readonly name: string;
  /** Physical entry identity without following a link target. */
  readonly kind: FileEntryKindType;
}

/** Publication guarantees are scoped to one file and exclude outside host path swaps. */
export interface PublicationType {
  /** Failure boundary of the admitted native file-copy route; unsupported is distinct from facade emulation. */
  readonly copy: "preserve" | "best-effort" | "unsupported";
  /** Failure boundary of the admitted native move route; remote copy/delete is only best-effort. */
  readonly move: "preserve" | "best-effort" | "unsupported";
  /** Weakest no-replace guarantee among admitted native operations; unsupported when none is admitted. */
  readonly noReplace: "atomic" | "cooperative" | "unsupported";
  /** Native copy publication guarantee for an absent target; staging and preparation must also be admitted. */
  readonly copyNoReplace?: "atomic" | "cooperative" | "unsupported";
  /** Native move no-replace guarantee; portable rename has only a cooperative precheck. */
  readonly moveNoReplace?: "atomic" | "cooperative" | "unsupported";
  /** Acknowledgement or resource flush boundary; neither promises durable directory replacement by itself. */
  readonly durability: "flush" | "acknowledged";
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
  /** Detached admission/lifecycle accounting when resource queuing is configured. */
  inspect?(): WritableInspectionType;
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
  /** File-shaped driver family discriminator. */
  readonly kind: "file";
  /** Native file behaviors the backend can expose directly. */
  readonly capabilities: FileDriverCapabilitiesType;
  /** Actual single-file publication and precondition boundary. */
  readonly publication?: PublicationType;
  /** Immutable deployment-specific host facts when this driver represents a host root. */
  readonly hostProfile?: HostProfileType;
  /** Pure hard admission, independent of an optional advisory planner. */
  admit?(input: DriverPlanInputType): DriverPlanType;
  /** Classifies the physical entry, including links, without following it. */
  entry?(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileEntryKindType | null>;
  /** Lists physical entries for no-follow destructive traversal. */
  entries?(path: PathType, options?: FileDriverSignalOptionsType): AsyncIterableIterator<FileEntryType>;
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
  /** Exclusively reserves one empty staging file. The successful caller owns its removal. */
  reserve?(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Opens an admitted long-lived positional writer; its resource owns accepted operation ordering and closure. */
  openWritableFile?(path: PathType, options?: WritableOptionsType): Promise<FileDriverWritableFileType>;
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
  /** Actual single-file publication and precondition boundary. */
  readonly publication?: PublicationType;
  /** Immutable deployment-specific host facts when this driver represents a host root. */
  readonly hostProfile?: HostProfileType;
  /** Pure hard admission, independent of an optional advisory planner. */
  admit?(input: DriverPlanInputType): DriverPlanType;
  /** Classifies the physical entry, including links, without following it. */
  entry?(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileEntryKindType | null>;
  /** Lists physical entries for no-follow destructive traversal. */
  entries?(path: PathType, options?: FileDriverSignalOptionsType): AsyncIterableIterator<FileEntryType>;
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
  /** Exclusively reserves one empty staging file. The successful caller owns its removal. */
  reserve?(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  openWritableFile?(path: PathType, options?: WritableOptionsType): Promise<FileDriverWritableFileType>;
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
  options = { ...options }; // Callbacks and policy flags belong to this configured instance.
  const capabilities = FileDriverCapabilitiesSchema.parse(backend.capabilities);
  if (backend.hostProfile !== undefined) {
    Object.freeze(capabilities.streamWriteModes);
    Object.freeze(capabilities);
  }
  const admit = (input: DriverPlanInputType): void => {
    const result = backend.admit?.(input);
    if (result !== undefined && !result.supported) {
      throw new FileSystemError(
        "not-supported",
        input.operation,
        input.path,
        result.problems.map((problem) => problem.message).join(" "),
        result,
      );
    }
  };
  const base = defineDriver({
    ...options,
    name: options.name || backend.name,
    kind: "file",
    provides: options.provides ?? [
      "stat",
      ...(capabilities.read ? ["read"] : []),
      ...(capabilities.write ? ["write"] : []),
      "list",
      ...(backend.hostProfile?.readOnly ? [] : ["mkdir", "remove"]),
      ...(backend.openReadStream === undefined ? [] : ["stream-read"]),
      ...(backend.writeStream === undefined || capabilities.streamWriteModes.length === 0 ? [] : ["stream-write"]),
      ...(backend.copy === undefined || !capabilities.copy ? [] : ["copy"]),
      ...(backend.move === undefined || !capabilities.move ? [] : ["move"]),
      ...(backend.openWritableFile === undefined || !capabilities.positionalWrite ? [] : ["positional-write"]),
      ...(backend.openSyncFile === undefined || !capabilities.syncAccess ? [] : ["sync-access"]),
    ],
    ownership: options.ownership ??
      (backend.dispose === undefined ? "none" : options.disposeBackend ? "owned" : "borrowed"),
    plan: (input) => {
      const planned = (options.plan ?? createFilePlan)(input);
      const admitted = backend.admit?.(input);
      if (admitted === undefined) return planned;
      return {
        ...planned,
        supported: planned.supported && admitted.supported,
        support: planned.supported && admitted.supported ? planned.support : "unsupported",
        problems: [...planned.problems, ...admitted.problems],
        actions: [...planned.actions, ...admitted.actions],
      };
    },
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  });
  return {
    ...base,
    kind: "file",
    capabilities,
    ...(backend.admit === undefined ? {} : { admit: backend.admit.bind(backend) }),
    ...(backend.hostProfile === undefined ? {} : { hostProfile: backend.hostProfile }),
    ...(backend.publication === undefined ? {} : { publication: backend.publication }),
    ...(backend.reserve === undefined ? {} : {
      reserve: async (path: PathType, options?: FileDriverSignalOptionsType) => {
        admit({ operation: "write", path });
        await backend.reserve!(path, options);
      },
    }),
    ...(backend.entry === undefined
      ? {}
      : { entry: (path: PathType, options?: FileDriverSignalOptionsType) => backend.entry!(path, options) }),
    ...(backend.entries === undefined
      ? {}
      : { entries: (path: PathType, options?: FileDriverSignalOptionsType) => backend.entries!(path, options) }),
    stat: (path, requestOptions) => backend.stat(path, requestOptions),
    readFile: (path, requestOptions) => backend.readFile(path, requestOptions),
    writeFile: async (path, data, requestOptions) => {
      admit({ operation: "write", path, mode: requestOptions.mode, source: "bytes" });
      await backend.writeFile(path, data, requestOptions);
    },
    readDir: (path, requestOptions) => backend.readDir(path, requestOptions),
    createDir: async (path, requestOptions) => {
      admit({ operation: "write", path });
      await backend.createDir(path, requestOptions);
    },
    remove: async (path, requestOptions) => {
      admit({ operation: "remove", path });
      await backend.remove(path, requestOptions);
    },
    ...(backend.openReadStream === undefined ? {} : {
      openReadStream: (path: PathType, requestOptions?: FileDriverReadOptionsType) =>
        backend.openReadStream!(path, requestOptions),
    }),
    ...(backend.writeStream === undefined ? {} : {
      writeStream: async (
        path: PathType,
        source: ReadableStream<Uint8Array>,
        requestOptions: FileDriverWriteOptionsType,
      ) => {
        admit({ operation: "write", path, source: "stream", mode: requestOptions.mode });
        await backend.writeStream!(path, source, requestOptions);
      },
    }),
    ...(backend.copy === undefined ? {} : {
      copy: async (source: PathType, destination: PathType, requestOptions: FileDriverCopyOptionsType) => {
        admit({
          operation: "copy",
          path: source,
          destination,
          overwrite: requestOptions.overwrite,
          preserve: requestOptions.preserve,
          exclusive: requestOptions.exclusive,
        });
        await backend.copy!(source, destination, requestOptions);
      },
    }),
    ...(backend.move === undefined ? {} : {
      move: async (source: PathType, destination: PathType, requestOptions: FileDriverMoveOptionsType) => {
        admit({
          operation: "move",
          path: source,
          destination,
          overwrite: requestOptions.overwrite,
          preserve: requestOptions.preserve,
          exclusive: requestOptions.exclusive,
        });
        await backend.move!(source, destination, requestOptions);
      },
    }),
    ...(backend.openWritableFile === undefined ? {} : {
      openWritableFile: async (path: PathType, options?: WritableOptionsType) => {
        admit({ operation: "write", path, mode: "update" });
        if (!capabilities.positionalWrite) {
          throw new FileSystemError(
            "not-supported",
            "open-writable-file",
            path,
            "Driver does not admit positional writes.",
          );
        }
        validateWritableOptions(options);
        const file = await backend.openWritableFile!(path, options);
        try {
          return file instanceof QueuedWritableFile ? file : new QueuedWritableFile(file, options);
        } catch (error) {
          await file.abort(error);
          throw error;
        }
      },
    }),
    ...(backend.openSyncFile === undefined ? {} : {
      openSyncFile: async (path: PathType) => {
        admit({ operation: "write", path, mode: "update" });
        if (!capabilities.syncAccess) {
          throw new FileSystemError(
            "not-supported",
            "open-sync-file",
            path,
            "Driver does not admit synchronous mutation.",
          );
        }
        return await backend.openSyncFile!(path);
      },
    }),
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  };
}
