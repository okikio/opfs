import { FileSystemError, toFileSystemError } from "../error.ts";
import { close } from "../close.ts";
import { project } from "../iteration.ts";
import { retire } from "../stream.ts";
import { z } from "zod";

import type { PathType } from "../path.ts";
import type { DirectoryRecordType, FileRecordType, RecordType, WriteModeType } from "../schema/mod.ts";
import { RecordMetadataSchema, RecordSchema, WriteModeSchema } from "../schema/mod.ts";
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
export const RecordReplacementSchema: z.ZodType<RecordReplacementType, RecordReplacementType> = z.enum([
  "atomic",
  "best-effort",
  "unknown",
]);

/** A validated record replacement guarantee. */
export type RecordReplacementType = import("../schema/types.ts").RecordReplacementType;

/**
 * Native byte/data behavior exposed by a record driver.
 *
 * These flags describe how far the backend can go beyond whole-record reads and
 * writes. The record adapter uses them to choose honest fallbacks.
 */
export const RecordDriverCapabilitiesSchema: z.ZodType<RecordDriverCapabilitiesType, RecordDriverCapabilitiesType> = z
  .object({
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
export type RecordDriverCapabilitiesType = import("../schema/types.ts").RecordDriverCapabilitiesType;

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
  /** Reads the record at `path`, or returns `null` when there is none. */
  get(path: PathType): Promise<RecordType | null>;
  /** Reads a record's listing data without its value. Leave it out to use `get`. */
  stat?(path: PathType): Promise<RecordListType | null>;
  /** Reads a file's bytes directly. Leave it out to read them from the record. */
  readFile?(path: PathType, options?: FileDriverReadOptionsType): Promise<Uint8Array>;
  /** Opens a file as a stream. Leave it out when the backend cannot stream reads. */
  openReadStream?(path: PathType, options?: FileDriverReadOptionsType): Promise<ReadableStream<Uint8Array>>;
  /** Writes a file's bytes directly. Leave it out to write a whole record with `set`. */
  writeFile?(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType): Promise<void>;
  /** Writes a file from a stream. Leave it out when the backend cannot stream writes. */
  writeStream?(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType): Promise<void>;
  /** Creates or replaces one record. */
  set(record: RecordType): Promise<void>;
  /** Deletes the record at `path`. */
  delete(path: PathType): Promise<void>;
  /** Lists the records whose parent is `parent`. */
  list(parent: PathType): AsyncIterableIterator<RecordListType>;
  /** Releases what the backend holds. Called when the owning driver closes. */
  dispose?(): void | Promise<void>;
}

/**
 * Independently useful record-oriented backend driver.
 *
 * A record driver is the honest native contract for key-value stores, document
 * stores, and SQL-backed row persistence that does not naturally behave like a
 * byte-addressable directory tree.
 */
export interface RecordDriverType<Backend = unknown> extends DriverType<Backend>, RecordBackendType {
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

/**
 * Returns whether an operation changes stored data.
 *
 * `write`, `copy`, `move` and `remove` change data. `read`, `stat` and `list`
 * do not. A read-only driver uses this to refuse a plan before it asks the
 * backend anything.
 *
 * @param operation The operation from a plan input.
 * @returns `true` when the operation writes, copies, moves or removes.
 *
 * @example
 * ```ts
 * import { mutates } from "@okikio/opfs/driver/record";
 *
 * mutates("write"); // true
 * mutates("read"); // false
 * ```
 */
export function mutates(operation: DriverPlanInputType["operation"]): boolean {
  return operation === "write" || operation === "copy" || operation === "move" || operation === "remove";
}

/**
 * Returns the plan that refuses an operation on a read-only driver.
 *
 * The plan has one `read-only` problem and suggests two actions: change the
 * policy or pick another driver. It does not look at the backend, so the same
 * input always gives the same plan.
 *
 * @param input The operation to refuse. It is checked against the plan-input schema.
 * @returns An unsupported plan for `input.operation`.
 *
 * @example
 * ```ts
 * import { mutates, readOnlyPlan } from "@okikio/opfs/driver/record";
 *
 * const input = { operation: "write", path: "/notes/a.txt", size: 12 } as const;
 * if (mutates(input.operation)) console.log(readOnlyPlan(input).problems[0]?.code); // "read-only"
 * ```
 */
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

/**
 * Returns the default plan for a record driver from its configured limits.
 *
 * The plan refuses the operation when a path is longer than the driver's
 * `path-length` limit, or when `input.size` is larger than its `file-bytes`
 * limit. Otherwise it reports native support. It does not ask the backend, so a
 * backend that knows more can pass its own planner as `options.plan` to
 * {@link defineRecordDriver}.
 *
 * @param base The driver whose limits apply.
 * @param input The operation, its paths and its expected size.
 * @returns A supported plan, or an unsupported plan with one problem.
 *
 * @example
 * ```ts
 * import type { DriverType } from "@okikio/opfs/driver";
 * import { createRecordPlan } from "@okikio/opfs/driver/record";
 *
 * declare const driver: DriverType;
 * const plan = createRecordPlan(driver, { operation: "write", path: "/a.bin", size: 2 ** 30 });
 * if (!plan.supported) console.log(plan.problems[0]?.code); // "file-too-large" when the limit is lower
 * ```
 */
export function createRecordPlan(base: DriverType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const maxPath = base.limits.find((limit) => limit.code === "path-length" && limit.value !== undefined);
  const invalid = [request.path, request.destination].find((path) =>
    path !== undefined && maxPath?.value !== undefined && path.length > maxPath.value
  );
  if (invalid !== undefined) {
    return DriverPlanSchema.parse({
      operation: request.operation,
      supported: false,
      support: "unsupported",
      problems: [{
        code: "invalid-path",
        layer: "driver",
        severity: "error",
        message: `Stored path exceeds ${maxPath!.value} UTF-16 code units.`,
        limit: maxPath,
      }],
      actions: [{ kind: "reduce-input" }],
    });
  }
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
 * import { defineRecordDriver, type RecordBackendType } from "@okikio/opfs/driver/record";
 *
 * declare const backend: RecordBackendType;
 * const driver = defineRecordDriver(backend, {
 *   name: "readonly-cache",
 *   readOnly: true,
 * });
 * ```
 */
export function defineRecordDriver<Backend = unknown>(
  backend: RecordBackendType,
  options: DefineRecordDriverOptionsType & {
    /** The caller's store, such as a browser extension storage area, to expose as {@link DriverType.backend}. */
    readonly backend?: Backend;
  },
): RecordDriverType<Backend> {
  options = { ...options }; // Callbacks and policy flags belong to this configured instance.
  const readOnly = options.readOnly === true || options.capabilities?.write === false ||
    backend.capabilities?.write === false;
  const capabilities = RecordDriverCapabilitiesSchema.parse({
    rangeRead: backend.capabilities?.rangeRead ?? false,
    streamRead: backend.capabilities?.streamRead ?? false,
    writeModes: backend.capabilities?.writeModes ?? [],
    streamWriteModes: backend.capabilities?.streamWriteModes ?? [],
    replacement: backend.capabilities?.replacement ?? "unknown",
    binary: backend.capabilities?.binary ?? false,
    transactions: backend.capabilities?.transactions ?? false,
    ...options.capabilities,
    write: !readOnly,
  });

  const base: DriverType<Backend> = defineDriver<Backend>({
    ...options,
    kind: "record",
    provides: options.provides ?? [
      "get",
      "list",
      ...(readOnly ? [] : ["set", "delete"]),
      ...(backend.stat === undefined ? [] : ["stat"]),
      ...(backend.readFile === undefined ? [] : ["read"]),
      ...(backend.openReadStream === undefined ? [] : ["stream-read"]),
      ...(backend.writeFile === undefined || readOnly ? [] : ["write"]),
      ...(backend.writeStream === undefined || readOnly ? [] : ["stream-write"]),
    ],
    ownership: options.ownership ??
      (backend.dispose === undefined ? "none" : options.disposeBackend ? "owned" : "borrowed"),
    plan: (input) => {
      const request = DriverPlanInputSchema.parse(input);
      if (readOnly && mutates(request.operation)) return readOnlyPlan(request);
      return options.plan === undefined ? createRecordPlan(base, request) : options.plan(request);
    },
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  });

  /** Shares deterministic admission with direct calls, before any injected backend access. */
  function admit(input: DriverPlanInputType): void {
    const planned = base.plan(input);
    if (!planned.supported) {
      throw new FileSystemError(
        "too-large",
        input.operation,
        input.path,
        planned.problems.map((problem) => problem.message).join(" "),
      );
    }
  }

  return {
    ...base,
    kind: "record",
    capabilities,
    get: async (path) => {
      admit({ operation: "read", path });
      const record = await backend.get(path);
      if (record === null) return null;
      const validated = RecordSchema.parse(record);
      if (validated.path !== path) throw new TypeError("Stored record does not match its physical key.");
      return validated;
    },
    ...(backend.stat === undefined ? {} : {
      stat: async (path: PathType) => {
        admit({ operation: "read", path });
        const record = await backend.stat!(path);
        if (record === null) return null;
        const validated = RecordMetadataSchema.parse(record);
        if (validated.path !== path) throw new TypeError("Stored metadata does not match its physical key.");
        return validated;
      },
    }),
    ...(backend.readFile === undefined ? {} : {
      readFile: (path: PathType, readOptions?: FileDriverReadOptionsType) => {
        admit({ operation: "read", path });
        return backend.readFile!(path, readOptions);
      },
    }),
    ...(backend.openReadStream === undefined ? {} : {
      openReadStream: (path: PathType, readOptions?: FileDriverReadOptionsType) => {
        admit({ operation: "read", path });
        return backend.openReadStream!(path, readOptions);
      },
    }),
    ...(backend.writeFile === undefined || readOnly ? {} : {
      writeFile: (path: PathType, data: Uint8Array, writeOptions: FileDriverWriteOptionsType) => {
        admit({ operation: "write", path, size: data.byteLength, source: "bytes", mode: writeOptions.mode });
        return backend.writeFile!(path, data, writeOptions);
      },
    }),
    ...(backend.writeStream === undefined || readOnly ? {} : {
      writeStream: async (
        path: PathType,
        source: ReadableStream<Uint8Array>,
        writeOptions: FileDriverWriteOptionsType,
      ) => {
        try {
          admit({ operation: "write", path, source: "stream", mode: writeOptions.mode });
        } catch (error) {
          try {
            await close([() => retire(source, error)], [error]);
          } catch (reason) {
            throw toFileSystemError(reason, "write", path);
          }
          throw error;
        }
        return backend.writeStream!(path, source, writeOptions);
      },
    }),
    set: (input) => {
      const record = RecordSchema.parse(input);
      if (readOnly) {
        throw new Error(`Record driver '${base.name}' is read-only; '${record.path}' cannot be changed.`);
      }
      admit({
        operation: "write",
        path: record.path,
        ...(record.kind === "file" ? { size: record.size } : {}),
        source: "bytes",
        mode: "replace",
      });
      return backend.set(record);
    },
    delete: (path) => {
      if (readOnly) {
        throw new Error(`Record driver '${base.name}' is read-only; '${path}' cannot be removed.`);
      }
      admit({ operation: "remove", path });
      return backend.delete(path);
    },
    async *list(parent) {
      admit({ operation: "list", path: parent });
      yield* project(backend.list(parent), (record) => {
        const validated = RecordMetadataSchema.parse(record);
        if (validated.path === parent || validated.parent !== parent) {
          throw new TypeError("Listed record is not a direct child of its requested parent.");
        }
        return validated;
      });
    },
    ...(options.disposeBackend && backend.dispose !== undefined ? { dispose: () => backend.dispose!() } : {}),
  };
}
