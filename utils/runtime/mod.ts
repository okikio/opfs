/**
 * Logical execution-location definitions used by activity placement policy.
 *
 * Runtime definitions are labels for placement. They do not start processes,
 * threads, queue consumers, or provider clients.
 *
 * @module
 */
import * as catalogCore from '@utils/catalog';
import type { DefinitionInput as CatalogDefinitionInput } from '@utils/catalog';

import type { Definition, DefinitionInput, Document, RuntimeCatalog, RuntimeSelection } from './types.ts';

/** Define one immutable logical runtime. */
export function define<const Id extends string>(input: DefinitionInput & Readonly<{ readonly id: Id }>): Definition & Readonly<{ readonly id: Id }> {
	assertIdentifier(input.id);
	if (input.description.trim().length === 0) throw new TypeError('Runtime description must not be empty.');
	return Object.freeze({ kind: 'runtime', ...input });
}

/** Create a named immutable runtime catalog. */
export function runtimeCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
>(namespace: Namespace, entries: Entries): RuntimeCatalog<Entries> {
	return catalogCore.create(namespace, entries);
}

/** Select a key-preserving runtime catalog subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: RuntimeCatalog<Entries>,
	keys: Keys,
): RuntimeSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogCore.select(source, keys);
}

/** Compose runtime definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends Definition>(...input: readonly CatalogDefinitionInput<Entry>[]): readonly Entry[] {
	return catalogCore.compose(...input);
}

/** Create deterministic runtime documentation. */
export function document(input: CatalogDefinitionInput<Definition>): readonly Document[] {
	return Object.freeze(catalogCore.values(input).map((definition) => Object.freeze({
		id: definition.id,
		description: definition.description,
	})));
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid runtime id ${JSON.stringify(value)}.`);
}

export { runtimeCatalog as catalog };
export type * from './types.ts';
