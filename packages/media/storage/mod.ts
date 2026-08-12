import { z } from 'zod';

/** Application-owned OPFS path. */
export const PathSchema = z.string().min(1).refine((value) => !value.includes('..'), 'Parent traversal is not permitted.');
/** Validated application-owned path. */
export type PathType = z.output<typeof PathSchema>;

/** Returns whether Origin Private File System access is available. */
export function supports(): boolean {
	return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/** Returns the root OPFS directory. */
export async function getRoot(): Promise<FileSystemDirectoryHandle> {
	if (!supports()) throw new Error('Origin Private File System is not available.');
	return await navigator.storage.getDirectory();
}
