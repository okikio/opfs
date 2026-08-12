import { z } from 'zod';
import { FormatSchema } from '@media/format';
import { SourceSchema } from '@media/source';

/** Hardware acceleration preference passed to compatible WebCodecs paths. */
export const HardwareSchema = z.enum(['no-preference', 'prefer-hardware', 'prefer-software']);
/** Video conversion options. */
export const VideoOptionsSchema = z.object({ codec: z.string().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), bitrate: z.number().positive().optional(), hardware: HardwareSchema.default('no-preference'), forceTranscode: z.boolean().default(false), discard: z.boolean().default(false) }).strict();
/** Audio conversion options. */
export const AudioOptionsSchema = z.object({ codec: z.string().optional(), channels: z.number().int().positive().optional(), sampleRate: z.number().int().positive().optional(), bitrate: z.number().positive().optional(), forceTranscode: z.boolean().default(false), discard: z.boolean().default(false) }).strict();
/** Stable conversion request. */
export const ConvertSchema = z.object({ source: SourceSchema, format: FormatSchema, video: VideoOptionsSchema.optional(), audio: AudioOptionsSchema.optional(), trim: z.object({ start: z.number().optional(), end: z.number().optional() }).strict().optional() }).strict();
/** Validated conversion request. */
export type ConvertType = z.output<typeof ConvertSchema>;

/**
 * Validates a conversion request before Mediabunny resources are acquired.
 *
 * Impact: This function validates structure only. Runtime codec support and
 * actual copy/remux/transcode decisions belong to the conversion planner and
 * Mediabunny capability checks.
 */
export function validate(input: z.input<typeof ConvertSchema>): ConvertType {
	return ConvertSchema.parse(input);
}
