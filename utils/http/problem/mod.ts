import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as catalog from '@utils/catalog';
import type { Catalog, CatalogEntryIdentity, CatalogSelection, DefinitionInput } from '@utils/catalog';
import { mergeHeaders } from '@utils/http/response/headers';

import type {
	CreateProblemOptions,
	ProblemBody,
	ProblemDefinition,
	ProblemDefinitionInput,
	ProblemDocument,
	ProblemExtensionContract,
	ProblemHeaders,
	ProblemResult,
	ProblemResultMetadata,
	ProblemRetryPolicy,
	ProblemSeverity,
	ProblemStatus,
} from './types.ts';

const problemResultMetadata = Symbol('kaiju.problem-result');
const canonicalMembers = new Set(['type', 'title', 'status', 'detail', 'instance']);

/** Define one immutable RFC 9457 problem contract. */
export function define<
	const Extensions extends ProblemExtensionContract | undefined = undefined,
	const Status extends ProblemStatus = ProblemStatus,
>(input: ProblemDefinitionInput<Extensions, Status>): ProblemDefinition<Extensions, Status> {
	assertDefinition(input);
	return Object.freeze({
		...input,
		kind: 'problem',
		exposure: input.exposure ?? 'public',
		...(input.examples ? { examples: Object.freeze([...input.examples]) } : {}),
		...(input.retry ? { retry: Object.freeze({ ...input.retry }) } : {}),
		...(input.provider ? { provider: Object.freeze({ ...input.provider }) } : {}),
	});
}

/** Create a named immutable problem catalog. */
export function problemCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, ProblemDefinition>>,
>(namespace: Namespace, entries: Entries): Catalog<Entries[keyof Entries], Entries> {
	return catalog.create(namespace, entries);
}

/** Select an immutable key-preserving problem subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, ProblemDefinition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalog.select(source, keys);
}

/** Compose problem definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends ProblemDefinition>(
	...inputs: readonly DefinitionInput<Entry>[]
): readonly Entry[] {
	return catalog.compose(...inputs);
}

/** Instantiate one problem occurrence as an RFC 9457 tuple. */
export function create<
	Definition extends ProblemDefinition,
	Extensions extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>,
>(
	definition: Definition,
	options: CreateProblemOptions<Extensions> = {},
): ProblemResult<Definition, ProblemBody<Definition> & Extensions> &
	{ readonly [problemResultMetadata]: ProblemResultMetadata<Definition> } {
	const extensions = options.extensions ?? ({} as Extensions);
	for (const key of Object.keys(extensions)) {
		if (canonicalMembers.has(key)) throw new TypeError(`Problem extension ${JSON.stringify(key)} overwrites an RFC 9457 member.`);
	}

	const body = Object.freeze({
		type: definition.type,
		title: definition.title,
		status: definition.status,
		...(options.detail !== undefined ? { detail: options.detail } : {}),
		...(options.instance !== undefined ? { instance: options.instance } : {}),
		...extensions,
	}) as ProblemBody<Definition> & Extensions;

	const headers = mergeHeaders(
		{ 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
		options.headers,
	);

	const tuple = [body, definition.status, headers] as unknown as ProblemResult<
		Definition,
		ProblemBody<Definition> & Extensions
	> & { readonly [problemResultMetadata]: ProblemResultMetadata<Definition> };

	Object.defineProperty(tuple, problemResultMetadata, {
		value: Object.freeze({
			definition,
			...(options.cause !== undefined ? { cause: options.cause } : {}),
		}),
		enumerable: false,
		writable: false,
		configurable: false,
	});

	return Object.freeze(tuple);
}

/** Return whether a value is any problem result or belongs to one definition/input. */
export function is(value: unknown): value is ProblemResult;
/** Return whether a value belongs to one exact problem definition. */
export function is<Definition extends ProblemDefinition>(
	value: unknown,
	definition: Definition,
): value is ProblemResult<Definition>;
/** Return whether a value belongs to any problem in a composed definition input. */
export function is<Entry extends ProblemDefinition>(
	value: unknown,
	input: DefinitionInput<Entry>,
): value is ProblemResult<Entry>;
/** Narrow a value to a problem result and optionally one exact declared universe. */
export function is(value: unknown, input?: DefinitionInput<ProblemDefinition>): value is ProblemResult {
	if (!Array.isArray(value) || !(problemResultMetadata in value)) return false;
	if (input === undefined) return true;
	const definition = (value as unknown as { readonly [problemResultMetadata]: ProblemResultMetadata })[
		problemResultMetadata
	].definition;
	return catalog.values(input).includes(definition);
}

/** Return the exact imported definition retained by a problem tuple. */
export function definitionOf<Definition extends ProblemDefinition>(value: ProblemResult<Definition>): Definition {
	if (!is(value)) throw new TypeError('Value is not a problem result.');
	return (value as unknown as { readonly [problemResultMetadata]: ProblemResultMetadata<Definition> })[
		problemResultMetadata
	].definition;
}

/** Return the internal cause retained by a problem tuple, when present. */
export function causeOf(value: ProblemResult): unknown {
	if (!is(value)) throw new TypeError('Value is not a problem result.');
	return (value as unknown as { readonly [problemResultMetadata]: ProblemResultMetadata })[problemResultMetadata].cause;
}

/** Exhaustively branch by direct definition identity using catalog keys. */
export function match<
	Entry extends ProblemDefinition,
	const Entries extends Readonly<Record<PropertyKey, Entry>>,
	Result,
>(
	value: ProblemResult<Entry>,
	universe: Catalog<Entry, Entries> | CatalogSelection<Entry, Entries>,
	handlers: { readonly [Key in keyof Entries]: (value: ProblemResult<Entries[Key]>) => Result },
): Result;
/** Branch through partial handlers with one required fallback. */
export function match<
	Entry extends ProblemDefinition,
	const Entries extends Readonly<Record<PropertyKey, Entry>>,
	Result,
>(
	value: ProblemResult<Entry>,
	universe: Catalog<Entry, Entries> | CatalogSelection<Entry, Entries>,
	handlers: Partial<{ readonly [Key in keyof Entries]: (value: ProblemResult<Entries[Key]>) => Result }>,
	options: { readonly otherwise: (value: ProblemResult<Entry>) => Result },
): Result;
/** Dispatch a problem result through exhaustive or fallback handlers. */
export function match(
	value: ProblemResult,
	universe: Catalog<ProblemDefinition> | CatalogSelection<ProblemDefinition>,
	handlers: Readonly<Record<PropertyKey, ((value: ProblemResult) => unknown) | undefined>>,
	options?: { readonly otherwise: (value: ProblemResult) => unknown },
): unknown {
	const definition = definitionOf(value);
	const metadata = catalog.metadata(universe);
	const key = metadata.keyByEntry.get(definition);
	if (key === undefined) throw new TypeError(`Problem ${JSON.stringify(definition.id)} is outside the supplied universe.`);
	const handler = handlers[key];
	if (handler) return handler(value);
	if (options) return options.otherwise(value);
	throw new TypeError(`Problem handler ${JSON.stringify(key)} is missing.`);
}

/** Exhaustively translate one problem universe into problem results. */
export function map<
	Entry extends ProblemDefinition,
	const Entries extends Readonly<Record<PropertyKey, Entry>>,
	Result extends ProblemResult,
>(
	value: ProblemResult<Entry>,
	universe: Catalog<Entry, Entries> | CatalogSelection<Entry, Entries>,
	handlers: { readonly [Key in keyof Entries]: (value: ProblemResult<Entries[Key]>) => Result },
): Result {
	return match(value, universe, handlers);
}

/** Create JSON-safe documentation from definitions, catalogs, or selections. */
export function document(input: DefinitionInput<ProblemDefinition>): readonly ProblemDocument[] {
	const keys = new Map<ProblemDefinition, string>();
	if (catalog.is(input)) {
		const metadata = catalog.metadata(input);
		for (const entry of metadata.entries) keys.set(entry as ProblemDefinition, metadata.keyByEntry.get(entry)!);
	}

	return Object.freeze(catalog.values(input).map((definition): ProblemDocument => {
		const key = keys.get(definition);
		return Object.freeze({
		...(key !== undefined ? { key } : {}),
		id: definition.id,
		type: definition.type,
		status: definition.status,
		title: definition.title,
		description: definition.description,
		...(definition.remediation !== undefined ? { remediation: definition.remediation } : {}),
		...(definition.externalDocumentation !== undefined
			? { externalDocumentation: definition.externalDocumentation }
			: {}),
		retry: definition.retry ?? Object.freeze({ kind: 'never' as const }),
		severity: definition.severity ?? 'error',
		exposure: definition.exposure,
		examples: definition.examples ?? Object.freeze([]),
		...(definition.provider !== undefined ? { provider: definition.provider } : {}),
		});
	}));
}

/** Validate definition extension values against the optional Standard Schema contract. */
export async function validateExtensions<Definition extends ProblemDefinition>(
	definition: Definition,
	value: unknown,
): Promise<readonly StandardSchemaV1.Issue[]> {
	const schema = definition.extensions?.schema;
	if (!schema) return Object.freeze([]);
	const result = await schema['~standard'].validate(value);
	return Object.freeze(result.issues ? [...result.issues] : []);
}

/**
 * Rejects invalid definition before it can enter authoritative module state.
 *
 * It keeps RFC 9457 problem representation separate from domain failure identity and server-framework execution.
 *
 * @internal
 */
function assertDefinition(input: ProblemDefinitionInput<ProblemExtensionContract | undefined, ProblemStatus>): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(input.id)) throw new TypeError(`Invalid problem id ${JSON.stringify(input.id)}.`);
	let type: URL;
	try {
		type = new URL(input.type);
	} catch {
		throw new TypeError(`Problem type ${JSON.stringify(input.type)} must be an absolute URI.`);
	}
	if (!type.protocol) throw new TypeError('Problem type must be absolute.');
	if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) {
		throw new TypeError(`Problem status ${input.status} must be an HTTP error status.`);
	}
	if (input.title.trim().length === 0) throw new TypeError('Problem title cannot be empty.');
	if (input.description.trim().length === 0) throw new TypeError('Problem description cannot be empty.');
}

export { problemCatalog as catalog };
export type {
	CreateProblemOptions,
	ProblemBody,
	ProblemDefinition,
	ProblemDefinitionInput,
	ProblemDocument,
	ProblemExample,
	ProblemExtensionContract,
	ProblemHeaders,
	ProblemProviderMetadata,
	ProblemResult,
	ProblemResultMetadata,
	ProblemRetryPolicy,
	ProblemSeverity,
	ProblemStatus,
} from './types.ts';
