import * as catalog from '@utils/catalog';
import * as endpoint from '@utils/server/endpoint';
import { joinPath } from '@utils/server/endpoint/path';
import * as resilience from '@utils/resilience';
import type {
	EndpointCompositionInput,
	EndpointDefinition,
	EndpointEntry,
	EndpointGroup,
	EndpointGroupSelection,
} from '@utils/server/endpoint';

import type {
	ServiceDefinition,
	ServiceDefinitionInput,
	ServicePolicy,
	ServicePolicyInput,
	ServiceSelection,
} from './types.ts';

/** Define one import-safe independently deployable service. */
export function define<
	const Id extends string,
	const Path extends string,
>(input: ServiceDefinitionInput<Id, Path>): ServiceDefinition<Id, Path> {
	assertIdentifier(input.id, 'service');
	assertPath(input.path);
	const endpoints = endpoint.compose(input.endpoints);
	if (endpoints.length === 0) throw new TypeError('A service must import at least one endpoint or endpoint group.');
	const workflows = input.workflows === undefined ? Object.freeze([]) : catalog.values(input.workflows);
	const policies = Object.freeze([...(input.policies ?? [])]);
	for (const value of policies) {
		if (value.kind !== 'service-policy') throw new TypeError('Service policies must be created with service.policy().');
	}
	return Object.freeze({
		...pickContributions(input),
		kind: 'service',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		path: input.path,
		...(input.environment !== undefined ? { environment: input.environment } : {}),
		endpoints,
		workflows,
		policies,
	});
}

/** Define one selector-based additive service policy. */
export function policy(input: ServicePolicyInput): ServicePolicy {
	assertIdentifier(input.id, 'service policy');
	const endpoints = endpoint.compose(input.endpoints);
	if (endpoints.length === 0) throw new TypeError('A service policy must target at least one endpoint.');
	return Object.freeze({
		...pickContributions(input),
		kind: 'service-policy',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		endpoints,
	});
}

/** Select exact endpoint definitions from one service without copying routes. */
export function select<Service extends ServiceDefinition>(
	service: Service,
	input: Readonly<{
		readonly id: string;
		readonly description?: string;
		readonly endpoints: EndpointCompositionInput;
	}>,
): ServiceSelection<Service> {
	assertIdentifier(input.id, 'service selection');
	const available = new Set(leafEndpoints(service.endpoints));
	const selected = leafEndpoints(endpoint.compose(input.endpoints));
	for (const definition of selected) {
		if (!available.has(definition)) {
			throw new TypeError(`Service selection ${JSON.stringify(input.id)} targets endpoint ${JSON.stringify(definition.id)} outside ${JSON.stringify(service.id)}.`);
		}
	}
	return Object.freeze({
		kind: 'service-selection',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		service,
		endpoints: Object.freeze(selected),
	});
}

/** Compose service definitions or selections into deterministic direct references. */
export function compose(
	...input: readonly (ServiceDefinition | ServiceSelection | readonly (ServiceDefinition | ServiceSelection)[])[]
): readonly (ServiceDefinition | ServiceSelection)[] {
	type Entry = ServiceDefinition | ServiceSelection;
	const result: Entry[] = [];
	const seen = new Set<Entry>();
	const ids = new Map<string, Entry>();
	const visit = (value: Entry | readonly Entry[]): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const entry = value as Entry;
		const owner = ids.get(entry.id);
		if (owner && owner !== entry) throw new TypeError(`Service composition ID ${JSON.stringify(entry.id)} is owned by different objects.`);
		ids.set(entry.id, entry);
		if (!seen.has(entry)) {
			seen.add(entry);
			result.push(entry);
		}
	};
	for (const value of input) visit(value);
	return Object.freeze(result);
}

/** Return exact leaf endpoint definitions represented by a composition. */
export function leafEndpoints(input: EndpointCompositionInput): readonly EndpointDefinition[] {
	const result: EndpointDefinition[] = [];
	const seen = new Set<EndpointDefinition>();
	const visit = (entry: EndpointEntry): void => {
		if (entry.kind === 'endpoint') {
			if (!seen.has(entry)) {
				seen.add(entry);
				result.push(entry);
			}
			return;
		}
		for (const nested of entry.endpoints) visit(nested);
	};
	for (const entry of endpoint.compose(input)) visit(entry);
	return Object.freeze(result);
}

/**
 * Selects contributions needed by the next phase without redefining them.
 *
 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
 *
 * @internal
 */
function pickContributions(input: ServiceDefinitionInput | ServicePolicyInput) {
	return {
		...(input.middleware !== undefined ? { middleware: snapshotInput(input.middleware) } : {}),
		...(input.authentication !== undefined ? { authentication: snapshotInput(input.authentication) } : {}),
		...(input.permissions !== undefined ? { permissions: snapshotInput(input.permissions) } : {}),
		...(input.entitlements !== undefined ? { entitlements: snapshotInput(input.entitlements) } : {}),
		...(input.billing !== undefined ? { billing: snapshotInput(input.billing) } : {}),
		...(input.resources !== undefined ? { resources: snapshotInput(input.resources) } : {}),
		...(input.problems !== undefined ? { problems: snapshotInput(input.problems) } : {}),
		...(input.resiliency !== undefined ? { resiliency: resilience.compose(input.resiliency) } : {}),
	};
}

/**
 * Captures the snapshot input as immutable state for the compiled service runtime.
 *
 * @internal
 */
function snapshotInput<Value>(value: Value): Value {
	if (!Array.isArray(value)) return value;
	return Object.freeze(value.map((entry) => snapshotInput(entry))) as Value;
}

/**
 * Rejects invalid path before it can enter authoritative module state.
 *
 * @internal
 */
function assertPath(value: string): void {
	if (!value.startsWith('/')) throw new TypeError(`Service path ${JSON.stringify(value)} must begin with /.`);
	if (value.includes('?') || value.includes('#')) throw new TypeError('Service paths may not contain query strings or fragments.');
	if (value.includes('//')) throw new TypeError(`Service path ${JSON.stringify(value)} must not contain empty path segments.`);
	if (value.length > 1 && value.endsWith('/')) throw new TypeError(`Service path ${JSON.stringify(value)} must not end with /.`);
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(value)}.`);
}

export type { EndpointGroup, EndpointGroupSelection };
