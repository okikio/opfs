/**
 * Stable expected-failure definitions and durable failure occurrences.
 *
 * Failures describe why work could not complete. They do not define HTTP
 * presentation or the success-or-failure container used by callers.
 *
 * @module
 */
import * as catalogCore from '@utils/catalog';
import type { Catalog, CatalogSelection, DefinitionInput } from '@utils/catalog';
import * as schema from '@utils/schema';

import type { Data, Definition, Encoded, FailureCatalog, FailureSelection, Occurrence } from './types.ts';

/** Error raised when durable failure data references an unknown definition. */
export class UnknownFailureDefinitionError extends TypeError {
	readonly id: string;

	constructor(id: string) {
		super(`Unknown failure definition ${JSON.stringify(id)}.`);
		this.name = 'UnknownFailureDefinitionError';
		this.id = id;
	}
}

/**
 * Owns the internal failure occurrence state used by declared failure encoding.
 *
 * Failure internals preserve stable expected-failure identity across process-local occurrences and durable encoded values.
 *
 * @internal
 */
class FailureOccurrence<FailureDefinition extends Definition> extends Error implements Occurrence<FailureDefinition> {
	readonly definition: FailureDefinition;
	readonly data: Data<FailureDefinition>;

	constructor(definition: FailureDefinition, data: Data<FailureDefinition>, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'Failure';
		this.definition = definition;
		this.data = data;
		Object.freeze(this);
	}
}

/** Define one immutable expected failure contract. */
export function define<const Id extends string, Output>(input: Readonly<{
	readonly id: Id;
	readonly description: string;
	readonly data: import('@standard-schema/spec').StandardSchemaV1<unknown, Output>;
}>): Definition<Id, Output> {
	assertIdentifier(input.id);
	if (input.description.trim().length === 0) throw new TypeError('Failure description must not be empty.');
	schema.assert(input.data, 'failure data schema');
	return Object.freeze({ kind: 'failure', ...input });
}

/** Create a named immutable failure catalog. */
export function failureCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
>(namespace: Namespace, entries: Entries): FailureCatalog<Entries> {
	return catalogCore.create(namespace, entries);
}

/** Select a key-preserving failure catalog subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: FailureCatalog<Entries>,
	keys: Keys,
): FailureSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogCore.select(source, keys);
}

/** Compose direct failure definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends Definition>(...inputs: readonly DefinitionInput<Entry>[]): readonly Entry[] {
	return catalogCore.compose(...inputs);
}

/** Create one schema-validated failure occurrence. */
export async function create<FailureDefinition extends Definition>(
	definition: FailureDefinition,
	input: Readonly<{ readonly data: unknown; readonly message?: string; readonly cause?: unknown }>,
): Promise<Occurrence<FailureDefinition>> {
	const data = await schema.parse(definition.data, input.data) as Data<FailureDefinition>;
	return new FailureOccurrence(
		definition,
		data,
		input.message ?? definition.description,
		input.cause,
	);
}

/** Return whether a value is any failure occurrence created by this package. */
export function isOccurrence(value: unknown): value is Occurrence {
	return value instanceof Error &&
		typeof (value as Partial<Occurrence>).definition === 'object' &&
		(value as Partial<Occurrence>).definition?.kind === 'failure' &&
		'data' in value;
}

/** Return whether a value is an occurrence of one exact failure definition. */
export function is<FailureDefinition extends Definition>(
	value: unknown,
	definition: FailureDefinition,
): value is Occurrence<FailureDefinition> {
	return isOccurrence(value) && value.definition === definition;
}

/** Match a failure occurrence by stable definition ID. */
export function match<Value>(
	value: Occurrence,
	cases: Readonly<Record<string, (value: Occurrence) => Value>>,
	otherwise?: (value: Occurrence) => Value,
): Value {
	const handler = cases[value.definition.id];
	if (handler !== undefined) return handler(value);
	if (otherwise !== undefined) return otherwise(value);
	throw new TypeError(`No failure match case exists for ${JSON.stringify(value.definition.id)}.`);
}

/** Encode an occurrence after revalidating its durable data. Causes are deliberately omitted. */
export async function encode(value: Occurrence): Promise<Encoded> {
	const data = await schema.parse(value.definition.data, value.data);
	return Object.freeze({ id: value.definition.id, data, message: value.message });
}

/** Decode and validate a durable occurrence through a trusted failure catalog. */
export async function decode<Entry extends Definition>(
	value: unknown,
	trusted: DefinitionInput<Entry>,
): Promise<Occurrence<Entry>> {
	if (!isEncoded(value)) throw new TypeError('Encoded failure must contain string id, message, and data fields.');
	const definition = catalogCore.values(trusted).find((entry) => entry.id === value.id);
	if (definition === undefined) throw new UnknownFailureDefinitionError(value.id);
	return await create(definition, { data: value.data, message: value.message });
}

/**
 * Checks whether encoded satisfies the condition required by declared failure encoding.
 *
 * @internal
 */
function isEncoded(value: unknown): value is Encoded {
	return typeof value === 'object' && value !== null &&
		typeof (value as { readonly id?: unknown }).id === 'string' &&
		typeof (value as { readonly message?: unknown }).message === 'string' &&
		'data' in value;
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid failure id ${JSON.stringify(value)}.`);
}

export { failureCatalog as catalog };
export type * from './types.ts';
