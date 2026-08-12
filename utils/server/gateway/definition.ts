import * as endpoint from '@utils/server/endpoint';
import type { ServiceDefinition, ServiceSelection } from '../service/types.ts';
import type {
	GatewayCachePolicy,
	GatewayCredentialPolicy,
	GatewayDefinition,
	GatewayDefinitionInput,
	GatewayMount,
	GatewayOrigin,
	GatewayObserverDefinition,
	GatewayObserverEventKind,
	GatewayObserverHandler,
	GatewayPolicy,
	GatewayPolicyInput,
	GatewayRedirectPolicy,
	GatewaySelection,
} from './types.ts';

/** Mount an exact service definition or selection at one origin. */
export function mount<Target extends ServiceDefinition | ServiceSelection>(
	target: Target,
	options: Readonly<{ readonly origin: GatewayOrigin }>,
): GatewayMount<Target> {
	const origin = normalizeOrigin(options.origin);
	return Object.freeze({ kind: 'gateway-mount', target, origin });
}

/** Define an import-safe gateway from exact mounted service references. */
export function define<const Id extends string>(input: GatewayDefinitionInput<Id>): GatewayDefinition<Id> {
	assertIdentifier(input.id, 'gateway');
	const services = flattenMounts(input.services);
	if (services.length === 0) throw new TypeError('A gateway must mount at least one service.');
	const policies = Object.freeze([...(input.policies ?? [])]);
	const observers = Object.freeze([...(input.observers ?? [])]);
	for (const value of policies) {
		if (value.kind !== 'gateway-policy') throw new TypeError('Gateway policies must be created with gateway.policy().');
	}
	for (const value of observers) {
		if (value.kind !== 'gateway-observer') throw new TypeError('Gateway observers must be created with gateway.observer.define().');
	}
	return Object.freeze({
		kind: 'gateway',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		services,
		policies,
		observers,
	});
}

/** Define one selector-based additive gateway policy. */
export function policy(input: GatewayPolicyInput): GatewayPolicy {
	assertIdentifier(input.id, 'gateway policy');
	const endpoints = leafEndpoints(input.endpoints);
	if (endpoints.length === 0) throw new TypeError('A gateway policy must target at least one endpoint.');
	if (input.bodyLimit !== undefined && (!Number.isSafeInteger(input.bodyLimit) || input.bodyLimit < 1)) {
		throw new TypeError('Gateway bodyLimit must be a positive safe integer.');
	}
	const timeout = input.timeout === undefined ? undefined : Temporal.Duration.from(input.timeout);
	if (timeout !== undefined && durationMilliseconds(timeout) <= 0) throw new TypeError('Gateway timeout must be positive.');
	return Object.freeze({
		kind: 'gateway-policy',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		endpoints,
		...(input.authenticate !== undefined ? { authenticate: input.authenticate } : {}),
		...(input.assertion !== undefined ? { assertion: input.assertion } : {}),
		...(timeout !== undefined ? { timeout } : {}),
		...(input.bodyLimit !== undefined ? { bodyLimit: input.bodyLimit } : {}),
		...(input.cache !== undefined ? { cache: input.cache } : {}),
		...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
		...(input.redirects !== undefined ? { redirects: input.redirects } : {}),
	});
}

/** Define explicit request/response credential forwarding behavior. */
export function credentials(options: Partial<Omit<GatewayCredentialPolicy, 'kind'>> = {}): GatewayCredentialPolicy {
	return Object.freeze({
		kind: 'gateway-credentials',
		requestCookies: options.requestCookies ?? 'strip',
		requestAuthorization: options.requestAuthorization ?? 'strip',
		responseCookies: options.responseCookies ?? 'strip',
	});
}

/** Define how upstream manual redirect locations are exposed publicly. */
export function redirects(options: Readonly<{
	readonly mode?: GatewayRedirectPolicy['mode'];
	readonly allowedOrigins?: readonly (string | URL)[];
}> = {}): GatewayRedirectPolicy {
	return Object.freeze({
		kind: 'gateway-redirects',
		mode: options.mode ?? 'rewrite-origin',
		allowedOrigins: Object.freeze((options.allowedOrigins ?? []).map((origin) => new URL(origin).origin)),
	});
}

const observerKinds = new Set<GatewayObserverEventKind>(['denied', 'forwarding', 'response', 'completed', 'failed', 'aborted']);

/**
 * Creates the define observer as import-safe definition data for compiled gateway routing.
 *
 * @internal
 */
function defineObserver(input: Readonly<{
	readonly id: string;
	readonly description: string;
	readonly events?: readonly GatewayObserverEventKind[];
}>): GatewayObserverDefinition {
	assertIdentifier(input.id, 'gateway observer');
	if (input.description.trim().length === 0) throw new TypeError('Gateway observer description cannot be empty.');
	const events = Object.freeze([...(input.events ?? observerKinds)]);
	if (events.length === 0 || events.some((event) => !observerKinds.has(event))) throw new TypeError('Gateway observer events are invalid.');
	return Object.freeze({ kind: 'gateway-observer', id: input.id, description: input.description, events });
}

/**
 * Indexes the observer handler so compiled gateway routing can publish diagnostics without making observers authoritative.
 *
 * @internal
 */
function observerHandler<Definition extends GatewayObserverDefinition>(
	definition: Definition,
	handle: GatewayObserverHandler<Definition>['handle'],
): GatewayObserverHandler<Definition> {
	if (definition.kind !== 'gateway-observer') throw new TypeError('Gateway observer handlers require an exact observer definition.');
	if (typeof handle !== 'function') throw new TypeError('Gateway observer handler must be a function.');
	return Object.freeze({ kind: 'gateway-observer-handler', definition, handle });
}

/**
 * Gateway lifecycle observer definition and handler namespace.
 *
 * Observers receive redacted metadata after route and trust decisions. They are
 * for telemetry, security auditing, and completion accounting; they cannot
 * mutate a request or response.
 */
export const observer = Object.freeze({ define: defineObserver, handler: observerHandler });

/** Select exact mounts from one gateway without copying routes. */
export function select<Gateway extends GatewayDefinition>(
	gateway: Gateway,
	input: Readonly<{
		readonly id: string;
		readonly description?: string;
		readonly services: readonly (ServiceDefinition | ServiceSelection)[];
	}>,
): GatewaySelection<Gateway> {
	assertIdentifier(input.id, 'gateway selection');
	const selected = input.services.map((service) => {
		const found = gateway.services.find((candidate) => candidate.target === service);
		if (!found) throw new TypeError(`Gateway selection targets service ${JSON.stringify(service.id)} outside ${JSON.stringify(gateway.id)}.`);
		return found;
	});
	return Object.freeze({
		kind: 'gateway-selection',
		id: input.id,
		...(input.description !== undefined ? { description: input.description } : {}),
		gateway,
		mounts: Object.freeze(selected),
	});
}

/** Compose gateway definitions or selections by direct identity. */
export function compose(
	...input: readonly (GatewayDefinition | GatewaySelection | readonly (GatewayDefinition | GatewaySelection)[])[]
): readonly (GatewayDefinition | GatewaySelection)[] {
	type Entry = GatewayDefinition | GatewaySelection;
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
		if (owner && owner !== entry) throw new TypeError(`Gateway composition ID ${JSON.stringify(entry.id)} belongs to different objects.`);
		ids.set(entry.id, entry);
		if (!seen.has(entry)) {
			seen.add(entry);
			result.push(entry);
		}
	};
	for (const value of input) visit(value);
	return Object.freeze(result);
}

/** Disable storage by shared or browser caches. */
export function noStore(): GatewayCachePolicy {
	return Object.freeze({ kind: 'gateway-cache', mode: 'no-store' });
}

/** Preserve origin cache headers without adding gateway storage behavior. */
export function passThroughCache(): GatewayCachePolicy {
	return Object.freeze({ kind: 'gateway-cache', mode: 'pass-through' });
}

/** Flatten an endpoint composition to exact leaf definitions without copying routes. */
export function leafEndpoints(input: import('@utils/server/endpoint').EndpointCompositionInput): readonly import('@utils/server/endpoint').EndpointDefinition[] {
	const result: import('@utils/server/endpoint').EndpointDefinition[] = [];
	const seen = new Set<import('@utils/server/endpoint').EndpointDefinition>();
	const visit = (entry: import('@utils/server/endpoint').EndpointEntry): void => {
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
 * Flattens mounts into the ordered representation consumed by compiled gateway routing.
 *
 * Gateway internals route only definitions selected by the composition root and keep gateway trust policy out of service-domain behavior.
 *
 * @internal
 */
function flattenMounts(input: GatewayDefinitionInput['services']): readonly GatewayMount[] {
	const result: GatewayMount[] = [];
	const visit = (value: GatewayMount | readonly GatewayMount[]): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if ((value as GatewayMount).kind !== 'gateway-mount') throw new TypeError('Gateway services must be created with gateway.mount().');
		result.push(value as GatewayMount);
	};
	for (const value of input) visit(value);
	return Object.freeze(result);
}

/**
 * Normalizes origin into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeOrigin(value: GatewayOrigin): string {
	const url = value instanceof URL ? value : new URL(value);
	if (url.username || url.password) throw new TypeError('Gateway origins may not contain credentials.');
	if (url.protocol !== 'https:' && !isLoopbackHttp(url)) throw new TypeError('Gateway origins must use HTTPS outside loopback development.');
	url.hash = '';
	url.search = '';
	url.pathname = url.pathname.replace(/\/$/, '');
	return url.toString().replace(/\/$/, '');
}

/**
 * Checks whether loopback http satisfies the condition required by compiled gateway routing.
 *
 * @internal
 */
function isLoopbackHttp(url: URL): boolean {
	return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * Converts duration into the millisecond value used by compiled gateway routing.
 *
 * @internal
 */
function durationMilliseconds(duration: Temporal.Duration): number {
	return duration.total({ unit: 'milliseconds', relativeTo: Temporal.PlainDate.from('2000-01-01') });
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(value)}.`);
}
