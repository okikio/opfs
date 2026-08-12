import { mergeHeaders } from './headers.ts';
import type {
	CreateResponseOptions,
	CursorPageWindow,
	OffsetPageWindow,
	PageWindow,
	PaginationLinkContext,
	PaginationLinks,
	PaginationMetadata,
	PaginationParameters,
	FinalizedResponseResult,
	FinalizeResponseOptions,
	ResponseBody,
	ResponseDefinition,
	ResponseHeaders,
	ResponseResult,
	ResponseResultMetadata,
	ResponseSchema,
	SuccessEnvelope,
} from './types.ts';

const responseResultMetadata = Symbol('kaiju.response-result');
const defaultParameters: PaginationParameters = Object.freeze({
	cursor: 'cursor',
	limit: 'limit',
	offset: 'offset',
	page: 'page',
	perPage: 'per_page',
});

/** Instantiate a definition-associated logical result. Request-dependent work happens in {@link finalize}. */
export function create<Definition extends ResponseDefinition>(
	definition: Definition,
	body: ResponseBody<Definition>,
	options: CreateResponseOptions = {},
): ResponseResult<Definition, Definition['mode'] extends 'empty' | 'redirect' ? null : Exclude<ResponseBody<Definition>, undefined>> &
	{ readonly [responseResultMetadata]: ResponseResultMetadata<Definition> } {
	const baseHeaders = mergeHeaders(definition.headers, options.headers);
	const additional: Record<string, string> = Object.create(null);
	if (options.location !== undefined) additional.Location = safeHeaderValue(String(options.location), 'Location');
	if (definition.mode === 'redirect' && additional.Location === undefined && !hasHeader(baseHeaders, 'Location')) {
		throw new TypeError(`Redirect response ${JSON.stringify(definition.id)} requires a Location header.`);
	}
	if (definition.contentType !== undefined && !hasHeader(baseHeaders, 'Content-Type')) additional['Content-Type'] = definition.contentType;
	const filename = options.filename ?? definition.filename;
	if (filename !== undefined && !hasHeader(baseHeaders, 'Content-Disposition')) {
		additional['Content-Disposition'] = `attachment; filename="${escapeFilename(filename)}"`;
	}
	const tuple = [
		definition.mode === 'empty' || definition.mode === 'redirect' ? null : body,
		definition.status,
		mergeHeaders(baseHeaders, additional),
	] as unknown as ResponseResult<Definition, Definition['mode'] extends 'empty' | 'redirect' ? null : Exclude<ResponseBody<Definition>, undefined>> &
		{ readonly [responseResultMetadata]: ResponseResultMetadata<Definition> };
	attachMetadata(tuple, Object.freeze({ definition, options: freezeOptions(options) }));
	return Object.freeze(tuple);
}

/**
 * Finalize one logical result with request-aware transport metadata.
 *
 * Handlers call {@link create} before a public request URL, current time, or
 * adapter-specific pagination parameter names necessarily exist. The server
 * adapter calls `finalize` exactly once after handler/result validation to:
 *
 * - generate pagination links from the current or explicitly supplied URL;
 * - preserve non-pagination query parameters and fragments;
 * - emit configured Link/count headers and body metadata;
 * - create optional data envelopes and timestamps.
 *
 * This function still returns a transport-neutral finalized value. The selected
 * server adapter owns the subsequent conversion to a native `Response`,
 * including prepared middleware headers and repeated Set-Cookie fields.
 */
export function finalize<Definition extends ResponseDefinition>(
	result: ResponseResult<Definition>,
	options: FinalizeResponseOptions = {},
): FinalizedResponseResult<Definition> {
	const metadata = metadataOf(result);
	const definition = metadata.definition;
	let body: unknown = result[0];
	let resolvedHeaders = result[2];
	let links: PaginationLinks | undefined;
	let pagination: PaginationMetadata | undefined;
	if (definition.mode === 'page') {
		const page = asPageWindow(body);
		const baseUrl = metadata.options.url ?? options.url;
		const policy = definition.pagination!;
		links = baseUrl === undefined ? Object.freeze({}) : pageLinks(page, baseUrl, {
			...defaultParameters,
			...(options.pagination ?? {}),
		}, metadata.options.link);
		pagination = pageMetadata(page, policy.totals === 'body' || policy.totals === 'both');
		if ((policy.links === 'header' || policy.links === 'both') && Object.keys(links).length > 0) {
			resolvedHeaders = mergeHeaders(resolvedHeaders, { Link: linkHeader(links) });
		}
		if (policy.totals === 'headers' || policy.totals === 'both') {
			resolvedHeaders = mergeHeaders(resolvedHeaders, paginationHeaders(page, pagination));
		}
		body = page.items;
	}
	const generatedMeta = buildMeta(definition.timestamp, metadata.options.meta, pagination, options.now);
	const shouldEnvelope = definition.envelope === 'data' || generatedMeta !== undefined || definition.mode === 'page';
	if (shouldEnvelope && definition.mode !== 'empty' && definition.mode !== 'redirect') {
		const envelope: SuccessEnvelope = Object.freeze({
			data: body,
			...(generatedMeta !== undefined ? { meta: generatedMeta } : {}),
			...(definition.mode === 'page' &&
				(definition.pagination!.links === 'body' || definition.pagination!.links === 'both') &&
				links !== undefined && Object.keys(links).length > 0
				? { links }
				: {}),
		});
		body = envelope;
	}
	return Object.freeze({ definition, body, status: result[1], headers: resolvedHeaders });
}

/** Return a copy of a logical result with occurrence headers merged in. */
export function withHeaders<Definition extends ResponseDefinition>(
	result: ResponseResult<Definition>,
	headers: import('./headers.ts').HeaderInput,
): ResponseResult<Definition> {
	if (!is(result)) throw new TypeError('Value is not a response result.');
	return clone(result, result[0], mergeHeaders(result[2], headers), metadataOf(result).options);
}

/** Return a copy whose final body contains merged metadata in a data envelope. */
export function withMeta<Definition extends ResponseDefinition>(
	result: ResponseResult<Definition>,
	meta: Readonly<Record<string, unknown>>,
): ResponseResult<Definition> {
	if (!is(result)) throw new TypeError('Value is not a response result.');
	const current = metadataOf(result);
	return clone(result, result[0], result[2], Object.freeze({
		...current.options,
		meta: Object.freeze({ ...(current.options.meta ?? {}), ...meta }),
	}));
}

/** Return whether a value is a response tuple created by this package. */
export function is(value: unknown): value is ResponseResult {
	return Array.isArray(value) && responseResultMetadata in value;
}

/** Return the exact imported definition retained by a response tuple. */
export function definitionOf<Definition extends ResponseDefinition>(value: ResponseResult<Definition>): Definition {
	return metadataOf(value).definition;
}

/** Construct request-aware pagination links without instantiating a response. */
export function pageLinks<Item>(
	page: PageWindow<Item>,
	baseUrl: string | URL,
	parameters: Partial<PaginationParameters> = {},
	custom?: (context: PaginationLinkContext<Item>) => string | URL | undefined,
): PaginationLinks {
	const names = Object.freeze({ ...defaultParameters, ...parameters });
	const parsed = parseBaseUrl(baseUrl);
	const generated = page.kind === 'cursor'
		? cursorLinks(page, parsed.url, names)
		: offsetLinks(page, parsed.url, names);
	const result: Partial<Record<keyof PaginationLinks, string>> = Object.create(null);
	for (const relation of ['self', 'first', 'previous', 'next', 'last'] as const) {
		const candidate = generated[relation];
		if (candidate === undefined && custom === undefined) continue;
		const replacement = custom?.({ relation, page, url: new URL(parsed.url), ...(candidate ? { generated: new URL(candidate) } : {}) });
		const selected = replacement === undefined ? candidate : new URL(replacement, parsed.url).href;
		if (selected !== undefined) result[relation] = formatUrl(selected, parsed.relative);
	}
	return Object.freeze(result as PaginationLinks);
}

/** Construct RFC 8288 Link and count/page fields from a page window. */
export function pageHeaders<Item>(
	page: PageWindow<Item>,
	url?: string | URL,
	parameters: Partial<PaginationParameters> = {},
): ResponseHeaders {
	const pagination = pageMetadata(page, true);
	return mergeHeaders(
		url === undefined ? undefined : { Link: linkHeader(pageLinks(page, url, parameters)) },
		paginationHeaders(page, pagination),
	);
}

/**
 * Builds the cursor links used to navigate a cursor-paginated result in logical HTTP response construction.
 *
 * @internal
 */
function cursorLinks(page: CursorPageWindow<unknown>, base: URL, names: PaginationParameters): Partial<Record<keyof PaginationLinks, string>> {
	const self = cursorUrl(base, page.cursor, page.limit, names);
	return {
		self: self.href,
		first: cursorUrl(base, undefined, page.limit, names).href,
		...(page.previousCursor !== undefined ? { previous: cursorUrl(base, page.previousCursor, page.limit, names).href } : {}),
		...(page.nextCursor !== undefined ? { next: cursorUrl(base, page.nextCursor, page.limit, names).href } : {}),
	};
}

/**
 * Builds self, first, previous, next, and last links for an offset-paginated result.
 *
 * Response internals build framework-neutral response data before a server adapter creates the native Response.
 *
 * @internal
 */
function offsetLinks(page: OffsetPageWindow<unknown>, base: URL, names: PaginationParameters): Partial<Record<keyof PaginationLinks, string>> {
	const usePage = page.source === 'page' || page.page !== undefined;
	const currentPage = page.page ?? Math.floor(page.offset / page.limit) + 1;
	const totalPages = page.total === undefined ? undefined : Math.max(1, Math.ceil(page.total / page.limit));
	const create = (offset: number, pageNumber: number): string => {
		const url = cleanPagination(base, names);
		if (usePage) {
			url.searchParams.set(names.page, String(pageNumber));
			url.searchParams.set(names.perPage, String(page.limit));
		} else {
			url.searchParams.set(names.offset, String(offset));
			url.searchParams.set(names.limit, String(page.limit));
		}
		return url.href;
	};
	return {
		self: create(page.offset, currentPage),
		first: create(0, 1),
		...(page.offset > 0 ? { previous: create(Math.max(0, page.offset - page.limit), Math.max(1, currentPage - 1)) } : {}),
		...(page.hasMore ? { next: create(page.offset + page.limit, currentPage + 1) } : {}),
		...(totalPages !== undefined ? { last: create(Math.max(0, (totalPages - 1) * page.limit), totalPages) } : {}),
	};
}

/**
 * Builds the cursor url used to navigate a cursor-paginated result in logical HTTP response construction.
 *
 * @internal
 */
function cursorUrl(base: URL, cursor: string | undefined, limit: number, names: PaginationParameters): URL {
	const url = cleanPagination(base, names);
	if (cursor !== undefined) url.searchParams.set(names.cursor, cursor);
	url.searchParams.set(names.limit, String(limit));
	return url;
}

/**
 * Removes only pagination query fields before new pagination links are generated, preserving filters and sorting.
 *
 * @internal
 */
function cleanPagination(base: URL, names: PaginationParameters): URL {
	const url = new URL(base);
	for (const name of Object.values(names)) url.searchParams.delete(name);
	return url;
}

/**
 * Builds the response metadata that describes the current cursor or offset page window.
 *
 * Response internals build framework-neutral response data before a server adapter creates the native Response.
 *
 * @internal
 */
function pageMetadata(page: PageWindow<unknown>, includeTotals: boolean): PaginationMetadata {
	if (page.kind === 'cursor') return Object.freeze({
		kind: 'cursor',
		limit: page.limit,
		hasMore: page.hasMore,
		...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
		...(includeTotals && page.total !== undefined ? { total: page.total } : {}),
		...(includeTotals && page.approximateTotal !== undefined ? { approximateTotal: page.approximateTotal } : {}),
		...(page.expiresAt !== undefined ? { expiresAt: String(page.expiresAt) } : {}),
	});
	const currentPage = page.page ?? Math.floor(page.offset / page.limit) + 1;
	return Object.freeze({
		kind: 'offset',
		limit: page.limit,
		hasMore: page.hasMore,
		offset: page.offset,
		page: currentPage,
		perPage: page.limit,
		...(includeTotals && page.total !== undefined ? { total: page.total, totalPages: Math.ceil(page.total / page.limit) } : {}),
		...(includeTotals && page.approximateTotal !== undefined ? { approximateTotal: page.approximateTotal } : {}),
	});
}

/**
 * Derives the pagination headers from the query contract used by logical HTTP response construction.
 *
 * Response internals build framework-neutral response data before a server adapter creates the native Response.
 *
 * @internal
 */
function paginationHeaders(page: PageWindow<unknown>, metadata: PaginationMetadata): ResponseHeaders {
	const fields: Record<string, string> = Object.create(null);
	fields['X-Per-Page'] = String(page.limit);
	if (page.total !== undefined) {
		fields['X-Total-Count'] = String(page.total);
		fields['Preference-Applied'] = 'count=exact';
	}
	if (page.approximateTotal !== undefined) {
		fields['X-Approximate-Total-Count'] = String(page.approximateTotal);
		if (page.total === undefined) fields['Preference-Applied'] = 'count=estimated';
	}
	if (page.kind === 'cursor') {
		if (page.expiresAt !== undefined) fields['X-Pagination-Expires-At'] = String(page.expiresAt);
	} else {
		fields['X-Offset'] = String(page.offset);
		fields['X-Page'] = String(metadata.page);
		if (metadata.totalPages !== undefined) fields['X-Total-Pages'] = String(metadata.totalPages);
	}
	return mergeHeaders(fields);
}

/**
 * Links header idempotently for logical HTTP response construction.
 *
 * @internal
 */
function linkHeader(links: PaginationLinks): string {
	return (['self', 'first', 'previous', 'next', 'last'] as const)
		.flatMap((relation) => links[relation] === undefined ? [] : [`<${links[relation]}>; rel="${relation === 'previous' ? 'prev' : relation}"`])
		.join(', ');
}

/**
 * Builds meta from validated inputs without changing source identity.
 *
 * It builds deterministic logical HTTP representations before a framework creates the native Response.
 *
 * @internal
 */
function buildMeta(
	timestamp: boolean,
	custom: Readonly<Record<string, unknown>> | undefined,
	pagination: PaginationMetadata | undefined,
	now: FinalizeResponseOptions['now'],
): Readonly<Record<string, unknown>> | undefined {
	if (!timestamp && custom === undefined && pagination === undefined) return undefined;
	return Object.freeze({
		...(custom ?? {}),
		...(pagination !== undefined ? { pagination } : {}),
		...(timestamp ? { timestamp: String(now?.() ?? Temporal.Now.instant()) } : {}),
	});
}

/**
 * Recognizes supported page-window result shapes before pagination headers or envelopes are generated.
 *
 * Response internals build framework-neutral response data before a server adapter creates the native Response.
 *
 * @internal
 */
function asPageWindow(value: unknown): PageWindow<unknown> {
	if (typeof value !== 'object' || value === null || !Array.isArray((value as { readonly items?: unknown }).items)) {
		throw new TypeError('Paginated response bodies must be PageWindow values.');
	}
	const page = value as Partial<PageWindow<unknown>>;
	if (page.kind !== 'cursor' && page.kind !== 'offset') throw new TypeError('PageWindow.kind must be cursor or offset.');
	if (!Number.isSafeInteger(page.limit) || page.limit! < 1 || typeof page.hasMore !== 'boolean') {
		throw new TypeError('Paginated response bodies require a positive limit and boolean hasMore value.');
	}
	if (page.kind === 'offset' && (!Number.isSafeInteger(page.offset) || page.offset! < 0)) {
		throw new TypeError('Offset pages require a non-negative offset.');
	}
	for (const count of [page.total, page.approximateTotal]) {
		if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new TypeError('Pagination counts must be non-negative safe integers.');
	}
	return value as PageWindow<unknown>;
}

/**
 * Parses base url into the validated internal model used by later phases.
 *
 * @internal
 */
function parseBaseUrl(value: string | URL): { readonly url: URL; readonly relative: boolean } {
	if (value instanceof URL) return { url: new URL(value), relative: false };
	const relative = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
	return { url: new URL(value, 'http://kaiju.invalid'), relative };
}

/**
 * Formats url for the representation emitted by logical HTTP response construction.
 *
 * @internal
 */
function formatUrl(value: string, relative: boolean): string {
	const url = new URL(value);
	return relative ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

/**
 * Checks whether header is present for logical HTTP response construction.
 *
 * @internal
 */
function hasHeader(headers: ResponseHeaders, name: string): boolean {
	const lower = name.toLowerCase();
	return Object.keys(headers).some((candidate) => candidate.toLowerCase() === lower);
}

/**
 * Returns the safe header value in the representation expected by logical HTTP response construction.
 *
 * @internal
 */
function safeHeaderValue(value: string, name: string): string {
	if (/\0|\r|\n/.test(value)) throw new TypeError(`${name} contains a forbidden control character.`);
	return value;
}

/**
 * Escapes the filename before logical HTTP response construction emits it into an external syntax.
 *
 * @internal
 */
function escapeFilename(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/[\r\n]/g, '');
}

/**
 * Snapshots options so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeOptions(options: CreateResponseOptions): CreateResponseOptions {
	return Object.freeze({
		...options,
		...(options.meta !== undefined ? { meta: Object.freeze({ ...options.meta }) } : {}),
	});
}

/**
 * Returns the metadata of required to interpret values handled by logical HTTP response construction.
 *
 * @internal
 */
function metadataOf<Definition extends ResponseDefinition>(value: ResponseResult<Definition>): ResponseResultMetadata<Definition> {
	if (!is(value)) throw new TypeError('Value is not a response result.');
	return (value as unknown as { readonly [responseResultMetadata]: ResponseResultMetadata<Definition> })[responseResultMetadata];
}

/**
 * Clones response metadata before enrichment so finalization does not mutate handler-owned values.
 *
 * Response internals build framework-neutral response data before a server adapter creates the native Response.
 *
 * @internal
 */
function clone<Definition extends ResponseDefinition>(
	original: ResponseResult<Definition>,
	body: unknown,
	headers: ResponseHeaders,
	options: CreateResponseOptions,
): ResponseResult<Definition> {
	const metadata = metadataOf(original);
	const tuple = [body, original[1], headers] as unknown as ResponseResult<Definition> &
		{ readonly [responseResultMetadata]: ResponseResultMetadata<Definition> };
	attachMetadata(tuple, Object.freeze({ definition: metadata.definition, options: freezeOptions(options) }));
	return Object.freeze(tuple);
}

/**
 * Attaches metadata at the point where logical HTTP response construction owns that relationship.
 *
 * @internal
 */
function attachMetadata<Definition extends ResponseDefinition>(
	tuple: ResponseResult<Definition> & { readonly [responseResultMetadata]: ResponseResultMetadata<Definition> },
	metadata: ResponseResultMetadata<Definition>,
): void {
	Object.defineProperty(tuple, responseResultMetadata, { value: metadata, enumerable: false, writable: false, configurable: false });
}
