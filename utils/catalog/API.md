@utils/catalog public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/catalog` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/catalog
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Catalog` | type | Record-shaped immutable catalog with hidden compile-time identity. | `value: Catalog` | `utils/activity/types.ts:101` uses `Catalog`. |
| `CatalogConflictError` | class | Error raised when different definitions reuse one stable catalog identifier. | `new CatalogConflictError(...)` | `.agents/tests/public-api-matrix.test.ts:148` uses `CatalogConflictError`. |
| `CatalogDocument` | interface | JSON-safe projection of a catalog or selection. | `value: CatalogDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogEntryDocument` | interface | JSON-safe description of one catalog entry. | `value: CatalogEntryDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogEntryIdentity` | interface | Stable identity required by values that participate in catalogs. | `value: CatalogEntryIdentity` | `utils/activity/types.ts:24` uses `CatalogEntryIdentity`. |
| `CatalogEntryValue` | type | Concrete runtime value represented by a valued catalog entry. | `value: CatalogEntryValue` | `utils/resource/types.ts:61` uses `CatalogEntryValue`. |
| `CatalogLike` | type | Any catalog-like value accepted by generic catalog helpers. | `value: CatalogLike` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogMetadata` | interface | Metadata retained for an immutable named catalog. | `value: CatalogMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogSelection` | type | Record-shaped immutable catalog selection with hidden compile-time identity. | `value: CatalogSelection` | `utils/activity/types.ts:107` uses `CatalogSelection`. |
| `CatalogSelectionError` | class | Error raised when a selection references a key that does not exist. | `new CatalogSelectionError(...)` | `.agents/tests/public-api-matrix.test.ts:141` uses `CatalogSelectionError`. |
| `CatalogSelectionMetadata` | interface | Metadata retained for an immutable selection from a source catalog. | `value: CatalogSelectionMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogValidationIssue` | interface | Validation issue produced while inspecting a definition input. | `value: CatalogValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogValidationResult` | type | Deterministic validation result for a catalog input. | `value: CatalogValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Compose definition inputs into a deterministic immutable entry list. | `compose(...)` | `utils/activity/mod.ts:62` uses `compose`. |
| `create` | function | Create an immutable record-shaped catalog for a domain namespace. | `create(...)` | `utils/activity/mod.ts:98` uses `create`. |
| `DefinitionEntry` | type | Entry union represented by one direct, nested, catalog, or selection input. | `value: DefinitionEntry` | `utils/server/endpoint/types.ts:144` uses `DefinitionEntry`. |
| `DefinitionInput` | type | Recursive input accepted by definition-consuming fields. | `value: DefinitionInput` | `utils/activity/mod.ts:113` uses `DefinitionInput`. |
| `document` | function | Create a JSON-safe deterministic projection for documentation and manifests. | `document(...)` | `.agents/tests/public-api-repetition.test.ts:46` uses `document`. |
| `is` | function | Return whether a value is a catalog or catalog selection. | `is(...)` | `utils/http/problem/mod.ts:202` uses `is`. |
| `isCatalog` | function | Return whether a value is a named source catalog. | `isCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isSelection` | function | Return whether a value is a catalog selection. | `isSelection(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `metadata` | function | Read hidden metadata after runtime narrowing of a catalog or selection. | `metadata(...)` | `utils/http/problem/mod.ts:177` uses `metadata`. |
| `select` | function | Select an immutable key-preserving subset from a source catalog. | `select(...)` | `utils/activity/mod.ts:109` uses `select`. |
| `validate` | function | Validate a definition input without throwing. | `validate(...)` | `.agents/tests/public-api-matrix.test.ts:150` uses `validate`. |
| `ValuedCatalogEntry` | interface | Generic catalog entry whose static definition represents a concrete runtime value. | `value: ValuedCatalogEntry` | `utils/resource/types.ts:33` uses `ValuedCatalogEntry`. |
| `values` | function | Flatten direct values, nested arrays, catalogs, and selections. | `values(...)` | `utils/activity/mod.ts:201` uses `values`. |

Detected uses
~~~~~~~~~~~~~

`CatalogConflictError` appears in `.agents/tests/public-api-matrix.test.ts:148`:

~~~~ typescript
assert.throws(() => catalog.compose(RuntimeA, conflicting), catalog.CatalogConflictError);
	assert.equal(catalog.is(catalog.create('matrix.catalog', { RuntimeA })), true);
	assert.equal(catalog.validate(catalog.create('matrix.catalog.valid', { RuntimeA })).valid, true);
	assert.equal(catalog.validate(Object.freeze({ RuntimeA })).valid, false);
~~~~

`CatalogSelectionError` appears in `.agents/tests/public-api-matrix.test.ts:141`:

~~~~ typescript
assert.throws(() => runtime.select(runtime.catalog('matrix.runtimes.error', { RuntimeA }), ['missing' as 'RuntimeA']), catalog.CatalogSelectionError);
	assert.throws(() => failure.select(failure.catalog('matrix.failures.error', { FailureA }), ['missing' as 'FailureA']), catalog.CatalogSelectionError);
	assert.throws(() => resource.select(resource.catalog('matrix.resources.error', { ResourceA }), ['missing' as 'ResourceA']), catalog.CatalogSelectionError);
	assert.throws(() => activity.select(activity.catalog('matrix.activities.error', { ActivityA }), ['missing' as 'ActivityA']), catalog.CatalogSelectionError);
~~~~

`create` appears in `utils/activity/mod.ts:98`:

~~~~ typescript
return catalogCore.create(namespace, entries);
}

/** Select a key-preserving activity catalog subset. */
~~~~

`is` appears in `utils/http/problem/mod.ts:202`:

~~~~ typescript
if (catalog.is(input)) {
		const metadata = catalog.metadata(input);
		for (const entry of metadata.entries) keys.set(entry as ProblemDefinition, metadata.keyByEntry.get(entry)!);
	}
~~~~

`metadata` appears in `utils/http/problem/mod.ts:177`:

~~~~ typescript
const metadata = catalog.metadata(universe);
	const key = metadata.keyByEntry.get(definition);
	if (key === undefined) throw new TypeError(`Problem ${JSON.stringify(definition.id)} is outside the supplied universe.`);
	const handler = handlers[key];
~~~~

`values` appears in `utils/activity/mod.ts:201`:

~~~~ typescript
return Object.freeze(catalogCore.values(input).map((definition) => Object.freeze({
		id: definition.id,
		version: definition.version,
		...(definition.description === undefined ? {} : { description: definition.description }),
~~~~

`select` appears in `utils/activity/mod.ts:109`:

~~~~ typescript
return catalogCore.select(source, keys);
}

/** Compose activities, catalogs, selections, and nested arrays. */
~~~~

`compose` appears in `utils/activity/mod.ts:62`:

~~~~ typescript
const runtimes = catalogCore.compose(input.runtimes);
	if (runtimes.length === 0) throw new TypeError('Activity definitions must allow at least one runtime.');
	const failures = input.failures === undefined ? Object.freeze([]) : catalogCore.compose(input.failures);
	const resources = input.resources === undefined ? Object.freeze([]) : catalogCore.compose(input.resources);
~~~~

`validate` appears in `.agents/tests/public-api-matrix.test.ts:150`:

~~~~ typescript
assert.equal(catalog.validate(catalog.create('matrix.catalog.valid', { RuntimeA })).valid, true);
	assert.equal(catalog.validate(Object.freeze({ RuntimeA })).valid, false);
}
~~~~

`document` appears in `.agents/tests/public-api-repetition.test.ts:46`:

~~~~ typescript
assert.equal(catalog.document(runtimes).entries.length, 1);
		assert.equal(catalog.document(runtime.select(runtimes, ['Runtime'])).type, 'selection');

		const collection = codec.array(TextCodec);
~~~~

`Catalog` appears in `utils/activity/types.ts:101`:

~~~~ typescript
export type ActivityCatalog<Entries extends Readonly<Record<PropertyKey, Definition>>> = Catalog<Entries[keyof Entries], Entries>;

/** Key-preserving activity catalog selection. */
export type ActivitySelection<
~~~~

`CatalogEntryIdentity` appears in `utils/activity/types.ts:24`:

~~~~ typescript
readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly resilience?: ResilienceInput;
}
~~~~

`CatalogEntryValue` appears in `utils/resource/types.ts:61`:

~~~~ typescript
export type Value<ResourceDefinition extends Definition> = CatalogEntryValue<ResourceDefinition>;

/** Direct dependency values supplied to a resource implementation. */
export type DependencyValues<Dependencies extends DependencyRecord> = {
~~~~

`CatalogSelection` appears in `utils/activity/types.ts:107`:

~~~~ typescript
> = CatalogSelection<Entry, Entries>;

/** JSON-safe activity documentation. */
export interface Document {
~~~~

`DefinitionEntry` appears in `utils/server/endpoint/types.ts:144`:

~~~~ typescript
DefinitionEntry<NonNullable<Input['responses']>>,
	ResponseDefinition
>;
~~~~

`DefinitionInput` appears in `utils/activity/mod.ts:113`:

~~~~ typescript
export function compose<Entry extends Definition>(...input: readonly CatalogDefinitionInput<Entry>[]): readonly Entry[] {
	return catalogCore.compose(...input);
}
~~~~

`ValuedCatalogEntry` appears in `utils/resource/types.ts:33`:

~~~~ typescript
> extends ValuedCatalogEntry<'resource', ResourceValue> {
	readonly description: string;
	readonly dependencies: Dependencies;
	readonly environment?: EnvironmentRequirement_;
~~~~

@utils/catalog/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Catalog` | type | Record-shaped immutable catalog with hidden compile-time identity. | `value: Catalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogBrand` | interface | Compile-time brand carried by catalog values. | `value: CatalogBrand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogDocument` | interface | JSON-safe projection of a catalog or selection. | `value: CatalogDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogEntryDocument` | interface | JSON-safe description of one catalog entry. | `value: CatalogEntryDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogEntryIdentity` | interface | Stable identity required by values that participate in catalogs. | `value: CatalogEntryIdentity` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `catalogEntryValue` | value | Phantom symbol used to retain the value represented by a static definition. | `catalogEntryValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogEntryValue` | type | Concrete runtime value represented by a valued catalog entry. | `value: CatalogEntryValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogLike` | type | Any catalog-like value accepted by generic catalog helpers. | `value: CatalogLike` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogMetadata` | interface | Metadata retained for an immutable named catalog. | `value: CatalogMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogSelection` | type | Record-shaped immutable catalog selection with hidden compile-time identity. | `value: CatalogSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogSelectionBrand` | interface | Compile-time brand carried by catalog selections. | `value: CatalogSelectionBrand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogSelectionMetadata` | interface | Metadata retained for an immutable selection from a source catalog. | `value: CatalogSelectionMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogValidationIssue` | interface | Validation issue produced while inspecting a definition input. | `value: CatalogValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CatalogValidationResult` | type | Deterministic validation result for a catalog input. | `value: CatalogValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionEntry` | type | Entry union represented by one direct, nested, catalog, or selection input. | `value: DefinitionEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | type | Recursive input accepted by definition-consuming fields. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValuedCatalogEntry` | interface | Generic catalog entry whose static definition represents a concrete runtime value. | `value: ValuedCatalogEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 43 public names across 2 package export targets. 17 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

