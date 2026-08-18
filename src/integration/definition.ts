import { z } from "zod";

import type { AdapterType } from "../adapter/definition.ts";
import type { FileSystemType } from "../filesystem.ts";
import { AdapterNameSchema } from "../schema.ts";

/**
 * Support declaration for one bridge direction.
 *
 * A direction is either real or intentionally absent. The definition does not
 * allow a silent `false` because callers need to know whether the missing route
 * is temporary, impossible, or out of scope for the current ecosystem.
 */
export const IntegrationDirectionSchema = z.object({
  /** Whether the direction has a real constructor. */
  supported: z.boolean(),
  /** Concrete reason when the direction is intentionally unsupported. */
  reason: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.supported && value.reason === undefined) {
    ctx.addIssue({ code: "custom", message: "Unsupported bridge directions require a reason." });
  }
});

/** A validated bridge-direction support declaration. */
export type IntegrationDirectionType = z.output<typeof IntegrationDirectionSchema>;

/**
 * Directions one ecosystem integration can expose.
 *
 * `toOpfs` describes projection into an OPFS adapter path. `fromOpfs` describes
 * projection back out of `FileSystemType` into a real ecosystem contract.
 */
export const IntegrationDirectionsSchema = z.object({
  /** Ecosystem/native resource projected into the OPFS filesystem model. */
  toOpfs: IntegrationDirectionSchema,
  /** OPFS filesystem projected back into the ecosystem's expected contract. */
  fromOpfs: IntegrationDirectionSchema,
}).strict();

/** Validated bridge direction declaration. */
export type IntegrationDirectionsType = z.output<typeof IntegrationDirectionsSchema>;

/**
 * Import-safe integration definition for ecosystems that support one or both directions.
 *
 * A driver owns backend-native persistence, an adapter translates a driver into
 * OPFS primitives, and a bridge implements a real OPFS-to-ecosystem contract.
 * This definition only describes which directions exist; it is not itself a bridge.
 */
export interface IntegrationType<Source = unknown, Target = unknown, ToOptions = void, FromOptions = void> {
  /** Stable integration name. */
  readonly name: string;
  /** Directions implemented without inventing unsupported synchronous semantics. */
  readonly directions: IntegrationDirectionsType;
  /**
   * Projects an ecosystem or native resource into an OPFS adapter when supported.
   *
   * This direction usually starts from a runtime-owned client, database, cache,
   * or filesystem resource.
   */
  readonly toOpfs?: (source: Source, options?: ToOptions) => AdapterType | Promise<AdapterType>;
  /**
   * Projects an OPFS facade into the ecosystem's own contract when supported.
   *
   * This direction must implement a real ecosystem contract, not a nominal
   * wrapper that only renames methods.
   */
  readonly fromOpfs?: (fileSystem: FileSystemType, options?: FromOptions) => Target | Promise<Target>;
}

/**
 * Normalizes schema failures so extension-definition mistakes have one public error class.
 *
 * Third-party integrations usually validate during startup or test setup, where
 * a single predictable `TypeError` is easier to surface than raw schema details.
 */
function parseIntegration<T>(label: string, schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new TypeError(`Invalid integration ${label}.`, { cause });
  }
}

/**
 * Validates one import-safe third-party integration definition.
 *
 * Direction flags and constructors must agree. This catches definitions that
 * advertise a route without providing its constructor while still allowing
 * honest one-way integrations when the opposite ecosystem contract cannot be
 * implemented from {@link FileSystemType}. No global registry is mutated.
 *
 * @example Declare a one-way integration into OPFS.
 * ```ts
 * import { defineIntegration } from "@okikio/opfs/integration/definition";
 *
 * const integration = defineIntegration({
 *   name: "memory",
 *   directions: {
 *     toOpfs: { supported: true },
 *     fromOpfs: { supported: false, reason: "No reverse bridge is implemented." },
 *   },
 *   toOpfs: (source) => source,
 * });
 * ```
 */
export function defineIntegration<Source, Target, ToOptions, FromOptions>(
  bridge: IntegrationType<Source, Target, ToOptions, FromOptions>,
): IntegrationType<Source, Target, ToOptions, FromOptions> {
  parseIntegration("name", AdapterNameSchema, bridge.name);
  const directions = parseIntegration("directions", IntegrationDirectionsSchema, bridge.directions);
  if (directions.toOpfs.supported !== (bridge.toOpfs !== undefined)) {
    throw new TypeError(`Integration '${bridge.name}' toOpfs direction does not match its constructor.`);
  }
  if (directions.fromOpfs.supported !== (bridge.fromOpfs !== undefined)) {
    throw new TypeError(`Integration '${bridge.name}' fromOpfs direction does not match its constructor.`);
  }
  return bridge;
}
