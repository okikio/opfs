import { z } from 'zod';

/** Positional byte write produced by a media writer. */
export const WriteSchema = z.object({ position: z.number().int().nonnegative(), data: z.instanceof(Uint8Array) }).strict();
/** Positional byte write type. */
export type WriteType = z.output<typeof WriteSchema>;

/** Owned destination for media bytes. */
export interface Writer {
	write(input: WriteType): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
}

/**
 * Creates a bounded in-memory writer for tests and small previews.
 *
 * Impact: The complete output stays in JavaScript memory. Use a disk-backed
 * writer for large files.
 */
export function createMemory(limitBytes = 16 * 1024 * 1024): Writer & { get(): Uint8Array } {
	let buffer = new Uint8Array(0);
	let closed = false;
	return {
		async write(input) {
			if (closed) throw new Error('Writer is closed.');
			const { position, data } = WriteSchema.parse(input);
			const end = position + data.byteLength;
			if (end > limitBytes) throw new RangeError('Memory output limit exceeded.');
			if (end > buffer.byteLength) {
				const next = new Uint8Array(end);
				next.set(buffer);
				buffer = next;
			}
			buffer.set(data, position);
		},
		async close() { closed = true; },
		async abort() { closed = true; buffer = new Uint8Array(0); },
		get() { return buffer.slice(); },
	};
}
