import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CatalogEntryIdentity } from '@utils/catalog';
import type { HeaderInput, ResponseHeaders } from './headers.ts';

/** Standard Schema-compatible response body contract. */
export type ResponseSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** HTTP success and redirect status codes supported by response definitions. */
export type ResponseStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226 | 300 | 301 | 302 | 303 | 304 | 305 | 307 | 308;

/** Concrete request or response example retained for generated documentation. */
export interface ResponseExample<Value = unknown> {
	readonly key: string;
	readonly summary?: string;
	readonly description?: string;
	readonly value: Value;
}

/** One string or encoded byte chunk accepted by a streaming HTML response. */
export type HtmlChunk = string | Uint8Array;

/** Complete one-off HTML body accepted as a string, Web Stream, or async iterable. */
export type HtmlBody = string | ReadableStream<Uint8Array> | AsyncIterable<HtmlChunk>;

/** Optional success envelope added during HTTP materialization. */
export type ResponseEnvelope = 'none' | 'data';

/** Pagination presentation policy retained by a paginated response definition. */
export interface PaginationResponsePolicy {
	readonly links: 'none' | 'header' | 'body' | 'both';
	readonly totals: 'none' | 'headers' | 'body' | 'both';
}

/** Static successful response contract. */
export interface ResponseDefinition<Schema extends ResponseSchema | undefined = ResponseSchema | undefined, Status extends ResponseStatus = ResponseStatus> extends CatalogEntryIdentity {
	readonly kind: 'response';
	readonly status: Status;
	readonly description: string;
	readonly schema?: Schema;
	readonly contentType?: string;
	readonly headers?: ResponseHeaders;
	readonly examples?: readonly ResponseExample[];
	readonly mode: 'body' | 'empty' | 'redirect' | 'stream' | 'download' | 'page' | 'html';
	readonly envelope: ResponseEnvelope;
	readonly timestamp: boolean;
	readonly pagination?: PaginationResponsePolicy;
	readonly filename?: string;
}

/** Input accepted by {@link define}. */
export interface ResponseDefinitionInput<Schema extends ResponseSchema | undefined, Status extends ResponseStatus> {
	readonly id: string;
	readonly status: Status;
	readonly description: string;
	readonly schema?: Schema;
	readonly contentType?: string;
	readonly headers?: HeaderInput;
	readonly examples?: readonly ResponseExample[];
	readonly mode?: ResponseDefinition['mode'];
	readonly envelope?: ResponseEnvelope;
	readonly timestamp?: boolean;
	readonly pagination?: Partial<PaginationResponsePolicy>;
	readonly filename?: string;
}

/** Cursor-based page returned by a storage adapter. */
export interface CursorPageWindow<Item> {
	readonly kind: 'cursor';
	readonly items: readonly Item[];
	readonly limit: number;
	readonly hasMore: boolean;
	readonly cursor?: string;
	readonly nextCursor?: string;
	readonly previousCursor?: string;
	readonly total?: number;
	readonly approximateTotal?: number;
	readonly expiresAt?: Temporal.Instant | string;
}

/** Offset/page-number page returned by a storage adapter. */
export interface OffsetPageWindow<Item> {
	readonly kind: 'offset';
	readonly items: readonly Item[];
	readonly offset: number;
	readonly limit: number;
	readonly hasMore: boolean;
	readonly source?: 'offset' | 'page';
	readonly page?: number;
	readonly total?: number;
	readonly approximateTotal?: number;
}

/** Transport-neutral page window supplied to a paginated response definition. */
export type PageWindow<Item> = CursorPageWindow<Item> | OffsetPageWindow<Item>;


/** Logical body accepted when instantiating one response definition. */
export type ResponseBody<Definition extends ResponseDefinition> =
	Definition['mode'] extends 'empty' | 'redirect' ? undefined
	: Definition extends ResponseDefinition<infer Schema>
		? Schema extends ResponseSchema
			? Definition['mode'] extends 'page'
				? PageWindow<StandardSchemaV1.InferOutput<Schema>>
				: StandardSchemaV1.InferOutput<Schema>
			: unknown
		: unknown;

/** Standard pagination URL parameter names used during materialization. */
export interface PaginationParameters {
	readonly cursor: string;
	readonly limit: string;
	readonly offset: string;
	readonly page: string;
	readonly perPage: string;
}

/** Generated pagination links. */
export interface PaginationLinks {
	readonly self?: string;
	readonly first?: string;
	readonly previous?: string;
	readonly next?: string;
	readonly last?: string;
}

/** Context supplied to a custom pagination link builder. */
export interface PaginationLinkContext<Item = unknown> {
	readonly relation: keyof PaginationLinks;
	readonly page: PageWindow<Item>;
	readonly url: URL;
	readonly generated?: URL;
}

/** Options applied when instantiating a successful response. */
export interface CreateResponseOptions {
	readonly headers?: HeaderInput;
	readonly location?: string | URL;
	readonly filename?: string;
	/** Explicit link-generation base URL. The server request URL is used when omitted. */
	readonly url?: string | URL;
	readonly link?: (context: PaginationLinkContext) => string | URL | undefined;
	readonly meta?: Readonly<Record<string, unknown>>;
}

/** Adapter-owned materialization options. */
export interface FinalizeResponseOptions {
	readonly url?: string | URL;
	readonly pagination?: Partial<PaginationParameters>;
	readonly now?: () => Temporal.Instant | string;
}

/** JSON-safe pagination metadata emitted in a response body. */
export interface PaginationMetadata {
	readonly kind: 'cursor' | 'offset';
	readonly limit: number;
	readonly hasMore: boolean;
	readonly cursor?: string;
	readonly offset?: number;
	readonly page?: number;
	readonly perPage?: number;
	readonly total?: number;
	readonly approximateTotal?: number;
	readonly totalPages?: number;
	readonly expiresAt?: string;
}

/** Default success envelope. */
export interface SuccessEnvelope<Data = unknown> {
	readonly data: Data;
	readonly meta?: Readonly<Record<string, unknown>>;
	readonly links?: PaginationLinks;
}

/** Fully request-aware result ready for native HTTP response conversion. */
export interface FinalizedResponseResult<Definition extends ResponseDefinition = ResponseDefinition> {
	readonly definition: Definition;
	readonly body: unknown;
	readonly status: Definition['status'];
	readonly headers: ResponseHeaders;
}

/** JSON-safe documentation projection for a successful response definition. */
export interface ResponseDocument {
	readonly key?: string;
	readonly id: string;
	readonly status: ResponseStatus;
	readonly description: string;
	readonly contentType?: string;
	readonly mode: ResponseDefinition['mode'];
	readonly envelope: ResponseEnvelope;
	readonly timestamp: boolean;
	readonly pagination?: PaginationResponsePolicy;
	readonly examples: readonly ResponseExample[];
	readonly headers: ResponseHeaders;
	readonly filename?: string;
}

/** Hidden metadata attached to each response tuple. */
export interface ResponseResultMetadata<Definition extends ResponseDefinition = ResponseDefinition> {
	readonly definition: Definition;
	readonly options: CreateResponseOptions;
}

/** Logical tuple returned by endpoint handlers before request-aware materialization. */
export type ResponseResult<Definition extends ResponseDefinition = ResponseDefinition, Body = unknown, Headers extends ResponseHeaders = ResponseHeaders> =
	readonly [body: Body, status: Definition['status'], headers: Headers];

export type { HeaderField, HeaderInput, HeaderValue, ResponseHeaders } from './headers.ts';
