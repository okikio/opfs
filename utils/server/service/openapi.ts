import * as endpoint from '@utils/server/endpoint';
import type {
	EndpointDefinition,
	EndpointOperation,
	OpenApiDocument,
	OpenApiOptions,
} from '@utils/server/endpoint';

import type { CompiledService, EffectiveServiceOperation } from './types.ts';

/** Options for projecting one compiled service to OpenAPI 3.1. */
export interface ServiceOpenApiOptions extends Omit<OpenApiOptions, 'description'> {
	/** Override the service definition description in the generated document. */
	readonly description?: string;
}

/**
 * Generate OpenAPI from the compiler-resolved operation graph.
 *
 * The projection uses effective response and problem envelopes, including
 * service, policy, group, endpoint, middleware, resource, and compiler-
 * generated contributions. It never reconstructs route ownership from IDs or
 * copied URL inventories.
 */
export async function openapi(
	compiled: CompiledService,
	options: ServiceOpenApiOptions,
): Promise<OpenApiDocument> {
	const definitions = compiled.operations.map(effectiveEndpoint);
	const description = options.description ?? compiled.definition.description;
	const document = await endpoint.openapi(definitions, {
		title: options.title,
		version: options.version,
		...(options.includeInternal !== undefined ? { includeInternal: options.includeInternal } : {}),
		...(description !== undefined ? { description } : {}),
	});
	return resilienceOpenApi(document, compiled.operations);
}

/**
 * Resolves the effective endpoint after inherited and contributed state is combined by the compiled service runtime.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
function effectiveEndpoint(
	effective: EffectiveServiceOperation,
): EndpointDefinition {
	const operation: EndpointOperation = Object.freeze({
		...effective.operation,
		problems: effective.problems,
		responses: effective.responses,
	});
	return Object.freeze({
		kind: 'endpoint',
		id: `${effective.id}:openapi`,
		...(effective.endpoint.description !== undefined ? { description: effective.endpoint.description } : {}),
		path: effective.path,
		inputs: effective.endpoint.inputs,
		operations: Object.freeze([operation]),
		internal: effective.operation.internal === true ||
			effective.endpoint.internal === true ||
			effective.groups.some((group) => group.internal === true),
	});
}
/**
 * Projects effective resilience policy into OpenAPI extension metadata without making the document the policy source of truth.
 *
 * Service internals link exact endpoint and middleware definitions to implementations before traffic and preserve request-stage ownership at runtime.
 *
 * @internal
 */
function resilienceOpenApi(
	document: OpenApiDocument,
	operations: readonly EffectiveServiceOperation[],
): OpenApiDocument {
	const paths: Record<string, Readonly<Record<string, unknown>>> = { ...document.paths };
	for (const effective of operations) {
		const path = effective.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
		const pathItem = paths[path];
		if (pathItem === undefined) continue;
		const original = pathItem[effective.method];
		if (!isRecord(original)) continue;
		const operation: Record<string, unknown> = { ...original };
		const parameters = Array.isArray(operation.parameters) ? [...operation.parameters] : [];
		const idempotency = effective.resiliency.find((policy) => policy.type === 'idempotency');
		if (idempotency?.type === 'idempotency' && !parameters.some((entry) =>
			isRecord(entry) && entry.in === 'header' && typeof entry.name === 'string' &&
			entry.name.toLowerCase() === idempotency.header.toLowerCase()
		)) {
			parameters.push({
				in: 'header',
				name: idempotency.header,
				required: idempotency.required,
				description: 'Identifies one logical mutation so a safe retry can reuse its recorded outcome.',
				schema: { type: 'string', minLength: 1 },
			});
		}
		if (parameters.length > 0) operation.parameters = parameters;
		const responses = isRecord(operation.responses) ? { ...operation.responses } : {};
		const retryableStatuses = new Set<string>();
		if (effective.resiliency.some((policy) => policy.type === 'rate-limit')) retryableStatuses.add('429');
		if (effective.resiliency.some((policy) =>
			policy.type === 'circuit-breaker' || policy.type === 'bulkhead'
		)) retryableStatuses.add('503');
		for (const status of retryableStatuses) {
			const existing = responses[status];
			if (!isRecord(existing)) continue;
			responses[status] = {
				...existing,
				headers: {
					...(isRecord(existing.headers) ? existing.headers : {}),
					'Retry-After': {
						description: 'Seconds or an HTTP date after which the client may retry.',
						schema: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] },
					},
				},
			};
		}
		operation.responses = responses;
		paths[path] = { ...pathItem, [effective.method]: operation };
	}
	return deepFreeze({ ...document, paths });
}

/**
 * Checks whether record satisfies the condition required by the compiled service runtime.
 *
 * @internal
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively freezes the value graph so the compiled service runtime cannot observe later caller mutation.
 *
 * @internal
 */
function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
	return Object.freeze(value);
}
