import { contentType } from '@std/media-types';
import { z } from 'zod';

/** Writable single-file media formats used by the first output layer. */
export const FormatSchema = z.enum(['mp4', 'mov', 'webm', 'mkv', 'ogg', 'mp3', 'wav', 'aac', 'flac', 'ts']);

/** Validated media format name. */
export type FormatType = z.output<typeof FormatSchema>;

const extensions: Readonly<Record<FormatType, string>> = {
	mp4: '.mp4', mov: '.mov', webm: '.webm', mkv: '.mkv', ogg: '.ogg', mp3: '.mp3', wav: '.wav',
	aac: '.aac', flac: '.flac', ts: '.ts',
};

/** Returns the conventional file extension for a format. */
export function getExtension(format: FormatType): string {
	return extensions[FormatSchema.parse(format)];
}

/**
 * Returns the standard MIME type for a format.
 *
 * Reason: `@std/media-types` owns the MIME database so this package does not
 * maintain a second copy.
 */
export function getMime(format: FormatType): string | undefined {
	return contentType(`file${getExtension(format)}`)?.split(';', 1)[0];
}
