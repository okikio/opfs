@utils/resource public API usage
================================

Purpose
-------

This reference maps every public export target declared by `@utils/resource` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/resource
---------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AnyImplementation` | interface | Runtime-erased resource implementation stored in heterogeneous collections. | `value: AnyImplementation` | `utils/server/service/compile.ts:435` uses `AnyImplementation`. |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:115` uses `catalog`. |
| `Collection` | interface | Live resource resolver and deterministic disposal owner. | `value: Collection` | `utils/server/service/runtime.ts:56` uses `Collection`. |
| `CollectionDisposedError` | class | Error raised when a disposing or disposed collection is used. | `new CollectionDisposedError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Compose resource definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:117` uses `compose`. |
| `create` | function | Create one independently owned, lazy resource collection. | `create(...)` | `.agents/support/production-fixture.ts:398` uses `create`. |
| `CreateArguments` | interface | Arguments supplied while creating one concrete resource value. | `value: CreateArguments` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CreateOptions` | interface | Options used to create one independently owned resource collection. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Create the direct or curried resource-definition authoring function. | `define(...)` | `.agents/support/production-fixture.ts:200` uses `define`. |
| `Definition` | interface | Static, import-safe provider-neutral resource contract. | `value: Definition` | `utils/activity/types.ts:23` uses `Definition`. |
| `DefinitionConflictError` | class | Error raised when two distinct definitions reuse one stable resource ID. | `new DefinitionConflictError(...)` | `.agents/tests/public-api-matrix.test.ts:172` uses `DefinitionConflictError`. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DependencyCycleError` | class | Error raised for a cycle in the static resource dependency graph. | `new DependencyCycleError(...)` | `.agents/tests/public-api-matrix.test.ts:175` uses `DependencyCycleError`. |
| `DependencyRecord` | type | A keyed record of direct resource dependencies. | `value: DependencyRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DependencyValues` | type | Direct dependency values supplied to a resource implementation. | `value: DependencyValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create deterministic, JSON-safe documentation for a resource graph. | `document(...)` | `utils/server/service/compile.ts:655` uses `document`. |
| `Document` | interface | JSON-safe projection of one resource definition. | `value: Document` | `utils/server/service/types.ts:173` uses `Document`. |
| `DocumentationMetadata` | interface | Optional external documentation for a resource definition. | `value: DocumentationMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Environment` | type | Parsed direct environment values supplied to a resource implementation. | `value: Environment` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ErasedCreateArguments` | interface | Runtime arguments shared by heterogeneous resource implementations. | `value: ErasedCreateArguments` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HealthMetadata` | interface | Optional health metadata included in generated resource documentation. | `value: HealthMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `implement` | function | Bind one host-specific constructor to one exact resource definition. | `implement(...)` | `.agents/support/production-fixture.ts:391` uses `implement`. |
| `Implementation` | interface | Host-specific implementation for one exact resource definition. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ImplementationConflictError` | class | Error raised when a collection receives two implementations for one definition. | `new ImplementationConflictError(...)` | `.agents/tests/public-api-matrix.test.ts:173` uses `ImplementationConflictError`. |
| `ImplementationInput` | interface | Input accepted by {@link implement}. | `value: ImplementationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `implementations` | function | Assemble an explicit, import-safe universe of resource implementations. | `implementations(...)` | `.agents/support/production-fixture.ts:397` uses `implementations`. |
| `ImplementationSet` | interface | Import-safe explicit universe of resource implementations. | `value: ImplementationSet` | `utils/server/service/types.ts:110` uses `ImplementationSet`. |
| `manifest` | value | Alias for {@link document} when generating deployment or operator manifests. | `manifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MissingImplementationError` | class | Error raised when a reachable resource definition has no implementation. | `new MissingImplementationError(...)` | `.agents/tests/public-api-matrix.test.ts:174` uses `MissingImplementationError`. |
| `Resolver` | interface | Resource resolver narrowed to an allowed definition union. | `value: Resolver` | `utils/activity/types.ts:66` uses `Resolver`. |
| `resourceCatalog` | function | Create a named immutable resource catalog. | `resourceCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select an immutable key-preserving resource subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:116` uses `select`. |
| `validate` | function | Validate a definition graph and, when supplied, implementation coverage. | `validate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationIssue` | type | Resource graph validation issue. | `value: ValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationResult` | type | Deterministic validation result for a resource graph. | `value: ValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Value` | type | Concrete value carried by a resource definition. | `value: Value` | `utils/activity/mod_test.ts:66` uses `Value`. |

Detected uses
~~~~~~~~~~~~~

`DefinitionConflictError` appears in `.agents/tests/public-api-matrix.test.ts:172`:

~~~~ typescript
assert.equal(new resource.DefinitionConflictError(ResourceA.id, ResourceA, ResourceA).id, ResourceA.id);
		assert.equal(new resource.ImplementationConflictError(ResourceA).definition, ResourceA);
		assert.equal(new resource.MissingImplementationError(ResourceB, [ResourceA]).requiredBy[0], ResourceA);
		assert.equal(new resource.DependencyCycleError([ResourceA, ResourceB]).path.length, 2);
~~~~

`ImplementationConflictError` appears in `.agents/tests/public-api-matrix.test.ts:173`:

~~~~ typescript
assert.equal(new resource.ImplementationConflictError(ResourceA).definition, ResourceA);
		assert.equal(new resource.MissingImplementationError(ResourceB, [ResourceA]).requiredBy[0], ResourceA);
		assert.equal(new resource.DependencyCycleError([ResourceA, ResourceB]).path.length, 2);
		assert.equal(new resource.DefinitionConflictError(ResourceB.id, ResourceB, ResourceB).id, ResourceB.id);
~~~~

`MissingImplementationError` appears in `.agents/tests/public-api-matrix.test.ts:174`:

~~~~ typescript
assert.equal(new resource.MissingImplementationError(ResourceB, [ResourceA]).requiredBy[0], ResourceA);
		assert.equal(new resource.DependencyCycleError([ResourceA, ResourceB]).path.length, 2);
		assert.equal(new resource.DefinitionConflictError(ResourceB.id, ResourceB, ResourceB).id, ResourceB.id);
		assert.equal(new resource.ImplementationConflictError(ResourceB).definition, ResourceB);
~~~~

`DependencyCycleError` appears in `.agents/tests/public-api-matrix.test.ts:175`:

~~~~ typescript
assert.equal(new resource.DependencyCycleError([ResourceA, ResourceB]).path.length, 2);
		assert.equal(new resource.DefinitionConflictError(ResourceB.id, ResourceB, ResourceB).id, ResourceB.id);
		assert.equal(new resource.ImplementationConflictError(ResourceB).definition, ResourceB);
		assert.equal(new resource.MissingImplementationError(ResourceA).definition, ResourceA);
~~~~

`define` appears in `.agents/support/production-fixture.ts:200`:

~~~~ typescript
const ImportRepository = resource.define<ImportRepositoryValue>()({
	id: 'validation.import-repository',
	description: 'Stores synthetic import records for production-style validation.',
	failures: [RepositoryAccessFailed],
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:116`:

~~~~ typescript
assert.equal(resource.select(resources, ['ResourceB']).ResourceB, ResourceB);
	assert.deepEqual(resource.compose(ResourceA, resource.select(resources, ['ResourceB'])), [ResourceA, ResourceB]);
	assert.equal(resource.document(resources).length, 2);
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:117`:

~~~~ typescript
assert.deepEqual(resource.compose(ResourceA, resource.select(resources, ['ResourceB'])), [ResourceA, ResourceB]);
	assert.equal(resource.document(resources).length, 2);

	const activities = activity.catalog('matrix.activities', { ActivityA, ActivityB });
~~~~

`implement` appears in `.agents/support/production-fixture.ts:391`:

~~~~ typescript
const RepositoryImplementation = resource.implement(ImportRepository, {
		create: async () => {
			await trace.record('resource', 'created', { id: ImportRepository.id });
			return repository;
~~~~

`implementations` appears in `.agents/support/production-fixture.ts:397`:

~~~~ typescript
const implementationSet = resource.implementations(RepositoryImplementation);
	const coordinatorResources = await resource.create(implementationSet, { host: Object.freeze({}), ctx: bootstrapContext });
	const taskQueue = queue.memory<Readonly<{ readonly activityId: string; readonly input: unknown; readonly path: string }>, unknown>({
		capacity: 128,
~~~~

`document` appears in `utils/server/service/compile.ts:655`:

~~~~ typescript
resourceGraph: resource.document(resources, implementations),
		permissions: Object.freeze(uniqueByIdentity(operations.flatMap((operation) => operation.permissions)).map((entry) => entry.id)),
		entitlements: Object.freeze(uniqueByIdentity(operations.flatMap((operation) => operation.entitlements)).map((entry) => entry.id)),
		billing: Object.freeze(uniqueByIdentity(operations.flatMap((operation) => operation.billing)).map((entry) => entry.id)),
~~~~

`create` appears in `.agents/support/production-fixture.ts:398`:

~~~~ typescript
const coordinatorResources = await resource.create(implementationSet, { host: Object.freeze({}), ctx: bootstrapContext });
	const taskQueue = queue.memory<Readonly<{ readonly activityId: string; readonly input: unknown; readonly path: string }>, unknown>({
		capacity: 128,
		id: (() => {
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:115`:

~~~~ typescript
const resources = resource.catalog('matrix.resources', { ResourceA, ResourceB });
	assert.equal(resource.select(resources, ['ResourceB']).ResourceB, ResourceB);
	assert.deepEqual(resource.compose(ResourceA, resource.select(resources, ['ResourceB'])), [ResourceA, ResourceB]);
	assert.equal(resource.document(resources).length, 2);
~~~~

`AnyImplementation` appears in `utils/server/service/compile.ts:435`:

~~~~ typescript
implementations: readonly AnyImplementation[],
	issues: ServiceValidationIssue[],
): ReadonlyMap<ResourceDefinition, AnyImplementation> {
	const result = new Map<ResourceDefinition, AnyImplementation>();
~~~~

`Collection` appears in `utils/server/service/runtime.ts:56`:

~~~~ typescript
let resources: ResourceCollection;
	try {
		resources = resource.create(compiled.implementation.resources, {
			...(options.environment !== undefined ? { environment: options.environment } : {}),
~~~~

`Definition` appears in `utils/activity/types.ts:23`:

~~~~ typescript
readonly resources?: CatalogDefinitionInput<ResourceDefinition>;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly resilience?: ResilienceInput;
}
~~~~

`Document` appears in `utils/server/service/types.ts:173`:

~~~~ typescript
readonly resourceGraph: readonly ResourceDocument[];
	readonly permissions: readonly string[];
	readonly entitlements: readonly string[];
	readonly billing: readonly string[];
~~~~

`ImplementationSet` appears in `utils/server/service/types.ts:110`:

~~~~ typescript
readonly resources: ResourceImplementationSet;
	readonly hostType?: Host;
}
~~~~

`Resolver` appears in `utils/activity/types.ts:66`:

~~~~ typescript
readonly resources: ResourceResolver<Resources<ActivityDefinition>>;
	heartbeat(value?: unknown): void;
}
~~~~

`Value` appears in `utils/activity/mod_test.ts:66`:

~~~~ typescript
function resolver(store: resource.Value<typeof Store>): resource.Resolver<typeof Store> {
	return Object.freeze({
		has(definition) { return definition === Store; },
		async get(definition) {
~~~~

@utils/resource/types
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AnyFactory` | type | Runtime-erased resource constructor retained in an explicit implementation set. | `value: AnyFactory` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `AnyImplementation` | interface | Runtime-erased resource implementation stored in heterogeneous collections. | `value: AnyImplementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Collection` | interface | Live resource resolver and deterministic disposal owner. | `value: Collection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CreateArguments` | interface | Arguments supplied while creating one concrete resource value. | `value: CreateArguments` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CreateOptions` | interface | Options used to create one independently owned resource collection. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Definition` | interface | Static, import-safe provider-neutral resource contract. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DependencyRecord` | type | A keyed record of direct resource dependencies. | `value: DependencyRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DependencyValues` | type | Direct dependency values supplied to a resource implementation. | `value: DependencyValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Document` | interface | JSON-safe projection of one resource definition. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DocumentationMetadata` | interface | Optional external documentation for a resource definition. | `value: DocumentationMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Environment` | type | Parsed direct environment values supplied to a resource implementation. | `value: Environment` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ErasedCreateArguments` | interface | Runtime arguments shared by heterogeneous resource implementations. | `value: ErasedCreateArguments` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `HealthMetadata` | interface | Optional health metadata included in generated resource documentation. | `value: HealthMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Implementation` | interface | Host-specific implementation for one exact resource definition. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ImplementationInput` | interface | Input accepted by {@link implement}. | `value: ImplementationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ImplementationSet` | interface | Import-safe explicit universe of resource implementations. | `value: ImplementationSet` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Resolver` | interface | Resource resolver narrowed to an allowed definition union. | `value: Resolver` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationIssue` | type | Resource graph validation issue. | `value: ValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValidationResult` | type | Deterministic validation result for a resource graph. | `value: ValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Value` | type | Concrete value carried by a resource definition. | `value: Value` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 57 public names across 2 package export targets. 19 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

