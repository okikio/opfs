import type { Writer, WriteType } from '@media/output';

/** Browser file handle shape required by this package. */
export interface FileHandle {
	createWritable(): Promise<FileSystemWritableFileStream>;
}

/** Creates a positional writer for a user-selected browser file. */
export async function create(handle: FileHandle): Promise<Writer> {
	const stream = await handle.createWritable();
	return {
		async write(input: WriteType) { await stream.write({ type: 'write', position: input.position, data: input.data }); },
		async close() { await stream.close(); },
		async abort(reason?: unknown) { await stream.abort(reason); },
	};
}

/** Returns whether the browser exposes the save-file picker API. */
export function supports(): boolean {
	return typeof globalThis === 'object' && 'showSaveFilePicker' in globalThis;
}
