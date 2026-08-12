import type { EventBus } from '@okikio/observables';
import type { Context } from '@utils/context';

/** Process-tree ownership guarantee implemented by the selected adapter. */
export type TreeMode = 'direct-child' | 'posix-process-group' | 'windows-process-tree' | 'windows-job-object';

/** Explicit output ownership policy. */
export type OutputMode =
	| Readonly<{ readonly type: 'inherit' }>
	| Readonly<{ readonly type: 'discard' }>
	| Readonly<{ readonly type: 'capture'; readonly maximumBytes: number }>
	| Readonly<{ readonly type: 'stream' }>
	| Readonly<{ readonly type: 'sink'; readonly write: WritableStream<Uint8Array> }>;

/** Graceful then forced shutdown policy. */
export interface ShutdownPolicy {
	readonly signal?: Deno.Signal;
	readonly grace?: Temporal.Duration | Temporal.DurationLike | string;
	readonly force?: Temporal.Duration | Temporal.DurationLike | string;
}

/** Inputs accepted while starting an operating-system process. */
export interface StartOptions {
	readonly command: string;
	readonly arguments?: readonly string[];
	readonly cwd?: string | URL;
	readonly env?: Readonly<Record<string, string>>;
	readonly clearEnv?: boolean;
	readonly stdin?: 'inherit' | 'null' | 'piped';
	readonly stdout?: OutputMode;
	readonly stderr?: OutputMode;
	readonly tree?: TreeMode;
	readonly shutdown?: ShutdownPolicy;
}

/** Process lifecycle event. */
export type Event =
	| Readonly<{ readonly type: 'started'; readonly pid: number }>
	| Readonly<{ readonly type: 'signal'; readonly signal: Deno.Signal }>
	| Readonly<{ readonly type: 'stopping'; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'forced' }>
	| Readonly<{ readonly type: 'exited'; readonly code: number; readonly success: boolean; readonly signal?: string }>
	| Readonly<{ readonly type: 'output-limit'; readonly stream: 'stdout' | 'stderr'; readonly maximumBytes: number }>;

/** Terminal process status and optionally captured output. */
export interface Exit {
	readonly code: number;
	readonly success: boolean;
	readonly signal?: string;
	readonly stdout?: Uint8Array;
	readonly stderr?: Uint8Array;
}

/** Owned child process. */
export interface Process extends AsyncDisposable {
	readonly pid: number;
	readonly tree: TreeMode;
	readonly stdin?: WritableStream<Uint8Array>;
	readonly stdout?: ReadableStream<Uint8Array>;
	readonly stderr?: ReadableStream<Uint8Array>;
	readonly events: EventBus<Event>['events'];
	wait(): Promise<Exit>;
	signal(signal: Deno.Signal): void;
	stop(reason?: unknown): Promise<void>;
}

/** Options accepted by the finite exec helper. */
export interface ExecOptions extends StartOptions {
	readonly input?: Uint8Array | string;
}
