import type { EventBus } from '@okikio/observables';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Context, Snapshot } from '@utils/context';
import type { Encoded as EncodedFailure } from '@utils/failure';

/** Validated request, response, and expected-failure wire schemas. */
export interface Protocol<Request, Response> {
	readonly request: StandardSchemaV1<unknown, Request>;
	readonly response: StandardSchemaV1<unknown, Response>;
	readonly failure?: StandardSchemaV1<unknown, EncodedFailure>;
}

/** Input accepted by {@link protocol}. */
export interface ProtocolInput<Request, Response> extends Protocol<Request, Response> {}

/** Explicit request transfer and correlation options. */
export interface RequestOptions {
	readonly id?: string;
	readonly transfer?: readonly Transferable[];
}

/** Worker lifecycle event. */
export type Event =
	| Readonly<{ readonly type: 'opened'; readonly id: string }>
	| Readonly<{ readonly type: 'request'; readonly id: string }>
	| Readonly<{ readonly type: 'result'; readonly id: string }>
	| Readonly<{ readonly type: 'failure'; readonly id: string; readonly failureId: string }>
	| Readonly<{ readonly type: 'fault'; readonly id?: string; readonly reason: unknown }>
	| Readonly<{ readonly type: 'cancelled'; readonly id: string }>
	| Readonly<{ readonly type: 'stopping'; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'stopped'; readonly forced: boolean }>;

/** Minimum raw Worker surface used by the handle and test adapters. */
export interface RawWorker {
	postMessage(message: unknown, transfer?: readonly Transferable[]): void;
	terminate(): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
	addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
	removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
}

/** Inputs accepted while opening one Deno Worker. */
export interface OpenOptions<Request, Response> {
	readonly module: URL;
	readonly name?: string;
	readonly permissions?: 'inherit' | 'none' | Deno.PermissionOptions;
	readonly protocol: Protocol<Request, Response>;
	readonly shutdownTimeout?: Temporal.Duration | Temporal.DurationLike | string;
	readonly id?: string;
	readonly requestId?: () => string;
	readonly createRawWorker?: (module: URL, options: WorkerOptions & Readonly<{ readonly deno?: Readonly<{ readonly permissions: 'inherit' | 'none' | Deno.PermissionOptions }> }>) => RawWorker;
}

/** Owned Worker request endpoint. */
export interface WorkerHandle<Request, Response> extends AsyncDisposable {
	readonly id: string;
	readonly events: EventBus<Event>['events'];
	request(ctx: Context, request: Request, options?: RequestOptions): Promise<Response>;
	stop(reason?: unknown): Promise<void>;
}


/** Worker-global message surface used by the server and test adapters. */
export interface RawWorkerScope {
	postMessage(message: unknown, transfer?: readonly Transferable[]): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	addEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'messageerror', listener: (event: MessageEvent<unknown>) => void): void;
}

/** Explicit response wrapper for transferring ownership of response values. */
export interface Reply<Response> {
	readonly kind: 'worker-reply';
	readonly response: Response;
	readonly transfer: readonly Transferable[];
}

/** Worker-side request handler. */
export type RequestHandler<Request, Response> = (
	request: Request,
	ctx: Context,
) => Response | Reply<Response> | Promise<Response | Reply<Response>>;

/** Inputs accepted while serving one Worker protocol. */
export interface ServeOptions<Request, Response> {
	readonly protocol: Protocol<Request, Response>;
	readonly handle: RequestHandler<Request, Response>;
	readonly scope?: RawWorkerScope;
}

/** Owned Worker-side protocol server. */
export interface WorkerServer extends AsyncDisposable {
	readonly closed: Promise<void>;
	stop(reason?: unknown): Promise<void>;
}

/** Parent-to-Worker request envelope. */
export interface RequestEnvelope<Request> {
	readonly type: 'request';
	readonly id: string;
	readonly context: Snapshot;
	readonly request: Request;
}

/** Parent-to-Worker control envelope. */
export type ControlEnvelope =
	| Readonly<{ readonly type: 'cancel'; readonly id: string; readonly reason?: unknown }>
	| Readonly<{ readonly type: 'shutdown'; readonly reason?: unknown }>;

/** Worker-to-parent response envelope. */
export type ResponseEnvelope<Response> =
	| Readonly<{ readonly type: 'result'; readonly id: string; readonly response: Response }>
	| Readonly<{ readonly type: 'failure'; readonly id: string; readonly failure: EncodedFailure }>
	| Readonly<{ readonly type: 'fault'; readonly id?: string; readonly fault: unknown }>
	| Readonly<{ readonly type: 'stopped' }>;
