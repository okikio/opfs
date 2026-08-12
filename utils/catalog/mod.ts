/**
 * Immutable definition catalogs with stable identity and deterministic composition.
 *
 * Catalogs group imported values without global registration or runtime lookup.
 *
 * @module
 */
import type {
	Catalog,
	CatalogDocument,
	CatalogEntryDocument,
	CatalogEntryIdentity,
	CatalogEntryValue,
	CatalogLike,
	CatalogMetadata,
	CatalogSelection,
	CatalogSelectionMetadata,
	CatalogValidationIssue,
	CatalogValidationResult,
	DefinitionInput,
	ValuedCatalogEntry,
} from './types.ts';

const catalogMetadata = Symbol('kaiju.catalog.metadata');
const selectionMetadata = Symbol('kaiju.catalog.selection.metadata');

/** Error raised when different definitions reuse one stable catalog identifier. */
export class CatalogConflictError extends Error {
	readonly id: string;
	readonly first: CatalogEntryIdentity;
	readonly second: CatalogEntryIdentity;

	constructor(id: string, first: CatalogEntryIdentity, second: CatalogEntryIdentity) {
		super(`Catalog identifier ${JSON.stringify(id)} is owned by different definition objects.`);
		this.name = 'CatalogConflictError';
		this.id = id;
		this.first = first;
		this.second = second;
	}
}

/** Error raised when a selection references a key that does not exist. */
export class CatalogSelectionError extends Error {
	readonly namespace: string;
	readonly key: PropertyKey;

	constructor(namespace: string, key: PropertyKey) {
		super(`Catalog ${JSON.stringify(namespace)} does not contain key ${String(key)}.`);
		this.name = 'CatalogSelectionError';
		this.namespace = namespace;
		this.key = key;
	}
}

/**
 * Create an immutable record-shaped catalog for a domain namespace.
 *
 * Domain packages normally wrap this helper behind APIs such as
 * `problem.catalog()` or `resource.catalog()`.
 */
export function create<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, CatalogEntryIdentity>>,
>(namespace: Namespace, entries: Entries): Catalog<Entries[keyof Entries], Entries> {
	assertNamespace(namespace);

	const target = Object.create(null) as Record<PropertyKey, CatalogEntryIdentity>;
	const keys = Reflect.ownKeys(entries);
	const orderedEntries: CatalogEntryIdentity[] = [];
	const keyByEntry = new Map<CatalogEntryIdentity, string>();
	const idOwners = new Map<string, CatalogEntryIdentity>();

	for (const key of keys) {
		if (typeof key !== 'string') {
			throw new TypeError('Catalog entry keys must be strings.');
		}

		const entry = entries[key];
		assertEntry(entry, key);
		assertIdOwnership(idOwners, entry);
		const previousKey = keyByEntry.get(entry);
		if (previousKey !== undefined) {
			throw new TypeError(
				`Catalog ${JSON.stringify(namespace)} assigns definition ${JSON.stringify(entry.id)} to both ${JSON.stringify(previousKey)} and ${JSON.stringify(key)}.`,
			);
		}
		defineEntry(target, key, entry);
		orderedEntries.push(entry);
		keyByEntry.set(entry, key);
	}

	const metadata: CatalogMetadata = Object.freeze({
		type: 'catalog',
		namespace,
		keys: Object.freeze(keys as string[]),
		entries: Object.freeze(orderedEntries),
		keyByEntry: immutableMap(keyByEntry),
	});

	Object.defineProperty(target, catalogMetadata, {
		value: metadata,
		enumerable: false,
		writable: false,
		configurable: false,
	});

	return Object.freeze(target) as Catalog<Entries[keyof Entries], Entries>;
}

/** Return whether a value is a catalog or catalog selection. */
export function is(value: unknown): value is CatalogLike {
	return isCatalog(value) || isSelection(value);
}

/** Return whether a value is a named source catalog. */
export function isCatalog(value: unknown): value is Catalog {
	return typeof value === 'object' && value !== null && catalogMetadata in value;
}

/** Return whether a value is a catalog selection. */
export function isSelection(value: unknown): value is CatalogSelection {
	return typeof value === 'object' && value !== null && selectionMetadata in value;
}

/** Return hidden metadata for a named source catalog. */
export function metadata<Entry extends CatalogEntryIdentity>(value: Catalog<Entry>): CatalogMetadata<Entry>;
/** Return hidden metadata for a catalog selection. */
export function metadata<Entry extends CatalogEntryIdentity>(
	value: CatalogSelection<Entry>,
): CatalogSelectionMetadata<Entry>;
/** Return hidden metadata when the precise catalog kind is not statically known. */
export function metadata<Entry extends CatalogEntryIdentity>(
	value: CatalogLike<Entry>,
): CatalogMetadata<Entry> | CatalogSelectionMetadata<Entry>;
/** Read hidden metadata after runtime narrowing of a catalog or selection. */
export function metadata(value: CatalogLike): CatalogMetadata | CatalogSelectionMetadata {
	if (isCatalog(value)) return readCatalogMetadata(value);
	if (isSelection(value)) return readSelectionMetadata(value);
	throw new TypeError('Value is not a catalog or catalog selection.');
}

/**
 * Flatten direct values, nested arrays, catalogs, and selections.
 *
 * The exact same object is deduplicated. Different objects sharing an ID are
 * rejected because stable IDs represent identity rather than semantic equality.
 */
export function values<Entry extends CatalogEntryIdentity>(
	input: DefinitionInput<Entry>,
): readonly Entry[] {
	const result: Entry[] = [];
	const seenObjects = new Set<Entry>();
	const idOwners = new Map<string, Entry>();

	visit(input, (entry) => {
		assertEntry(entry);
		const owner = idOwners.get(entry.id);
		if (owner && owner !== entry) throw new CatalogConflictError(entry.id, owner, entry);
		idOwners.set(entry.id, entry);
		if (seenObjects.has(entry)) return;
		seenObjects.add(entry);
		result.push(entry);
	});

	return Object.freeze(result);
}

/** Select an immutable key-preserving subset from a source catalog. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, CatalogEntryIdentity>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	type Entry = Entries[keyof Entries];
	const sourceMetadata = readCatalogMetadata(source);
	const target = Object.create(null) as Record<PropertyKey, Entry>;
	const selectedEntries: Entry[] = [];
	const keyByEntry = new Map<Entry, string>();
	const seenKeys = new Set<string>();

	for (const key of keys) {
		if (seenKeys.has(key)) continue;
		seenKeys.add(key);

		if (!Object.hasOwn(source, key)) throw new CatalogSelectionError(sourceMetadata.namespace, key);
		const entry = source[key];
		defineEntry(target, key, entry);
		selectedEntries.push(entry);
		keyByEntry.set(entry, key);
	}

	const selectedKeys = Object.freeze([...seenKeys]);
	const metadata: CatalogSelectionMetadata<Entry> = Object.freeze({
		type: 'selection',
		namespace: sourceMetadata.namespace,
		source,
		keys: selectedKeys,
		entries: Object.freeze(selectedEntries),
		keyByEntry: immutableMap(keyByEntry),
	});

	Object.defineProperty(target, selectionMetadata, {
		value: metadata,
		enumerable: false,
		writable: false,
		configurable: false,
	});

	return Object.freeze(target) as CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>>;
}

/** Compose definition inputs into a deterministic immutable entry list. */
export function compose<Entry extends CatalogEntryIdentity>(
	...inputs: readonly DefinitionInput<Entry>[]
): readonly Entry[] {
	return values(inputs);
}

/** Validate a definition input without throwing. */
export function validate(input: unknown): CatalogValidationResult {
	const issues: CatalogValidationIssue[] = [];
	const entries: CatalogEntryIdentity[] = [];
	const seenObjects = new Set<CatalogEntryIdentity>();
	const idOwners = new Map<string, CatalogEntryIdentity>();

	try {
		visitUnknown(input, (entry) => {
			if (!isEntry(entry)) {
				issues.push({ code: 'invalid-entry', message: 'Catalog input contains a value without string id and kind.' });
				return;
			}
			if (entry.id.length === 0) issues.push({ code: 'empty-id', message: 'Catalog entry id cannot be empty.' });
			if (entry.kind.length === 0) issues.push({ code: 'empty-kind', message: 'Catalog entry kind cannot be empty.', id: entry.id });
			const owner = idOwners.get(entry.id);
			if (owner && owner !== entry) {
				issues.push({
					code: 'duplicate-id',
					message: `Catalog identifier ${JSON.stringify(entry.id)} is owned by different objects.`,
					id: entry.id,
					first: owner,
					second: entry,
				});
			}
			idOwners.set(entry.id, entry);
			if (!seenObjects.has(entry)) {
				seenObjects.add(entry);
				entries.push(entry);
			}
		});
	} catch (error) {
		issues.push({
			code: 'invalid-entry',
			message: error instanceof Error ? error.message : String(error),
		});
	}

	return issues.length === 0
		? { valid: true, entries: Object.freeze(entries) }
		: { valid: false, issues: Object.freeze(issues) };
}

/** Create a JSON-safe deterministic projection for documentation and manifests. */
export function document(input: DefinitionInput<CatalogEntryIdentity>): CatalogDocument {
	if (isCatalog(input)) return documentCatalog(readCatalogMetadata(input));
	if (isSelection(input)) return documentSelection(readSelectionMetadata(input));
	return Object.freeze({
		type: 'composition',
		entries: Object.freeze(values(input).map((entry, index) => documentEntry(String(index), entry))),
	});
}


/**
 * Owns the internal immutable map state used by immutable catalog composition.
 *
 * Catalog internals preserve exact definition identity and deterministic iteration so callers never depend on a mutable global registry.
 *
 * @internal
 */
class ImmutableMap<Key, Value> implements ReadonlyMap<Key, Value> {
	readonly #source: ReadonlyMap<Key, Value>;

	constructor(source: ReadonlyMap<Key, Value>) {
		this.#source = new Map(source);
		Object.freeze(this);
	}

	get size(): number {
		return this.#source.size;
	}

	/**
	 * Returns the catalog entry for a stable ID while preserving the original definition object identity.
	 *
	 * @internal
	 */
	get(key: Key): Value | undefined {
		return this.#source.get(key);
	}

	/**
	 * Checks whether a stable ID is present in the immutable catalog without exposing its backing map.
	 *
	 * @internal
	 */
	has(key: Key): boolean {
		return this.#source.has(key);
	}

	/**
	 * Visits catalog entries in deterministic insertion order so derived artifacts remain stable.
	 *
	 * @internal
	 */
	forEach(callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArgument?: unknown): void {
		for (const [key, value] of this.#source) callback.call(thisArgument, value, key, this);
	}

	/**
	 * Returns the deterministic `[id, definition]` iterator view used by catalog consumers.
	 *
	 * @internal
	 */
	entries(): MapIterator<[Key, Value]> {
		return this.#source.entries();
	}

	/**
	 * Returns stable catalog IDs in deterministic insertion order.
	 *
	 * @internal
	 */
	keys(): MapIterator<Key> {
		return this.#source.keys();
	}

	/**
	 * Returns definition values in deterministic insertion order.
	 *
	 * @internal
	 */
	values(): MapIterator<Value> {
		return this.#source.values();
	}

	/**
	 * Returns the native iterator view used by synchronous iteration protocols.
	 *
	 * @internal
	 */
	[Symbol.iterator](): MapIterator<[Key, Value]> {
		return this.entries();
	}
}

/**
 * Builds the immutable map used for deterministic lookup by immutable catalog composition.
 *
 * @internal
 */
function immutableMap<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
	return new ImmutableMap(source);
}

/**
 * Projects the document catalog from executable definitions without creating runtime work in immutable catalog composition.
 *
 * @internal
 */
function documentCatalog(metadata: CatalogMetadata): CatalogDocument {
	return Object.freeze({
		type: 'catalog',
		namespace: metadata.namespace,
		entries: Object.freeze(metadata.entries.map((entry) => documentEntry(metadata.keyByEntry.get(entry)!, entry))),
	});
}

/**
 * Projects the document selection from executable definitions without creating runtime work in immutable catalog composition.
 *
 * @internal
 */
function documentSelection(metadata: CatalogSelectionMetadata): CatalogDocument {
	return Object.freeze({
		type: 'selection',
		namespace: metadata.namespace,
		entries: Object.freeze(metadata.entries.map((entry) => documentEntry(metadata.keyByEntry.get(entry)!, entry))),
	});
}

/**
 * Builds or validates the document entry consumed by immutable catalog composition.
 *
 * @internal
 */
function documentEntry(key: string, entry: CatalogEntryIdentity): CatalogEntryDocument {
	return Object.freeze({
		key,
		id: entry.id,
		kind: entry.kind,
		...(entry.description !== undefined ? { description: entry.description } : {}),
	});
}

/**
 * Walks nested input while preserving the module's deterministic traversal rules.
 *
 * It preserves exact definition identity and deterministic composition without creating mutable global registration state.
 *
 * @internal
 */
function visit<Entry extends CatalogEntryIdentity>(
	input: DefinitionInput<Entry>,
	accept: (entry: Entry) => void,
): void {
	if (Array.isArray(input)) {
		for (const item of input) visit(item, accept);
		return;
	}
	if (isCatalog(input)) {
		for (const entry of readCatalogMetadata(input).entries as readonly Entry[]) accept(entry);
		return;
	}
	if (isSelection(input)) {
		for (const entry of readSelectionMetadata(input).entries as readonly Entry[]) accept(entry);
		return;
	}
	accept(input as Entry);
}

/**
 * Walks unknown while preserving the module's deterministic traversal rules.
 *
 * It preserves exact definition identity and deterministic composition without creating mutable global registration state.
 *
 * @internal
 */
function visitUnknown(input: unknown, accept: (entry: unknown) => void): void {
	if (Array.isArray(input)) {
		for (const item of input) visitUnknown(item, accept);
		return;
	}
	if (isCatalog(input)) {
		for (const entry of readCatalogMetadata(input).entries) accept(entry);
		return;
	}
	if (isSelection(input)) {
		for (const entry of readSelectionMetadata(input).entries) accept(entry);
		return;
	}
	accept(input);
}

/**
 * Builds or validates the define entry consumed by immutable catalog composition.
 *
 * @internal
 */
function defineEntry(target: Record<PropertyKey, CatalogEntryIdentity>, key: string, entry: CatalogEntryIdentity): void {
	Object.defineProperty(target, key, {
		value: entry,
		enumerable: true,
		writable: false,
		configurable: false,
	});
}

/**
 * Rejects invalid namespace before it can enter authoritative module state.
 *
 * @internal
 */
function assertNamespace(namespace: string): void {
	if (namespace.trim().length === 0) throw new TypeError('Catalog namespace cannot be empty.');
}

/**
 * Rejects invalid entry before it can enter authoritative module state.
 *
 * @internal
 */
function assertEntry(value: unknown, key?: string): asserts value is CatalogEntryIdentity {
	if (!isEntry(value)) {
		throw new TypeError(`${key ? `Catalog entry ${JSON.stringify(key)}` : 'Catalog entry'} must have string id and kind.`);
	}
	if (value.id.length === 0) throw new TypeError('Catalog entry id cannot be empty.');
	if (value.kind.length === 0) throw new TypeError(`Catalog entry ${JSON.stringify(value.id)} kind cannot be empty.`);
}

/**
 * Checks whether entry satisfies the condition required by immutable catalog composition.
 *
 * @internal
 */
function isEntry(value: unknown): value is CatalogEntryIdentity {
	return typeof value === 'object' && value !== null &&
		typeof (value as { id?: unknown }).id === 'string' &&
		typeof (value as { kind?: unknown }).kind === 'string';
}

/**
 * Rejects invalid id ownership before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdOwnership(
	owners: Map<string, CatalogEntryIdentity>,
	entry: CatalogEntryIdentity,
): void {
	const owner = owners.get(entry.id);
	if (owner && owner !== entry) throw new CatalogConflictError(entry.id, owner, entry);
	owners.set(entry.id, entry);
}

/**
 * Reads catalog metadata under the module's cancellation and ownership rules.
 *
 * @internal
 */
function readCatalogMetadata<Entry extends CatalogEntryIdentity>(value: Catalog<Entry>): CatalogMetadata<Entry> {
	return (value as unknown as { [catalogMetadata]: CatalogMetadata<Entry> })[catalogMetadata];
}

/**
 * Reads selection metadata under the module's cancellation and ownership rules.
 *
 * @internal
 */
function readSelectionMetadata<Entry extends CatalogEntryIdentity>(
	value: CatalogSelection<Entry>,
): CatalogSelectionMetadata<Entry> {
	return (value as unknown as { [selectionMetadata]: CatalogSelectionMetadata<Entry> })[selectionMetadata];
}

export type {
	Catalog,
	CatalogDocument,
	CatalogEntryDocument,
	CatalogEntryIdentity,
	CatalogEntryValue,
	CatalogLike,
	CatalogMetadata,
	CatalogSelection,
	CatalogSelectionMetadata,
	CatalogValidationIssue,
	CatalogValidationResult,
	DefinitionEntry,
	DefinitionInput,
	ValuedCatalogEntry,
} from './types.ts';
