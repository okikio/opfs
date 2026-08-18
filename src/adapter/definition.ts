import {
  AdapterCapabilitiesSchema,
  AdapterLimitsSchema,
  AdapterNameSchema,
  AdapterPartitionSchema,
} from "../schema.ts";
import type {
  AdapterCapabilitiesType,
  AdapterLimitsType,
  AdapterPartitionType,
  CoordinationModeType,
  MetricsModeType,
  OptimizationType,
} from "../schema.ts";
import type { PathType } from "../path.ts";
import type { DriverType } from "../driver/definition.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverDirectoryEntryType,
  FileDriverMoveOptionsType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverStatType,
  FileDriverSyncFileType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
} from "../driver/file.ts";

/**
 * Filesystem primitive translation consumed by {@link createFileSystem}.
 *
 * A configured adapter always points at the backend driver whose mechanics it
 * translates. Driver metadata therefore remains independently inspectable even
 * when the facade chooses an adapter fallback or optimization route.
 *
 * Think of the adapter as the narrow waist of the architecture. Below it, the
 * driver keeps native storage semantics honest. Above it, `FileSystemType`
 * decides which OPFS-shaped routes are native, emulated, partitioned, or
 * intentionally unsupported.
 */
export interface AdapterType {
  /** Stable translation name such as `opfs`, `record`, or `object`. */
  readonly name: string;
  /** Backend driver that owns persistence mechanics and provider lifecycle. */
  readonly driver: DriverType;
  /** Native adapter routes available without facade emulation. */
  readonly capabilities: AdapterCapabilitiesType;
  /** Adapter-level logical limits derived from its translation strategy. */
  readonly limits?: AdapterLimitsType;
  /** Adapter-level physical partition shape when the translation exposes one. */
  readonly partition?: AdapterPartitionType;

  /** Returns one entry's native metadata, or `null` when it is missing. */
  stat(path: PathType, options?: FileDriverSignalOptionsType): Promise<FileDriverStatType | null>;
  /** Materializes a file body through the adapter's native translation path. */
  readFile(path: PathType, options?: FileDriverReadOptionsType): Promise<Uint8Array>;
  /** Writes a complete file body through the adapter's native translation path. */
  writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void>;
  /** Lists direct children without recursive facade behavior. */
  readDir(path: PathType, options?: FileDriverSignalOptionsType): AsyncIterableIterator<FileDriverDirectoryEntryType>;
  /** Creates one native directory node for the translated backend. */
  createDir(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Removes one translated backend entry. */
  remove(path: PathType, options?: FileDriverSignalOptionsType): Promise<void>;
  /** Opens a native read stream when the adapter can avoid full buffering. */
  openReadStream?(path: PathType, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Writes streamed bytes natively when the translated backend supports that route. */
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType): Promise<void>;
  /** Performs one adapter-native copy without facade recursion or fallback logic. */
  copy?(source: PathType, destination: PathType, options: FileDriverCopyOptionsType): Promise<void>;
  /** Performs one adapter-native move without facade fallback logic. */
  move?(source: PathType, destination: PathType, options: FileDriverMoveOptionsType): Promise<void>;
  /** Opens long-lived asynchronous positional writes when supported natively. */
  openWritableFile?(path: PathType): Promise<FileDriverWritableFileType>;
  /** Opens synchronous random access when supported natively. */
  openSyncFile?(path: PathType): Promise<FileDriverSyncFileType>;
  /** Releases adapter-owned resources. Borrowed drivers usually remain live. */
  dispose?(): void | Promise<void>;
}

/**
 * Options that control the adapter-independent filesystem facade.
 *
 * These settings describe facade policy, not backend-native capability. Use
 * driver limits and adapter capability reports for storage facts, and use these
 * options when the application wants to opt into or out of the facade behavior
 * layered on top.
 */
export interface FileSystemOptionsType {
  /** Coordination strategy for facade-owned mutation locks. */
  readonly coordination?: CoordinationModeType;
  /** Namespace used when the coordination layer persists lock identities. */
  readonly lockPrefix?: string;
  /** Maximum bytes materialized by facade-owned non-streaming fallbacks. */
  readonly maxBufferedWriteBytes?: number;
  /** Independently disableable adapter/facade fast paths. */
  readonly optimizations?: Partial<OptimizationType>;
  /** Metrics detail. Defaults to `basic`. */
  readonly metrics?: MetricsModeType;
  /** Closes the adapter when the filesystem facade is disposed. */
  readonly disposeAdapter?: boolean;
}

/**
 * Parses one adapter-owned schema and normalizes invalid configuration to `TypeError`.
 *
 * Custom adapter authors usually want one predictable construction failure type
 * instead of several raw schema exceptions.
 */
function parseAdapterSchema<T>(schema: { parse(value: unknown): T }, value: unknown, name: string): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new TypeError(`Invalid adapter ${name}.`, { cause });
  }
}

/**
 * Validates a custom adapter without registering global state.
 *
 * The associated driver is mandatory. This keeps provider requirements and
 * limits visible instead of letting a custom adapter become an opaque backend.
 *
 * @example Wrap a custom file adapter around a configured driver.
 * ```ts
 * import { defineAdapter } from "@okikio/opfs/adapter";
 *
 * const adapter = defineAdapter({
 *   name: "custom",
 *   driver,
 *   capabilities: {
 *     streamRead: false,
 *     streamWriteModes: [],
 *     rangeRead: false,
 *     nativeCopy: false,
 *     nativeMove: false,
 *     positionalWrite: false,
 *     syncAccess: false,
 *   },
 *   stat,
 *   readFile,
 *   writeFile,
 *   readDir,
 *   createDir,
 *   remove,
 * });
 * ```
 */
export function defineAdapter<T extends AdapterType>(adapter: T): T {
  parseAdapterSchema(AdapterNameSchema, adapter.name, "name");
  parseAdapterSchema(AdapterCapabilitiesSchema, adapter.capabilities, "capabilities");
  if (
    adapter.driver === undefined || typeof adapter.driver.inspect !== "function" ||
    typeof adapter.driver.plan !== "function"
  ) {
    throw new TypeError(`Adapter '${adapter.name}' must expose its configured backend driver.`);
  }
  if (adapter.limits !== undefined) parseAdapterSchema(AdapterLimitsSchema, adapter.limits, "limits");
  if (adapter.partition !== undefined) parseAdapterSchema(AdapterPartitionSchema, adapter.partition, "partition");

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
    throw new TypeError(`Adapter '${adapter.name}' streamWriteModes do not match its writeStream implementation.`);
  }
  return adapter;
}
