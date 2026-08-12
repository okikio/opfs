import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as catalog from '@utils/catalog';
import { Hono, type Context as HonoContext } from 'hono';

import * as endpoint from '@utils/server/endpoint';
import * as context from '@utils/context';
import type { Context } from '@utils/context';
import type {
	MiddlewareContextDefinition,
	MiddlewareContextValue,
	MiddlewareDefinition,
	MiddlewareHandler,
	MiddlewarePlan,
	MiddlewareResourceResolver,
} from '@utils/server/middleware';
import * as query from '@utils/query';
import * as resilience from '@utils/resilience';
import * as problem from '@utils/http/problem';
import * as response from '@utils/http/response';
import type { Collection as ResourceCollection, Definition as ResourceDefinition } from '@utils/resource';
import * as resource from '@utils/resource';
import * as requestWire from '@utils/http/request';

import { ServerProblems } from '../problems.ts';
import type {
	CompiledService,
	CreateServiceOptions,
	EffectiveServiceOperation,
	ServiceConcernRuntimes,
	ServiceContextStore,
	ServiceRequestState,
	ServiceRequestStatePatch,
	ServiceRuntime,
	ServiceStageResult,
	ServiceConcernValues,
} from './types.ts';

/** Framework-owned problems that a service runtime may produce independently of endpoint declarations. */
const FrameworkProblemDefinitions: readonly problem.ProblemDefinition[] = Object.freeze(Object.values(ServerProblems));

/** Error raised when a compiled service is missing a required concern runtime. */
export class ServiceRuntimeConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ServiceRuntimeConfigurationError';
	}
}

/** Create a live Hono runtime from one fully compiled service. */
export function create<Host extends object, Concerns extends ServiceConcernValues = ServiceConcernValues>(
	compiled: CompiledService<import('./types.ts').ServiceDefinition, Host>,
	options: CreateServiceOptions<Host, Concerns>,
): ServiceRuntime {
	validateConcernRuntimes(compiled, options.concerns);
	const serviceContext = context.create({ id: `service:${compiled.definition.id}` });
	let resources: ResourceCollection;
	try {
		resources = resource.create(compiled.implementation.resources, {
			...(options.environment !== undefined ? { environment: options.environment } : {}),
			host: options.host,
			ctx: serviceContext,
		});
	} catch (error) {
		serviceContext[Symbol.dispose]();
		throw error;
	}
	const app = new Hono();
	const middlewareByDefinition = new Map(
		compiled.implementation.middleware.map((handler) => [handler.definition, handler] as const),
	);

	for (const operation of compiled.operations) {
		app.on(operation.method.toUpperCase(), operation.path, async (hono) => {
			return await executeOperation(
				operation,
				hono,
				resources,
				serviceContext,
				middlewareByDefinition,
				options,
			);
		});
	}

	let disposed = false;
	return Object.freeze({
		resources,
		fetch: (request: Request) => {
			if (disposed) return new Response('Service runtime is disposed.', { status: 503 });
			return app.fetch(request);
		},
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			try {
				await resources[Symbol.asyncDispose]();
			} finally {
				await serviceContext[Symbol.asyncDispose]();
			}
		},
	});
}

/**
 * Execute one compiled service operation as a finite request.
 *
 * ```text
 * Request
 *   -> correlation + Context
 *   -> request middleware
 *   -> parse and validate input
 *   -> authentication and service concerns
 *   -> endpoint handler
 *   -> validate declared result
 *   -> response middleware
 *   -> Response
 *
 * any declared failure -> mapped HTTP problem
 * any unexpected fault -> runtime fault handling
 * ```
 *
 * The function uses only definitions and implementations selected by the
 * compiled service. Request-local state stays inside the request context.
 *
 * @internal
 */
async function executeOperation<Host extends object, Concerns extends ServiceConcernValues>(
	operation: EffectiveServiceOperation,
	hono: HonoContext,
	resources: ResourceCollection,
	serviceContext: Context,
	middlewareByDefinition: ReadonlyMap<MiddlewareDefinition, MiddlewareHandler>,
	options: CreateServiceOptions<Host, Concerns>,
): Promise<Response> {
	const request = hono.req.raw;
	const timeout = operation.resiliency.find((policy) => policy.type === 'timeout');
	const correlation = await requestWire.correlation(request, options.requestId === undefined ? {} : { requestId: options.requestId });
	const requestId = correlation.requestId;
	const traceId = options.traceId?.(request) ?? correlation.traceId;
	hono.header('X-Request-ID', requestId);
	const clock = serviceContext.clock;
	const requestContext = context.child(serviceContext, {
		id: requestId,
		...(traceId !== undefined ? { traceId } : {}),
		signal: request.signal,
		...(timeout?.type === 'timeout' ? { deadline: clock.now().add(timeout.duration) } : {}),
	});
	const values = createContextStore();
	let activeRequest = request;
	let mutableState: MutableServiceRequestState<Host, Concerns> = {
		request: activeRequest,
		host: options.host,
		ctx: requestContext,
		input: Object.freeze({}),
		resources,
		values,
		operation,
	};
	const finish = (httpResponse: Response): Response => response.onComplete(httpResponse, async (completion) => {
		requestContext[Symbol.dispose]();
		try { await requestWire.disposeMemo(activeRequest); } catch { /* cleanup remains best effort */ }
		if (activeRequest !== request) {
			try { await requestWire.disposeMemo(request); } catch { /* cleanup remains best effort */ }
		}
		try {
			await options.onResponseComplete?.(Object.freeze({
				requestId,
				operationId: operation.operation.id,
				method: operation.method,
				path: operation.path,
				status: httpResponse.status,
				completion,
			}));
		} catch {
			// Completion observers cannot change a response already in flight.
		}
	});

	try {
		const bodyLimit = operation.resiliency.find((policy) => policy.type === 'body-limit');
		if (bodyLimit?.type === 'body-limit' && request.body !== null) {
			const bounded = await boundedRequest(request, bodyLimit.bytes);
			if (bounded === bodyTooLarge) {
				return finish(await toResponse(hono, problem.create(ServerProblems.BodyTooLarge, {
					detail: `The request body exceeds ${bodyLimit.bytes} bytes.`,
					instance: new URL(request.url).pathname,
				}), activeRequest));
			}
			activeRequest = bounded;
			mutableState = { ...mutableState, request: activeRequest };
		}

		const pipeline = runMiddleware(
			operation.middleware.wholeRequest,
			mutableState,
			middlewareByDefinition,
			async () => await runMiddleware(
				operation.middleware.beforeValidation,
				mutableState,
				middlewareByDefinition,
				async () => await runAuthenticationAndValidation(),
			),
		);
		const result = await raceWithSignal(pipeline, requestContext.signal);
		return finish(await finalizeResult(operation, result, activeRequest, hono));
	} catch (error) {
		await reportError(options, error, freezeState(mutableState));
		if (error instanceof context.ContextDeadlineExceededError) {
			return finish(await toResponse(hono, problem.create(ServerProblems.DeadlineExceeded, {
				instance: new URL(request.url).pathname,
				cause: error,
			}), activeRequest));
		}
		return finish(await toResponse(hono, problem.create(ServerProblems.Internal, {
			instance: new URL(request.url).pathname,
			cause: error,
		}), activeRequest));
	}

	/**
	 * Runs authentication and validation while preserving the module's cancellation and completion contract.
	 *
	 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
	 *
	 * @internal
	 */
	async function runAuthenticationAndValidation(): Promise<ServiceStageResult> {
		const authentication = await runConcern(
			options.concerns?.authenticate,
			operation.authentication,
			mutableState,
		);
		if (authentication.result !== undefined) return authentication.result;
		mutableState = applyPatch(mutableState, authentication.patch);

		const parsed = await parseInputs(operation, activeRequest, options.requestParsing);
		if (!parsed.success) {
			const unsupported = parsed.issues.some((issue) => issue.code === 'unsupported-content-type');
			return problem.create(unsupported ? ServerProblems.UnsupportedMediaType : ServerProblems.InvalidRequest, {
				detail: unsupported
					? 'The request Content-Type is not supported by this operation.'
					: 'One or more request values are invalid.',
				instance: new URL(request.url).pathname,
				extensions: { issues: parsed.issues },
			});
		}
		mutableState = { ...mutableState, input: parsed.input };

		return await runMiddleware(
			operation.middleware.afterValidation,
			mutableState,
			middlewareByDefinition,
			async () => {
				const enterOperation = async (): Promise<ServiceStageResult> => {
					for (const [runtime, definitions] of [
						[options.concerns?.authorize, operation.permissions],
						[options.concerns?.entitlements, operation.entitlements],
						[options.concerns?.billing, operation.billing],
					] as const) {
						const outcome = await runConcern(runtime, definitions, mutableState);
						if (outcome.result !== undefined) return outcome.result;
						mutableState = applyPatch(mutableState, outcome.patch);
					}

					const runAttempt = async (): Promise<ServiceStageResult> => await runMiddleware(
						operation.middleware.aroundOperation,
						mutableState,
						middlewareByDefinition,
						async () => await operation.handler.handle({
							request: activeRequest,
							host: options.host,
							input: mutableState.input,
							resources: createResourceResolver(resources, new Set(operation.resources)),
							ctx: requestContext,
							...(mutableState.authentication !== undefined ? { authentication: mutableState.authentication } : {}),
							...(mutableState.actor !== undefined ? { actor: mutableState.actor } : {}),
							...(mutableState.organization !== undefined ? { organization: mutableState.organization } : {}),
							...(mutableState.authorization !== undefined ? { authorization: mutableState.authorization } : {}),
							...(mutableState.entitlementState !== undefined ? { entitlements: mutableState.entitlementState } : {}),
							...(mutableState.billingState !== undefined ? { billing: mutableState.billingState } : {}),
						}),
					);
					return await executeResilienceStage(operation, 'operation', mutableState, options, runAttempt);
				};

				return await executeResilienceStage(operation, 'admission', mutableState, options, enterOperation);
			},
		);

	}
}

/**
 * Executes resilience stage as one finite phase of the module runtime.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
async function executeResilienceStage<Host extends object, Concerns extends ServiceConcernValues>(
	operation: EffectiveServiceOperation,
	stage: import('@utils/resilience').ResilienceStage,
	state: MutableServiceRequestState<Host, Concerns>,
	options: CreateServiceOptions<Host, Concerns>,
	next: () => Promise<ServiceStageResult>,
): Promise<ServiceStageResult> {
	const policies = Object.freeze(operation.resiliency.filter((policy) =>
		policy.type !== 'timeout' && policy.type !== 'body-limit' && resilience.stage(policy) === stage
	));
	if (policies.length === 0) return await next();
	return await options.concerns!.resilience!.execute(policies, freezeState(state), next);
}



/**
 * Races request work with cancellation without detaching the losing operation from service-owned cleanup.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function raceWithSignal<Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> {
	if (signal.aborted) throw cancellationReason(signal);
	return await new Promise<Result>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(cancellationReason(signal)));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

/**
 * Checks whether cellation reason is currently allowed by the compiled service runtime.
 *
 * @internal
 */
function cancellationReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new context.ContextCancelledError(reason);
}

/**
 * Reports an unexpected service runtime error through the host error hook without changing the response contract.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function reportError<Host extends object, Concerns extends ServiceConcernValues>(
	options: CreateServiceOptions<Host, Concerns>,
	error: unknown,
	state: ServiceRequestState<Host, Concerns>,
): Promise<void> {
	if (options.onError === undefined) return;
	try {
		await options.onError(normalizeError(error), state);
	} catch {
		// Error reporting is observational and must not replace the original
		// request failure or change its declared HTTP problem mapping.
	}
}

/**
 * Runs middleware while preserving the module's cancellation and completion contract.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
async function runMiddleware<Host extends object, Concerns extends ServiceConcernValues>(
	definitions: readonly MiddlewareDefinition[],
	state: MutableServiceRequestState<Host, Concerns>,
	handlers: ReadonlyMap<MiddlewareDefinition, MiddlewareHandler>,
	final: () => Promise<ServiceStageResult>,
): Promise<ServiceStageResult> {
	let index = -1;
	const dispatch = async (position: number): Promise<ServiceStageResult> => {
		if (position <= index) throw new TypeError('Middleware called next() more than once.');
		index = position;
		const definition = definitions[position];
		if (!definition) return await final();
		const handler = handlers.get(definition);
		if (!handler) throw new ServiceRuntimeConfigurationError(`Middleware ${definition.id} has no runtime handler.`);
		return await handler.handle({
			request: state.request,
			host: state.host,
			values: state.values,
			resources: createResourceResolver(state.resources, new Set(resourceClosure(definition.resources))),
			ctx: state.ctx,
		}, async () => await dispatch(position + 1)) as ServiceStageResult;
	};
	return await dispatch(0);
}

/**
 * Runs concern while preserving the module's cancellation and completion contract.
 *
 * @internal
 */
async function runConcern<Host extends object, Concerns extends ServiceConcernValues, Definition>(
	runtime: ((definitions: readonly Definition[], state: ServiceRequestState<Host, Concerns>) => Promise<ServiceRequestStatePatch<Concerns> | problem.ProblemResult | void>) | undefined,
	definitions: readonly Definition[],
	state: MutableServiceRequestState<Host, Concerns>,
): Promise<Readonly<{ readonly patch?: ServiceRequestStatePatch<Concerns>; readonly result?: problem.ProblemResult }>> {
	if (definitions.length === 0) return Object.freeze({});
	if (!runtime) throw new ServiceRuntimeConfigurationError('A required service concern runtime was not supplied.');
	const result = await runtime(definitions, freezeState(state));
	if (problem.is(result)) return Object.freeze({ result });
	return result === undefined ? Object.freeze({}) : Object.freeze({ patch: result });
}

/**
 * Parses inputs into the validated internal model used by later phases.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
async function parseInputs(
	operation: EffectiveServiceOperation,
	request: Request,
	parsing: requestWire.RequestParsingOptions | undefined,
): Promise<
	| Readonly<{ readonly success: true; readonly input: Readonly<Record<string, unknown>> }>
	| Readonly<{ readonly success: false; readonly issues: readonly requestWire.RequestValidationDetail[] }>
> {
	const input: Record<string, unknown> = Object.create(null);
	const issues: requestWire.RequestValidationDetail[] = [];
	const bodyLimit = operation.resiliency.find((policy) => policy.type === 'body-limit');
	const maximumBodyBytes = bodyLimit?.type === 'body-limit' ? bodyLimit.bytes : parsing?.maximumBodyBytes;
	for (const source of ['param', 'query', 'header', 'cookie', 'json', 'form', 'raw'] as const) {
		const slot = operation.operation.inputs[source] ?? operation.endpoint.inputs[source];
		if (!slot) continue;
		let raw: unknown;
		try {
			raw = await rawInput(source, request, operation.path, { ...(parsing ?? {}), ...(maximumBodyBytes === undefined ? {} : { maximumBodyBytes }) });
		} catch (error) {
			const sourceIssues = error instanceof requestWire.RequestTransportError
				? requestWire.validationDetails(source, error.issues)
				: [requestWire.validationDetail(source, {
					message: error instanceof Error ? error.message : String(error),
				})];
			issues.push(...sourceIssues);
			continue;
		}
		const result = await endpoint.match(endpoint.schemaOf(slot), raw);
		if (!result.success) {
			issues.push(...requestWire.validationDetails(source, result.issues));
			continue;
		}
		input[source] = result.value;
	}
	return issues.length === 0
		? Object.freeze({ success: true, input: Object.freeze(input) })
		: Object.freeze({ success: false, issues: Object.freeze(issues) });
}

/**
 * Reads a request body as bounded raw bytes for endpoint operations that explicitly declare raw input.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function rawInput(
	source: 'param' | 'query' | 'header' | 'cookie' | 'json' | 'form' | 'raw',
	request: Request,
	routePath: string,
	options: requestWire.RequestParsingOptions,
): Promise<unknown> {
	const url = new URL(request.url);
	switch (source) {
		case 'param': return requestWire.parseParameters(routePath, url.pathname, options);
		case 'query': return requestWire.parseQuery(url.searchParams, options);
		case 'header': return requestWire.parseHeaders(request.headers, options);
		case 'cookie': return requestWire.parseCookies(request.headers.get('cookie'), options);
		case 'json': return await requestWire.parseJson(request.clone(), options);
		case 'form': return await requestWire.parseForm(request.clone(), options);
		case 'raw': return request;
	}
}

/**
 * Builds or retrieves the finalize result returned by the compiled service runtime.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function finalizeResult(
	operation: EffectiveServiceOperation,
	result: ServiceStageResult,
	request: Request,
	hono: HonoContext,
): Promise<Response> {
	if (result instanceof Response) {
		if (operation.operation.rawResponse) return result;
		return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
			instance: new URL(request.url).pathname,
			cause: new TypeError('Raw Response values require rawResponse: true on the operation.'),
		}), request);
	}
	if (response.is(result)) {
		const definition = response.definitionOf(result);
		if (!operation.responses.includes(definition)) return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
			instance: new URL(request.url).pathname,
			cause: new TypeError(`Undeclared response ${definition.id}.`),
		}), request);
		const validationIssues = await validateResponseBody(definition, result[0]);
		if (validationIssues.length > 0) return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
			instance: new URL(request.url).pathname,
			cause: new TypeError(`Response ${definition.id} does not satisfy its schema: ${validationIssues.map((issue) => issue.message).join('; ')}`),
		}), request);
		const notModified = operation.responses.find((candidate) => candidate.status === 304 && candidate.mode === 'empty');
		if (notModified !== undefined && response.isNotModified(request, result[2])) {
			return await toResponse(hono, response.create(notModified, undefined, {
				headers: response.conditionalHeaders(result[2]),
			}), request, operation);
		}
		return await toResponse(hono, result, request, operation);
	}
	if (problem.is(result)) {
		const definition = problem.definitionOf(result);
		if (!operation.problems.includes(definition) && !FrameworkProblemDefinitions.includes(definition)) {
			return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
				instance: new URL(request.url).pathname,
				cause: new TypeError(`Undeclared problem ${definition.id}.`),
			}), request);
		}
		return await toResponse(hono, result, request);
	}
	return await toResponse(hono, problem.create(ServerProblems.UndeclaredResult, {
		instance: new URL(request.url).pathname,
		cause: new TypeError('Endpoint handler returned neither a declared tuple nor a Response.'),
	}), request);
}

/**
 * Converts the source value to response expected by the compiled service runtime.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function toResponse(
	hono: HonoContext,
	result: response.ResponseResult | problem.ProblemResult,
	request: Request,
	operation?: EffectiveServiceOperation,
	negotiate = true,
): Promise<Response> {
	const resolved = response.is(result)
		? response.finalize(result, {
			url: request.url,
			...(operation === undefined ? {} : { pagination: paginationParameters(operation, result[0]) }),
		})
		: { body: result[0], status: result[1], headers: result[2] };
	let body = resolved.body;
	let headers = resolved.headers;
	if (isAsyncIterable(body)) body = readableStreamFromAsyncIterable(body);
	const contentType = responseContentType(result, body, headers);
	if (contentType !== undefined && !hasHeader(headers, 'Content-Type')) {
		headers = response.mergeHeaders(headers, { 'Content-Type': contentType });
	}
	if (negotiate && response.is(result) && contentType !== undefined && body !== null && body !== undefined) {
		try {
			requestWire.negotiateContent(request.headers.get('accept'), [contentType.split(';', 1)[0]!]);
		} catch (error) {
			if (error instanceof requestWire.RequestTransportError && error.issues.some((issue) => issue.code === 'not-acceptable')) {
				return await toResponse(hono, problem.create(ServerProblems.NotAcceptable, {
					detail: `This operation produces ${contentType.split(';', 1)[0]}.`,
					instance: new URL(request.url).pathname,
					extensions: { supported: [contentType.split(';', 1)[0]] },
				}), request, undefined, false);
			}
			throw error;
		}
	}
	let bodyInit: BodyInit | null;
	if (body === null || body === undefined) bodyInit = null;
	else if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream) {
		bodyInit = body as BodyInit;
	} else {
		bodyInit = JSON.stringify(body);
	}
	return hono.newResponse(bodyInit, {
		status: resolved.status,
		headers: response.toHeaders(headers),
	});
}

/**
 * Selects the declared response media type that matches the finalized logical response body.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
function responseContentType(
	result: response.ResponseResult | problem.ProblemResult,
	body: unknown,
	headers: response.ResponseHeaders,
): string | undefined {
	const explicit = response.headerValues(headers, 'Content-Type')[0];
	if (explicit !== undefined) return explicit;
	if (problem.is(result)) return 'application/problem+json; charset=utf-8';
	const definition = response.definitionOf(result);
	if (definition.contentType !== undefined) return definition.contentType;
	if (body === null || body === undefined) return undefined;
	if (definition.mode === 'html') return 'text/html; charset=utf-8';
	if (typeof body === 'string') return 'text/plain; charset=utf-8';
	if (body instanceof Blob && body.type.length > 0) return body.type;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream || definition.mode === 'stream' || definition.mode === 'download') {
		return 'application/octet-stream';
	}
	return 'application/json; charset=utf-8';
}

/**
 * Derives the pagination parameters from the query contract used by the compiled service runtime.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
function paginationParameters(
	operation: EffectiveServiceOperation,
	body: unknown,
): Partial<response.PaginationParameters> {
	const slot = operation.operation.inputs.query ?? operation.endpoint.inputs.query;
	if (!slot) return Object.freeze({});
	const schema = endpoint.schemaOf(slot);
	if (!query.is(schema)) return Object.freeze({});
	const pageKind = typeof body === 'object' && body !== null && 'kind' in body
		? (body as { readonly kind?: unknown }).kind
		: undefined;
	if (pageKind !== 'cursor' && pageKind !== 'offset') return Object.freeze({});
	return query.paginationParameters(schema, pageKind) ?? Object.freeze({});
}

/**
 * Checks whether async iterable satisfies the condition required by the compiled service runtime.
 *
 * @internal
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<string | Uint8Array> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Reads a ReadableStream produced from an async iterable under the module's cancellation and ownership rules.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
function readableStreamFromAsyncIterable(iterable: AsyncIterable<string | Uint8Array>): ReadableStream<Uint8Array> {
	const iterator = iterable[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		/**
		 * Pulls the next value only when the compiled service runtime is ready to accept it.
		 *
		 * @internal
		 */
		async pull(controller) {
			const { done, value } = await iterator.next();
			if (done) controller.close();
			else controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
		},
		/**
		 * Checks whether cel is currently allowed by the compiled service runtime.
		 *
		 * @internal
		 */
		async cancel(reason) { await iterator.return?.(reason); },
	});
}

/**
 * Checks whether header is present for the compiled service runtime.
 *
 * @internal
 */
function hasHeader(headers: response.ResponseHeaders, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((candidate) => candidate.toLowerCase() === lower);
}

/**
 * Creates context store while preserving the module's ownership rules.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
function createContextStore(): ServiceContextStore {
	const values = new Map<MiddlewareContextDefinition, unknown>();
	return Object.freeze({
		/**
		 * Checks whether the required state is present for the compiled service runtime.
		 *
		 * @internal
		 */
		has<Definition extends MiddlewareContextDefinition>(definition: Definition): boolean {
			return values.has(definition);
		},
		/**
		 * Gets state from the compiled service runtime after its ownership and validation rules have been established.
		 *
		 * @internal
		 */
		get<Definition extends MiddlewareContextDefinition>(definition: Definition): MiddlewareContextValue<Definition> {
			if (!values.has(definition)) {
				throw new TypeError(`Middleware context ${JSON.stringify(definition.id)} is unavailable.`);
			}
			return values.get(definition) as MiddlewareContextValue<Definition>;
		},
		/**
		 * Sets state on the internal builder or record used by the compiled service runtime.
		 *
		 * @internal
		 */
		set<Definition extends MiddlewareContextDefinition>(
			definition: Definition,
			value: MiddlewareContextValue<Definition>,
		): void {
			values.set(definition, value);
		},
	});
}


/**
 * Requires concrete resource definition before the compiled service runtime continues.
 *
 * @internal
 */
function requireConcreteResourceDefinition(
	definition: endpoint.EndpointResourceDefinition,
): ResourceDefinition {
	if (!isConcreteResourceDefinition(definition)) {
		throw new ServiceRuntimeConfigurationError(
			`Resource reference ${JSON.stringify(definition.id)} is not a concrete @utils/resource definition.`,
		);
	}
	return definition;
}

/**
 * Checks whether concrete resource definition satisfies the condition required by the compiled service runtime.
 *
 * @internal
 */
function isConcreteResourceDefinition(
	definition: endpoint.EndpointResourceDefinition,
): definition is ResourceDefinition {
	return definition.kind === 'resource' &&
		'dependencies' in definition &&
		typeof (definition as { readonly dependencies?: unknown }).dependencies === 'object' &&
		(definition as { readonly dependencies?: unknown }).dependencies !== null;
}

/**
 * Creates resource resolver while preserving the module's ownership rules.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
function createResourceResolver(
	collection: ResourceCollection,
	allowed: ReadonlySet<ResourceDefinition>,
): endpoint.EndpointResourceResolver & MiddlewareResourceResolver {
	return Object.freeze({
		/**
		 * Checks whether the required state is present for the compiled service runtime.
		 *
		 * @internal
		 */
		has<Definition extends endpoint.EndpointResourceDefinition>(definition: Definition): boolean {
			return isConcreteResourceDefinition(definition) && allowed.has(definition) && collection.has(definition);
		},
		/**
		 * Gets state from the compiled service runtime after its ownership and validation rules have been established.
		 *
		 * @internal
		 */
		async get<Definition extends endpoint.EndpointResourceDefinition>(
			definition: Definition,
		): Promise<endpoint.EndpointResourceValue<Definition>> {
			const concrete = requireConcreteResourceDefinition(definition);
			if (!allowed.has(concrete)) {
				throw new TypeError(`Resource ${JSON.stringify(concrete.id)} is outside the effective operation envelope.`);
			}
			return await collection.get(concrete) as endpoint.EndpointResourceValue<Definition>;
		},
	});
}

/**
 * Derives the exact resource-definition closure that one effective service operation may acquire.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
function resourceClosure(input: MiddlewareDefinition['resources']): ResourceDefinition[] {
	if (input === undefined) return [];
	const roots = catalog.values(input).map(requireConcreteResourceDefinition);
	const result: ResourceDefinition[] = [];
	const seen = new Set<ResourceDefinition>();
	const visit = (definition: ResourceDefinition): void => {
		if (seen.has(definition)) return;
		seen.add(definition);
		for (const dependency of Object.values(definition.dependencies)) visit(dependency);
		result.push(definition);
	};
	for (const root of roots) visit(root);
	return result;
}

/**
 * Snapshots state so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeState<Host extends object, Concerns extends ServiceConcernValues>(state: MutableServiceRequestState<Host, Concerns>): ServiceRequestState<Host, Concerns> {
	return Object.freeze({ ...state });
}

/**
 * Applies patch at the phase that owns its side effects.
 *
 * @internal
 */
function applyPatch<Host extends object, Concerns extends ServiceConcernValues>(
	state: MutableServiceRequestState<Host, Concerns>,
	patch: ServiceRequestStatePatch<Concerns> | undefined,
): MutableServiceRequestState<Host, Concerns> {
	return patch === undefined ? state : { ...state, ...patch };
}

/**
 * Checks concern runtimes and preserves the deterministic issues needed by callers.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
function validateConcernRuntimes<Host extends object, Concerns extends ServiceConcernValues>(
	compiled: CompiledService,
	concerns: ServiceConcernRuntimes<Host, Concerns> | undefined,
): void {
	const required = [
		['authentication', compiled.operations.some((operation) => operation.authentication.length > 0), concerns?.authenticate],
		['authorization', compiled.operations.some((operation) => operation.permissions.length > 0), concerns?.authorize],
		['entitlements', compiled.operations.some((operation) => operation.entitlements.length > 0), concerns?.entitlements],
		['billing', compiled.operations.some((operation) => operation.billing.length > 0), concerns?.billing],
	] as const;
	for (const [name, needed, runtime] of required) {
		if (needed && runtime === undefined) throw new ServiceRuntimeConfigurationError(`Service requires a ${name} runtime.`);
	}
	const delegated = [...new Set(compiled.operations.flatMap((operation) =>
		operation.resiliency.filter((policy) => policy.type !== 'timeout' && policy.type !== 'body-limit')
	))];
	if (delegated.length === 0) return;
	const runtime = concerns?.resilience;
	if (runtime === undefined) {
		throw new ServiceRuntimeConfigurationError(
			`Service requires a resilience runtime for: ${[...new Set(delegated.map((policy) => policy.type))].join(', ')}.`,
		);
	}
	for (const policy of delegated) {
		if (!runtime.supports(policy)) {
			throw new ServiceRuntimeConfigurationError(`The resilience runtime does not support ${policy.type}.`);
		}
	}
}

const bodyTooLarge = Symbol('service-body-too-large');

/**
 * Applies the bounded request limit before the compiled service runtime accepts unbounded work or data.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
async function boundedRequest(request: Request, limit: number): Promise<Request | typeof bodyTooLarge> {
	const knownLength = parseContentLength(request.headers.get('content-length'));
	if (knownLength !== undefined && knownLength > limit) return bodyTooLarge;
	if (request.body === null) return request;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > limit) {
				await reader.cancel('Service body limit exceeded.');
				return bodyTooLarge;
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const init: RequestInit & { readonly duplex: 'half' } = {
		method: request.method,
		headers: request.headers,
		body: bytes,
		redirect: request.redirect,
		signal: request.signal,
		duplex: 'half',
	};
	return new Request(request.url, init);
}

/**
 * Checks response body and preserves the deterministic issues needed by callers.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
async function validateResponseBody(
	definition: response.ResponseDefinition,
	body: unknown,
): Promise<readonly StandardSchemaV1.Issue[]> {
	if (definition.schema === undefined || definition.mode === 'empty' || definition.mode === 'redirect') return Object.freeze([]);
	if (definition.mode !== 'page') {
		const result = await definition.schema['~standard'].validate(body);
		return Object.freeze(result.issues ? [...result.issues] : []);
	}
	if (typeof body !== 'object' || body === null || !Array.isArray((body as { readonly items?: unknown }).items)) {
		return Object.freeze([{ message: 'Paginated responses require a PageWindow body.', path: ['items'] }]);
	}
	const issues: StandardSchemaV1.Issue[] = [];
	const items = (body as { readonly items: readonly unknown[] }).items;
	for (let index = 0; index < items.length; index += 1) {
		const result = await definition.schema['~standard'].validate(items[index]);
		for (const issue of result.issues ?? []) issues.push({
			...issue,
			path: ['items', index, ...(issue.path ?? [])],
		});
	}
	return Object.freeze(issues);
}

/**
 * Parses content length into the validated internal model used by later phases.
 *
 * @internal
 */
function parseContentLength(value: string | null): number | undefined {
	if (value === null) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}


interface MutableServiceRequestState<
	Host extends object,
	Concerns extends ServiceConcernValues,
> extends ServiceRequestState<Host, Concerns> {
	readonly request: Request;
	readonly host: Host;
	readonly ctx: Context;
	readonly resources: ResourceCollection;
	readonly values: ServiceContextStore;
	readonly operation: EffectiveServiceOperation;
	input: ServiceRequestState<Host, Concerns>['input'];
	authentication?: Concerns['authentication'];
	actor?: Concerns['actor'];
	organization?: Concerns['organization'];
	authorization?: Concerns['authorization'];
	entitlementState?: Concerns['entitlements'];
	billingState?: Concerns['billing'];
}

/** Normalize JavaScript's unrestricted thrown values before exposing them to host callbacks. */
function normalizeError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason), { cause: reason });
}
