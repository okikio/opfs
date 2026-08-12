import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CatalogEntryIdentity } from '@utils/catalog';

/** Browser SameSite policy for an application cookie. */
export type CookieSameSite = 'strict' | 'lax' | 'none';

/** Static attributes applied whenever a cookie is written. */
export interface CookieAttributes {
	readonly domain?: string;
	readonly path?: string;
	readonly secure?: boolean;
	readonly httpOnly?: boolean;
	readonly sameSite?: CookieSameSite;
	readonly partitioned?: boolean;
	readonly priority?: 'low' | 'medium' | 'high';
	readonly maxAge?: number;
}

/** Import-safe definition of one stable application cookie. */
export interface CookieDefinition<Schema extends StandardSchemaV1<string, string> = StandardSchemaV1<string, string>> extends CatalogEntryIdentity {
	readonly kind: 'cookie';
	readonly name: string;
	readonly value: Schema;
	readonly attributes: CookieAttributes;
}

/** Input accepted by `cookie.define()`. */
export interface CookieDefinitionInput<Schema extends StandardSchemaV1<string, string>> {
	readonly id: string;
	readonly description: string;
	readonly name: string;
	readonly value: Schema;
	readonly attributes?: CookieAttributes;
}

/** Output inferred from a cookie definition's Standard Schema. */
export type CookieValue<Definition extends CookieDefinition> = StandardSchemaV1.InferOutput<Definition['value']>;

/** Optional per-occurrence attributes applied while setting a cookie. */
export interface SetCookieOptions {
	readonly expires?: Temporal.Instant | Date;
	readonly maxAge?: number;
}

/** Non-throwing cookie read result. */
export type CookieReadResult<Value> =
	| Readonly<{ readonly success: true; readonly value: Value | undefined }>
	| Readonly<{ readonly success: false; readonly issues: readonly StandardSchemaV1.Issue[] }>;

/** JSON-safe cookie definition projection. */
export interface CookieDocument {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly attributes: CookieAttributes;
}
