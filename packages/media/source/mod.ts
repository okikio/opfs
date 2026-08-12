import { z } from 'zod';

/** Remote HTTP or HTTPS media source. */
export const UrlSourceSchema = z.object({
	kind: z.literal('url'),
	url: z.url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), 'Expected HTTP or HTTPS URL'),
	parallelism: z.number().int().positive().max(32).default(2),
	cacheBytes: z.number().int().nonnegative().default(8 * 1024 * 1024),
}).strict();

/** Local Blob or File media source. */
export const BlobSourceSchema = z.object({
	kind: z.literal('blob'),
	blob: z.custom<Blob>((value) => typeof Blob !== 'undefined' && value instanceof Blob),
}).strict();

/** Sequential stream media source. */
export const StreamSourceSchema = z.object({
	kind: z.literal('stream'),
	stream: z.custom<ReadableStream<Uint8Array>>((value) => typeof ReadableStream !== 'undefined' && value instanceof ReadableStream),
}).strict();

/** Media source accepted by the library boundary. */
export const SourceSchema = z.discriminatedUnion('kind', [UrlSourceSchema, BlobSourceSchema, StreamSourceSchema]);

/** Validated remote source. */
export type UrlSourceType = z.output<typeof UrlSourceSchema>;
/** Validated local Blob source. */
export type BlobSourceType = z.output<typeof BlobSourceSchema>;
/** Validated sequential stream source. */
export type StreamSourceType = z.output<typeof StreamSourceSchema>;
/** Validated media source. */
export type SourceType = z.output<typeof SourceSchema>;

/** Returns whether the source supports efficient random access. */
export function isRandom(source: SourceType): boolean {
	return source.kind !== 'stream';
}
