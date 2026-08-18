import { z } from "zod";

/** Compile-time assertion that fails when a boolean type is not `true`. */
type AssertTrue<T extends true> = T;

/** Bidirectional assignability check used to catch schema/type drift. */
type IsEquivalent<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

import type { DriverMetricsType } from "../metrics.ts";
import {
  DriverKindSchema,
  type DriverKindType,
  DriverOptimizationSchema,
  type DriverOptimizationType,
  DriverOwnershipSchema,
  type DriverOwnershipType,
  LimitSchema,
  type LimitType,
  PathSchema,
  RequirementSchema,
  type RequirementType,
  SupportModeSchema,
  WriteModeSchema,
} from "../schema.ts";

/**
 * Layer that identified one storage planning problem.
 *
 * The layer tells the caller where the constraint lives so they can respond at
 * the right seam. For example, a driver limit may require a different backend,
 * while a filesystem problem may only require a facade policy change.
 */
export const ProblemLayerSchema = z.enum(["client", "driver", "adapter", "filesystem"]);

/** A validated storage problem layer. */
export type ProblemLayerType = "client" | "driver" | "adapter" | "filesystem";

/**
 * Severity of one storage planning problem.
 *
 * These levels are presentation-friendly summaries. Callers should still use
 * the structured `code`, `layer`, and optional `limit` fields to drive policy.
 */
export const ProblemSeveritySchema = z.enum(["info", "warning", "error"]);

/** A validated storage planning problem severity. */
export type ProblemSeverityType = "info" | "warning" | "error";

/**
 * Action a caller can take after a storage preflight result.
 *
 * The planner does not mutate configuration or probe providers on the caller's
 * behalf. It only reports the next kind of move that could make the request
 * succeed honestly.
 */
export const ActionKindSchema = z.enum([
  "partition",
  "change-policy",
  "select-driver",
  "reduce-input",
  "enable-optimization",
  "disable-optimization",
  "probe",
  "retry",
]);

/** A validated storage planning action. */
export type ActionKindType =
  | "partition"
  | "change-policy"
  | "select-driver"
  | "reduce-input"
  | "enable-optimization"
  | "disable-optimization"
  | "probe"
  | "retry";

/**
 * One structured problem found while planning a storage operation.
 *
 * The problem is machine-readable first. `message` helps logs and humans, while
 * `code`, `layer`, and `limit` let a caller sort provider ceilings, policy
 * choices, and unsupported routes without parsing prose.
 */
export const ProblemSchema = z.object({
  /** Stable machine-readable problem code. */
  code: z.string().min(1),
  /** Layer that identified the problem. */
  layer: ProblemLayerSchema,
  /** Severity used by diagnostics and policy. */
  severity: ProblemSeveritySchema,
  /** Human-readable summary of the problem. */
  message: z.string().min(1),
  /** Related limit when the problem comes from a specific ceiling or budget. */
  limit: LimitSchema.optional(),
}).strict();

/** A validated storage planning problem. */
export interface ProblemType {
  /** Stable machine-readable problem code. */
  readonly code: string;
  /** Layer that identified the problem. */
  readonly layer: ProblemLayerType;
  /** Severity used by diagnostics and policy. */
  readonly severity: ProblemSeverityType;
  /** Human-readable summary of the problem. */
  readonly message: string;
  /** Related limit when the problem comes from a specific ceiling or budget. */
  readonly limit?: LimitType | undefined;
}

type _ProblemTypeMatchesSchema = AssertTrue<IsEquivalent<ProblemType, z.output<typeof ProblemSchema>>>;

/**
 * One structured action available to the caller after planning.
 *
 * Actions deliberately stay coarse-grained. They explain intent such as
 * `reduce-input` or `select-driver` without assuming the caller's UI, retry, or
 * orchestration policy.
 */
export const ActionSchema = z.object({
  /** Coarse-grained next step the caller can take. */
  kind: ActionKindSchema,
  /** Optional machine-readable qualifier for UI or policy routing. */
  code: z.string().min(1).optional(),
  /** Optional human-readable action detail. */
  detail: z.string().min(1).optional(),
}).strict();

/** A validated storage planning action. */
export interface ActionType {
  /** Coarse-grained next step the caller can take. */
  readonly kind: ActionKindType;
  /** Optional machine-readable qualifier for UI or policy routing. */
  readonly code?: string | undefined;
  /** Optional human-readable action detail. */
  readonly detail?: string | undefined;
}

type _ActionTypeMatchesSchema = AssertTrue<IsEquivalent<ActionType, z.output<typeof ActionSchema>>>;

/**
 * Operations that a backend driver can preflight without performing I/O.
 *
 * This stays smaller than the full facade surface. The driver only plans the
 * backend-native work it understands directly, while the adapter and facade add
 * higher-level emulation and policy above it.
 */
export const DriverOperationSchema = z.enum(["stat", "read", "write", "list", "copy", "move", "remove"]);

/** A validated backend driver operation. */
export type DriverOperationType = "stat" | "read" | "write" | "list" | "copy" | "move" | "remove";

/**
 * Concrete operation shape presented to a backend driver planner.
 *
 * Paths are canonical at the driver seam. The filesystem facade normalizes public
 * input before an adapter calls a driver, and direct driver callers must supply canonical paths. `size` can be omitted for an unknown-length stream.
 */
export const DriverPlanInputSchema = z.object({
  /** Backend-native operation being preflighted. */
  operation: DriverOperationSchema,
  /** Canonical source path when the operation targets one path. */
  path: PathSchema.optional(),
  /** Canonical destination path for copy and move operations. */
  destination: PathSchema.optional(),
  /** Caller-known logical byte size when available. */
  size: z.number().int().nonnegative().optional(),
  /** Caller-known already-buffered byte count for streamed work. */
  inputBytes: z.number().int().nonnegative().optional(),
  /** Physical input source form for write operations. */
  source: z.enum(["bytes", "stream"]).optional(),
  /** Requested write semantics for write operations. */
  mode: WriteModeSchema.optional(),
  /** Whether a read request targets a byte range instead of the full file. */
  range: z.boolean().optional(),
}).strict();

/** A validated backend driver preflight request. */
export interface DriverPlanInputType {
  /** Backend-native operation being preflighted. */
  readonly operation: DriverOperationType;
  /** Canonical source path when the operation targets one path. */
  readonly path?: string | undefined;
  /** Canonical destination path for copy and move operations. */
  readonly destination?: string | undefined;
  /** Caller-known logical byte size when available. */
  readonly size?: number | undefined;
  /** Caller-known already-buffered byte count for streamed work. */
  readonly inputBytes?: number | undefined;
  /** Physical input source form for write operations. */
  readonly source?: "bytes" | "stream" | undefined;
  /** Requested write semantics for write operations. */
  readonly mode?: "replace" | "append" | "update" | undefined;
  /** Whether a read request targets a byte range instead of the full file. */
  readonly range?: boolean | undefined;
}

type _DriverPlanInputTypeMatchesSchema = AssertTrue<
  IsEquivalent<DriverPlanInputType, z.output<typeof DriverPlanInputSchema>>
>;

/**
 * Serializable result returned by a backend driver planner.
 *
 * `supported` answers whether the requested backend-native operation can work
 * under current facts and policy. `support` explains whether that route is
 * native, emulated later, partitioned, or unavailable once the result is folded
 * into the adapter and filesystem plan.
 */
export const DriverPlanSchema = z.object({
  /** Backend-native operation that was planned. */
  operation: DriverOperationSchema,
  /** Whether the request can proceed under current facts and policy. */
  supported: z.boolean(),
  /** Effective support mode for the backend-native route. */
  support: SupportModeSchema,
  /** Physical part or block size when partitioning is involved. */
  partBytes: z.number().int().positive().optional(),
  /** Physical part or block count when partitioning is involved. */
  parts: z.number().int().positive().optional(),
  /** Structured problems reported by driver planning. */
  problems: z.array(ProblemSchema).readonly(),
  /** Structured actions the caller can take next. */
  actions: z.array(ActionSchema).readonly(),
}).strict();

/** A validated backend driver preflight result. */
export interface DriverPlanType {
  /** Backend-native operation that was planned. */
  readonly operation: DriverOperationType;
  /** Whether the request can proceed under current facts and policy. */
  readonly supported: boolean;
  /** Effective support mode for the backend-native route. */
  readonly support: "native" | "emulated" | "partitioned" | "unsupported";
  /** Physical part or block size when partitioning is involved. */
  readonly partBytes?: number | undefined;
  /** Physical part or block count when partitioning is involved. */
  readonly parts?: number | undefined;
  /** Structured problems reported by driver planning. */
  readonly problems: readonly ProblemType[];
  /** Structured actions the caller can take next. */
  readonly actions: readonly ActionType[];
}

type _DriverPlanTypeMatchesSchema = AssertTrue<
  IsEquivalent<DriverPlanType, z.output<typeof DriverPlanSchema>>
>;

/**
 * Serializable configured-driver report exposed through filesystem inspection.
 *
 * This is the durable description a caller can log, diff, snapshot in tests, or
 * surface in diagnostics before any storage work starts.
 */
export const DriverInspectionSchema = z.object({
  /** Stable configured driver name. */
  name: z.string().min(1),
  /** Backend family implemented by this driver. */
  kind: DriverKindSchema,
  /** Stable backend-native operations and capabilities. */
  provides: z.array(z.string().min(1)).readonly(),
  /** Ownership of any long-lived backend resource. */
  ownership: DriverOwnershipSchema,
  /** Requirements already known for this configured instance. */
  requirements: z.array(RequirementSchema).readonly(),
  /** Limits with provider, policy, or probe provenance. */
  limits: z.array(LimitSchema).readonly(),
  /** Independently visible driver optimization switches. */
  optimizations: z.array(DriverOptimizationSchema).readonly(),
}).strict();

/** A validated configured-driver report. */
export interface DriverInspectionType {
  /** Stable configured driver name. */
  readonly name: string;
  /** Backend family implemented by this driver. */
  readonly kind: DriverKindType;
  /** Stable backend-native operations and capabilities. */
  readonly provides: readonly string[];
  /** Ownership of any long-lived backend resource. */
  readonly ownership: DriverOwnershipType;
  /** Requirements already known for this configured instance. */
  readonly requirements: readonly RequirementType[];
  /** Limits with provider, policy, or probe provenance. */
  readonly limits: readonly LimitType[];
  /** Independently visible driver optimization switches. */
  readonly optimizations: readonly DriverOptimizationType[];
}

type _DriverInspectionTypeMatchesSchema = AssertTrue<
  IsEquivalent<DriverInspectionType, z.output<typeof DriverInspectionSchema>>
>;

/**
 * Common behavior implemented by every configured storage driver.
 *
 * A driver is independently useful without the OPFS facade. It owns backend
 * storage mechanics, requirements, limits, provider-specific optimization
 * policy, and optional lifecycle. Adapters translate a driver into the small
 * filesystem primitive contract.
 */
export interface DriverType {
  /** Stable configured driver name. */
  readonly name: string;
  /** Native storage family implemented by this driver. */
  readonly kind: DriverKindType;
  /** Stable backend operations/capabilities this configured driver provides. */
  readonly provides: readonly string[];
  /** Ownership of the long-lived backend resource, when one exists. */
  readonly ownership: DriverOwnershipType;
  /** Requirements already known for this configured instance. */
  readonly requirements: readonly RequirementType[];
  /** Provider, implementation, user, and probe limits with explicit provenance. */
  readonly limits: readonly LimitType[];
  /** Independently controllable driver optimizations and their current state. */
  readonly optimizations: readonly DriverOptimizationType[];
  /**
   * Returns a detached current driver report.
   *
   * Callers can inspect this result without worrying about later mutation by the
   * driver implementation.
   */
  inspect(): DriverInspectionType;
  /**
   * Creates a deterministic backend preflight result without performing storage I/O.
   *
   * Use this before expensive or irreversible work when the request size, write
   * mode, or selected route may already violate a provider limit or local policy.
   */
  plan(input: DriverPlanInputType): DriverPlanType;
  /**
   * Returns driver-owned physical metrics when the implementation collects them.
   *
   * These metrics describe backend work such as provider requests or bytes moved.
   * They complement, rather than replace, the logical filesystem metrics.
   */
  getMetrics?(): DriverMetricsType;
  /**
   * Releases resources explicitly owned by the configured driver.
   *
   * Borrowed clients, databases, and stores stay owned by the caller unless the
   * driver definition explicitly transferred that ownership.
   */
  dispose?(): void | Promise<void>;
}

/**
 * Data used to create a small custom driver definition.
 *
 * This is the lowest-level extension seam. A third-party package can describe a
 * real configured backend here, then layer a file, record, or object contract on
 * top when it wants stronger operational typing.
 */
export interface DefineDriverOptionsType {
  /** Stable inspection name for the configured backend instance. */
  readonly name: string;
  /** Backend family that owns the persistence mechanics. */
  readonly kind: DriverKindType;
  /** Stable backend-native verbs or capabilities this instance provides. */
  readonly provides?: readonly string[];
  /** Whether the driver owns, borrows, or avoids long-lived backend resources. */
  readonly ownership?: DriverOwnershipType;
  /** Known availability facts for this configured instance. */
  readonly requirements?: readonly RequirementType[];
  /** Provider, implementation, user, and probe limits with explicit provenance. */
  readonly limits?: readonly LimitType[];
  /** Independently visible and disableable optimization switches. */
  readonly optimizations?: readonly DriverOptimizationType[];
  /** Optional deterministic planner for backend-native work. */
  readonly plan?: (input: DriverPlanInputType) => DriverPlanType;
  /** Optional physical metrics collected by this driver. */
  readonly getMetrics?: () => DriverMetricsType;
  /** Optional lifecycle hook for resources this driver truly owns. */
  readonly dispose?: () => void | Promise<void>;
}

/**
 * Normalizes custom-driver definition failures to one extension-facing error class.
 *
 * Third-party extension code usually wants one predictable failure shape during
 * startup or test setup, not raw Zod errors from several validation paths.
 */
function parseDriverSchema<T>(label: string, schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new TypeError(`Invalid driver ${label}.`, { cause });
  }
}

/**
 * Creates an import-safe custom driver definition without global registration.
 *
 * Third-party packages can compose this definition with a concrete file,
 * record, or object driver contract. The function validates structured
 * requirements, limits, and optimization invariants once at construction.
 *
 * @example Minimal deterministic driver definition.
 * ```ts
 * import { defineDriver } from "@okikio/opfs/driver";
 *
 * const driver = defineDriver({
 *   name: "example",
 *   kind: "record",
 *   provides: ["get", "set", "delete", "list"],
 * });
 * ```
 *
 * @example Driver with explicit size ceiling and planning result.
 * ```ts
 * import { defineDriver } from "@okikio/opfs/driver";
 *
 * const driver = defineDriver({
 *   name: "small-records",
 *   kind: "record",
 *   limits: [{
 *     code: "file-bytes",
 *     kind: "hard",
 *     source: "provider",
 *     unit: "bytes",
 *     value: 64 * 1024,
 *   }],
 *   plan: (input) => ({
 *     operation: input.operation,
 *     supported: input.size === undefined || input.size <= 64 * 1024,
 *     support: "native",
 *     problems: [],
 *     actions: [],
 *   }),
 * });
 * ```
 */
export function defineDriver(options: DefineDriverOptionsType): DriverType {
  const inspection = parseDriverSchema("definition", DriverInspectionSchema, {
    name: options.name,
    kind: options.kind,
    provides: options.provides ?? [],
    ownership: options.ownership ?? "none",
    requirements: options.requirements ?? [],
    limits: options.limits ?? [],
    optimizations: options.optimizations ?? [],
  });

  return {
    ...inspection,
    inspect: () => DriverInspectionSchema.parse(inspection),
    plan: options.plan ?? ((input) =>
      DriverPlanSchema.parse({
        operation: DriverPlanInputSchema.parse(input).operation,
        supported: true,
        support: "native",
        problems: [],
        actions: [],
      })),
    ...(options.getMetrics === undefined ? {} : { getMetrics: options.getMetrics }),
    ...(options.dispose === undefined ? {} : { dispose: options.dispose }),
  };
}
