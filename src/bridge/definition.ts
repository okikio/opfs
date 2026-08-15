import { z } from "zod";

import type { AdapterType } from "../adapter/definition.ts";
import type { FileSystemType } from "../filesystem.ts";
import { AdapterNameSchema } from "../schema.ts";

/** Support declaration for one bridge direction. */
export const BridgeDirectionSchema = z.object({
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
export type BridgeDirectionType = z.output<typeof BridgeDirectionSchema>;

/** Directions one ecosystem integration can expose. */
export const BridgeDirectionsSchema = z.object({
  /** Ecosystem/native resource projected into the OPFS filesystem model. */
  toOpfs: BridgeDirectionSchema,
  /** OPFS filesystem projected back into the ecosystem's expected contract. */
  fromOpfs: BridgeDirectionSchema,
}).strict();

/** Validated bridge direction declaration. */
export type BridgeDirectionsType = z.output<typeof BridgeDirectionsSchema>;

/**
 * Paired integration descriptor for ecosystems that support one or both directions.
 *
 * An adapter remains the primitive `ecosystem -> OPFS` translation and a driver
 * remains the ecosystem-shaped `OPFS -> ecosystem` translation. A bridge does
 * not replace either contract. It groups the two constructors so support can be
 * inspected and extended as one coherent integration.
 */
export interface BridgeType<Source = unknown, Target = unknown, ToOptions = void, FromOptions = void> {
  /** Stable integration name. */
  readonly name: string;
  /** Directions implemented without inventing unsupported synchronous semantics. */
  readonly directions: BridgeDirectionsType;
  /** Projects an ecosystem/native resource into an OPFS adapter when supported. */
  readonly toOpfs?: (source: Source, options?: ToOptions) => AdapterType | Promise<AdapterType>;
  /** Projects an OPFS facade into the ecosystem's own contract when supported. */
  readonly fromOpfs?: (fileSystem: FileSystemType, options?: FromOptions) => Target | Promise<Target>;
}

/**
 * Validates a third-party bridge descriptor without registering global state.
 *
 * Direction flags and constructors must agree. This catches integrations that
 * advertise a route but forget to provide its constructor, while still allowing
 * honest one-way bridges for ecosystems whose other direction is impossible.
 */
export function defineBridge<Source, Target, ToOptions, FromOptions>(
  bridge: BridgeType<Source, Target, ToOptions, FromOptions>,
): BridgeType<Source, Target, ToOptions, FromOptions> {
  AdapterNameSchema.parse(bridge.name);
  const directions = BridgeDirectionsSchema.parse(bridge.directions);
  if (directions.toOpfs.supported !== (bridge.toOpfs !== undefined)) {
    throw new TypeError(`Bridge '${bridge.name}' toOpfs direction does not match its constructor.`);
  }
  if (directions.fromOpfs.supported !== (bridge.fromOpfs !== undefined)) {
    throw new TypeError(`Bridge '${bridge.name}' fromOpfs direction does not match its constructor.`);
  }
  return bridge;
}
