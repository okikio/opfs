import { z } from 'zod';
import type { SourceType } from '@media/source';

/** Inspection depth. Deeper inspection can require additional media reads. */
export const InspectDepthSchema = z.enum(['basic', 'support', 'full']);
/** Validated inspection depth. */
export type InspectDepthType = z.output<typeof InspectDepthSchema>;

/** Serializable initial inspection summary. */
export const InspectionSchema = z.object({ sourceKind: z.enum(['url', 'blob', 'stream']), depth: InspectDepthSchema }).strict();
/** Serializable inspection summary type. */
export type InspectionType = z.output<typeof InspectionSchema>;

/**
 * Creates the stable inspection request summary used before Mediabunny probing.
 *
 * Background: Mediabunny performs lazy reads. The package keeps `basic`,
 * `support`, and `full` explicit so callers can control the cost of inspection.
 */
export async function inspect(source: SourceType, depth: InspectDepthType = 'basic'): Promise<InspectionType> {
	return InspectionSchema.parse({ sourceKind: source.kind, depth });
}
