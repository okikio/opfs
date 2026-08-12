import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as catalog from '@utils/catalog';
import type { Catalog, CatalogSelection, DefinitionInput } from '@utils/catalog';

import { headers } from './headers.ts';
import type {
	HtmlBody,
	PaginationResponsePolicy,
	ResponseDefinition,
	ResponseDefinitionInput,
	ResponseDocument,
	ResponseSchema,
	ResponseStatus,
} from './types.ts';

const defaultPaginationPolicy: PaginationResponsePolicy = Object.freeze({ links: 'both', totals: 'both' });

const htmlBodySchema: ResponseSchema<unknown, HtmlBody> & Readonly<{
	readonly '~standard-json-schema': Readonly<{ readonly version: 1; readonly vendor: 'kaiju-response'; readonly jsonSchema: Readonly<Record<string, unknown>> }>;
}> = Object.freeze({
	'~standard': Object.freeze({
		version: 1,
		vendor: 'kaiju-response',
		/**
		 * Checks state and preserves the deterministic issues needed by callers.
		 *
		 * @internal
		 */
		validate(value: unknown): StandardSchemaV1.Result<HtmlBody> {
			return typeof value === 'string' || value instanceof ReadableStream || isAsyncIterable(value)
				? { value: value as HtmlBody }
				: { issues: [{ message: 'Expected an HTML string, byte stream, or async iterable.' }] };
		},
	}),
	'~standard-json-schema': Object.freeze({
		version: 1,
		vendor: 'kaiju-response',
		jsonSchema: Object.freeze({ type: 'string', description: 'HTML document or streamed HTML representation.' }),
	}),
});

/** Define one immutable successful HTTP response contract. */
export function define<const Schema extends ResponseSchema | undefined, const Status extends ResponseStatus>(
	input: ResponseDefinitionInput<Schema, Status>,
): ResponseDefinition<Schema, Status> {
	assertDefinition(input);
	const mode = input.mode ?? 'body';
	return Object.freeze({
		kind: 'response',
		id: input.id,
		status: input.status,
		description: input.description,
		...(input.schema !== undefined ? { schema: input.schema } : {}),
		...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
		...(input.headers !== undefined ? { headers: headers(input.headers) } : {}),
		...(input.examples ? { examples: Object.freeze(input.examples.map((example) => Object.freeze({ ...example }))) } : {}),
		mode,
		envelope: input.envelope ?? (mode === 'page' ? 'data' : 'none'),
		timestamp: input.timestamp ?? false,
		...(mode === 'page'
			? { pagination: Object.freeze({ ...defaultPaginationPolicy, ...(input.pagination ?? {}) }) }
			: {}),
		...(input.filename !== undefined ? { filename: input.filename } : {}),
	});
}

/** Define a `200 OK` response. */
export function ok<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 200>, 'id' | 'status' | 'schema'> & { readonly id?: string },
): ResponseDefinition<Schema, 200> {
	return define({ ...options, id: options.id ?? defaultId(200, options.description), status: 200, schema });
}

/** Define a `201 Created` response. */
export function created<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 201>, 'id' | 'status' | 'schema'> & { readonly id?: string },
): ResponseDefinition<Schema, 201> {
	return define({ ...options, id: options.id ?? defaultId(201, options.description), status: 201, schema });
}

/** Define a `202 Accepted` response. */
export function accepted<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 202>, 'id' | 'status' | 'schema'> & { readonly id?: string },
): ResponseDefinition<Schema, 202> {
	return define({ ...options, id: options.id ?? defaultId(202, options.description), status: 202, schema });
}

/** Define a bodyless `204 No Content` response. */
export function noContent(
	options: Omit<ResponseDefinitionInput<undefined, 204>, 'id' | 'status' | 'schema' | 'mode' | 'description'> & {
		readonly id?: string;
		readonly description?: string;
	} = {},
): ResponseDefinition<undefined, 204> & { readonly mode: 'empty' } {
	const description = options.description ?? 'No content.';
	return define({ ...options, id: options.id ?? defaultId(204, description), description, status: 204, mode: 'empty' }) as ResponseDefinition<undefined, 204> & { readonly mode: 'empty' };
}


/** Define a bodyless `304 Not Modified` response for explicit conditional contracts. */
export function notModified(
	options: Omit<ResponseDefinitionInput<undefined, 304>, 'id' | 'status' | 'schema' | 'mode' | 'description'> & {
		readonly id?: string;
		readonly description?: string;
	} = {},
): ResponseDefinition<undefined, 304> & { readonly mode: 'empty' } {
	const description = options.description ?? 'Not modified.';
	return define({ ...options, id: options.id ?? defaultId(304, description), description, status: 304, mode: 'empty' }) as ResponseDefinition<undefined, 304> & { readonly mode: 'empty' };
}

/** Define a `206 Partial Content` response whose body is produced by an artifact adapter. */
export function partialContent<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 206>, 'id' | 'status' | 'schema'> & { readonly id?: string },
): ResponseDefinition<Schema, 206> & { readonly mode: 'body' } {
	return define({ ...options, id: options.id ?? defaultId(206, options.description), status: 206, schema }) as ResponseDefinition<Schema, 206> & { readonly mode: 'body' };
}

/** Define an HTTP redirect response. */
export function redirect<const Status extends 300 | 301 | 302 | 303 | 305 | 307 | 308>(
	status: Status,
	options: Omit<ResponseDefinitionInput<undefined, Status>, 'id' | 'status' | 'schema' | 'mode'> & { readonly id?: string },
): ResponseDefinition<undefined, Status> & { readonly mode: 'redirect' } {
	return define({ ...options, id: options.id ?? defaultId(status, options.description), status, mode: 'redirect' }) as ResponseDefinition<undefined, Status> & { readonly mode: 'redirect' };
}

/** Define a streaming response. */
export function stream<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 200>, 'id' | 'status' | 'schema' | 'mode'> & { readonly id?: string },
): ResponseDefinition<Schema, 200> & { readonly mode: 'stream' } {
	return define({ ...options, id: options.id ?? defaultId(200, options.description), status: 200, schema, mode: 'stream' }) as ResponseDefinition<Schema, 200> & { readonly mode: 'stream' };
}

/** Define a paginated collection response. */
export function paginated<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 200>, 'id' | 'status' | 'schema' | 'mode'> & { readonly id?: string },
): ResponseDefinition<Schema, 200> & { readonly mode: 'page' } {
	return define({ ...options, id: options.id ?? defaultId(200, options.description), status: 200, schema, mode: 'page' }) as ResponseDefinition<Schema, 200> & { readonly mode: 'page' };
}

/** Define a downloadable response. */
export function download<const Schema extends ResponseSchema>(
	schema: Schema,
	options: Omit<ResponseDefinitionInput<Schema, 200>, 'id' | 'status' | 'schema' | 'mode'> & { readonly id?: string },
): ResponseDefinition<Schema, 200> {
	return define({ ...options, id: options.id ?? defaultId(200, options.description), status: 200, schema, mode: 'download' });
}

/** Define a small one-off HTML page without changing the Solid application renderer. */
export function html(
	options: Omit<ResponseDefinitionInput<typeof htmlBodySchema, 200>, 'id' | 'status' | 'schema' | 'mode' | 'contentType'> & {
		readonly id?: string;
		readonly contentType?: string;
	},
): ResponseDefinition<typeof htmlBodySchema, 200> & { readonly mode: 'html' } {
	return define({
		...options,
		id: options.id ?? defaultId(200, options.description),
		status: 200,
		schema: htmlBodySchema,
		mode: 'html',
		contentType: options.contentType ?? 'text/html; charset=utf-8',
	}) as ResponseDefinition<typeof htmlBodySchema, 200> & { readonly mode: 'html' };
}

/** Create a named immutable response catalog. */
export function responseCatalog<const Namespace extends string, const Entries extends Readonly<Record<PropertyKey, ResponseDefinition>>>(
	namespace: Namespace,
	entries: Entries,
): Catalog<Entries[keyof Entries], Entries> {
	return catalog.create(namespace, entries);
}

/** Select an immutable key-preserving response subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, ResponseDefinition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalog.select(source, keys);
}

/** Compose response definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends ResponseDefinition>(...inputs: readonly DefinitionInput<Entry>[]): readonly Entry[] {
	return catalog.compose(...inputs);
}

/** Create JSON-safe response documentation. */
export function document(input: DefinitionInput<ResponseDefinition>): readonly ResponseDocument[] {
	return Object.freeze(catalog.values(input).map((definition) => Object.freeze({
		id: definition.id,
		status: definition.status,
		description: definition.description,
		...(definition.contentType !== undefined ? { contentType: definition.contentType } : {}),
		mode: definition.mode,
		envelope: definition.envelope,
		timestamp: definition.timestamp,
		...(definition.pagination !== undefined ? { pagination: definition.pagination } : {}),
		examples: definition.examples ?? Object.freeze([]),
		headers: definition.headers ?? Object.freeze({}),
		...(definition.filename !== undefined ? { filename: definition.filename } : {}),
	})));
}

/**
 * Creates the fallback id used when logical HTTP response construction receives no explicit value.
 *
 * @internal
 */
function defaultId(status: ResponseStatus, description: string): string {
	const slug = description.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
	if (slug.length === 0) throw new TypeError('Response description must contain an identifier-safe character or an explicit id must be supplied.');
	return `http:${status}:${slug}`;
}

/**
 * Rejects invalid definition before it can enter authoritative module state.
 *
 * It builds deterministic logical HTTP representations before a framework creates the native Response.
 *
 * @internal
 */
function assertDefinition(input: ResponseDefinitionInput<ResponseSchema | undefined, ResponseStatus>): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(input.id)) throw new TypeError(`Invalid response id ${JSON.stringify(input.id)}.`);
	if (input.description.trim().length === 0) throw new TypeError('Response description cannot be empty.');
	const mode = input.mode ?? 'body';
	if (mode === 'empty' && input.schema !== undefined) throw new TypeError('Empty responses cannot define a body schema.');
	if (mode !== 'empty' && mode !== 'redirect' && input.schema === undefined) throw new TypeError(`${mode} responses require a body schema.`);
	if ([204, 205, 304].includes(input.status) && mode !== 'empty') throw new TypeError(`HTTP ${input.status} responses must use empty mode.`);
	if (mode === 'redirect' && ![300, 301, 302, 303, 305, 307, 308].includes(input.status)) throw new TypeError('Redirect responses require a redirect status.');
	if (input.filename !== undefined && mode !== 'download') throw new TypeError('Response filenames are only valid for download responses.');
	if (input.pagination !== undefined && mode !== 'page') throw new TypeError('Pagination presentation is only valid for paginated responses.');
	if (mode === 'page' && input.envelope === 'none') throw new TypeError('Paginated responses require the data envelope.');
}

/**
 * Checks whether async iterable satisfies the condition required by logical HTTP response construction.
 *
 * @internal
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
