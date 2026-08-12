/**
 * Import-safe resource definitions and lazily acquired owned collections.
 *
 * Definitions describe required capabilities and dependencies. Implementations
 * provide host-specific construction without changing definition identity.
 *
 * @module
 */
import * as catalogCore from '@utils/catalog';
import type {
	Catalog,
	CatalogEntryIdentity,
	CatalogSelection,
	DefinitionInput as CatalogDefinitionInput,
} from '@utils/catalog';
import * as context from '@utils/context';

import type {
	AnyImplementation,
	Collection,
	CreateArguments,
	CreateOptions,
	Definition,
	DefinitionInput,
	DependencyRecord,
	Document,
	ErasedCreateArguments,
	Implementation,
	ImplementationInput,
	ImplementationSet,
	ValidationIssue,
	ValidationResult,
	Value,
} from './types.ts';

const emptyDependencies = Object.freeze(Object.create(null)) as Readonly<Record<string, never>>;
const emptyEnvironment = Object.freeze(Object.create(null)) as Readonly<Record<string, never>>;

/** Error raised when two distinct definitions reuse one stable resource ID. */
export class DefinitionConflictError extends Error {
	readonly id: string;
	readonly first: Definition;
	readonly second: Definition;

	constructor(id: string, first: Definition, second: Definition) {
		super(`Resource identifier ${JSON.stringify(id)} is owned by different definition objects.`);
		this.name = 'DefinitionConflictError';
		this.id = id;
		this.first = first;
		this.second = second;
	}
}

/** Error raised when a collection receives two implementations for one definition. */
export class ImplementationConflictError extends Error {
	readonly definition: Definition;

	constructor(definition: Definition) {
		super(`Resource ${JSON.stringify(definition.id)} has more than one implementation.`);
		this.name = 'ImplementationConflictError';
		this.definition = definition;
	}
}

/** Error raised when a reachable resource definition has no implementation. */
export class MissingImplementationError extends Error {
	readonly definition: Definition;
	readonly requiredBy: readonly Definition[];

	constructor(definition: Definition, requiredBy: readonly Definition[] = []) {
		const suffix = requiredBy.length === 0
			? ''
			: `\nRequired by:\n${requiredBy.map((item) => `  ${item.id}`).join('\n')}`;
		super(`Missing resource implementation.\n\nResource:\n  ${definition.id}${suffix}`);
		this.name = 'MissingImplementationError';
		this.definition = definition;
		this.requiredBy = Object.freeze([...requiredBy]);
	}
}

/** Error raised for a cycle in the static resource dependency graph. */
export class DependencyCycleError extends Error {
	readonly path: readonly Definition[];

	constructor(path: readonly Definition[]) {
		super(`Resource dependency cycle detected:\n${path.map((item) => item.id).join(' -> ')}`);
		this.name = 'DependencyCycleError';
		this.path = Object.freeze([...path]);
	}
}

/** Error raised when a disposing or disposed collection is used. */
export class CollectionDisposedError extends Error {
	constructor() {
		super('The resource collection is disposing or has already been disposed.');
		this.name = 'CollectionDisposedError';
	}
}

/**
 * Define a provider-neutral resource when only static metadata is needed.
 *
 * Use the curried overload, `resource.define<Value>()({...})`, when dependent
 * implementations need the concrete resource value type.
 */
export function define<
	const Dependencies extends DependencyRecord = Readonly<Record<string, never>>,
	const Environment extends DefinitionInput<Dependencies>['environment'] = undefined,
>(input: DefinitionInput<Dependencies, Environment>): Definition<unknown, Dependencies, Environment>;
/** Define a resource with an explicit concrete value contract. */
export function define<ResourceValue>(): <
	const Dependencies extends DependencyRecord = Readonly<Record<string, never>>,
	const Environment extends DefinitionInput<Dependencies>['environment'] = undefined,
>(input: DefinitionInput<Dependencies, Environment>) => Definition<ResourceValue, Dependencies, Environment>;
/** Create the direct or curried resource-definition authoring function. */
export function define(
	input?: DefinitionInput<DependencyRecord, DefinitionInput<DependencyRecord>['environment']>,
): Definition | ((input: DefinitionInput) => Definition) {
	if (input === undefined) return (next: DefinitionInput) => defineResource(next);
	return defineResource(input);
}

/**
 * Creates the define resource as import-safe definition data for the resource collection.
 *
 * Resource internals preserve exact definition identity, lazy dependency acquisition, shared in-flight creation, and reverse-order disposal.
 *
 * @internal
 */
function defineResource<
	Dependencies extends DependencyRecord,
	Environment extends DefinitionInput<Dependencies>['environment'],
>(input: DefinitionInput<Dependencies, Environment>): Definition<unknown, Dependencies, Environment> {
	assertDefinitionInput(input);
	const dependencies = input.dependencies === undefined ? emptyDependencies : freezeRecord(input.dependencies);
	return Object.freeze({
		...input,
		kind: 'resource',
		dependencies,
		...(input.health === undefined ? {} : { health: Object.freeze({ ...input.health }) }),
		...(input.documentation === undefined ? {} : { documentation: Object.freeze({ ...input.documentation }) }),
	}) as Definition<unknown, Dependencies, Environment>;
}

/** Create a named immutable resource catalog. */
export function resourceCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
>(namespace: Namespace, entries: Entries): Catalog<Entries[keyof Entries], Entries> {
	return catalogCore.create(namespace, entries);
}

/** Select an immutable key-preserving resource subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogCore.select(source, keys);
}

/** Compose resource definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends Definition>(
	...inputs: readonly CatalogDefinitionInput<Entry>[]
): readonly Entry[] {
	return catalogCore.compose(...inputs);
}

/** Bind one host-specific constructor to one exact resource definition. */
export function implement<
	ResourceDefinition extends Definition,
	ResourceValue extends Value<ResourceDefinition>,
	Host = unknown,
>(
	definition: ResourceDefinition,
	input: ImplementationInput<ResourceDefinition, ResourceValue, Host>,
): Implementation<ResourceDefinition, ResourceValue, Host> {
	if (typeof input.create !== 'function') throw new TypeError('Resource implementation create must be a function.');
	return Object.freeze({ definition, create: input.create });
}

/**
 * Assemble an explicit, import-safe universe of resource implementations.
 *
 * Repeating the same implementation object is harmless. A different
 * implementation for the same exact definition is rejected.
 */
export function implementations<const Implementations extends readonly AnyImplementation[]>(
	...input: Implementations
): ImplementationSet<Implementations> {
	const accepted: AnyImplementation[] = [];
	const seenObjects = new Set<AnyImplementation>();
	const byDefinition = new Map<Definition, AnyImplementation>();
	const byId = new Map<string, Definition>();

	for (const implementation of input) {
		if (seenObjects.has(implementation)) continue;
		seenObjects.add(implementation);
		assertImplementation(implementation);

		const idOwner = byId.get(implementation.definition.id);
		if (idOwner !== undefined && idOwner !== implementation.definition) {
			throw new DefinitionConflictError(implementation.definition.id, idOwner, implementation.definition);
		}
		byId.set(implementation.definition.id, implementation.definition);

		const existing = byDefinition.get(implementation.definition);
		if (existing !== undefined && existing !== implementation) {
			throw new ImplementationConflictError(implementation.definition);
		}
		byDefinition.set(implementation.definition, implementation);
		accepted.push(implementation);
	}

	return Object.freeze({ implementations: Object.freeze(accepted) }) as unknown as ImplementationSet<Implementations>;
}

/** Validate a definition graph and, when supplied, implementation coverage. */
export function validate(
	input: CatalogDefinitionInput<Definition> | ImplementationSet,
): ValidationResult {
	const issues: ValidationIssue[] = [];
	const roots = isImplementationSet(input)
		? input.implementations.map((implementation) => implementation.definition)
		: catalogCore.values(input);
	const definitions = collectDefinitions(roots, issues);

	if (isImplementationSet(input)) {
		const seen = new Map<Definition, AnyImplementation>();
		for (const implementation of input.implementations) {
			const previous = seen.get(implementation.definition);
			if (previous !== undefined && previous !== implementation) {
				issues.push(Object.freeze({
					code: 'duplicate-implementation',
					message: `Resource ${JSON.stringify(implementation.definition.id)} has multiple implementations.`,
					definition: implementation.definition,
				}));
			}
			seen.set(implementation.definition, implementation);
		}
		for (const definition of definitions) {
			if (seen.has(definition)) continue;
			issues.push(Object.freeze({
				code: 'missing-implementation',
				message: `Resource ${JSON.stringify(definition.id)} has no implementation.`,
				definition,
				requiredBy: Object.freeze(findDependents(definition, definitions)),
			}));
		}
	}

	return issues.length === 0
		? Object.freeze({ valid: true, definitions: Object.freeze(definitions) })
		: Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

/** Create deterministic, JSON-safe documentation for a resource graph. */
export function document(
	input: CatalogDefinitionInput<Definition>,
	implementationSet?: ImplementationSet,
): readonly Document[] {
	const definitions = collectDefinitions(catalogCore.values(input), []);
	const available = implementationSet === undefined
		? undefined
		: new Set(implementationSet.implementations.map((implementation) => implementation.definition));

	return Object.freeze(definitions.map((definition): Document => {
		const direct = Object.values(definition.dependencies);
		const transitive = collectTransitiveDependencies(definition);
		const environment = definition.environment?.fields.map((field) => Object.freeze({
			key: field.key,
			reason: field.reason,
			requirementId: definition.environment!.id,
		})) ?? Object.freeze([]);
		return Object.freeze({
			id: definition.id,
			description: definition.description,
			dependencies: Object.freeze(direct.map((dependency) => dependency.id)),
			transitiveDependencies: Object.freeze(transitive.map((dependency) => dependency.id)),
			environment: Object.freeze([...environment]),
			permissions: ids(definition.permissions),
			failures: ids(definition.failures),
			...(available === undefined ? {} : { implementationAvailable: available.has(definition) }),
			...(definition.health === undefined ? {} : { health: definition.health }),
			...(definition.documentation === undefined ? {} : { documentation: definition.documentation }),
		});
	}));
}

/** Alias for {@link document} when generating deployment or operator manifests. */
export const manifest = document;

/** Create one independently owned, lazy resource collection. */
export function create<Host>(implementationSet: ImplementationSet, options: CreateOptions<Host>): Collection {
	const validation = validate(implementationSet);
	if (!validation.valid) throwValidationIssue(validation.issues[0]!);
	return new LiveCollection(implementationSet, options);
}

/**
 * Owns the internal live collection state used by the resource collection.
 *
 * ```text
 * collection.get(Resource)
 *        |
 *        +-- acquire declared dependencies first
 *        |
 *        +-- share one in-flight create() per definition
 *        |
 *        `-- remember acquired value and disposal order
 *
 * collection.dispose()
 *        `-- last acquired -> ... -> first acquired
 * ```
 *
 * Resource internals preserve exact definition identity, lazy dependency
 * acquisition, shared in-flight creation, and reverse-order disposal.
 *
 * @internal
 */
class LiveCollection implements Collection {
	readonly #implementationByDefinition: ReadonlyMap<Definition, AnyImplementation>;
	readonly #environment: Readonly<Record<string, unknown>>;
	readonly #host: unknown;
	readonly #ctx: context.Owned;
	readonly #acquisitions = new Map<Definition, Promise<unknown>>();
	readonly #values = new Map<Definition, unknown>();
	readonly #disposalOrder: unknown[] = [];
	#state: 'active' | 'disposing' | 'disposed' = 'active';
	#disposalPromise: Promise<void> | undefined;

	constructor(set: ImplementationSet, options: CreateOptions<unknown>) {
		this.#implementationByDefinition = new Map(
			set.implementations.map((implementation) => [implementation.definition, implementation] as const),
		);
		this.#environment = options.environment ?? emptyEnvironment;
		this.#host = options.host;
		this.#ctx = context.child(options.ctx);
	}

	/**
	 * Checks whether the required state is present for the resource collection.
	 *
	 * @internal
	 */
	has<ResourceDefinition extends Definition>(definition: ResourceDefinition): boolean {
		return this.#implementationByDefinition.has(definition);
	}

	/**
	 * Gets state from the resource collection after its ownership and validation rules have been established.
	 *
	 * @internal
	 */
	get<ResourceDefinition extends Definition>(definition: ResourceDefinition): Promise<Value<ResourceDefinition>> {
		if (this.#state !== 'active') return Promise.reject(new CollectionDisposedError());
		if (!this.#implementationByDefinition.has(definition)) {
			return Promise.reject(new MissingImplementationError(definition));
		}
		return this.#resolve(definition, []) as Promise<Value<ResourceDefinition>>;
	}

	/**
	 * Resolves state from already validated module inputs.
	 *
	 * It preserves exact resource-definition identity, lazy dependency acquisition, and reverse-order collection disposal.
	 *
	 * @internal
	 */
	async #resolve(definition: Definition, path: readonly Definition[]): Promise<unknown> {
		if (this.#state !== 'active') throw new CollectionDisposedError();
		if (this.#values.has(definition)) return this.#values.get(definition);

		const cycleIndex = path.indexOf(definition);
		if (cycleIndex >= 0) throw new DependencyCycleError([...path.slice(cycleIndex), definition]);

		const existing = this.#acquisitions.get(definition);
		if (existing !== undefined) return await existing;

		const acquisition = this.#createValue(definition, [...path, definition]);
		this.#acquisitions.set(definition, acquisition);
		try {
			return await acquisition;
		} catch (error) {
			this.#acquisitions.delete(definition);
			throw error;
		}
	}

	/**
	 * Creates value while preserving the module's ownership rules.
	 *
	 * It preserves exact resource-definition identity, lazy dependency acquisition, and reverse-order collection disposal.
	 *
	 * @internal
	 */
	async #createValue(definition: Definition, path: readonly Definition[]): Promise<unknown> {
		const implementation = this.#implementationByDefinition.get(definition);
		if (implementation === undefined) throw new MissingImplementationError(definition, path.slice(0, -1));

		const dependencies: Record<string, unknown> = Object.create(null);
		for (const [key, dependency] of Object.entries(definition.dependencies)) {
			dependencies[key] = await this.#resolve(dependency, path);
		}

		context.check(this.#ctx);
		const arguments_: ErasedCreateArguments = Object.freeze({
			definition,
			dependencies: Object.freeze(dependencies),
			environment: selectEnvironment(definition, this.#environment),
			host: this.#host,
			ctx: this.#ctx,
		});
		const value = await implementation.create(arguments_);

		if (this.#state !== 'active') {
			await disposeValue(value);
			throw new CollectionDisposedError();
		}

		this.#values.set(definition, value);
		this.#disposalOrder.push(value);
		return value;
	}

	/**
	 * Releases owned state and waits for cleanup completion when used with `await using`.
	 *
	 * @internal
	 */
	[Symbol.asyncDispose](): Promise<void> {
		if (this.#disposalPromise !== undefined) return this.#disposalPromise;
		this.#state = 'disposing';
		context.cancel(this.#ctx, new CollectionDisposedError());
		this.#disposalPromise = this.#dispose();
		return this.#disposalPromise;
	}

	/**
	 * Disposes owned state exactly once and releases all module-owned resources.
	 *
	 * It preserves exact resource-definition identity, lazy dependency acquisition, and reverse-order collection disposal.
	 *
	 * @internal
	 */
	async #dispose(): Promise<void> {
		const errors: unknown[] = [];
		await Promise.allSettled([...this.#acquisitions.values()]);
		for (let index = this.#disposalOrder.length - 1; index >= 0; index -= 1) {
			try {
				await disposeValue(this.#disposalOrder[index]);
			} catch (error) {
				errors.push(error);
			}
		}
		this.#values.clear();
		this.#acquisitions.clear();
		this.#state = 'disposed';
		await this.#ctx[Symbol.asyncDispose]();
		if (errors.length > 0) throw new AggregateError(errors, 'One or more resources failed to dispose.');
	}
}

/**
 * Collects definitions while preserving deterministic identity and order.
 *
 * It preserves exact resource-definition identity, lazy dependency acquisition, and reverse-order collection disposal.
 *
 * @internal
 */
function collectDefinitions(roots: readonly Definition[], issues: ValidationIssue[]): Definition[] {
	const definitions: Definition[] = [];
	const visited = new Set<Definition>();
	const visiting: Definition[] = [];
	const byId = new Map<string, Definition>();

	const visit = (definition: Definition): void => {
		const owner = byId.get(definition.id);
		if (owner !== undefined && owner !== definition) {
			issues.push(Object.freeze({
				code: 'duplicate-definition-id',
				message: `Resource identifier ${JSON.stringify(definition.id)} is owned by different definitions.`,
				id: definition.id,
				first: owner,
				second: definition,
			}));
			return;
		}
		byId.set(definition.id, definition);

		const cycleIndex = visiting.indexOf(definition);
		if (cycleIndex >= 0) {
			const path = Object.freeze([...visiting.slice(cycleIndex), definition]);
			issues.push(Object.freeze({
				code: 'dependency-cycle',
				message: `Resource dependency cycle detected: ${path.map((item) => item.id).join(' -> ')}`,
				path,
			}));
			return;
		}
		if (visited.has(definition)) return;

		visiting.push(definition);
		for (const dependency of Object.values(definition.dependencies)) visit(dependency);
		visiting.pop();
		visited.add(definition);
		definitions.push(definition);
	};

	for (const root of roots) visit(root);
	return definitions;
}

/**
 * Finds dependents used by the resource collection without creating it when absent.
 *
 * @internal
 */
function findDependents(target: Definition, definitions: readonly Definition[]): Definition[] {
	return definitions.filter((definition) => Object.values(definition.dependencies).includes(target));
}

/**
 * Collects transitive dependencies while preserving deterministic identity and order.
 *
 * It preserves exact resource-definition identity, lazy dependency acquisition, and reverse-order collection disposal.
 *
 * @internal
 */
function collectTransitiveDependencies(definition: Definition): Definition[] {
	const result: Definition[] = [];
	const seen = new Set<Definition>();
	const visit = (current: Definition): void => {
		for (const dependency of Object.values(current.dependencies)) {
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			result.push(dependency);
			visit(dependency);
		}
	};
	visit(definition);
	return result;
}

/**
 * Collects the ids used to preserve stable identity in the resource collection.
 *
 * @internal
 */
function ids(input: CatalogDefinitionInput<CatalogEntryIdentity> | undefined): readonly string[] {
	return input === undefined ? Object.freeze([]) : Object.freeze(catalogCore.values(input).map((entry) => entry.id));
}

/**
 * Selects environment needed by the resource collection without changing the source definition.
 *
 * @internal
 */
function selectEnvironment(
	definition: Definition,
	environment: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	if (definition.environment === undefined) return emptyEnvironment;
	const selected: Record<string, unknown> = Object.create(null);
	for (const field of definition.environment.fields) selected[field.key] = environment[field.key];
	return Object.freeze(selected);
}

/**
 * Disposes value exactly once and releases all module-owned resources.
 *
 * @internal
 */
async function disposeValue(value: unknown): Promise<void> {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
	const asyncDispose = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose];
	if (typeof asyncDispose === 'function') {
		await asyncDispose.call(value);
		return;
	}
	const dispose = (value as Partial<Disposable>)[Symbol.dispose];
	if (typeof dispose === 'function') dispose.call(value);
}

/**
 * Snapshots record so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeRecord<Entry>(record: Readonly<Record<string, Entry>>): Readonly<Record<string, Entry>> {
	const target: Record<string, Entry> = Object.create(null);
	for (const [key, value] of Object.entries(record)) {
		Object.defineProperty(target, key, { value, enumerable: true, writable: false, configurable: false });
	}
	return Object.freeze(target);
}

/**
 * Rejects invalid definition input before it can enter authoritative module state.
 *
 * @internal
 */
function assertDefinitionInput(
	input: DefinitionInput<DependencyRecord, DefinitionInput<DependencyRecord>['environment']>,
): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(input.id)) throw new TypeError(`Invalid resource id ${JSON.stringify(input.id)}.`);
	if (input.description.trim().length === 0) throw new TypeError('Resource description cannot be empty.');
	for (const [key, dependency] of Object.entries(input.dependencies ?? {})) {
		if (key.length === 0) throw new TypeError('Resource dependency keys cannot be empty.');
		if (!isDefinition(dependency)) throw new TypeError(`Resource dependency ${JSON.stringify(key)} is not a resource definition.`);
	}
}

/**
 * Rejects invalid implementation before it can enter authoritative module state.
 *
 * @internal
 */
function assertImplementation(value: AnyImplementation): void {
	if (!value || typeof value !== 'object' || !isDefinition(value.definition) || typeof value.create !== 'function') {
		throw new TypeError('Resource implementation must contain a definition and create function.');
	}
}

/**
 * Checks whether definition satisfies the condition required by the resource collection.
 *
 * @internal
 */
function isDefinition(value: unknown): value is Definition {
	return typeof value === 'object' && value !== null &&
		(value as { kind?: unknown }).kind === 'resource' &&
		typeof (value as { id?: unknown }).id === 'string' &&
		typeof (value as { description?: unknown }).description === 'string';
}

/**
 * Checks whether implementation set satisfies the condition required by the resource collection.
 *
 * @internal
 */
function isImplementationSet(value: unknown): value is ImplementationSet {
	return typeof value === 'object' && value !== null &&
		Array.isArray((value as { implementations?: unknown }).implementations);
}

/**
 * Propagates validation issue through the controlled iterator path used by the resource collection.
 *
 * Resource internals preserve exact definition identity, lazy dependency acquisition, shared in-flight creation, and reverse-order disposal.
 *
 * @internal
 */
function throwValidationIssue(issue: ValidationIssue): never {
	switch (issue.code) {
		case 'duplicate-definition-id':
			throw new DefinitionConflictError(issue.id, issue.first, issue.second);
		case 'duplicate-implementation':
			throw new ImplementationConflictError(issue.definition);
		case 'missing-implementation':
			throw new MissingImplementationError(issue.definition, issue.requiredBy);
		case 'dependency-cycle':
			throw new DependencyCycleError(issue.path);
	}
}

export { resourceCatalog as catalog };
export type {
	AnyImplementation,
	Collection,
	CreateArguments,
	CreateOptions,
	Definition,
	DefinitionInput,
	DependencyRecord,
	DependencyValues,
	Document,
	DocumentationMetadata,
	Environment,
	ErasedCreateArguments,
	HealthMetadata,
	Implementation,
	ImplementationInput,
	ImplementationSet,
	Resolver,
	ValidationIssue,
	ValidationResult,
	Value,
} from './types.ts';
