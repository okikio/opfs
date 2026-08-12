import * as catalog from '@utils/catalog';
import type { CatalogEntryIdentity } from '@utils/catalog';
import type { EndpointDefinition } from '@utils/server/endpoint';
import { leafEndpoints } from '../service/definition.ts';
import type {
	CompiledService,
	ServiceDefinition,
	ServiceManifest,
	ServiceRouteManifestEntry,
	ServiceSelection,
} from '../service/types.ts';
import type {
	CompiledGateway,
	CompiledGatewayRoute,
	CompileGatewayOptions,
	GatewayCachePolicy,
	GatewayCredentialPolicy,
	GatewayDefinition,
	GatewayManifest,
	GatewayMount,
	GatewayPolicy,
	GatewayRedirectPolicy,
	GatewayRouteManifestEntry,
	GatewayServiceArtifact,
	GatewayValidationIssue,
	GatewayValidationResult,
	GatewayValidationSubject,
} from './types.ts';

const defaultCache: GatewayCachePolicy = Object.freeze({ kind: 'gateway-cache', mode: 'no-store' });
const defaultCredentials: GatewayCredentialPolicy = Object.freeze({ kind: 'gateway-credentials', requestCookies: 'strip', requestAuthorization: 'strip', responseCookies: 'strip' });
const defaultRedirects: GatewayRedirectPolicy = Object.freeze({ kind: 'gateway-redirects', mode: 'rewrite-origin', allowedOrigins: Object.freeze([]) });

/** Error raised when a gateway cannot be compiled safely. */
export class GatewayCompilationError extends Error {
	readonly issues: readonly GatewayValidationIssue[];

	constructor(issues: readonly GatewayValidationIssue[]) {
		super(`Gateway compilation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}`);
		this.name = 'GatewayCompilationError';
		this.issues = Object.freeze([...issues]);
	}
}

/** Validate mount and policy ownership without requiring service artifacts. */
export function validate(definition: GatewayDefinition): GatewayValidationResult {
	const issues: GatewayValidationIssue[] = [];
	const mountedServices = new Map<string, ServiceDefinition>();
	const availableEndpoints = new Set<EndpointDefinition>();
	for (const mounted of definition.services) {
		const service = serviceOf(mounted.target);
		const existing = mountedServices.get(service.id);
		if (existing && existing !== service) {
			issues.push(issue('duplicate-mount', `Service ID ${JSON.stringify(service.id)} belongs to different definitions.`, mounted));
		}
		if (existing === service) {
			issues.push(issue('duplicate-mount', `Service ${JSON.stringify(service.id)} is mounted more than once.`, mounted));
		}
		mountedServices.set(service.id, service);
		for (const endpoint of selectedEndpoints(mounted.target)) availableEndpoints.add(endpoint);
	}
	for (const policy of definition.policies) {
		for (const target of policy.endpoints) {
			if (!availableEndpoints.has(target)) {
				issues.push(issue('policy-target-outside-gateway', `Policy ${JSON.stringify(policy.id)} targets endpoint ${JSON.stringify(target.id)} outside gateway ${JSON.stringify(definition.id)}.`, policy));
			}
		}
	}
	return issues.length === 0
		? Object.freeze({ valid: true })
		: Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

/** Compile exact service route artifacts into one deterministic edge route table. */
export function compile<Definition extends GatewayDefinition>(
	definition: Definition,
	options: CompileGatewayOptions,
): CompiledGateway<Definition> {
	const validation = validate(definition);
	const issues: GatewayValidationIssue[] = validation.valid ? [] : [...validation.issues];
	const artifacts = indexArtifacts(options.services, issues);
	const policyTargets = new Map(definition.policies.map((policy) => [policy, new Set(policy.endpoints)] as const));
	const routes: CompiledGatewayRoute[] = [];
	const routeOwners = new Map<string, CompiledGatewayRoute>();

	for (const mounted of definition.services) {
		const service = serviceOf(mounted.target);
		const artifact = artifacts.get(service.id);
		if (!artifact) {
			issues.push(issue('missing-service-artifact', `Gateway mount ${JSON.stringify(service.id)} has no compiled service artifact.`, mounted));
			continue;
		}
		const selected = new Set(selectedEndpoints(mounted.target).map((endpoint) => endpoint.id));
		for (const route of artifact.manifest.routes) {
			if (!selected.has(route.endpointId)) continue;
			const endpoint = endpointById(service, route.endpointId);
			if (!endpoint) {
				issues.push(issue('invalid-definition', `Service artifact route ${JSON.stringify(route.id)} references endpoint ${JSON.stringify(route.endpointId)} outside the mounted definition.`));
				continue;
			}
			const policies = definition.policies.filter((policy) => policyTargets.get(policy)?.has(endpoint));
			const effective = effectivePolicy(policies, issues, route);
			const compiledRoute: CompiledGatewayRoute = Object.freeze({
				id: `${definition.id}:${route.id}`,
				gateway: definition,
				serviceId: service.id,
				endpointId: route.endpointId,
				operationId: route.operationId,
				method: route.method,
				path: route.path,
				origin: mounted.origin.toString(),
				authenticate: effective.authenticate,
				assertions: effective.assertions,
				...(effective.timeout !== undefined ? { timeout: effective.timeout } : {}),
				...(effective.bodyLimit !== undefined ? { bodyLimit: effective.bodyLimit } : {}),
				cache: effective.cache,
				credentials: effective.credentials,
				redirects: effective.redirects,
				observers: definition.observers,
			});
			const key = `${compiledRoute.method} ${normalizeRouteShape(compiledRoute.path)}`;
			const owner = routeOwners.get(key);
			if (owner && owner.serviceId !== compiledRoute.serviceId) {
				issues.push(issue('route-conflict', `${compiledRoute.method} ${compiledRoute.path} is owned by both ${owner.serviceId} and ${compiledRoute.serviceId}.`, compiledRoute));
				continue;
			}
			routeOwners.set(key, compiledRoute);
			routes.push(compiledRoute);
		}
	}
	if (issues.length > 0) throw new GatewayCompilationError(Object.freeze(issues));
	const frozenRoutes = Object.freeze(routes.toSorted(compareRoutes));
	return Object.freeze({
		kind: 'compiled-gateway',
		definition,
		routes: frozenRoutes,
		manifest: manifest(definition, frozenRoutes),
	});
}

/** Return the JSON-safe gateway manifest retained by a compiled gateway. */
export function document(compiled: CompiledGateway): GatewayManifest {
	return compiled.manifest;
}

/**
 * Indexes artifacts for exact validation and lookup in later phases.
 *
 * It compiles and executes trusted service routing without letting gateway policy become service-domain behavior.
 *
 * @internal
 */
function indexArtifacts(
	input: readonly GatewayServiceArtifact[],
	issues: GatewayValidationIssue[],
): ReadonlyMap<string, Readonly<{ readonly manifest: ServiceManifest }>> {
	const result = new Map<string, Readonly<{ readonly manifest: ServiceManifest }>>();
	for (const artifact of input) {
		const manifest = isCompiledService(artifact) ? artifact.manifest : artifact;
		const existing = result.get(manifest.id);
		if (existing && existing.manifest !== manifest) {
			issues.push(issue('invalid-definition', `More than one service artifact uses ID ${JSON.stringify(manifest.id)}.`, artifact));
			continue;
		}
		result.set(manifest.id, Object.freeze({ manifest }));
	}
	return result;
}

/**
 * Resolves the effective policy after inherited and contributed state is combined by compiled gateway routing.
 *
 * Gateway internals route only definitions selected by the composition root and keep gateway trust policy out of service-domain behavior.
 *
 * @internal
 */
function effectivePolicy(
	policies: readonly GatewayPolicy[],
	issues: GatewayValidationIssue[],
	route: ServiceRouteManifestEntry,
): Readonly<{
	readonly authenticate: readonly CatalogEntryIdentity[];
	readonly assertions: readonly CatalogEntryIdentity[];
	readonly timeout?: Temporal.Duration;
	readonly bodyLimit?: number;
	readonly cache: GatewayCachePolicy;
	readonly credentials: GatewayCredentialPolicy;
	readonly redirects: GatewayRedirectPolicy;
}> {
	const authenticate = Object.freeze(policies.flatMap((policy) => definitionValues(policy.authenticate)));
	const assertions = Object.freeze(policies.flatMap((policy) => definitionValues(policy.assertion)));
	const timeout = singleValue(policies.flatMap((policy) => policy.timeout === undefined ? [] : [policy.timeout]), 'timeout', route, issues, sameDuration);
	const bodyLimit = singleValue(policies.flatMap((policy) => policy.bodyLimit === undefined ? [] : [policy.bodyLimit]), 'body limit', route, issues);
	const cache = singleValue(policies.flatMap((policy) => policy.cache === undefined ? [] : [policy.cache]), 'cache policy', route, issues, sameCache) ?? defaultCache;
	const credentials = singleValue(policies.flatMap((policy) => policy.credentials === undefined ? [] : [policy.credentials]), 'credential policy', route, issues, sameCredentials) ?? defaultCredentials;
	const redirects = singleValue(policies.flatMap((policy) => policy.redirects === undefined ? [] : [policy.redirects]), 'redirect policy', route, issues, sameRedirects) ?? defaultRedirects;
	return Object.freeze({
		authenticate,
		assertions,
		...(timeout !== undefined ? { timeout } : {}),
		...(bodyLimit !== undefined ? { bodyLimit } : {}),
		cache,
		credentials,
		redirects,
	});
}

/**
 * Returns the single value in the representation expected by compiled gateway routing.
 *
 * Gateway internals route only definitions selected by the composition root and keep gateway trust policy out of service-domain behavior.
 *
 * @internal
 */
function singleValue<Value>(
	values: readonly Value[],
	label: string,
	route: ServiceRouteManifestEntry,
	issues: GatewayValidationIssue[],
	equal: (left: Value, right: Value) => boolean = Object.is,
): Value | undefined {
	const first = values[0];
	if (first === undefined) return undefined;
	for (const value of values.slice(1)) {
		if (!equal(first, value)) {
			issues.push(issue('conflicting-policy', `Route ${JSON.stringify(route.id)} receives conflicting ${label} values.`, route));
			break;
		}
	}
	return first;
}

/**
 * Selects ed endpoints needed by compiled gateway routing without changing the source definition.
 *
 * @internal
 */
function selectedEndpoints(target: ServiceDefinition | ServiceSelection): readonly EndpointDefinition[] {
	return target.kind === 'service-selection' ? target.endpoints : leafEndpoints(target.endpoints);
}

/**
 * Returns the service definition that owns a compiled gateway route.
 *
 * @internal
 */
function serviceOf(target: ServiceDefinition | ServiceSelection): ServiceDefinition {
	return target.kind === 'service-selection' ? target.service : target;
}

/**
 * Resolves the exact endpoint definition referenced by a compiled gateway route and rejects stale route metadata.
 *
 * @internal
 */
function endpointById(service: ServiceDefinition, id: string): EndpointDefinition | undefined {
	return leafEndpoints(service.endpoints).find((endpoint) => endpoint.id === id);
}

/**
 * Builds the manifest that records the state consumed by compiled gateway routing.
 *
 * @internal
 */
function manifest(definition: GatewayDefinition, routes: readonly CompiledGatewayRoute[]): GatewayManifest {
	return Object.freeze({
		id: definition.id,
		routes: Object.freeze(routes.map(routeManifest)),
		services: Object.freeze([...new Set(routes.map((route) => route.serviceId))]),
	});
}

/**
 * Builds the route manifest that records the state consumed by compiled gateway routing.
 *
 * Gateway internals route only definitions selected by the composition root and keep gateway trust policy out of service-domain behavior.
 *
 * @internal
 */
function routeManifest(route: CompiledGatewayRoute): GatewayRouteManifestEntry {
	return Object.freeze({
		id: route.id,
		serviceId: route.serviceId,
		endpointId: route.endpointId,
		operationId: route.operationId,
		method: route.method,
		path: route.path,
		origin: route.origin,
		authentication: Object.freeze(route.authenticate.map(definitionId)),
		assertions: Object.freeze(route.assertions.map(definitionId)),
		...(route.timeout !== undefined ? { timeout: route.timeout.toString() } : {}),
		...(route.bodyLimit !== undefined ? { bodyLimit: route.bodyLimit } : {}),
		cache: route.cache.mode,
		credentials: Object.freeze({
			requestCookies: route.credentials.requestCookies,
			requestAuthorization: route.credentials.requestAuthorization,
			responseCookies: route.credentials.responseCookies,
		}),
		redirects: route.redirects.mode,
		observers: Object.freeze(route.observers.map((observer) => observer.id)),
	});
}

/**
 * Derives the definition id from exact imported definitions used by compiled gateway routing.
 *
 * @internal
 */
function definitionId(value: unknown, index: number): string {
	return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
		? (value as { id: string }).id
		: `anonymous:${index}`;
}


/**
 * Returns the definition values consumed by compiled gateway routing.
 *
 * @internal
 */
function definitionValues<Entry extends import('@utils/catalog').CatalogEntryIdentity>(
	input: import('@utils/catalog').DefinitionInput<Entry> | undefined,
): readonly Entry[] {
	return input === undefined ? Object.freeze([]) : catalog.values(input);
}

/**
 * Checks whether duration are equivalent for the purposes of compiled gateway routing.
 *
 * @internal
 */
function sameDuration(left: Temporal.Duration, right: Temporal.Duration): boolean {
	return left.toString() === right.toString();
}

/**
 * Checks whether cache are equivalent for the purposes of compiled gateway routing.
 *
 * @internal
 */
function sameCache(left: GatewayCachePolicy, right: GatewayCachePolicy): boolean {
	return left.mode === right.mode;
}

/**
 * Checks whether credentials are equivalent for the purposes of compiled gateway routing.
 *
 * @internal
 */
function sameCredentials(left: GatewayCredentialPolicy, right: GatewayCredentialPolicy): boolean {
	return left.requestCookies === right.requestCookies &&
		left.requestAuthorization === right.requestAuthorization &&
		left.responseCookies === right.responseCookies;
}

/**
 * Checks whether redirects are equivalent for the purposes of compiled gateway routing.
 *
 * @internal
 */
function sameRedirects(left: GatewayRedirectPolicy, right: GatewayRedirectPolicy): boolean {
	return left.mode === right.mode && left.allowedOrigins.join('\n') === right.allowedOrigins.join('\n');
}

/**
 * Normalizes route shape into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeRouteShape(path: string): string {
	return path.replace(/:[^/]+/g, ':parameter').replace(/\/+/g, '/');
}

/**
 * Compares routes using the stable ordering required by compiled gateway routing.
 *
 * @internal
 */
function compareRoutes(left: CompiledGatewayRoute, right: CompiledGatewayRoute): number {
	return left.path.localeCompare(right.path) || left.method.localeCompare(right.method) || left.id.localeCompare(right.id);
}

/**
 * Checks whether compiled service satisfies the condition required by compiled gateway routing.
 *
 * @internal
 */
function isCompiledService(value: GatewayServiceArtifact): value is CompiledService {
	return (value as CompiledService).kind === 'compiled-service';
}

/**
 * Checks whether sue satisfies the condition required by compiled gateway routing.
 *
 * @internal
 */
function issue(
	code: GatewayValidationIssue['code'],
	message: string,
	definition?: GatewayValidationSubject,
): GatewayValidationIssue {
	return definition === undefined
		? Object.freeze({ code, message })
		: Object.freeze({ code, message, definition });
}
