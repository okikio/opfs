/**
 * OPFS-shaped filesystem APIs over explicit storage drivers and adapters.
 *
 * The public storage path is:
 *
 * ```text
 * protocol/native API -> client -> driver -> adapter -> FileSystemType
 *                                                    |
 *                                                    `-> bridge -> ecosystem
 * ```
 *
 * A client owns a wire protocol when one exists. A driver owns independently
 * useful backend behavior, requirements, limits, optimizations, planning, and
 * physical metrics. An adapter translates that driver into the small portable
 * filesystem primitive set. `FileSystemType` owns path semantics, coordination,
 * recursive operations, fallbacks, and OPFS-shaped handles. Reverse ecosystem
 * contracts live under explicit `bridge/*` subpaths.
 *
 * `openFileSystem()` is the browser convenience path. It acquires the native
 * OPFS root, creates the OPFS file driver and adapter, then returns the same
 * `FileSystemType` used by every other backend. Importing this root module does
 * not open storage or import server/provider integrations.
 *
 * @example Use native browser OPFS.
 * ```ts
 * import { openFileSystem } from "@okikio/opfs";
 *
 * const fileSystem = await openFileSystem();
 * await fileSystem.writeFile("/cache/result.json", "{}", { parents: true });
 * ```
 *
 * @example Compose an injected backend.
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createMemoryDriver } from "@okikio/opfs/driver/memory";
 * import { createRecordAdapter } from "@okikio/opfs/adapter/record";
 *
 * const driver = createMemoryDriver();
 * const fileSystem = createFileSystem(createRecordAdapter(driver));
 * await fileSystem.writeFile("/hello.txt", "hello", { parents: true });
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
  OpenWritableFileOptionsType,
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
export type { WritableFileType } from "./src/writable.ts";
export type { WriteDataType } from "./src/stream.ts";
export type {
  AdapterCapabilitiesType,
  AdapterLimitsType,
  AdapterPartitionType,
  CoordinationModeType,
  DriverKindType,
  DriverOptimizationType,
  DriverOwnershipType,
  EntryKindType,
  ErrorCodeType,
  LimitKindType,
  LimitSourceType,
  LimitType,
  LimitUnitType,
  MetricsModeType,
  OpfsContextType,
  OptimizationType,
  PartitionModeType,
  RequirementStateType,
  RequirementType,
  SupportModeType,
  WriteModeType,
} from "./src/schema.ts";
export type { FileSystemOptionsType } from "./src/adapter/definition.ts";
export type { InspectionType, SupportType, WriteSupportType } from "./src/capability.ts";
export type { DriverMetricsType, MetricEntryType, MetricOperationType, MetricsType } from "./src/metrics.ts";
export { PlanInputSchema, PlanOperationSchema, PlanSchema, WriteSourceSchema } from "./src/plan.ts";
export type { PlanInputType, PlanOperationType, PlanType, WriteSourceType } from "./src/plan.ts";
export type { OpfsCapabilitiesType, OpfsProbeErrorType, OpfsStorageEstimateType } from "./src/probe.ts";
