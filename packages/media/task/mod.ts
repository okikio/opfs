import { z } from 'zod';

/** Authoritative task status. */
export const TaskStatusSchema = z.enum(['created', 'preparing', 'running', 'paused', 'finalizing', 'completed', 'failed', 'canceled']);
/** Current task phase. */
export const TaskPhaseSchema = z.enum(['inspect', 'download', 'convert', 'write', 'finalize']);
/** Serializable task state. */
export const TaskStateSchema = z.object({ status: TaskStatusSchema, phase: TaskPhaseSchema.optional(), ratio: z.number().min(0).max(1).nullable().default(null) }).strict();
/** Task status type. */
export type TaskStatusType = z.output<typeof TaskStatusSchema>;
/** Task state type. */
export type TaskStateType = z.output<typeof TaskStateSchema>;

/** Long-running media operation. `done` remains the terminal authority. */
export interface Task<Result> {
	readonly done: Promise<Result>;
	getState(): TaskStateType;
	pause(): Promise<void>;
	resume(): Promise<void>;
	cancel(): Promise<void>;
}

/** Creates a minimal task around one abort-aware operation. */
export function create<Result>(operation: (signal: AbortSignal, set: (state: TaskStateType) => void) => Promise<Result>): Task<Result> {
	const controller = new AbortController();
	let state: TaskStateType = { status: 'created', ratio: null };
	let paused = false;
	const set = (next: TaskStateType) => { state = TaskStateSchema.parse(next); };
	const done = operation(controller.signal, set);
	return {
		done,
		getState: () => state,
		async pause() { paused = true; set({ ...state, status: 'paused' }); },
		async resume() { if (paused) { paused = false; set({ ...state, status: 'running' }); } },
		async cancel() { controller.abort(); set({ ...state, status: 'canceled' }); },
	};
}
