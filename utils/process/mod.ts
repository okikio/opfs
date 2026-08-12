/**
 * Direct child-process ownership with bounded I/O capture and cancellation.
 *
 * Concrete packages decide what a child process means. This module only owns
 * the generic subprocess lifecycle.
 *
 * @module
 */
import { EventBus } from '@okikio/observables';
import * as contextCore from '@utils/context';
import type { Context } from '@utils/context';

import type { Event, ExecOptions, Exit, OutputMode, Process, StartOptions, TreeMode } from './types.ts';

/** Requested process-tree ownership mode is not implemented by this adapter. */
export class UnsupportedTreeModeError extends Error {
	readonly tree: TreeMode;

	constructor(tree: TreeMode) {
		super(`Process tree mode ${JSON.stringify(tree)} is not implemented by the Deno direct-child adapter.`);
		this.name = 'UnsupportedTreeModeError';
		this.tree = tree;
	}
}

/** Captured child output exceeded its configured byte limit. */
export class OutputLimitError extends Error {
	readonly stream: 'stdout' | 'stderr';
	readonly maximumBytes: number;

	constructor(stream: 'stdout' | 'stderr', maximumBytes: number) {
		super(`Child ${stream} exceeded its ${maximumBytes}-byte capture limit.`);
		this.name = 'OutputLimitError';
		this.stream = stream;
		this.maximumBytes = maximumBytes;
	}
}

/** Child process did not stop within the graceful and forced shutdown periods. */
export class ProcessStopTimeoutError extends Error {
	readonly pid: number;

	constructor(pid: number) {
		super(`Child process ${pid} did not stop within its shutdown policy.`);
		this.name = 'ProcessStopTimeoutError';
		this.pid = pid;
	}
}

/**
 * Start one directly owned child process.
 *
 * ```text
 * parent Context
 *      |
 *      v
 * Deno.Command.spawn()
 *      |
 *      +-- stdout/stderr pumps ----> captured or streamed output
 *      |
 *      +-- ctx cancellation -------> graceful stop
 *      |
 *      `-- dispose ----------------> stop -> wait -> force if required
 * ```
 *
 * The returned handle owns the direct child and its output pumps. Disposal does
 * not return until those owned resources have settled.
 */
export async function start(ctx: Context, options: StartOptions): Promise<Process> {
	contextCore.check(ctx);
	if (options.command.trim().length === 0) throw new TypeError('Process command must not be empty.');
	const tree = options.tree ?? 'direct-child';
	if (tree !== 'direct-child') throw new UnsupportedTreeModeError(tree);
	const stdinMode = options.stdin ?? 'null';
	const stdoutMode = options.stdout ?? { type: 'inherit' };
	const stderrMode = options.stderr ?? { type: 'inherit' };
	validateOutputMode(stdoutMode, 'stdout');
	validateOutputMode(stderrMode, 'stderr');
	const child = new Deno.Command(options.command, {
		args: [...(options.arguments ?? [])],
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.env === undefined ? {} : { env: { ...options.env } }),
		clearEnv: options.clearEnv ?? false,
		stdin: stdinMode,
		stdout: denoOutputMode(stdoutMode),
		stderr: denoOutputMode(stderrMode),
	}).spawn();
	const events = new EventBus<Event>();
	events.emit(Object.freeze({ type: 'started', pid: child.pid }));
	const captured: { stdout?: Uint8Array; stderr?: Uint8Array } = {};
	const outputPumps: Promise<void>[] = [];
	let streamStdout: ReadableStream<Uint8Array> | undefined;
	let streamStderr: ReadableStream<Uint8Array> | undefined;
	let outputFailure: unknown;
	let hasOutputFailure = false;

	if (stdoutMode.type === 'stream') streamStdout = child.stdout;
	else if (stdoutMode.type === 'capture' || stdoutMode.type === 'sink') {
		outputPumps.push(ownOutput(child.stdout, stdoutMode, 'stdout').then((value) => { if (value !== undefined) captured.stdout = value; }).catch((error) => { outputFailure = error; hasOutputFailure = true; }));
	}
	if (stderrMode.type === 'stream') streamStderr = child.stderr;
	else if (stderrMode.type === 'capture' || stderrMode.type === 'sink') {
		outputPumps.push(ownOutput(child.stderr, stderrMode, 'stderr').then((value) => { if (value !== undefined) captured.stderr = value; }).catch((error) => { outputFailure = error; hasOutputFailure = true; }));
	}

	let stopPromise: Promise<void> | undefined;
	let exitPromise: Promise<Exit> | undefined;
	let terminal = false;
	let disposed = false;
	let process!: Process;
	const abort = () => void process.stop(ctx.signal.reason).catch(() => {});

	process = Object.freeze({
		pid: child.pid,
		tree,
		...(stdinMode === 'piped' ? { stdin: child.stdin } : {}),
		...(streamStdout === undefined ? {} : { stdout: streamStdout }),
		...(streamStderr === undefined ? {} : { stderr: streamStderr }),
		events: events.events,
		/**
		 * Waits for state without transferring ownership to the waiter.
		 *
		 * It owns one child-process lifecycle so cooperative stop, output handling, and forced escalation cannot diverge across callers.
		 *
		 * @internal
		 */
		wait() {
			if (exitPromise !== undefined) return exitPromise;
			exitPromise = (async () => {
				const status = await child.status;
				terminal = true;
				ctx.signal.removeEventListener('abort', abort);
				await Promise.all(outputPumps);
				if (hasOutputFailure) throw outputFailure;
				const exit: Exit = Object.freeze({
					code: status.code,
					success: status.success,
					...(status.signal === null ? {} : { signal: status.signal }),
					...(captured.stdout === undefined ? {} : { stdout: captured.stdout }),
					...(captured.stderr === undefined ? {} : { stderr: captured.stderr }),
				});
				events.emit(Object.freeze({
					type: 'exited',
					code: status.code,
					success: status.success,
					...(status.signal === null ? {} : { signal: status.signal }),
				}));
				return exit;
			})();
			return exitPromise;
		},
		/**
		 * Converts the process stop request into the platform signal used for cooperative child-process shutdown.
		 *
		 * @internal
		 */
		signal(signal: Deno.Signal) {
			if (terminal) return;
			try { child.kill(signal); }
			catch (error) {
				if (isProcessGone(error)) return;
				throw error;
			}
			events.emit(Object.freeze({ type: 'signal', signal }));
		},
		/**
		 * Stops owned work through the module's cooperative and terminal shutdown rules.
		 *
		 * It owns one child-process lifecycle so cooperative stop, output handling, and forced escalation cannot diverge across callers.
		 *
		 * @internal
		 */
		stop(reason?: unknown) {
			if (stopPromise !== undefined) return stopPromise;
			stopPromise = (async () => {
				if (terminal) {
					await process.wait();
					return;
				}
				events.emit(Object.freeze({ type: 'stopping', ...(reason === undefined ? {} : { reason }) }));
				const shutdown = options.shutdown ?? {};
				const gracefulSignal = shutdown.signal ?? 'SIGTERM';
				const graceMilliseconds = durationMilliseconds(shutdown.grace ?? { seconds: 10 });
				const forceMilliseconds = durationMilliseconds(shutdown.force ?? { seconds: 5 });
				try { process.signal(gracefulSignal); }
				catch (error) { if (!terminal) throw error; }
				if (await settlesWithin(process.wait(), graceMilliseconds)) return;
				events.emit(Object.freeze({ type: 'forced' }));
				try { process.signal('SIGKILL'); }
				catch (error) { if (!terminal) throw error; }
				if (!await settlesWithin(process.wait(), forceMilliseconds)) throw new ProcessStopTimeoutError(child.pid);
			})();
			return stopPromise;
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			try { await process.stop('Process handle was disposed.'); }
			finally {
				ctx.signal.removeEventListener('abort', abort);
				events[Symbol.dispose]();
			}
		},
	});
	ctx.signal.addEventListener('abort', abort, { once: true });
	if (ctx.signal.aborted) abort();
	return process;

	/**
	 * Wraps child-process output so the process owner controls reader lifetime and cancellation.
	 *
	 * Process internals keep spawn, output, cooperative stop, forced escalation, and disposal semantics consistent for every caller.
	 *
	 * @internal
	 */
	async function ownOutput(
		stream: ReadableStream<Uint8Array>,
		mode: Extract<OutputMode, Readonly<{ readonly type: 'capture' | 'sink' }>>,
		name: 'stdout' | 'stderr',
	): Promise<Uint8Array | undefined> {
		if (mode.type === 'sink') {
			await stream.pipeTo(mode.write, { preventClose: true });
			return undefined;
		}
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				total += next.value.byteLength;
				if (total > mode.maximumBytes) {
					events.emit(Object.freeze({ type: 'output-limit', stream: name, maximumBytes: mode.maximumBytes }));
					void process.stop(new OutputLimitError(name, mode.maximumBytes)).catch(() => {});
					throw new OutputLimitError(name, mode.maximumBytes);
				}
				chunks.push(next.value);
			}
			return concat(chunks, total);
		} finally {
			reader.releaseLock();
		}
	}
}

/** Run one finite process and return its terminal status and captured output. */
export async function exec(ctx: Context, options: ExecOptions): Promise<Exit> {
	await using child = await start(ctx, options);
	if (options.input !== undefined) {
		if (child.stdin === undefined) throw new TypeError('Process input requires stdin: "piped".');
		const writer = child.stdin.getWriter();
		try {
			const bytes = typeof options.input === 'string' ? new TextEncoder().encode(options.input) : options.input;
			await writer.write(bytes);
			await writer.close();
		} finally {
			writer.releaseLock();
		}
	}
	return await child.wait();
}

/**
 * Checks whether process gone satisfies the condition required by the child-process owner.
 *
 * @internal
 */
function isProcessGone(value: unknown): boolean {
	return value instanceof Deno.errors.NotFound;
}

/**
 * Maps the process output policy to the Deno command stdio mode used at spawn time.
 *
 * @internal
 */
function denoOutputMode(mode: OutputMode): 'inherit' | 'null' | 'piped' {
	if (mode.type === 'inherit') return 'inherit';
	if (mode.type === 'discard') return 'null';
	return 'piped';
}

/**
 * Checks output mode and preserves the deterministic issues needed by callers.
 *
 * @internal
 */
function validateOutputMode(mode: OutputMode, name: string): void {
	if (mode.type === 'capture' && (!Number.isSafeInteger(mode.maximumBytes) || mode.maximumBytes < 1)) {
		throw new TypeError(`${name} capture maximumBytes must be a positive safe integer.`);
	}
}

/**
 * Converts duration into the millisecond value used by the child-process owner.
 *
 * @internal
 */
function durationMilliseconds(value: Temporal.Duration | Temporal.DurationLike | string): number {
	const duration = Temporal.Duration.from(value);
	return Math.max(0, duration.total({ unit: 'millisecond', relativeTo: Temporal.PlainDate.from('2000-01-01') }));
}

/**
 * Sets tles within on the internal builder or record used by the child-process owner.
 *
 * Process internals keep spawn, output, cooperative stop, forced escalation, and disposal semantics consistent for every caller.
 *
 * @internal
 */
async function settlesWithin(value: Promise<unknown>, milliseconds: number): Promise<boolean> {
	if (milliseconds <= 0) return false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			value.then(() => true, () => true),
			new Promise<boolean>((resolve) => timer = setTimeout(() => resolve(false), milliseconds)),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Concatenates captured process-output chunks into the final bounded byte buffer returned to the caller.
 *
 * @internal
 */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

export type * from './types.ts';
