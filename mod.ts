/**
 * Adapter-independent filesystem APIs with an OPFS-compatible frontend.
 *
 * The package has two independent layers:
 *
 * 1. `createFileSystem(adapter)` provides high-level path APIs and OPFS-shaped
 *    file/directory handle facades over any backend adapter.
 * 2. `openFileSystem()` selects the browser's native Origin Private File System
 *    as that backend.
 *
 * Runtime-specific and ecosystem adapters live on explicit subpaths so browser
 * bundles do not import Node, Bun, Deno, RxDB, unstorage, db0, or Drizzle by
 * accident.
 *
 * @example Use native browser OPFS.
 * ```ts
 * import { openFileSystem } from "@okikio/opfs";
 *
 * const fileSystem = await openFileSystem();
 * await fileSystem.writeFile("/cache/result.json", "{}", { parents: true });
 * ```
 *
 * @example Use the same frontend over an injected adapter.
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
 *
 * const fileSystem = createFileSystem(createMemoryAdapter());
 * const file = await fileSystem.root.getFileHandle("hello.txt", { create: true });
 * const writable = await file.createWritable();
 * await writable.write("hello");
 * await writable.close();
 * ```
 *
 * @module
 */

export { createFileSystem } from "./src/filesystem.ts";
export { openFileSystem } from "./src/adapter/opfs.ts";
export { FileSystemError, getErrorMessage, getErrorName, toFileSystemError } from "./src/error.ts";
export { getOpfsContext } from "./src/context.ts";
export { probeOpfs } from "./src/probe.ts";
export type {
  CopyOptionsType,
  DirectoryEntryType,
  DirectoryOptionsType,
  DirectoryStatType,
  EmptyDirectoryOptionsType,
  ExistsOptionsType,
  FileOptionsType,
  FileStatType,
  FileSystemType,
  MakeDirectoryOptionsType,
  MoveOptionsType,
  OpenSyncFileOptionsType,
  ReadOptionsType,
  ReadTextOptionsType,
  RemoveOptionsType,
  SignalOptionsType,
  StatType,
  WalkEntryType,
  WalkOptionsType,
  WriteOptionsType,
} from "./src/filesystem.ts";
export type {
  DirectoryHandleType,
  FileHandleType,
  HandleCreateOptionsType,
  HandleRemoveOptionsType,
  HandleType,
  WritableChunkType,
  WritableFileStreamType,
  WriteCommandType,
} from "./src/handle.ts";
export type { SyncFileType } from "./src/sync.ts";
export type { WriteDataType } from "./src/stream.ts";
export type {
  AdapterCapabilitiesType,
  CoordinationModeType,
  EntryKindType,
  ErrorCodeType,
  OpfsContextType,
  WriteModeType,
} from "./src/schema.ts";
export type { FileSystemOptionsType } from "./src/adapter/definition.ts";
export type { OpfsCapabilitiesType, OpfsProbeErrorType, OpfsStorageEstimateType } from "./src/probe.ts";
