import type {
	CatalogEntryIdentity,
	CatalogEntryValue,
	DefinitionInput as CatalogDefinitionInput,
	ValuedCatalogEntry,
} from '@utils/catalog';
import type { Context } from '@utils/context';
import type { EnvironmentFields, EnvironmentRequirement, InferEnvironmentFields } from '@utils/env';

const resourceDependenciesType: unique symbol = Symbol('kaiju.resource.dependencies-type');
const resourceEnvironmentType: unique symbol = Symbol('kaiju.resource.environment-type');

/** A keyed record of direct resource dependencies. */
export type DependencyRecord = Readonly<Record<string, Definition>>;

/** Optional health metadata included in generated resource documentation. */
export interface HealthMetadata {
	readonly description?: string;
	readonly timeoutMilliseconds?: number;
}

/** Optional external documentation for a resource definition. */
export interface DocumentationMetadata {
	readonly url?: string;
	readonly notes?: string;
}

/** Static, import-safe provider-neutral resource contract. */
export interface Definition<
	ResourceValue = unknown,
	Dependencies extends DependencyRecord = DependencyRecord,
	EnvironmentRequirement_ extends EnvironmentRequirement | undefined = EnvironmentRequirement | undefined,
> extends ValuedCatalogEntry<'resource', ResourceValue> {
	readonly description: string;
	readonly dependencies: Dependencies;
	readonly environment?: EnvironmentRequirement_;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly failures?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly health?: HealthMetadata;
	readonly documentation?: DocumentationMetadata;
	readonly [resourceDependenciesType]: Dependencies;
	readonly [resourceEnvironmentType]: EnvironmentRequirement_;
}

/** Input accepted by {@link define}. */
export interface DefinitionInput<
	Dependencies extends DependencyRecord = Readonly<Record<string, never>>,
	EnvironmentRequirement_ extends EnvironmentRequirement | undefined = undefined,
> {
	readonly id: string;
	readonly description: string;
	readonly dependencies?: Dependencies;
	readonly environment?: EnvironmentRequirement_;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly failures?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly health?: HealthMetadata;
	readonly documentation?: DocumentationMetadata;
}

/** Concrete value carried by a resource definition. */
export type Value<ResourceDefinition extends Definition> = CatalogEntryValue<ResourceDefinition>;

/** Direct dependency values supplied to a resource implementation. */
export type DependencyValues<Dependencies extends DependencyRecord> = {
	readonly [Key in keyof Dependencies]: Value<Dependencies[Key]>;
};

/** Parsed direct environment values supplied to a resource implementation. */
export type Environment<Requirement extends EnvironmentRequirement | undefined> =
	Requirement extends EnvironmentRequirement<infer Fields extends EnvironmentFields>
		? InferEnvironmentFields<Fields>
		: Readonly<Record<string, never>>;

/** Arguments supplied while creating one concrete resource value. */
export interface CreateArguments<ResourceDefinition extends Definition, Host> {
	readonly definition: ResourceDefinition;
	readonly dependencies: DependencyValues<ResourceDefinition['dependencies']>;
	readonly environment: Environment<ResourceDefinition['environment']>;
	readonly host: Host;
	readonly ctx: Context;
}

/** Host-specific implementation for one exact resource definition. */
export interface Implementation<
	ResourceDefinition extends Definition = Definition,
	ResourceValue = Value<ResourceDefinition>,
	Host = unknown,
> {
	readonly definition: ResourceDefinition;
	readonly create: (arguments_: CreateArguments<ResourceDefinition, Host>) => ResourceValue | Promise<ResourceValue>;
}

/** Input accepted by {@link implement}. */
export interface ImplementationInput<ResourceDefinition extends Definition, ResourceValue, Host> {
	readonly create: (arguments_: CreateArguments<ResourceDefinition, Host>) => ResourceValue | Promise<ResourceValue>;
}

/** Runtime arguments shared by heterogeneous resource implementations. */
export interface ErasedCreateArguments {
	readonly definition: Definition;
	readonly dependencies: Readonly<Record<string, unknown>>;
	readonly environment: Readonly<Record<string, unknown>>;
	readonly host: unknown;
	readonly ctx: Context;
}

/** Runtime-erased resource constructor retained in an explicit implementation set. */
export type AnyFactory = {
	bivarianceHack(arguments_: ErasedCreateArguments): unknown | Promise<unknown>;
}['bivarianceHack'];

/** Runtime-erased resource implementation stored in heterogeneous collections. */
export interface AnyImplementation {
	readonly definition: Definition;
	readonly create: AnyFactory;
}

/** Import-safe explicit universe of resource implementations. */
export interface ImplementationSet<
	Implementations extends readonly AnyImplementation[] = readonly AnyImplementation[],
> {
	readonly implementations: Implementations;
}

/** Options used to create one independently owned resource collection. */
export interface CreateOptions<Host> {
	readonly environment?: Readonly<Record<string, unknown>>;
	readonly host: Host;
	readonly ctx: Context;
}

/** Resource resolver narrowed to an allowed definition union. */
export interface Resolver<Allowed extends Definition = Definition> {
	/** Return whether the supplied exact definition has an implementation. */
	has<ResourceDefinition extends Allowed>(definition: ResourceDefinition): boolean;
	/** Lazily create or return the collection-owned value for a definition. */
	get<ResourceDefinition extends Allowed>(definition: ResourceDefinition): Promise<Value<ResourceDefinition>>;
}

/** Live resource resolver and deterministic disposal owner. */
export interface Collection extends Resolver, AsyncDisposable {}

/** Resource graph validation issue. */
export type ValidationIssue =
	| Readonly<{ readonly code: 'duplicate-definition-id'; readonly message: string; readonly id: string; readonly first: Definition; readonly second: Definition }>
	| Readonly<{ readonly code: 'duplicate-implementation'; readonly message: string; readonly definition: Definition }>
	| Readonly<{ readonly code: 'missing-implementation'; readonly message: string; readonly definition: Definition; readonly requiredBy: readonly Definition[] }>
	| Readonly<{ readonly code: 'dependency-cycle'; readonly message: string; readonly path: readonly Definition[] }>;

/** Deterministic validation result for a resource graph. */
export type ValidationResult =
	| Readonly<{ readonly valid: true; readonly definitions: readonly Definition[] }>
	| Readonly<{ readonly valid: false; readonly issues: readonly ValidationIssue[] }>;

/** JSON-safe projection of one resource definition. */
export interface Document {
	readonly id: string;
	readonly description: string;
	readonly dependencies: readonly string[];
	readonly transitiveDependencies: readonly string[];
	readonly environment: readonly Readonly<{ readonly key: string; readonly reason: string; readonly requirementId: string }>[];
	readonly permissions: readonly string[];
	readonly failures: readonly string[];
	readonly implementationAvailable?: boolean;
	readonly health?: HealthMetadata;
	readonly documentation?: DocumentationMetadata;
}
