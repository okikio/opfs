import { z } from "zod";

import type { PathType } from "../path.ts";
import type { DirectoryRecordType, FileRecordType, RecordType, WriteModeType } from "../schema.ts";
import { WriteModeSchema } from "../schema.ts";
import type { FileDriverReadOptionsType, FileDriverWriteOptionsType } from "./file.ts";
import {
  defineDriver,
  type DefineDriverOptionsType,
  DriverPlanInputSchema,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
  type DriverType,
} from "./definition.ts";

/**
 * Metadata returned during direct-child listing without requiring file-body materialization.
 *
 * Record backends often store whole values or rows. This lighter listing shape
 * lets a caller inspect directory structure without paying to fetch file bytes.
 */
export type RecordListType = DirectoryRecordType | Omit<FileRecordType, "data">;

/**
 * Replacement guarantee exposed by a record-oriented backend.
 *
 * This tells adapters and callers how honestly they can represent replace-style
 * writes when the backend stores logical values rather than byte-addressable
 * files.
 */
export const RecordReplacementSchema = z.enum(["atomic", "best-effort", "unknown"]);

/** A validated record replacement guarantee. */
export type RecordReplacementType = z.output<typeof RecordReplacementSchema>;

/**
 * Native byte/data behavior exposed by a record driver.
 *
 * These flags describe how far the backend can go beyond whole-record reads and
 * writes. The record adapter uses them to choose honest fallbacks.
 */
export const RecordDriverCapabilitiesSchema = z.object({
  /** Backend can satisfy byte ranges without reconstructing the complete logical file. */
  rangeRead: z.boolean(),
  /** Backend can expose file bytes as a native stream. */
  streamRead: z.boolean(),
  /** Configured driver permits mutation. */
  write: z.boolean(),
  /** Write modes implemented as one backend-native operation instead of adapter read-modify-write. */
  writeModes: z.array(WriteModeSchema).readonly(),
  /** Stream write modes implemented by the backend without facade materialization. */
  streamWriteModes: z.array(WriteModeSchema).readonly(),
  /** Atomicity of one complete logical-record replacement performed by `set()`. */
  replacement: RecordReplacementSchema,
  /** Backend can preserve native binary data without the portable base64 representation. */
  binary: z.boolean(),
  /**
   * Backend exposes transaction mechanics used by its own driver operations.
   *
   * This flag does not upgrade the generic record adapter's `get()` then `set()`
   * append/update fallback into one transaction. Cross-owner atomic append or
   * update requires a native `writeFile()`/`writeStream()` mode or a stronger
   * backend-specific operation that the driver explicitly advertises.
   */
  transactions: z.boolean(),
}).strict();

/** A validated record-driver capability description. */
export type RecordDriverCapabilitiesType = z.output<typeof RecordDriverCapabilitiesSchema>;

/**
 * Required persistence mechanics for value, document, and SQL record drivers.
 *
 * The required operations address complete logical records. Optional byte lanes
 * let a backend avoid base64 or complete-value materialization when its physical
 * storage can do better.
 */
export interface RecordBackendType {
  readonly capabilities?: Partial<RecordDriverCapabilitiesType> & {
    readonly writeModes?: readonly WriteModeType[];
    readonly streamWriteModes?: readonly WriteModeType[];
  };
  get(path: PathType): Promise<RecordType | null>;
  stat?(path: PathType): Promise<RecordListType | null>;
  readFile?(path: PathType, options?: FileDriverReadOptionsType): Promise<Uint8Array>;
  openReadStream?(path: PathType, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  writeFile?(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void>;
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType): Promise<void>;
  set(record: RecordType): Promise<void>;
  delete(path: PathType): Promise<void>;
  list(parent: PathType): AsyncIterableIterator<RecordListType>;
  dispose?(): void | Promise<void>;
}

/**
 * Independently useful record-oriented backend driver.
 *
 * A record driver is the honest native contract for key-value stores, document
 * stores, and SQL-backed row persistence that does not naturally behave like a
 * byte-addressable directory tree.
 */
export interface RecordDriverType extends DriverType, RecordBackendType {
  readonly kind: "record";
  /** Native record-oriented behaviors the backend can expose directly. */
  readonly capabilities: RecordDriverCapabilitiesType;
}

/** Construction options for {@link defineRecordDriver}. */
export interface DefineRecordDriverOptionsType extends Omit<DefineDriverOptionsType, "kind" | "plan" | "dispose"> {
  /** Overrides or fills capability facts that the backend does not declare inline. */
  readonly capabilities?: Partial<RecordDriverCapabilitiesType>;
  /** Disables every mutating driver operation while retaining read/list access. */
  readonly readOnly?: boolean;
  /** Optional backend-native planner override. */
  readonly plan?: (input: DriverPlanInputType) => DriverPlanType;
  /** Transfers backend disposal ownership from the caller to the driver. */
  readonly disposeBackend?: boolean;
}

/** Returns whether one preflight operation needs backend mutation. */
export function mutates(operation: DriverPlanInputType["operation"]): boolean {
  return operation === "write" || operation === "copy" || operation === "move" || operation === "remove";
}

/** Creates a deterministic read-only rejection before backend-specific planning. */
export function readOnlyPlan(input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported: false,
    support: "unsupported",
    problems: [{
      code: "read-only",
      layer: "driver",
      severity: "error",
      message: `Driver is configured read-only; ${request.operation} requires backend mutation.`,
    }],
    actions: [{ kind: "change-policy" }, { kind: "select-driver" }],
  });
}

/** Creates the default record-driver plan from known file size and configured limits. */
export function createRecordPlan(base: DriverType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const maxFile = base.limits.find((limit) => limit.code === "file-bytes" && limit.value !== undefined);
  if (request.size !== undefined && maxFile?.value !== undefined && request.size > maxFile.value) {
    return DriverPlanSchema.parse({
      operation: request.operation,
      supported: false,
      support: "unsupported",
      problems: [{
        code: "file-too-large",
        layer: "driver",
        severity: "error",
        message: `Requested size ${request.size} exceeds the configured record-driver file limit ${maxFile.value}.`,
        limit: maxFile,
      }],
      actions: [
        { kind: "reduce-input" },
        { kind: "select-driver" },
      ],
    });
  }
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported: true,
    support: "native",
    problems: [],
    actions: [],
  });
}

/**
 * Creates a configured record driver over backend-specific persistence mechanics.
 *
 * The returned driver can be used directly for logical records or passed to
 * `createRecordAdapter()` to expose OPFS filesystem primitives. No global
 * registry or application runtime is required.
 *
 * @example Mark one configured store as read-only.
 * ```ts
 * import { defineRecordDriver } from "@okikio/opfs/driver/record";
 *
 * const driver = defineRecordDriver(backend, {
 *   name: "readonly-cache",
 *   readOnly: true,
 * });
 * ```
 */
export function defineRecordDriver(
  backend: RecordBackendType,
  options: DefineRecordDriverOptionsType,
): RecordDriverType {
  const capabilities = RecordDriverCapabilitiesSchema.parse({
    rangeRead: backend.capabilities?.rangeRead ?? false,
    streamRead: backend.capabilities?.streamRead ?? false,
    writeModes: backend.capabilities?.writeModes ?? [],
    streamWriteModes: backend.capabilities?.streamWriteModes ?? [],
    replacement: backend.capabilities?.replacement ?? "unknown",
    binary: backend.capabilities?.binary ?? false,
    transactions: backend.capabilities?.transactions ?? false,
    ...options.capabilities,
    write: !(options.readOnly ?? false),
  });

  const base = defineDriver({
    ...options,
    kind: "record",
    provides: options.provides ?? [
      "get",
      "list",
      ...(options.readOnly ? [] : ["set", "delete"]),
      ...(backend.stat === undefined ? [] : ["stat"]),
      ...(backend.readFile === undefined ? [] : ["read"]),
      ...(backend.openReadStream === undefined ? [] : ["stream-read"]),
      ...(backend.writeFile === undefined || options.readOnly ? [] : ["write"]),
      ...(backend.writeStream === undefined || options.readOnly ? [] : ["stream-write"]),
    ],
    ownership: options.ownership ??
      (backend.dispose === undefined ? "none" : options.disposeBackend ? "owned" : "borrowed"),
    plan: (input) => {
      const request = DriverPlanInputSchema.parse(input);
      if ((options.readOnly ?? false) && mutates(request.operation)) return readOnlyPlan(request);
      return options.plan === undefined ? createRecordPlan(base, request) : options.plan(request);
    },
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  });

  return {
    ...base,
    kind: "record",
    capabilities,
    get: (path) => backend.get(path),
    ...(backend.stat === undefined ? {} : { stat: (path: PathType) => backend.stat!(path) }),
    ...(backend.readFile === undefined ? {} : {
      readFile: (path: PathType, readOptions?: FileDriverReadOptionsType) => backend.readFile!(path, readOptions),
    }),
    ...(backend.openReadStream === undefined ? {} : {
      openReadStream: (path: PathType, readOptions?: FileDriverReadOptionsType) =>
        backend.openReadStream!(path, readOptions),
    }),
    ...(backend.writeFile === undefined || options.readOnly ? {} : {
      writeFile: (path: PathType, data: Uint8Array, writeOptions: FileDriverWriteOptionsType) =>
        backend.writeFile!(path, data, writeOptions),
    }),
    ...(backend.writeStream === undefined || options.readOnly ? {} : {
      writeStream: (path: PathType, source: ReadableStream<Uint8Array>, writeOptions: FileDriverWriteOptionsType) =>
        backend.writeStream!(path, source, writeOptions),
    }),
    set: (record) => {
      if (options.readOnly) {
        throw new Error(`Record driver '${base.name}' is read-only; '${record.path}' cannot be changed.`);
      }
      return backend.set(record);
    },
    delete: (path) => {
      if (options.readOnly) {
        throw new Error(`Record driver '${base.name}' is read-only; '${path}' cannot be removed.`);
      }
      return backend.delete(path);
    },
    list: (parent) => backend.list(parent),
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  };
}
