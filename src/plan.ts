import { z } from "zod";

import type { AdapterType } from "./adapter/definition.ts";
import { getSupport } from "./capability.ts";
import {
  ActionSchema,
  type ActionType,
  DriverPlanSchema,
  type DriverPlanType,
  ProblemSchema,
  type ProblemType,
} from "./driver/definition.ts";
import { normalizePath } from "./path.ts";
import type { OptimizationType, SupportModeType } from "./schema.ts";
import { SupportModeSchema, WriteModeSchema } from "./schema.ts";

/**
 * Physical source form supplied to a planned write.
 *
 * The planner distinguishes already-materialized bytes from an open stream
 * because stream buffering and partitioning decisions depend on that difference.
 */
export const WriteSourceSchema = z.enum(["bytes", "stream"]);
/** Validated physical write-source form. */
export type WriteSourceType = z.output<typeof WriteSourceSchema>;
/**
 * Filesystem operations supported by deterministic preflight planning.
 *
 * Planning intentionally covers the routes where size, buffering, partitioning,
 * or fallback behavior most often changes the caller's decision.
 */
export const PlanOperationSchema = z.enum(["read", "write", "copy", "move"]);
/** Validated preflight operation name. */
export type PlanOperationType = z.output<typeof PlanOperationSchema>;

/**
 * Serializable preflight request for one concrete filesystem operation.
 *
 * The public request still uses caller-friendly paths and optional defaults.
 * `createPlan()` normalizes those values before it asks the driver for a native
 * planning result.
 */
export const PlanInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("read"),
    path: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    range: z.boolean().default(false),
  }).strict(),
  z.object({
    operation: z.literal("write"),
    path: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    inputBytes: z.number().int().nonnegative().optional(),
    source: WriteSourceSchema,
    mode: WriteModeSchema.default("replace"),
  }).strict(),
  z.object({
    operation: z.literal("copy"),
    path: z.string().optional(),
    destination: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    operation: z.literal("move"),
    path: z.string().optional(),
    destination: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  }).strict(),
]);
/** Input accepted by filesystem preflight before defaults and path normalization. */
export type PlanInputType = z.input<typeof PlanInputSchema>;

/**
 * Structured preflight result for the complete driver -> adapter -> filesystem stack.
 *
 * The driver result is preserved inside the combined plan so callers can see
 * which problems came from the backend itself and which were added by adapter or
 * filesystem policy.
 */
export const PlanSchema = z.object({
  operation: PlanOperationSchema,
  supported: z.boolean(),
  support: SupportModeSchema,
  driver: DriverPlanSchema,
  bufferBytes: z.number().int().nonnegative().optional(),
  partBytes: z.number().int().positive().optional(),
  parts: z.number().int().positive().optional(),
  problems: z.array(ProblemSchema).readonly(),
  actions: z.array(ActionSchema).readonly(),
}).strict();
/** Validated complete-stack preflight result. */
export type PlanType = z.output<typeof PlanSchema>;

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
function getDriverPlan(input: z.output<typeof PlanInputSchema>, adapter: AdapterType): DriverPlanType {
  return adapter.driver.plan({
    operation: input.operation,
    ...(input.path === undefined ? {} : { path: normalizePath(input.path) }),
    ...((input.operation === "copy" || input.operation === "move") && input.destination !== undefined
      ? { destination: normalizePath(input.destination) }
      : {}),
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.operation === "write"
      ? {
        source: input.source,
        mode: input.mode,
        ...(input.inputBytes === undefined ? {} : { inputBytes: input.inputBytes }),
      }
      : {}),
    ...(input.operation === "read" ? { range: input.range } : {}),
  });
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
  const driver = getDriverPlan(request, context.adapter);
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
