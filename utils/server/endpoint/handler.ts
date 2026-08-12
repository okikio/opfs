import type {
	EndpointDefinition,
	EndpointInputSlots,
	EndpointHandler,
	EndpointHandlerBinding,
	AnyEndpointHandler,
	AnyEndpointHandlerBinding,
	EndpointHandlerSet,
	EndpointHandlerResult,
	EndpointConcernValues,
	EmptyEndpointHost,
	EndpointMethod,
	EndpointOperation,
} from './types.ts';

/** Bind a complete single-method endpoint directly to its handler. */
export function handler<
	Endpoint extends EndpointDefinition<string, EndpointInputSlots, readonly [EndpointOperation]>,
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
>(
	endpoint: Endpoint,
	handle: EndpointHandler<Endpoint, Endpoint['operations'][0], Host, Concerns>,
): EndpointHandlerBinding<Endpoint, Endpoint['operations'][0], Host, Concerns>;
/** Bind every method of one endpoint through an exhaustive lowercase method map. */
export function handler<
	Endpoint extends EndpointDefinition,
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
>(
	endpoint: Endpoint,
	handles: HandlerMap<Endpoint, Host, Concerns>,
): EndpointHandlerSet<Endpoint>;
/** Bind one imported operation from a multi-method endpoint. */
export function handler<
	Endpoint extends EndpointDefinition,
	Operation extends Endpoint['operations'][number],
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
>(
	endpoint: Endpoint,
	operation: Operation,
	handle: EndpointHandler<Endpoint, Operation, Host, Concerns>,
): EndpointHandlerBinding<Endpoint, Operation, Host, Concerns>;
/** Normalize direct, operation-specific, or exhaustive handler authoring. */
export function handler(
	endpoint: EndpointDefinition,
	operationOrHandles: unknown,
	maybeHandle?: unknown,
): EndpointHandlerBinding | AnyEndpointHandlerBinding | EndpointHandlerSet {
	if (isOperation(operationOrHandles)) {
		if (!endpoint.operations.includes(operationOrHandles)) {
			throw new TypeError(`Operation ${JSON.stringify(operationOrHandles.id)} does not belong to endpoint ${JSON.stringify(endpoint.id)}.`);
		}
		if (typeof maybeHandle !== 'function') throw new TypeError('Endpoint handler must be a function.');
		return erasedBinding(endpoint, operationOrHandles, maybeHandle as AnyEndpointHandler);
	}

	if (typeof operationOrHandles === 'function') {
		if (endpoint.operations.length !== 1) {
			throw new TypeError(`Endpoint ${JSON.stringify(endpoint.id)} requires an exhaustive method map or explicit operation.`);
		}
		return erasedBinding(endpoint, endpoint.operations[0]!, operationOrHandles as AnyEndpointHandler);
	}

	if (!isHandlerRecord(operationOrHandles)) throw new TypeError('Endpoint handlers require a function or exhaustive method map.');
	const keys = Object.keys(operationOrHandles);
	const expected = new Set(endpoint.operations.map((operation) => operation.method));
	for (const key of keys) {
		if (!expected.has(key as EndpointMethod)) {
			throw new TypeError(`Handler map contains undeclared ${key.toUpperCase()} method for ${JSON.stringify(endpoint.id)}.`);
		}
	}
	const bindings: AnyEndpointHandlerBinding[] = [];
	for (const operation of endpoint.operations) {
		const handle = operationOrHandles[operation.method];
		if (typeof handle !== 'function') {
			throw new TypeError(`Handler map is missing ${operation.method.toUpperCase()} for ${JSON.stringify(endpoint.id)}.`);
		}
		bindings.push(erasedBinding(endpoint, operation, handle as AnyEndpointHandler));
	}
	return Object.freeze({
		kind: 'endpoint-handlers',
		endpoint,
		bindings: Object.freeze(bindings),
	});
}

/** Compose direct bindings and complete handler sets into one immutable list. */
type EndpointHandlerEntry = AnyEndpointHandlerBinding | EndpointHandlerSet;
type EndpointHandlerInput = EndpointHandlerEntry | readonly EndpointHandlerInput[];

/** Flatten handler bindings while rejecting duplicate operation implementations. */
export function handlers(
	...input: readonly EndpointHandlerInput[]
): readonly AnyEndpointHandlerBinding[] {
	const result: AnyEndpointHandlerBinding[] = [];
	const seenBindings = new Map<EndpointDefinition, Map<EndpointOperation, AnyEndpointHandlerBinding>>();
	const visit = (value: EndpointHandlerInput): void => {
		if (isHandlerInputArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value.kind === 'endpoint-handlers') {
			for (const item of value.bindings) visit(item);
			return;
		}
		let endpointBindings = seenBindings.get(value.endpoint);
		if (!endpointBindings) {
			endpointBindings = new Map();
			seenBindings.set(value.endpoint, endpointBindings);
		}
		const existing = endpointBindings.get(value.operation);
		if (existing && existing !== value) {
			throw new TypeError(
				`Operation ${JSON.stringify(value.operation.id)} has more than one handler binding for endpoint ${JSON.stringify(value.endpoint.id)}.`,
			);
		}
		if (!existing) {
			endpointBindings.set(value.operation, value);
			result.push(value);
		}
	};
	for (const value of input) visit(value);
	return Object.freeze(result);
}

type HandlerMap<Endpoint extends EndpointDefinition, Host extends object, Concerns extends EndpointConcernValues> = {
	readonly [Method in Endpoint['operations'][number]['method']]: EndpointHandler<
		Endpoint,
		Extract<Endpoint['operations'][number], { readonly method: Method }>,
		Host,
		Concerns
	>;
};

/**
 * Creates the exact endpoint-to-handler binding retained by service compilation.
 *
 * Endpoint internals keep routes, schemas, responses, problems, resources, and documentation metadata in one import-safe definition model.
 *
 * @internal
 */
function binding<
	Endpoint extends EndpointDefinition,
	Operation extends EndpointOperation,
	Host extends object,
	Concerns extends EndpointConcernValues,
>(
	endpoint: Endpoint,
	operation: Operation,
	handle: EndpointHandler<Endpoint, Operation, Host, Concerns>,
): EndpointHandlerBinding<Endpoint, Operation, Host, Concerns> {
	return Object.freeze({ kind: 'endpoint-handler', endpoint, operation, handle });
}

/**
 * Erases only generic handler types after exact endpoint identity has already been captured for heterogeneous composition.
 *
 * @internal
 */
function erasedBinding(
	endpoint: EndpointDefinition,
	operation: EndpointOperation,
	handle: AnyEndpointHandler,
): AnyEndpointHandlerBinding {
	return Object.freeze({ kind: 'endpoint-handler', endpoint, operation, handle });
}

/**
 * Checks whether handler input array satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isHandlerInputArray(value: EndpointHandlerInput): value is readonly EndpointHandlerInput[] {
	return Array.isArray(value);
}

/**
 * Checks whether handler record satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isHandlerRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether operation satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isOperation(value: unknown): value is EndpointOperation {
	return typeof value === 'object' && value !== null &&
		(value as { kind?: unknown }).kind === 'endpoint-operation';
}
