import { z } from "zod";

/** Compile-time assertion that fails when a boolean type is not `true`. */
type AssertTrue<T extends true> = T;

/** Bidirectional assignability check used to catch schema/type drift. */
type IsEquivalent<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

import type { AdapterType } from "./adapter/definition.ts";
import { getSupport } from "./capability.ts";
import {
  ActionSchema,
  type ActionType,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
  ProblemSchema,
  type ProblemType,
} from "./driver/definition.ts";
import { normalizePath } from "./path.ts";
import type { OptimizationType, SupportModeType } from "./_schema_types.ts";
import { SupportModeSchema, WriteModeSchema } from "./schema.ts";

/** Validated read preflight input after defaults are applied. */
interface ReadPlanInputResolvedType {
  readonly operation: "read";
  readonly path?: string | undefined;
  readonly size?: number | undefined;
  readonly range: boolean;
}

/** Validated write preflight input after defaults are applied. */
interface WritePlanInputResolvedType {
  readonly operation: "write";
  readonly path?: string | undefined;
  readonly size?: number | undefined;
  readonly inputBytes?: number | undefined;
  readonly source: WriteSourceType;
  readonly mode: "replace" | "append" | "update";
}

/** Validated copy preflight input. */
type CopyPlanInputResolvedType = CopyPlanInputType;

/** Validated move preflight input. */
type MovePlanInputResolvedType = MovePlanInputType;

/** Validated preflight input shape after schema defaults are applied. */
type ResolvedPlanInputType =
  | ReadPlanInputResolvedType
  | WritePlanInputResolvedType
  | CopyPlanInputResolvedType
  | MovePlanInputResolvedType;

/**
 * Physical source form supplied to a planned write.
 *
 * The planner distinguishes already-materialized bytes from an open stream
 * because stream buffering and partitioning decisions depend on that difference.
 */
export const WriteSourceSchema: z.ZodType<WriteSourceType, WriteSourceType> = z.enum(["bytes", "stream"]);
/** Validated physical write-source form. */
export type WriteSourceType = "bytes" | "stream";
/**
 * Filesystem operations supported by deterministic preflight planning.
 *
 * Planning intentionally covers the routes where size, buffering, partitioning,
 * or fallback behavior most often changes the caller's decision.
 */
export const PlanOperationSchema: z.ZodType<PlanOperationType, PlanOperationType> = z.enum([
  "read",
  "write",
  "copy",
  "move",
]);
/** Validated preflight operation name. */
export type PlanOperationType = "read" | "write" | "copy" | "move";

/** Preflight input for a read request before schema defaults are applied. */
export interface ReadPlanInputType {
  /** Selects a read preflight request. */
  readonly operation: "read";
  /** Path the caller plans to read. */
  readonly path?: string | undefined;
  /** Caller-known logical size when available. */
  readonly size?: number | undefined;
  /** Whether the read plans a byte range instead of the full file. */
  readonly range?: boolean | undefined;
}

/** Preflight input for a write request before schema defaults are applied. */
export interface WritePlanInputType {
  /** Selects a write preflight request. */
  readonly operation: "write";
  /** Path the caller plans to write. */
  readonly path?: string | undefined;
  /** Caller-known logical size when available. */
  readonly size?: number | undefined;
  /** Caller-known already-buffered byte count when streaming. */
  readonly inputBytes?: number | undefined;
  /** Physical source form for the write request. */
  readonly source: WriteSourceType;
  /** Requested write semantics. */
  readonly mode?: "replace" | "append" | "update" | undefined;
}

/** Preflight input for a copy request. */
export interface CopyPlanInputType {
  /** Selects a copy preflight request. */
  readonly operation: "copy";
  /** Source path the caller plans to copy. */
  readonly path?: string | undefined;
  /** Destination path for the copy request. */
  readonly destination?: string | undefined;
  /** Caller-known logical size when available. */
  readonly size?: number | undefined;
  /** Whether the route may replace an existing destination. */
  readonly overwrite?: boolean | undefined;
  /** Requires preservation of existing destination bytes before publication; defaults to true. */
  readonly preserve?: boolean | undefined;
  /** Requires atomic no-replace on the selected physical route. */
  readonly exclusive?: boolean | undefined;
}

/** Preflight input for a move request. */
export interface MovePlanInputType {
  /** Selects a move preflight request. */
  readonly operation: "move";
  /** Source path the caller plans to move. */
  readonly path?: string | undefined;
  /** Destination path for the move request. */
  readonly destination?: string | undefined;
  /** Caller-known logical size when available. */
  readonly size?: number | undefined;
  /** Whether the route may replace an existing destination. */
  readonly overwrite?: boolean | undefined;
  /** Requires preservation of existing destination bytes before publication; defaults to true. */
  readonly preserve?: boolean | undefined;
  /** Requires atomic no-replace on the selected physical route. */
  readonly exclusive?: boolean | undefined;
}

/**
 * Serializable preflight request for one concrete filesystem operation.
 *
 * The public request still uses caller-friendly paths and optional defaults.
 * `createPlan()` normalizes those values before it asks the driver for a native
 * planning result.
 */
const PlanInputSchemaDefinition = z.discriminatedUnion("operation", [
  z.object({
    /** Selects a read preflight request. */
    operation: z.literal("read"),
    /** Path the caller plans to read. */
    path: z.string().optional(),
    /** Caller-known logical size when available. */
    size: z.number().int().nonnegative().optional(),
    /** Whether the read plans a byte range instead of the full file. */
    range: z.boolean().default(false),
  }).strict(),
  z.object({
    /** Selects a write preflight request. */
    operation: z.literal("write"),
    /** Path the caller plans to write. */
    path: z.string().optional(),
    /** Caller-known logical size when available. */
    size: z.number().int().nonnegative().optional(),
    /** Caller-known already-buffered byte count when streaming. */
    inputBytes: z.number().int().nonnegative().optional(),
    /** Physical source form for the write request. */
    source: WriteSourceSchema,
    /** Requested write semantics. */
    mode: WriteModeSchema.default("replace"),
  }).strict(),
  z.object({
    /** Selects a copy preflight request. */
    operation: z.literal("copy"),
    /** Source path the caller plans to copy. */
    path: z.string().optional(),
    /** Destination path for the copy request. */
    destination: z.string().optional(),
    /** Caller-known logical size when available. */
    size: z.number().int().nonnegative().optional(),
    overwrite: z.boolean().optional(),
    preserve: z.boolean().optional(),
    exclusive: z.boolean().optional(),
  }).strict(),
  z.object({
    /** Selects a move preflight request. */
    operation: z.literal("move"),
    /** Source path the caller plans to move. */
    path: z.string().optional(),
    /** Destination path for the move request. */
    destination: z.string().optional(),
    /** Caller-known logical size when available. */
    size: z.number().int().nonnegative().optional(),
    overwrite: z.boolean().optional(),
    preserve: z.boolean().optional(),
    exclusive: z.boolean().optional(),
  }).strict(),
]);

/** Input accepted by filesystem preflight before defaults and path normalization. */
export type PlanInputType = ReadPlanInputType | WritePlanInputType | CopyPlanInputType | MovePlanInputType;

/** Public preflight validator with explicit input and resolved-output contracts. */
export const PlanInputSchema: z.ZodType<ResolvedPlanInputType, PlanInputType> = PlanInputSchemaDefinition;

type _ReadPlanInputTypeMatchesSchema = AssertTrue<
  IsEquivalent<ReadPlanInputType, z.input<(typeof PlanInputSchemaDefinition.options)[0]>>
>;
type _WritePlanInputTypeMatchesSchema = AssertTrue<
  IsEquivalent<WritePlanInputType, z.input<(typeof PlanInputSchemaDefinition.options)[1]>>
>;
type _CopyPlanInputTypeMatchesSchema = AssertTrue<
  IsEquivalent<CopyPlanInputType, z.input<(typeof PlanInputSchemaDefinition.options)[2]>>
>;
type _MovePlanInputTypeMatchesSchema = AssertTrue<
  IsEquivalent<MovePlanInputType, z.input<(typeof PlanInputSchemaDefinition.options)[3]>>
>;
type _PlanInputTypeMatchesSchema = AssertTrue<IsEquivalent<PlanInputType, z.input<typeof PlanInputSchema>>>;

/**
 * Structured preflight result for the complete driver -> adapter -> filesystem stack.
 *
 * The driver result is preserved inside the combined plan so callers can see
 * which problems came from the backend itself and which were added by adapter or
 * filesystem policy.
 */
export const PlanSchema: z.ZodType<PlanType, PlanType> = z.object({
  /** Filesystem operation that was planned. */
  operation: PlanOperationSchema,
  /** Whether the complete storage stack can perform the request safely. */
  supported: z.boolean(),
  /** Effective support mode after driver, adapter, and facade policy are combined. */
  support: SupportModeSchema,
  /** Backend-native planning result preserved inside the full plan. */
  driver: DriverPlanSchema,
  /** Facade-owned buffering required before the request can proceed. */
  bufferBytes: z.number().int().nonnegative().optional(),
  /** Physical part or block size when partitioning is involved. */
  partBytes: z.number().int().positive().optional(),
  /** Physical part or block count when partitioning is involved. */
  parts: z.number().int().positive().optional(),
  /** Structured problems found across the complete storage stack. */
  problems: z.array(ProblemSchema).readonly(),
  /** Structured actions the caller can take next. */
  actions: z.array(ActionSchema).readonly(),
}).strict();
/** Validated complete-stack preflight result. */
export interface PlanType {
  /** Filesystem operation that was planned. */
  readonly operation: PlanOperationType;
  /** Whether the complete storage stack can perform the request safely. */
  readonly supported: boolean;
  /** Effective support mode after driver, adapter, and facade policy are combined. */
  readonly support: SupportModeType;
  /** Backend-native planning result preserved inside the full plan. */
  readonly driver: DriverPlanType;
  /** Facade-owned buffering required before the request can proceed. */
  readonly bufferBytes?: number | undefined;
  /** Physical part or block size when partitioning is involved. */
  readonly partBytes?: number | undefined;
  /** Physical part or block count when partitioning is involved. */
  readonly parts?: number | undefined;
  /** Structured problems found across the complete storage stack. */
  readonly problems: readonly ProblemType[];
  /** Structured actions the caller can take next. */
  readonly actions: readonly ActionType[];
}

type _PlanTypeMatchesSchema = AssertTrue<IsEquivalent<PlanType, z.output<typeof PlanSchema>>>;

/**
 * Internal facade state required to combine adapter and driver preflight.
 *
 * `createPlan()` stays pure by accepting the small amount of resolved facade
 * state it needs instead of reaching into a concrete filesystem instance.
 */
export interface PlanContextType {
  readonly adapter: AdapterType;
  readonly optimizations: OptimizationType;
  readonly maxBufferedWriteBytes: number;
}

/**
 * Creates one validated adapter/filesystem problem for the combined plan.
 *
 * Keeping this helper local ensures synthetic plan problems use the same schema
 * shape as driver-produced problems.
 */
function problem(
  code: string,
  layer: "adapter" | "filesystem",
  severity: "info" | "warning" | "error",
  message: string,
): ProblemType {
  return ProblemSchema.parse({ code, layer, severity, message });
}

/** Creates one validated recovery/configuration action for the combined plan. */
function action(kind: ActionType["kind"], detail?: string): ActionType {
  return ActionSchema.parse({ kind, ...(detail === undefined ? {} : { detail }) });
}

/**
 * Creates a canonical driver request from a public filesystem preflight request.
 *
 * This is the seam where facade-friendly input becomes backend-friendly input:
 * paths are normalized, defaults are resolved, and only driver-relevant fields
 * cross the boundary.
 */
export function getDriverInput(
  value: PlanInputType,
  adapter: AdapterType,
  optimizations: OptimizationType,
): DriverPlanInputType {
  const input = PlanInputSchema.parse(value);
  const nativeStream = optimizations.streamWrite &&
    adapter.capabilities.streamWriteModes.includes(input.operation === "write" ? input.mode : "replace") &&
    adapter.writeStream !== undefined;
  const fallbackCopy = (input.operation === "copy" &&
    (!(optimizations.nativeCopy && adapter.capabilities.nativeCopy && adapter.copy !== undefined) ||
      (adapter.hostProfile !== undefined && input.preserve === false))) ||
    (input.operation === "move" &&
      !(optimizations.nativeMove && adapter.capabilities.nativeMove && adapter.move !== undefined));
  return {
    operation: fallbackCopy ? "write" : input.operation,
    ...(input.path === undefined
      ? {}
      : { path: normalizePath(fallbackCopy ? input.destination ?? input.path : input.path) }),
    ...((input.operation === "copy" || input.operation === "move") && input.destination !== undefined
      ? { destination: normalizePath(input.destination) }
      : {}),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(fallbackCopy
      ? {
        source: optimizations.streamRead && adapter.capabilities.streamRead && adapter.openReadStream !== undefined &&
            nativeStream
          ? "stream" as const
          : "bytes" as const,
        mode: "replace" as const,
      }
      : {}),
    ...(input.operation === "write"
      ? {
        source: input.source === "stream" && !nativeStream ? "bytes" : input.source,
        mode: input.mode,
        ...(input.inputBytes === undefined ? {} : { inputBytes: input.inputBytes }),
      }
      : {}),
    ...(input.operation === "read" ? { range: input.range } : {}),
    ...((input.operation === "copy" || input.operation === "move")
      ? {
        intent: input.operation,
        overwrite: input.overwrite,
        preserve: input.preserve,
        exclusive: input.exclusive,
      }
      : {}),
  };
}

/** Uses the same selected physical request as executable hard admission. */
function getDriverPlan(
  input: ResolvedPlanInputType,
  adapter: AdapterType,
  optimizations: OptimizationType,
): DriverPlanType {
  const result = (adapter.plan?.bind(adapter) ?? adapter.driver.plan.bind(adapter.driver))(
    getDriverInput(input, adapter, optimizations),
  );
  return { ...result, operation: input.operation };
}

/**
 * Creates a deterministic plan without performing storage I/O.
 *
 * The plan starts from the driver's native answer, then layers in adapter and
 * filesystem consequences such as buffering warnings, non-atomic move fallbacks,
 * and route-level unsupported results.
 *
 * @example Preflight a streamed write.
 * ```ts
 * import { createPlan } from "@okikio/opfs/plan";
 *
 * const plan = createPlan({
 *   operation: "write",
 *   path: "/archive.bin",
 *   source: "stream",
 *   size: 8 * 1024,
 *   mode: "replace",
 * }, {
 *   adapter,
 *   optimizations,
 *   maxBufferedWriteBytes: 64 * 1024 * 1024,
 * });
 * ```
 *
 * @example Detect a large emulated move before work starts.
 * ```ts
 * import { createPlan } from "@okikio/opfs/plan";
 *
 * const plan = createPlan({
 *   operation: "move",
 *   path: "/from.bin",
 *   destination: "/to.bin",
 *   size: 512 * 1024 * 1024,
 * }, {
 *   adapter,
 *   optimizations,
 *   maxBufferedWriteBytes: 64 * 1024 * 1024,
 * });
 * ```
 */
export function createPlan(input: PlanInputType, context: PlanContextType): PlanType {
  const request = PlanInputSchema.parse(input);
  const driver = getDriverPlan(request, context.adapter, context.optimizations);
  const support = getSupport(context.adapter, context.optimizations);
  const problems: ProblemType[] = [...driver.problems];
  const actions: ActionType[] = [...driver.actions];
  let route: SupportModeType;
  let bufferBytes: number | undefined;

  if (request.operation === "read") {
    route = request.range ? support.rangeRead : support.read;
    if (request.range && route === "emulated") {
      problems.push(problem(
        "range-materialized",
        "filesystem",
        "warning",
        "The requested byte range requires a complete materialized read before slicing.",
      ));
    }
  } else if (request.operation === "write") {
    route = request.source === "stream" ? support.streamWrite[request.mode] : support.write;
    const inputBytes = request.inputBytes ?? (request.mode === "replace" ? request.size : undefined);
    if (request.source === "stream" && route === "emulated") {
      if (inputBytes !== undefined && inputBytes > context.maxBufferedWriteBytes) {
        route = "unsupported";
        problems.push(problem(
          "buffer-too-large",
          "filesystem",
          "error",
          `The stream needs ${inputBytes} buffered bytes, above maxBufferedWriteBytes=${context.maxBufferedWriteBytes}.`,
        ));
        actions.push(action("reduce-input"), action("select-driver", "Select a driver with native streaming writes."));
      } else {
        bufferBytes = inputBytes;
        problems.push(
          problem(
            "stream-buffered",
            "filesystem",
            "warning",
            inputBytes === undefined
              ? `The stream will be buffered and will fail if it crosses maxBufferedWriteBytes=${context.maxBufferedWriteBytes}.`
              : `The facade will buffer ${inputBytes} bytes before the adapter write.`,
          ),
        );
      }
    }
    if (driver.support === "partitioned" && route !== "unsupported") route = "partitioned";
  } else {
    route = request.operation === "copy" ? support.copy : support.move;
    if (
      request.operation === "copy" && context.adapter.hostProfile !== undefined && request.preserve === false &&
      route !== "unsupported"
    ) route = "emulated";
    const publication = context.adapter.publication;
    const guarantee = request.operation === "copy" || route === "emulated" ? publication?.copy : publication?.move;
    const stage = context.adapter.reserve !== undefined && context.adapter.move !== undefined &&
      publication?.move === "preserve";
    if (
      request.overwrite && request.preserve !== false && guarantee !== "preserve" &&
      !(request.operation === "copy" && stage)
    ) {
      problems.push(
        problem(
          "replacement-not-preserved",
          "filesystem",
          "error",
          "This selected file route cannot preserve an existing destination before publication.",
        ),
      );
      actions.push(
        action("change-policy", "Choose preserve:false explicitly, or select a preserving publication route."),
      );
    }
    const noReplace = request.operation === "copy"
      ? publication?.copyNoReplace ?? publication?.noReplace
      : publication?.moveNoReplace ?? publication?.noReplace;
    if (request.exclusive && !request.overwrite && (route === "emulated" || noReplace !== "atomic")) {
      problems.push(
        problem(
          "no-replace-not-atomic",
          "filesystem",
          "error",
          "This route has no admitted atomic destination no-replace primitive.",
        ),
      );
      actions.push(action("select-driver"));
    }
    if (request.operation === "move" && route === "emulated") {
      problems.push(problem(
        "move-not-atomic",
        "filesystem",
        "warning",
        "The selected move route is copy followed by remove and is not atomic.",
      ));
    }
    if (route === "emulated" && request.size !== undefined && request.size > context.maxBufferedWriteBytes) {
      const canStream = support.streamRead === "native" &&
        (support.streamWrite.replace === "native" || support.streamWrite.replace === "partitioned");
      if (!canStream) {
        route = "unsupported";
        problems.push(problem(
          "copy-buffer-too-large",
          "filesystem",
          "error",
          `${request.operation} would materialize ${request.size} bytes, above maxBufferedWriteBytes=${context.maxBufferedWriteBytes}.`,
        ));
        actions.push(action("select-driver", "Select a driver with a complete streaming read/write route."));
      }
    }
  }

  if (route === "unsupported") {
    problems.push(problem(
      "route-unsupported",
      "adapter",
      "error",
      `Adapter '${context.adapter.name}' cannot safely perform this ${request.operation} request with the configured policies.`,
    ));
    actions.push(action("select-driver"));
  }

  const supported = route !== "unsupported" && !problems.some((value) => value.severity === "error");
  return PlanSchema.parse({
    operation: request.operation,
    supported,
    support: supported ? route : "unsupported",
    driver,
    ...(bufferBytes === undefined ? {} : { bufferBytes }),
    ...(driver.partBytes === undefined ? {} : { partBytes: driver.partBytes }),
    ...(driver.parts === undefined ? {} : { parts: driver.parts }),
    problems,
    actions,
  });
}
