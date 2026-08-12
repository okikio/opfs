import { getLogger } from '@logtape/logtape';
import { z } from 'zod';
import type { Writer } from '@media/output';

const logger = getLogger(['media', 'download']);

/** Direct HTTP download request. */
export const DownloadSchema = z.object({ url: z.url(), headers: z.record(z.string(), z.string()).default({}) }).strict();
/** Direct HTTP download type. */
export type DownloadType = z.output<typeof DownloadSchema>;

/**
 * Streams one HTTP response directly into a positional writer.
 *
 * Impact: The function does not collect the complete file in memory. HTTP range
 * admission and restart-safe resume are separate capabilities and are not hidden
 * inside this basic path.
 */
export async function download(input: DownloadType, writer: Writer, signal?: AbortSignal): Promise<number> {
	const request = DownloadSchema.parse(input);
	const response = await fetch(request.url, { headers: request.headers, signal });
	if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}.`);
	logger.debug('Downloading {url} with HTTP {status}.', { url: request.url, status: response.status });
	const reader = response.body.getReader();
	let position = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await writer.write({ position, data: value });
			position += value.byteLength;
		}
		await writer.close();
		return position;
	} catch (error) {
		await writer.abort(error);
		throw error;
	} finally {
		reader.releaseLock();
	}
}
