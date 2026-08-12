/** Stable identity required by values that participate in catalogs. */
export interface CatalogEntryIdentity {
	/** Globally unique stable identifier for the definition. */
	readonly id: string;
	/** Domain discriminator such as `problem`, `resource`, or `permission`. */
	readonly kind: string;
	/** Human-readable explanation used by generated documentation. */
	readonly description?: string;
}


/** Phantom symbol used to retain the value represented by a static definition. */
export declare const catalogEntryValue: unique symbol;

/**
 * Generic catalog entry whose static definition represents a concrete runtime value.
 *
 * The property is type-only; definition objects do not gain an enumerable runtime
 * field. Domain packages such as resources use this protocol so portable
 * contracts can retain value inference without importing a runtime adapter.
 */
export interface ValuedCatalogEntry<
	Kind extends string = string,
	Value = unknown,
> extends CatalogEntryIdentity {
	readonly kind: Kind;
	readonly [catalogEntryValue]: Value;
}

/** Concrete runtime value represented by a valued catalog entry. */
export type CatalogEntryValue<Entry extends ValuedCatalogEntry> =
	Entry extends ValuedCatalogEntry<string, infer Value> ? Value : never;

/** Metadata retained for an immutable named catalog. */
export interface CatalogMetadata<Entry extends CatalogEntryIdentity = CatalogEntryIdentity> {
	readonly type: 'catalog';
	readonly namespace: string;
	readonly keys: readonly string[];
	readonly entries: readonly Entry[];
	readonly keyByEntry: ReadonlyMap<Entry, string>;
}

/** Metadata retained for an immutable selection from a source catalog. */
export interface CatalogSelectionMetadata<Entry extends CatalogEntryIdentity = CatalogEntryIdentity> {
	readonly type: 'selection';
	readonly namespace: string;
	readonly source: Catalog<Entry>;
	readonly keys: readonly string[];
	readonly entries: readonly Entry[];
	readonly keyByEntry: ReadonlyMap<Entry, string>;
}

const catalogBrand: unique symbol = Symbol('kaiju.catalog.type');
const catalogSelectionBrand: unique symbol = Symbol('kaiju.catalog.selection.type');

/** Record-shaped immutable catalog with hidden compile-time identity. */
export type Catalog<
	Entry extends CatalogEntryIdentity = CatalogEntryIdentity,
	Entries extends Readonly<Record<PropertyKey, CatalogEntryIdentity>> = Readonly<Record<string, Entry>>,
> = Readonly<Entries> & CatalogBrand<Entry>;

/** Record-shaped immutable catalog selection with hidden compile-time identity. */
export type CatalogSelection<
	Entry extends CatalogEntryIdentity = CatalogEntryIdentity,
	Entries extends Readonly<Record<PropertyKey, CatalogEntryIdentity>> = Readonly<Record<string, Entry>>,
> = Readonly<Entries> & CatalogSelectionBrand<Entry>;

/** Any catalog-like value accepted by generic catalog helpers. */
export type CatalogLike<Entry extends CatalogEntryIdentity = CatalogEntryIdentity> =
	| CatalogBrand<Entry>
	| CatalogSelectionBrand<Entry>;

/** Recursive input accepted by definition-consuming fields. */
export type DefinitionInput<Entry extends CatalogEntryIdentity> =
	| Entry
	| CatalogLike<Entry>
	| readonly DefinitionInput<Entry>[];


/** Entry union represented by one direct, nested, catalog, or selection input. */
export type DefinitionEntry<
	Input,
	Depth extends readonly unknown[] = readonly [],
> = Depth['length'] extends 8 ? Extract<Input, CatalogEntryIdentity>
	: Input extends readonly (infer Item)[] ? DefinitionEntry<Item, readonly [...Depth, unknown]>
	: Input extends CatalogBrand<infer Entry> ? Entry
	: Input extends CatalogSelectionBrand<infer Entry> ? Entry
	: Input extends CatalogEntryIdentity ? Input
	: never;

/** JSON-safe description of one catalog entry. */
export interface CatalogEntryDocument {
	readonly key: string;
	readonly id: string;
	readonly kind: string;
	readonly description?: string;
}

/** JSON-safe projection of a catalog or selection. */
export interface CatalogDocument {
	readonly type: 'catalog' | 'selection' | 'composition';
	readonly namespace?: string;
	readonly entries: readonly CatalogEntryDocument[];
}

/** Validation issue produced while inspecting a definition input. */
export interface CatalogValidationIssue {
	readonly code: 'invalid-entry' | 'duplicate-id' | 'empty-id' | 'empty-kind';
	readonly message: string;
	readonly id?: string;
	readonly first?: CatalogEntryIdentity;
	readonly second?: CatalogEntryIdentity;
}

/** Deterministic validation result for a catalog input. */
export type CatalogValidationResult =
	| { readonly valid: true; readonly entries: readonly CatalogEntryIdentity[] }
	| { readonly valid: false; readonly issues: readonly CatalogValidationIssue[] };

/** Compile-time brand carried by catalog values. */
export interface CatalogBrand<Entry extends CatalogEntryIdentity> {
	readonly [catalogBrand]: Entry;
}

/** Compile-time brand carried by catalog selections. */
export interface CatalogSelectionBrand<Entry extends CatalogEntryIdentity> {
	readonly [catalogSelectionBrand]: Entry;
}
