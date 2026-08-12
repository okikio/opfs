import * as catalogProtocol from '@utils/catalog';
import * as resilience from '@utils/resilience';
import type {
	Catalog,
	CatalogEntryIdentity,
	CatalogSelection,
	DefinitionInput,
} from '@utils/catalog';

import type {
	MiddlewareContextDefinition,
	MiddlewareContextDefinitionInput,
	MiddlewareDefinition,
	MiddlewareDefinitionInput,
	MiddlewareDocument,
	MiddlewareHandler,
	MiddlewareInput,
	MiddlewareLane,
	MiddlewareNext,
	MiddlewareOnceKey,
	MiddlewarePlan,
	MiddlewareProblems,
	MiddlewareProvides,
	MiddlewareRequires,
	MiddlewareResources,
	MiddlewareUse,
	MiddlewareValidationIssue,
	MiddlewareValidationResult,
} from './types.ts';

const lanes = Object.freeze([
	'wholeRequest',
	'beforeValidation',
	'afterValidation',
	'aroundOperation',
] as const satisfies readonly MiddlewareLane[]);

/** Define a typed request-context value. */
export function context<Value>(): (
	input: MiddlewareContextDefinitionInput,
) => MiddlewareContextDefinition<Value>;
/** Define an untyped request-context value used only for static composition. */
export function context(input: MiddlewareContextDefinitionInput): MiddlewareContextDefinition<unknown>;
/** Create the direct or curried middleware-context authoring function. */
export function context(
	input?: MiddlewareContextDefinitionInput,
): MiddlewareContextDefinition | ((input: MiddlewareContextDefinitionInput) => MiddlewareContextDefinition) {
	if (input === undefined) return createContext;
	return createContext(input);
}

/**
 * Creates context while preserving the module's ownership rules.
 *
 * @internal
 */
function createContext(input: MiddlewareContextDefinitionInput): MiddlewareContextDefinition {
	assertId(input.id, 'middleware context');
	if (input.description.trim().length === 0) throw new TypeError('Middleware context description cannot be empty.');
	return Object.freeze({ kind: 'middleware-context', ...input }) as MiddlewareContextDefinition;
}

/** Define one import-safe middleware contract. */
export function define<
	const Input extends MiddlewareDefinitionInput,
>(input: Input): MiddlewareDefinition<
	MiddlewareRequires<Input>,
	MiddlewareProvides<Input>,
	MiddlewareResources<Input>,
	MiddlewareProblems<Input>
> {
	assertId(input.id, 'middleware');
	if (input.description.trim().length === 0) throw new TypeError('Middleware description cannot be empty.');
	const requires = Object.freeze([...(input.requires ?? [])]) as unknown as MiddlewareRequires<Input>;
	const provides = Object.freeze([...(input.provides ?? [])]) as unknown as MiddlewareProvides<Input>;
	assertContextList(requires, 'requires');
	assertContextList(provides, 'provides');
	return Object.freeze({
		kind: 'middleware',
		id: input.id,
		description: input.description,
		requires,
		provides,
		...(input.resources !== undefined ? { resources: snapshotInput(input.resources) } : {}),
		...(input.problems !== undefined ? { problems: snapshotInput(input.problems) } : {}),
		...(input.permissions !== undefined ? { permissions: snapshotInput(input.permissions) } : {}),
		...(input.entitlements !== undefined ? { entitlements: snapshotInput(input.entitlements) } : {}),
		...(input.authentication !== undefined ? { authentication: snapshotInput(input.authentication) } : {}),
		...(input.resiliency !== undefined ? { resiliency: resilience.compose(input.resiliency) } : {}),
		...(input.documentation ? { documentation: Object.freeze({ ...input.documentation }) } : {}),
	}) as MiddlewareDefinition<
		MiddlewareRequires<Input>,
		MiddlewareProvides<Input>,
		MiddlewareResources<Input>,
		MiddlewareProblems<Input>
	>;
}

/**
 * Captures the snapshot input as immutable state for middleware definition and execution.
 *
 * @internal
 */
function snapshotInput<Value>(value: Value): Value {
	if (!Array.isArray(value)) return value;
	return Object.freeze(value.map((entry) => snapshotInput(entry))) as Value;
}

/** Bind runtime behavior to one exact middleware definition. */
export function handler<
	Definition extends MiddlewareDefinition,
	Host = unknown,
	Result = unknown,
>(
	definition: Definition,
	handle: MiddlewareHandler<Definition, Host, Result>['handle'],
): MiddlewareHandler<Definition, Host, Result> {
	if (typeof handle !== 'function') throw new TypeError('Middleware handler must be a function.');
	return Object.freeze({ kind: 'middleware-handler', definition, handle });
}

const onceByRequest = new WeakMap<Request, Set<MiddlewareOnceKey>>();

/**
 * Wrap an exact middleware handler so its inner work executes at most once for
 * one Request, even when the same definition is contributed by several layers.
 *
 * Duplicate occurrences still call `next()`, preserving the compiled onion.
 * The request-keyed state is weak and cannot suppress another request.
 */
export function once<
	Definition extends MiddlewareDefinition,
	Host = unknown,
	Result = unknown,
>(
	binding: MiddlewareHandler<Definition, Host, Result>,
	key: MiddlewareOnceKey = binding.definition,
): MiddlewareHandler<Definition, Host, Result> {
	return handler(binding.definition, async (context, next) => {
		let executed = onceByRequest.get(context.request);
		if (executed === undefined) {
			executed = new Set();
			onceByRequest.set(context.request, executed);
		}
		if (executed.has(key)) return await next();
		executed.add(key);
		return await binding.handle(context, next);
	});
}

/** Create a named middleware catalog. */
export function middlewareCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, MiddlewareDefinition>>,
>(namespace: Namespace, entries: Entries): Catalog<Entries[keyof Entries], Entries> {
	return catalogProtocol.create(namespace, entries);
}

/** Select an immutable key-preserving middleware subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, MiddlewareDefinition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogProtocol.select(source, keys);
}

/** Compose middleware definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends MiddlewareDefinition>(
	...input: readonly DefinitionInput<Entry>[]
): readonly Entry[] {
	return catalogProtocol.compose(...input);
}

/** Surround the complete application request pipeline before transport materialization. */
export const wholeRequest = <Definition extends MiddlewareDefinition>(definition: Definition): MiddlewareUse<Definition, 'wholeRequest'> =>
	use(definition, 'wholeRequest');
/** Place middleware immediately before request validation. */
export const beforeValidation = <Definition extends MiddlewareDefinition>(definition: Definition): MiddlewareUse<Definition, 'beforeValidation'> =>
	use(definition, 'beforeValidation');
/** Place middleware in the normal post-validation lane. */
export const afterValidation = <Definition extends MiddlewareDefinition>(definition: Definition): MiddlewareUse<Definition, 'afterValidation'> =>
	use(definition, 'afterValidation');
/** Place middleware immediately around endpoint handler invocation. */
export const aroundOperation = <Definition extends MiddlewareDefinition>(definition: Definition): MiddlewareUse<Definition, 'aroundOperation'> =>
	use(definition, 'aroundOperation');

/** Normalize middleware input while preserving authored order within each lane. */
export function plan(input: MiddlewareInput | undefined): MiddlewarePlan {
	const result: Record<MiddlewareLane, MiddlewareDefinition[]> = {
		wholeRequest: [],
		beforeValidation: [],
		afterValidation: [],
		aroundOperation: [],
	};
	if (input !== undefined) visit(input, (definition, lane) => result[lane].push(definition));
	return freezePlan(result);
}

/** Validate ordering, IDs, and context guarantees for one middleware input. */
export function validate(
	input: MiddlewareInput | undefined,
	initialContexts: readonly MiddlewareContextDefinition[] = [],
): MiddlewareValidationResult {
	const normalized = plan(input);
	const issues: MiddlewareValidationIssue[] = [];
	const idOwners = new Map<string, MiddlewareDefinition>();
	const available = new Set(initialContexts);
	const providers = new Map<MiddlewareContextDefinition, MiddlewareDefinition>();

	for (const lane of lanes) {
		for (const definition of normalized[lane]) {
			const owner = idOwners.get(definition.id);
			if (owner && owner !== definition) {
				issues.push(issue('duplicate-id', `Middleware ID ${JSON.stringify(definition.id)} is duplicated.`, definition));
			}
			idOwners.set(definition.id, definition);
			for (const required of definition.requires) {
				if (!available.has(required)) {
					issues.push(issue('missing-required-context', `${definition.id} requires unavailable context ${required.id}.`, definition, required));
				}
			}
			for (const provided of definition.provides) {
				const existing = providers.get(provided);
				if (existing && existing !== definition) {
					issues.push(issue('duplicate-context-provider', `${provided.id} is provided by both ${existing.id} and ${definition.id}.`, definition, provided));
				}
				providers.set(provided, definition);
				available.add(provided);
			}
		}
	}

	return issues.length === 0
		? Object.freeze({ valid: true, plan: normalized })
		: Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

/** Create deterministic JSON-safe middleware documentation. */
export function document(input: DefinitionInput<MiddlewareDefinition>): readonly MiddlewareDocument[] {
	return Object.freeze(catalogProtocol.values(input).map((definition): MiddlewareDocument => Object.freeze({
		id: definition.id,
		description: definition.description,
		requires: Object.freeze(definition.requires.map((item) => item.id)),
		provides: Object.freeze(definition.provides.map((item) => item.id)),
		resources: ids(definition.resources),
		problems: ids(definition.problems),
		permissions: ids(definition.permissions),
		entitlements: ids(definition.entitlements),
		resiliency: definition.resiliency === undefined ? Object.freeze([]) : Object.freeze(resilience.compose(definition.resiliency).map((policy) => policy.type)),
		...(definition.documentation !== undefined ? { documentation: definition.documentation } : {}),
	})));
}

/**
 * Creates one middleware selection entry that retains exact definition identity and caller-supplied configuration.
 *
 * @internal
 */
function use<Definition extends MiddlewareDefinition, Lane extends MiddlewareLane>(
	definition: Definition,
	lane: Lane,
): MiddlewareUse<Definition, Lane> {
	return Object.freeze({ kind: 'middleware-use', definition, lane });
}

/**
 * Walks nested input while preserving the module's deterministic traversal rules.
 *
 * It keeps middleware definitions import-safe while making request-phase contribution and execution order explicit.
 *
 * @internal
 */
function visit(
	input: MiddlewareInput,
	accept: (definition: MiddlewareDefinition, lane: MiddlewareLane) => void,
): void {
	if (isMiddlewareArray(input)) {
		for (const item of input) visit(item, accept);
		return;
	}
	if (input.kind === 'middleware-use') {
		accept(input.definition, input.lane);
		return;
	}
	// Plain middleware defaults to the normal post-validation operation lane.
	accept(input, 'afterValidation');
}

/**
 * Checks whether middleware array satisfies the condition required by middleware definition and execution.
 *
 * @internal
 */
function isMiddlewareArray(input: MiddlewareInput): input is readonly MiddlewareInput[] {
	return Array.isArray(input);
}

/**
 * Snapshots plan so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezePlan(input: Record<MiddlewareLane, MiddlewareDefinition[]>): MiddlewarePlan {
	return Object.freeze({
		wholeRequest: Object.freeze(input.wholeRequest),
		beforeValidation: Object.freeze(input.beforeValidation),
		afterValidation: Object.freeze(input.afterValidation),
		aroundOperation: Object.freeze(input.aroundOperation),
	});
}

/**
 * Collects the ids used to preserve stable identity in middleware definition and execution.
 *
 * @internal
 */
function ids(input: DefinitionInput<CatalogEntryIdentity> | undefined): readonly string[] {
	return input === undefined
		? Object.freeze([])
		: Object.freeze(catalogProtocol.values(input).map((entry) => entry.id));
}

/**
 * Rejects invalid context list before it can enter authoritative module state.
 *
 * @internal
 */
function assertContextList(values: readonly MiddlewareContextDefinition[], field: string): void {
	const seen = new Set<MiddlewareContextDefinition>();
	for (const value of values) {
		if (value.kind !== 'middleware-context') throw new TypeError(`Middleware ${field} entries must be context definitions.`);
		if (seen.has(value)) throw new TypeError(`Middleware ${field} repeats context ${JSON.stringify(value.id)}.`);
		seen.add(value);
	}
}

/**
 * Rejects invalid id before it can enter authoritative module state.
 *
 * @internal
 */
function assertId(id: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(id)}.`);
}

/**
 * Checks whether sue satisfies the condition required by middleware definition and execution.
 *
 * Middleware internals make context contribution, ordering, and request-phase ownership explicit before the server runtime executes them.
 *
 * @internal
 */
function issue(
	code: MiddlewareValidationIssue['code'],
	message: string,
	definition?: MiddlewareDefinition,
	context?: MiddlewareContextDefinition,
): MiddlewareValidationIssue {
	return Object.freeze({
		code,
		message,
		...(definition !== undefined ? { definition } : {}),
		...(context !== undefined ? { context } : {}),
	});
}

export { middlewareCatalog as catalog };
export type {
	MiddlewareContextDefinition,
	MiddlewareContextDefinitionInput,
	MiddlewareContextStore,
	MiddlewareContextValue,
	MiddlewareDefinition,
	MiddlewareDefinitionInput,
	MiddlewareDocument,
	MiddlewareHandler,
	MiddlewareHandlerContext,
	MiddlewareInput,
	MiddlewareLane,
	MiddlewareNext,
	MiddlewareOnceKey,
	MiddlewarePlan,
	MiddlewareProblems,
	MiddlewareProvides,
	MiddlewareRequires,
	MiddlewareResourceDefinition,
	MiddlewareResourceResolver,
	MiddlewareResourceValue,
	MiddlewareResources,
	MiddlewareUse,
	MiddlewareValidationIssue,
	MiddlewareValidationResult,
} from './types.ts';
