import type { Catalog, CatalogEntryIdentity, CatalogSelection } from '@utils/catalog';

/** Stable logical location where activities may execute. */
export interface Definition extends CatalogEntryIdentity {
	readonly kind: 'runtime';
	readonly description: string;
}

/** Input accepted by {@link define}. */
export interface DefinitionInput {
	readonly id: string;
	readonly description: string;
}

/** Named runtime catalog. */
export type RuntimeCatalog<Entries extends Readonly<Record<PropertyKey, Definition>>> = Catalog<Entries[keyof Entries], Entries>;

/** Key-preserving runtime catalog selection. */
export type RuntimeSelection<
	Entry extends Definition,
	Entries extends Readonly<Record<PropertyKey, Entry>>,
> = CatalogSelection<Entry, Entries>;

/** JSON-safe runtime documentation. */
export interface Document {
	readonly id: string;
	readonly description: string;
}
