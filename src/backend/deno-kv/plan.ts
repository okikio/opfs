/**
 * Preflight plans for the Deno KV driver.
 *
 * A plan says, before any write, whether an operation fits in one atomic commit,
 * needs parts, or cannot run under the configured limits.
 *
 * @module
 */
import { key } from "./layout.ts";
import {
  DENO_KV_DEFAULT_INLINE_BYTES,
  DENO_KV_DEFAULT_MAX_PARTS,
  DENO_KV_DEFAULT_PART_BYTES,
  DENO_KV_MAX_KEY_BYTES,
  estimateKeyBytes,
  positive,
  validateSizePolicy,
} from "./limits.ts";
import type { DenoKvDriverOptionsType } from "./types.ts";
import {
  type ActionType,
  DriverPlanInputSchema,
  type DriverPlanInputType,
  DriverPlanSchema,
  type DriverPlanType,
  type ProblemType,
} from "../../driver/definition.ts";
import { PartitionModeSchema } from "../../schema/mod.ts";

/** Creates a path-aware Deno KV plan before any provider request is sent. */
export function createDenoKvPlan(options: DenoKvDriverOptionsType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const partition = PartitionModeSchema.parse(options.partition ?? "auto");
  const prefix = `${options.prefix ?? "okikio-opfs"}:v3`;
  const partBytes = positive(options.partBytes, DENO_KV_DEFAULT_PART_BYTES, "partBytes");
  const inlineBytes = positive(options.inlineBytes, DENO_KV_DEFAULT_INLINE_BYTES, "inlineBytes");
  const maxParts = positive(options.maxParts, DENO_KV_DEFAULT_MAX_PARTS, "maxParts");
  validateSizePolicy(partBytes, inlineBytes, maxParts);
  const problems: ProblemType[] = [];
  const actions: ActionType[] = [];
  if (request.path !== undefined) {
    const entryBytes = estimateKeyBytes(key(prefix, request.path));
    const partBytesEstimate = estimateKeyBytes(
      [
        prefix,
        "pin",
        request.path,
        "00000000000-00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000",
      ],
    );
    const estimated = Math.max(entryBytes, partBytesEstimate);
    if (estimated > DENO_KV_MAX_KEY_BYTES) {
      problems.push({
        code: "key-too-large",
        layer: "driver",
        severity: "error",
        message: `Deno KV physical key estimate ${estimated} bytes exceeds the ${DENO_KV_MAX_KEY_BYTES}-byte ` +
          `serialized provider limit for '${request.path}'.`,
        limit: {
          code: "serialized-key-bytes",
          kind: "hard",
          source: "provider",
          unit: "bytes",
          value: DENO_KV_MAX_KEY_BYTES,
        },
      });
      actions.push({ kind: "reduce-input" }, { kind: "select-driver" });
    }
  }
  let support: "native" | "partitioned" | "unsupported" = "native";
  let count: number | undefined;
  if (request.operation === "write" && request.size !== undefined) {
    const usesParts = partition === "always" || (partition === "auto" && request.size > inlineBytes);
    if (partition === "never" && request.size > inlineBytes) {
      support = "unsupported";
      problems.push({
        code: "partition-disabled",
        layer: "driver",
        severity: "error",
        message:
          `The ${request.size}-byte write exceeds inlineBytes=${inlineBytes}, but Deno KV partitioning is disabled.`,
      });
      actions.push({ kind: "change-policy" }, { kind: "select-driver" });
    } else if (usesParts) {
      support = "partitioned";
      count = Math.max(1, Math.ceil(request.size / partBytes));
      if (count > maxParts) {
        support = "unsupported";
        problems.push({
          code: "too-many-parts",
          layer: "driver",
          severity: "error",
          message: `The write needs ${count} Deno KV parts, above configured maxParts=${maxParts}.`,
          limit: {
            code: "parts",
            kind: "policy",
            source: "user",
            unit: "count",
            value: maxParts,
          },
        });
        actions.push({ kind: "change-policy" }, { kind: "select-driver" });
      }
    }
  }
  const supported = support !== "unsupported" && problems.every((problem) => problem.severity !== "error");
  return DriverPlanSchema.parse({
    operation: request.operation,
    supported,
    support: supported ? support : "unsupported",
    ...(count === undefined ? {} : { parts: count, partBytes }),
    problems,
    actions,
  });
}
