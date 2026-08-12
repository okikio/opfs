/**
 * Validated correlated request/response protocols for Deno Worker threads.
 *
 * The module owns request correlation, schema validation, cancellation, expected
 * failure encoding, transfer lists, protocol invalidation, and shutdown.
 *
 * @module
 */
import { EventBus } from '@okikio/observables';
import * as contextCore from '@utils/context';
import type { Context } from '@utils/context';
import * as failure from '@utils/failure';
import type { Encoded as EncodedFailure } from '@utils/failure';
import * as schema from '@utils/schema';

import type {
	Event,
	OpenOptions,
	RawWorkerScope,
	Reply,
	Protocol,
	ProtocolInput,
	RawWorker,
	RequestEnvelope,
	RequestOptions,
	ServeOptions,
	ResponseEnvelope,
	WorkerHandle,
	WorkerServer,
} from './types.ts';

/** Worker returned an expected encoded failure. */
export class WorkerFailureError extends Error {
	readonly failure: EncodedFailure;

	constructor(failure: EncodedFailure) {
		super(failure.message);
		this.name = 'WorkerFailureError';
		this.failure = failure;
	}
}

/** Worker returned or raised an unexpected fault. */
export class WorkerFaultError extends Error {
	readonly fault: unknown;

	constructor(fault: unknown) {
		super(fault instanceof Error ? fault.message : 'Worker faulted.', { cause: fault });
		this.name = 'WorkerFaultError';
		this.fault = fault;
	}
}

/** Worker wire protocol was violated. */
export class WorkerProtocolError extends Error {
	readonly messageValue: unknown;

	constructor(message: string, messageValue?: unknown) {
		super(message);
		this.name = 'WorkerProtocolError';
		this.messageValue = messageValue;
	}
}

/** Worker stopped before a pending request completed. */
export class WorkerStoppedError extends Error {
	readonly reason: unknown;

	constructor(reason?: unknown) {
		super('Worker stopped before the request completed.', reason === undefined ? undefined : { cause: reason });
		this.name = 'WorkerStoppedError';
		this.reason = reason;
	}
}

interface Pending<Response> {
	readonly resolve: (value: Response) => void;
	readonly reject: (reason: unknown) => void;
	readonly unlink: () => void;
}

/** Define one immutable validated Worker protocol. */
export function protocol<Request, Response>(input: ProtocolInput<Request, Response>): Protocol<Request, Response> {
	schema.assert(input.request, 'Worker request schema');
	schema.assert(input.response, 'Worker response schema');
	if (input.failure !== undefined) schema.assert(input.failure, 'Worker failure schema');
	return Object.freeze({ ...input });
}



/** Wrap a Worker response with an explicit transfer list. */
export function reply<Response>(response: Response, transfer: readonly Transferable[] = []): Reply<Response> {
	return Object.freeze({ kind: 'worker-reply', response, transfer: Object.freeze([...transfer]) });
}

/**
 * Serve one validated Worker protocol inside a Worker thread.
 *
 * ```text
 * parent message
 *      |
 *      +-- request -> validate -> child Context -> handler -> response/failure
 *      +-- cancel  -> cancel matching child Context
 *      `-- stop    -> cancel all -> join all -> stopped acknowledgement
 * ```
 *
 * Every active request owns a local child context. Server shutdown waits for
 * those requests before it detaches the Worker message listeners.
 */
export function serve<Request, Response>(options: ServeOptions<Request, Response>): WorkerServer {
	const scope = options.scope ?? getWorkerScope();
	const active = new Map<string, Readonly<{ readonly ctx: contextCore.Owned; readonly settled: Promise<void> }>>();
	let state: 'active' | 'stopping' | 'stopped' = 'active';
	let stopPromise: Promise<void> | undefined;
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => resolveClosed = resolve);

	const onMessage = (event: MessageEvent<unknown>): void => void receive(event.data);
	const onMessageError = (event: MessageEvent<unknown>): void => void protocolFault(
		new WorkerProtocolError('Parent message could not be deserialized.', event.data),
	);
	scope.addEventListener('message', onMessage);
	scope.addEventListener('messageerror', onMessageError);

	let server!: WorkerServer;
	server = Object.freeze({
		closed,
		/**
		 * Stops owned work through the module's cooperative and terminal shutdown rules.
		 *
		 * @internal
		 */
		stop(reason?: unknown) {
			stopPromise ??= stop(reason, false);
			return stopPromise;
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			await server.stop('Worker server was disposed.');
		},
	});
	return server;

	/**
	 * Receives and validates one protocol message before the Worker request protocol mutates request state.
	 *
	 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
	 *
	 * @internal
	 */
	async function receive(message: unknown): Promise<void> {
		if (state === 'stopped') return;
		if (!isRecord(message) || typeof message.type !== 'string') {
			await protocolFault(new WorkerProtocolError('Parent sent a non-envelope message.', message));
			return;
		}
		if (message.type === 'request') {
			if (state !== 'active') {
				post(Object.freeze({
					type: 'fault',
					...(typeof message.id === 'string' ? { id: message.id } : {}),
					fault: serializeFault(new WorkerStoppedError('Worker server is stopping.')),
				}));
				return;
			}
			await startRequest(message);
			return;
		}
		if (message.type === 'cancel') {
			if (typeof message.id !== 'string') {
				await protocolFault(new WorkerProtocolError('Cancel envelope is missing a request ID.', message));
				return;
			}
			const request = active.get(message.id);
			if (request !== undefined) contextCore.cancel(request.ctx, message.reason);
			return;
		}
		if (message.type === 'shutdown') {
			stopPromise ??= stop(message.reason, true);
			await stopPromise;
			return;
		}
		await protocolFault(new WorkerProtocolError(`Unsupported parent message type ${JSON.stringify(message.type)}.`, message));
	}

	/**
	 * Starts the request under the Worker request protocol.
	 *
	 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
	 *
	 * @internal
	 */
	async function startRequest(message: Record<string, unknown>): Promise<void> {
		if (typeof message.id !== 'string') {
			await protocolFault(new WorkerProtocolError('Request envelope is missing a request ID.', message));
			return;
		}
		const requestId = message.id;
		try { assertId(requestId, 'Worker request'); }
		catch (error) {
			await protocolFault(error instanceof Error ? error : new WorkerProtocolError('Worker request ID is invalid.', message));
			return;
		}
		if (active.has(requestId)) {
			await protocolFault(new WorkerProtocolError(`Request ID ${JSON.stringify(requestId)} is already active.`, message));
			return;
		}
		if (!isSnapshot(message.context)) {
			await protocolFault(new WorkerProtocolError('Request context snapshot is invalid.', message.context));
			return;
		}

		let request: Request;
		try {
			request = await schema.parse(options.protocol.request, message.request);
		} catch (error) {
			post(Object.freeze({ type: 'fault', id: requestId, fault: serializeFault(error) }));
			return;
		}

		let requestCtx: contextCore.Owned;
		try {
			requestCtx = contextCore.restore(message.context);
			contextCore.check(requestCtx);
		} catch (error) {
			post(Object.freeze({ type: 'fault', id: requestId, fault: serializeFault(error) }));
			return;
		}

		const settled = execute(requestId, request, requestCtx);
		active.set(requestId, Object.freeze({ ctx: requestCtx, settled }));
		await settled;
	}

	/**
	 * Executes work as one finite phase of the module runtime.
	 *
	 * It keeps Worker request correlation, validation, cooperative cancellation, and forced shutdown under one protocol owner.
	 *
	 * @internal
	 */
	async function execute(requestId: string, request: Request, requestCtx: contextCore.Owned): Promise<void> {
		try {
			const handled = await options.handle(request, requestCtx);
			if (requestCtx.signal.aborted) return;
			contextCore.check(requestCtx);
			const response = isReply(handled) ? handled.response : handled;
			const validated = await schema.parse(options.protocol.response, response);
			if (requestCtx.signal.aborted) return;
			post(
				Object.freeze({ type: 'result', id: requestId, response: validated }),
				isReply(handled) ? handled.transfer : undefined,
			);
		} catch (error) {
			if (requestCtx.signal.aborted) return;
			if (failure.isOccurrence(error)) {
				try {
					const encoded = await failure.encode(error);
					const validated = options.protocol.failure === undefined
						? encoded
						: await schema.parse(options.protocol.failure, encoded);
					post(Object.freeze({ type: 'failure', id: requestId, failure: validated }));
				} catch (encodingError) {
					post(Object.freeze({ type: 'fault', id: requestId, fault: serializeFault(encodingError) }));
				}
				return;
			}
			post(Object.freeze({ type: 'fault', id: requestId, fault: serializeFault(error) }));
		} finally {
			active.delete(requestId);
			await requestCtx[Symbol.asyncDispose]();
		}
	}

	/**
	 * Creates the protocol fault reported when a peer violates the Worker request protocol.
	 *
	 * @internal
	 */
	async function protocolFault(error: Error): Promise<void> {
		if (state === 'stopped') return;
		try { post(Object.freeze({ type: 'fault', fault: serializeFault(error) })); }
		catch { /* the parent is unreachable; local cleanup still runs */ }
		stopPromise ??= stop(error, false);
		await stopPromise;
	}

	/**
	 * Stops owned work through the module's cooperative and terminal shutdown rules.
	 *
	 * It keeps Worker request correlation, validation, cooperative cancellation, and forced shutdown under one protocol owner.
	 *
	 * @internal
	 */
	async function stop(reason: unknown, acknowledge: boolean): Promise<void> {
		if (state === 'stopped') return;
		state = 'stopping';
		for (const request of active.values()) contextCore.cancel(request.ctx, reason);
		await Promise.allSettled([...active.values()].map((request) => request.settled));
		state = 'stopped';
		scope.removeEventListener('message', onMessage);
		scope.removeEventListener('messageerror', onMessageError);
		if (acknowledge) {
			try { post(Object.freeze({ type: 'stopped' })); }
			catch { /* parent-side timeout owns forced termination */ }
		}
		resolveClosed?.();
		resolveClosed = undefined;
	}

	/**
	 * Posts one framed message through the Worker request protocol after transfer and lifecycle checks.
	 *
	 * @internal
	 */
	function post(message: unknown, transfer?: readonly Transferable[]): void {
		if (transfer === undefined || transfer.length === 0) scope.postMessage(message);
		else scope.postMessage(message, transfer);
	}
}

/**
 * Open one owned Deno Worker with correlated, validated, abort-aware requests.
 *
 * ```text
 * handle.request(input)
 *       |
 *       +-- validate + assign request id
 *       +-- post request -----------------------> Worker server
 *       |                                           |
 *       |<-------------- response / failure --------+
 *       |
 *       `-- caller abort -> cancel frame -> await terminal acknowledgement
 *
 * handle.stop() -> stop frame -> grace period -> terminate if required
 * ```
 *
 * The handle owns correlation state, abort listeners, protocol validation, and
 * final Worker termination.
 */
export function open<Request, Response>(ctx: Context, options: OpenOptions<Request, Response>): WorkerHandle<Request, Response> {
	contextCore.check(ctx);
	const id = options.id ?? crypto.randomUUID();
	assertId(id, 'Worker');
	const createRaw = options.createRawWorker ?? ((module, workerOptions) => new Worker(module, workerOptions) as RawWorker);
	const raw = createRaw(options.module, {
		type: 'module',
		...(options.name === undefined ? {} : { name: options.name }),
		deno: { permissions: options.permissions ?? 'inherit' },
	});
	const events = new EventBus<Event>();
	const pending = new Map<string, Pending<Response>>();
	const cancelledIds = new Map<string, ReturnType<typeof setTimeout>>();
	const createRequestId = options.requestId ?? (() => crypto.randomUUID());
	const shutdownTimeout = Temporal.Duration.from(options.shutdownTimeout ?? { seconds: 1 });
	let state: 'active' | 'stopping' | 'stopped' = 'active';
	let stopPromise: Promise<void> | undefined;
	let resolveStopped: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => resolveStopped = resolve);

	const onMessage = (event: MessageEvent<unknown>): void => void handleMessage(event.data);
	const onError = (event: ErrorEvent): void => invalidate(new WorkerFaultError(event.error ?? event.message));
	const onMessageError = (event: MessageEvent<unknown>): void => invalidate(new WorkerProtocolError('Worker message could not be deserialized.', event.data));
	raw.addEventListener('message', onMessage);
	raw.addEventListener('error', onError);
	raw.addEventListener('messageerror', onMessageError);
	events.emit(Object.freeze({ type: 'opened', id }));
	let handle!: WorkerHandle<Request, Response>;
	const parentAbort = () => void handle.stop(ctx.signal.reason).catch(() => {});

	handle = Object.freeze({
		id,
		events: events.events,
		/**
		 * Runs one correlated request through the Worker request protocol until response, cancellation, or shutdown.
		 *
		 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
		 *
		 * @internal
		 */
		async request(requestCtx: Context, request: Request, requestOptions: RequestOptions = {}) {
			contextCore.check(requestCtx);
			if (state !== 'active') throw new WorkerStoppedError();
			const requestId = requestOptions.id ?? createRequestId();
			assertId(requestId, 'Worker request');
			if (pending.has(requestId) || cancelledIds.has(requestId)) {
				throw new TypeError(`Worker request ID ${JSON.stringify(requestId)} is already active or recently cancelled.`);
			}
			const validated = await schema.parse(options.protocol.request, request);
			contextCore.check(requestCtx);
			const envelope: RequestEnvelope<Request> = Object.freeze({
				type: 'request',
				id: requestId,
				context: contextCore.snapshot(requestCtx),
				request: validated,
			});
			const response = new Promise<Response>((resolve, reject) => {
				const abort = () => {
					const current = pending.get(requestId);
					if (current === undefined) return;
					pending.delete(requestId);
					current.unlink();
					rememberCancelled(requestId);
					try { raw.postMessage(Object.freeze({ type: 'cancel', id: requestId, reason: requestCtx.signal.reason })); }
					catch (error) { invalidate(new WorkerFaultError(error)); }
					events.emit(Object.freeze({ type: 'cancelled', id: requestId }));
					reject(new contextCore.ContextCancelledError(requestCtx.signal.reason));
				};
				const unlink = () => requestCtx.signal.removeEventListener('abort', abort);
				pending.set(requestId, { resolve, reject, unlink });
				requestCtx.signal.addEventListener('abort', abort, { once: true });
				if (requestCtx.signal.aborted) abort();
			});
			if (!pending.has(requestId)) return await response;
			try {
				raw.postMessage(envelope, requestOptions.transfer);
				events.emit(Object.freeze({ type: 'request', id: requestId }));
			} catch (error) {
				settlePending(requestId, (entry) => entry.reject(error));
			}
			return await response;
		},
		/**
		 * Stops owned work through the module's cooperative and terminal shutdown rules.
		 *
		 * It keeps Worker request correlation, validation, cooperative cancellation, and forced shutdown under one protocol owner.
		 *
		 * @internal
		 */
		stop(reason?: unknown) {
			if (stopPromise !== undefined) return stopPromise;
			stopPromise = (async () => {
				if (state === 'stopped') return;
				state = 'stopping';
				events.emit(Object.freeze({ type: 'stopping', ...(reason === undefined ? {} : { reason }) }));
				try { raw.postMessage(Object.freeze({ type: 'shutdown', ...(reason === undefined ? {} : { reason }) })); }
				catch { /* forced termination below still owns cleanup */ }
				const cooperative = await settlesWithin(stopped, durationMilliseconds(shutdownTimeout));
				if (!cooperative) raw.terminate();
				finishStop(reason, !cooperative);
			})();
			return stopPromise;
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			await handle.stop('Worker handle was disposed.');
		},
	});
	ctx.signal.addEventListener('abort', parentAbort, { once: true });
	return handle;

	/**
	 * Handles the message as an authoritative transition in the Worker request protocol.
	 *
	 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
	 *
	 * @internal
	 */
	async function handleMessage(message: unknown): Promise<void> {
		if (!isRecord(message) || typeof message.type !== 'string') {
			invalidate(new WorkerProtocolError('Worker sent a non-envelope message.', message));
			return;
		}
		if (message.type === 'stopped') {
			if (state === 'active') {
				invalidate(new WorkerStoppedError('Worker stopped without a shutdown request.'));
				return;
			}
			resolveStopped?.();
			resolveStopped = undefined;
			return;
		}
		if (message.type === 'fault' && message.id === undefined) {
			invalidate(new WorkerFaultError(message.fault));
			return;
		}
		if (typeof message.id !== 'string') {
			invalidate(new WorkerProtocolError('Worker response is missing a request ID.', message));
			return;
		}
		const requestId = message.id;
		if (cancelledIds.has(requestId)) {
			forgetCancelled(requestId);
			return;
		}
		const entry = pending.get(requestId);
		if (entry === undefined) {
			invalidate(new WorkerProtocolError(`Worker responded with unknown request ID ${JSON.stringify(requestId)}.`, message));
			return;
		}
		try {
			if (message.type === 'result') {
				const value = await schema.parse(options.protocol.response, message.response);
				settlePending(requestId, (current) => current.resolve(value));
				events.emit(Object.freeze({ type: 'result', id: requestId }));
				return;
			}
			if (message.type === 'failure') {
				const failure = options.protocol.failure === undefined
					? assertEncodedFailure(message.failure)
					: await schema.parse(options.protocol.failure, message.failure);
				settlePending(requestId, (current) => current.reject(new WorkerFailureError(failure)));
				events.emit(Object.freeze({ type: 'failure', id: requestId, failureId: failure.id }));
				return;
			}
			if (message.type === 'fault') {
				settlePending(requestId, (current) => current.reject(new WorkerFaultError(message.fault)));
				events.emit(Object.freeze({ type: 'fault', id: requestId, reason: message.fault }));
				return;
			}
			invalidate(new WorkerProtocolError(`Unsupported Worker response type ${JSON.stringify(message.type)}.`, message));
		} catch (error) {
			invalidate(error instanceof Error ? error : new WorkerProtocolError('Worker response validation failed.', message));
		}
	}

	/**
	 * Sets tle pending on the internal builder or record used by the Worker request protocol.
	 *
	 * @internal
	 */
	function settlePending(requestId: string, settle: (entry: Pending<Response>) => void): void {
		const entry = pending.get(requestId);
		if (entry === undefined) return;
		pending.delete(requestId);
		entry.unlink();
		settle(entry);
	}

	/**
	 * Remembers cancelled long enough for the Worker request protocol to ignore late protocol messages safely.
	 *
	 * @internal
	 */
	function rememberCancelled(requestId: string): void {
		const timer = setTimeout(() => forgetCancelled(requestId), 60_000);
		cancelledIds.set(requestId, timer);
	}

	/**
	 * Forgets cancelled after the Worker request protocol no longer needs late-message protection.
	 *
	 * @internal
	 */
	function forgetCancelled(requestId: string): void {
		const timer = cancelledIds.get(requestId);
		if (timer !== undefined) clearTimeout(timer);
		cancelledIds.delete(requestId);
	}

	/**
	 * Marks the current owned value invalid so the Worker request protocol cannot return it to reusable state.
	 *
	 * @internal
	 */
	function invalidate(reason: unknown): void {
		if (state === 'stopped') return;
		events.emit(Object.freeze({ type: 'fault', reason }));
		state = 'stopping';
		finishStop(reason, true);
		stopPromise ??= Promise.resolve();
	}

	/**
	 * Finishes stop only after the Worker request protocol has settled owned work.
	 *
	 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
	 *
	 * @internal
	 */
	function finishStop(reason: unknown, forced: boolean): void {
		if (state === 'stopped') return;
		state = 'stopped';
		raw.terminate();
		ctx.signal.removeEventListener('abort', parentAbort);
		raw.removeEventListener('message', onMessage);
		raw.removeEventListener('error', onError);
		raw.removeEventListener('messageerror', onMessageError);
		for (const [requestId, entry] of pending) {
			pending.delete(requestId);
			entry.unlink();
			entry.reject(new WorkerStoppedError(reason));
		}
		for (const requestId of cancelledIds.keys()) forgetCancelled(requestId);
		events.emit(Object.freeze({ type: 'stopped', forced }));
		events[Symbol.dispose]();
		resolveStopped?.();
		resolveStopped = undefined;
	}
}


/**
 * Gets worker scope from the Worker request protocol after its ownership and validation rules have been established.
 *
 * @internal
 */
function getWorkerScope(): RawWorkerScope {
	const value = globalThis as Partial<RawWorkerScope>;
	if (typeof value.postMessage !== 'function' || typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
		throw new TypeError('The current runtime does not expose a Worker global message scope.');
	}
	return value as RawWorkerScope;
}

/**
 * Checks whether reply satisfies the condition required by the Worker request protocol.
 *
 * @internal
 */
function isReply<Response>(value: Response | Reply<Response>): value is Reply<Response> {
	return isRecord(value) && value.kind === 'worker-reply' && Array.isArray(value.transfer);
}

/**
 * Checks whether snapshot satisfies the condition required by the Worker request protocol.
 *
 * @internal
 */
function isSnapshot(value: unknown): value is contextCore.Snapshot {
	return isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.startedAt === 'string' &&
		(value.traceId === undefined || typeof value.traceId === 'string') &&
		(value.deploymentId === undefined || typeof value.deploymentId === 'string') &&
		(value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string') &&
		(value.deadline === undefined || typeof value.deadline === 'string');
}

/**
 * Serializes fault into the external representation required by the Worker request protocol.
 *
 * @internal
 */
function serializeFault(value: unknown): Readonly<Record<string, unknown>> {
	if (value instanceof Error) {
		return Object.freeze({
			name: value.name,
			message: value.message,
			...(value.stack === undefined ? {} : { stack: value.stack }),
			...(value.cause === undefined ? {} : { cause: safeFaultValue(value.cause) }),
		});
	}
	return Object.freeze({ name: 'Error', message: String(value), value: safeFaultValue(value) });
}

/**
 * Returns the safe fault value in the representation expected by the Worker request protocol.
 *
 * @internal
 */
function safeFaultValue(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Error) return serializeFault(value);
	if (Array.isArray(value)) return Object.freeze(value.slice(0, 32).map(safeFaultValue));
	if (isRecord(value)) {
		const entries = Object.entries(value).slice(0, 32).map(([key, entry]) => [key, safeFaultValue(entry)] as const);
		return Object.freeze(Object.fromEntries(entries));
	}
	return String(value);
}

/**
 * Rejects invalid encoded failure before it can enter authoritative module state.
 *
 * @internal
 */
function assertEncodedFailure(value: unknown): EncodedFailure {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.message !== 'string' || !('data' in value)) {
		throw new WorkerProtocolError('Worker failure envelope is invalid.', value);
	}
	return Object.freeze({ id: value.id, data: value.data, message: value.message });
}

/**
 * Rejects invalid id before it can enter authoritative module state.
 *
 * @internal
 */
function assertId(value: string, label: string): void {
	if (value.trim().length === 0) throw new TypeError(`${label} ID must not be empty.`);
	if (value.length > 512) throw new TypeError(`${label} ID must not exceed 512 characters.`);
}

/**
 * Checks whether record satisfies the condition required by the Worker request protocol.
 *
 * @internal
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Converts duration into the millisecond value used by the Worker request protocol.
 *
 * @internal
 */
function durationMilliseconds(value: Temporal.Duration | Temporal.DurationLike | string): number {
	return Math.max(0, Temporal.Duration.from(value).total({ unit: 'millisecond', relativeTo: Temporal.PlainDate.from('2000-01-01') }));
}

/**
 * Sets tles within on the internal builder or record used by the Worker request protocol.
 *
 * Worker internals own request correlation, schema validation, cooperative cancellation, protocol failure, and forced termination.
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

export type * from './types.ts';
