import { z } from "zod";

import type { AdapterType } from "./adapter/definition.ts";
import { getSupport } from "./capability.ts";
import type { OptimizationType, SupportModeType } from "./schema.ts";
import { SupportModeSchema, WriteModeSchema } from "./schema.ts";

/** Kind of input presented to a filesystem write planner. */
export const WriteSourceSchema = z.enum(["bytes", "stream"]);

/** A validated write-source shape. */
export type WriteSourceType = z.output<typeof WriteSourceSchema>;

/** Operations that have materially different storage routes. */
export const PlanOperationSchema = z.enum(["read", "write", "copy", "move"]);

/** A validated plannable operation. */
export type PlanOperationType = z.output<typeof PlanOperationSchema>;

/** Serializable preflight request for one storage operation. */
export const PlanInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("read"),
    /** Known logical file size. */
    size: z.number().int().nonnegative().optional(),
    /** Whether the caller requests only a byte range. */
    range: z.boolean().default(false),
  }).strict(),
  z.object({
    operation: z.literal("write"),
    /** Known logical output size. Unknown stream sizes can omit it. */
    size: z.number().int().nonnegative().optional(),
    /** Bytes supplied by this write. Used to preflight facade stream materialization. */
    inputBytes: z.number().int().nonnegative().optional(),
    /** Byte collection or streaming producer. */
    source: WriteSourceSchema,
    /** Replace, append, or update semantics. */
    mode: WriteModeSchema.default("replace"),
  }).strict(),
  z.object({
    operation: z.literal("copy"),
    /** Known source byte size when the caller already has it. */
    size: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    operation: z.literal("move"),
    /** Known source byte size when the caller already has it. */
    size: z.number().int().nonnegative().optional(),
  }).strict(),
]);

/** A validated storage preflight request. */
export type PlanInputType = z.input<typeof PlanInputSchema>;

/** Serializable preflight result explaining the selected route and limits. */
export const PlanSchema = z.object({
  /** Requested operation. */
  operation: PlanOperationSchema,
  /** Whether the configured stack can safely attempt the request. */
  supported: z.boolean(),
  /** Native, emulated, partitioned, or unsupported route selected for the request. */
  support: SupportModeSchema,
  /** Expected facade materialization when it is statically known. */
  bufferBytes: z.number().int().nonnegative().optional(),
  /** Physical part size when a partitioned adapter route is selected. */
  partBytes: z.number().int().positive().optional(),
  /** Physical part count when both size and partition shape are known. */
  parts: z.number().int().positive().optional(),
  /** Concrete reasons that determined the route. */
  reasons: z.array(z.string()).readonly(),
  /** Non-fatal constraints the caller may want to act on. */
  warnings: z.array(z.string()).readonly(),
}).strict();

/** A validated storage preflight result. */
export type PlanType = z.output<typeof PlanSchema>;

/** Inputs needed by the pure planner without importing the filesystem class. */
export interface PlanContextType {
  /** Configured adapter. */
  readonly adapter: AdapterType;
  /** Resolved facade optimization policy. */
  readonly optimizations: OptimizationType;
  /** Facade materialization ceiling. */
  readonly maxBufferedWriteBytes: number;
}

/** Marks a result unsupported while preserving accumulated explanatory text. */
function unsupported(operation: PlanOperationType, reasons: string[], warnings: string[]): PlanType {
  return PlanSchema.parse({ operation, supported: false, support: "unsupported", reasons, warnings });
}

/** Applies adapter hard file-size and partition-count limits before route selection. */
function checkSize(
  input: PlanInputType,
  context: PlanContextType,
  reasons: string[],
  warnings: string[],
): { support?: SupportModeType; partBytes?: number; parts?: number } | null {
  const size = input.size;
  if (size === undefined) {
    if (context.adapter.limits?.maxFileBytes !== undefined) {
      warnings.push(`Adapter file limit is ${context.adapter.limits.maxFileBytes} bytes; the requested size is unknown.`);
    }
    return {};
  }

  const maxFileBytes = context.adapter.limits?.maxFileBytes;
  if (maxFileBytes !== undefined && size > maxFileBytes) {
    reasons.push(`Requested size ${size} exceeds adapter maxFileBytes ${maxFileBytes}.`);
    return null;
  }

  const partition = context.adapter.partition;
  if (partition === undefined || partition.mode === "never") return {};
  const threshold = partition.thresholdBytes ?? partition.partBytes;
  const shouldPartition = partition.mode === "always" || size > threshold;
  if (!shouldPartition) return {};

  const parts = Math.max(1, Math.ceil(size / partition.partBytes));
  if (partition.maxParts !== undefined && parts > partition.maxParts) {
    reasons.push(`Partitioned value requires ${parts} parts, above adapter maximum ${partition.maxParts}.`);
    return null;
  }
  reasons.push(`Adapter stores this logical value as ${parts} physical parts of at most ${partition.partBytes} bytes.`);
  return { support: "partitioned", partBytes: partition.partBytes, parts };
}

/**
 * Creates a deterministic storage preflight plan without performing I/O.
 *
 * The planner answers two separate questions: whether the operation is safe to
 * attempt, and which storage route it will use. Unknown provider limits remain
 * warnings rather than being guessed. Applications can therefore reject large
 * work early, change a buffer/partition policy, or select another adapter.
 */
export function createPlan(input: PlanInputType, context: PlanContextType): PlanType {
  const request = PlanInputSchema.parse(input);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const support = getSupport(context.adapter, context.optimizations);
  const size = checkSize(request, context, reasons, warnings);
  if (size === null) return unsupported(request.operation, reasons, warnings);

  if (request.operation === "read") {
    const route = request.range ? support.rangeRead : support.read;
    if (route === "unsupported") {
      reasons.push("Configured adapter cannot read file bytes.");
      return unsupported(request.operation, reasons, warnings);
    }
    reasons.push(request.range && route === "emulated"
      ? "Byte range will be produced after a materialized read."
      : request.range ? "Adapter can read the requested byte range directly." : "Adapter can read the file directly.");
    return PlanSchema.parse({ operation: request.operation, supported: true, support: route, reasons, warnings });
  }

  if (request.operation === "write") {
    let route = request.source === "stream" ? support.streamWrite[request.mode] : support.write;
    let bufferBytes: number | undefined;
    const inputBytes = request.inputBytes ?? (request.mode === "replace" ? request.size : undefined);
    if (route === "unsupported") {
      reasons.push(`Configured adapter cannot perform ${request.mode} writes.`);
      return unsupported(request.operation, reasons, warnings);
    }
    if (request.source === "stream" && route === "emulated") {
      if (inputBytes !== undefined && inputBytes > context.maxBufferedWriteBytes) {
        reasons.push(
          `Stream requires facade materialization but ${inputBytes} input bytes exceeds maxBufferedWriteBytes ${context.maxBufferedWriteBytes}.`,
        );
        return unsupported(request.operation, reasons, warnings);
      }
      bufferBytes = inputBytes;
      warnings.push(
        inputBytes === undefined
          ? `Stream is not native for ${request.mode}; input size is unknown and the facade will fail if it crosses maxBufferedWriteBytes ${context.maxBufferedWriteBytes}.`
          : `Stream is not native for ${request.mode}; the facade will materialize ${inputBytes} input bytes under maxBufferedWriteBytes ${context.maxBufferedWriteBytes}.`,
      );
    }
    if (size.support === "partitioned") route = "partitioned";
    reasons.push(route === "native"
      ? "Configured adapter has a direct write route for this input."
      : route === "partitioned"
      ? "Logical file write is preserved through the adapter's partition layout."
      : "Facade will emulate the requested write using materialized adapter primitives.");
    return PlanSchema.parse({
      operation: request.operation,
      supported: true,
      support: route,
      ...(bufferBytes === undefined ? {} : { bufferBytes }),
      ...(size.partBytes === undefined ? {} : { partBytes: size.partBytes }),
      ...(size.parts === undefined ? {} : { parts: size.parts }),
      reasons,
      warnings,
    });
  }

  const route = request.operation === "copy" ? support.copy : support.move;
  if (route === "unsupported") {
    reasons.push(`Configured adapter cannot ${request.operation} with either a native route or safe facade fallback.`);
    return unsupported(request.operation, reasons, warnings);
  }

  if (route === "emulated" && request.size !== undefined && request.size > context.maxBufferedWriteBytes) {
    const streamedRead = support.streamRead === "native";
    const streamedWrite = support.streamWrite.replace === "native" || support.streamWrite.replace === "partitioned";
    if (!streamedRead || !streamedWrite) {
      reasons.push(
        `${request.operation} fallback would materialize ${request.size} bytes because a complete streaming read/write path is unavailable; maxBufferedWriteBytes is ${context.maxBufferedWriteBytes}.`,
      );
      return unsupported(request.operation, reasons, warnings);
    }
  }

  if (request.operation === "move" && route === "emulated") {
    warnings.push("Emulated move is copy followed by remove and is not atomic.");
  }
  reasons.push(route === "native"
    ? `Adapter has a native ${request.operation} route.`
    : `${request.operation} will be composed from facade read/write/remove primitives.`);
  return PlanSchema.parse({ operation: request.operation, supported: true, support: route, reasons, warnings });
}
