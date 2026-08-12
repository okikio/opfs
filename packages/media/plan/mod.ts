import { z } from 'zod';
import { FormatSchema } from '@media/format';

/** Work required for one selected media track. */
export const ActionSchema = z.enum(['copy', 'remux', 'transcode', 'discard']);
/** Complete media operation classification. */
export const OperationSchema = z.enum(['copy', 'remux', 'transcode', 'mixed']);
/** Work required for one output request. */
export const PlanSchema = z.object({ format: FormatSchema, operation: OperationSchema, reasons: z.array(z.string()) }).strict();

/** Track action type. */
export type ActionType = z.output<typeof ActionSchema>;
/** Complete operation type. */
export type OperationType = z.output<typeof OperationSchema>;
/** Validated media plan. */
export type PlanType = z.output<typeof PlanSchema>;

/**
 * Creates a deterministic initial operation plan.
 *
 * Options: `copy` is valid only when the complete resource remains unchanged.
 * `remux` keeps encoded media but changes its container. `transcode` is used
 * when the caller requests codec or sample changes.
 */
export function create(input: { format: z.input<typeof FormatSchema>; sourceFormat?: string; changes?: boolean }): PlanType {
	const format = FormatSchema.parse(input.format);
	if (input.changes) return { format, operation: 'transcode', reasons: ['requested media properties change'] };
	if (input.sourceFormat === format) return { format, operation: 'copy', reasons: ['source and output format match'] };
	return { format, operation: 'remux', reasons: ['container changes while media can remain encoded'] };
}
