import * as catalog from '@utils/catalog';
import { getCookies, setCookie as appendSetCookie } from '@std/http/cookie';
import type { Cookie as StandardCookie } from '@std/http/cookie';
import type { Catalog, CatalogSelection, DefinitionInput } from '@utils/catalog';
import type {
	CookieAttributes,
	CookieDefinition,
	CookieDefinitionInput,
	CookieDocument,
	CookieReadResult,
	CookieValue,
	SetCookieOptions,
} from './types.ts';

/** Define one import-safe application cookie contract. */
export function define<const Schema extends import('@standard-schema/spec').StandardSchemaV1<string, string>>(
	input: CookieDefinitionInput<Schema>,
): CookieDefinition<Schema> {
	assertIdentifier(input.id);
	assertCookieName(input.name);
	if (input.description.trim().length === 0) throw new TypeError('Cookie description cannot be empty.');
	assertSchema(input.value);
	const attributes = normalizeAttributes(input.name, input.attributes ?? Object.freeze({}));
	return Object.freeze({
		kind: 'cookie',
		id: input.id,
		description: input.description,
		name: input.name,
		value: input.value,
		attributes,
	});
}

/** Create a named immutable cookie catalog. */
export function cookieCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, CookieDefinition>>,
>(namespace: Namespace, entries: Entries): Catalog<Entries[keyof Entries], Entries> {
	return catalog.create(namespace, entries);
}

/** Select an immutable key-preserving cookie subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, CookieDefinition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: Catalog<Entries[keyof Entries], Entries>,
	keys: Keys,
): CatalogSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalog.select(source, keys);
}

/** Compose cookie definitions, catalogs, selections, and nested arrays. */
export function compose<Entry extends CookieDefinition>(
	...input: readonly DefinitionInput<Entry>[]
): readonly Entry[] {
	return catalog.compose(...input);
}

/** Parse one cookie from a Request or Headers object. */
export async function safeGet<Definition extends CookieDefinition>(
	input: Request | Headers,
	definition: Definition,
): Promise<CookieReadResult<CookieValue<Definition>>> {
	const encoded = getCookies(headersOf(input))[definition.name];
	if (encoded === undefined) return Object.freeze({ success: true, value: undefined });
	let decoded: string;
	try {
		decoded = decodeURIComponent(encoded);
	} catch {
		decoded = encoded;
	}
	const result = await definition.value['~standard'].validate(decoded);
	return result.issues
		? Object.freeze({ success: false, issues: Object.freeze([...result.issues]) })
		: Object.freeze({ success: true, value: result.value as CookieValue<Definition> });
}

/** Parse one cookie and throw a TypeError when its value is invalid. */
export async function get<Definition extends CookieDefinition>(
	input: Request | Headers,
	definition: Definition,
): Promise<CookieValue<Definition> | undefined> {
	const result = await safeGet(input, definition);
	if (result.success) return result.value;
	throw new TypeError(`Cookie ${JSON.stringify(definition.name)} is invalid: ${result.issues.map((issue) => issue.message).join('; ')}`);
}

/** Append one Set-Cookie field without overwriting other cookie writes. */
export function set<Definition extends CookieDefinition>(
	headers: Headers,
	definition: Definition,
	value: CookieValue<Definition>,
	options: SetCookieOptions = {},
): void {
	appendSetCookie(headers, occurrence(definition, String(value), options));
}

/** Append an expired Set-Cookie field for one definition. */
function deleteCookie(headers: Headers, definition: CookieDefinition): void {
	appendSetCookie(headers, occurrence(definition, '', {
		expires: new Date(0),
		maxAge: 0,
	}));
}

/** Create deterministic JSON-safe cookie documentation. */
export function document(input: DefinitionInput<CookieDefinition>): readonly CookieDocument[] {
	return Object.freeze(catalog.values(input).map((definition) => Object.freeze({
		id: definition.id,
		name: definition.name,
		description: definition.description ?? '',
		attributes: definition.attributes,
	})));
}

/**
 * Normalizes a cookie attribute occurrence so duplicate-attribute handling can report the exact source position.
 *
 * The helper stays internal so callers depend on the module contract rather than its implementation mechanics.
 *
 * @internal
 */
function occurrence(
	definition: CookieDefinition,
	value: string,
	options: SetCookieOptions,
): StandardCookie {
	const attributes = definition.attributes;
	const maxAge = options.maxAge ?? attributes.maxAge;
	if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0)) {
		throw new TypeError('Cookie maxAge must be a non-negative safe integer number of seconds.');
	}
	const expires = options.expires === undefined
		? undefined
		: options.expires instanceof Date ? options.expires : new Date(options.expires.epochMilliseconds);
	return {
		name: definition.name,
		value: encodeURIComponent(value),
		...(attributes.domain !== undefined ? { domain: attributes.domain } : {}),
		...(attributes.path !== undefined ? { path: attributes.path } : {}),
		...(maxAge !== undefined ? { maxAge } : {}),
		...(expires !== undefined ? { expires } : {}),
		...(attributes.httpOnly !== undefined ? { httpOnly: attributes.httpOnly } : {}),
		...(attributes.secure !== undefined ? { secure: attributes.secure } : {}),
		...(attributes.sameSite !== undefined ? { sameSite: sameSite(attributes.sameSite) } : {}),
		...(attributes.partitioned !== undefined ? { partitioned: attributes.partitioned } : {}),
		...(attributes.priority !== undefined ? { unparsed: [`Priority=${capitalize(attributes.priority)}`] } : {}),
	};
}

/**
 * Checks whether site are equivalent for the purposes of the surrounding module.
 *
 * @internal
 */
function sameSite(value: NonNullable<CookieAttributes['sameSite']>): NonNullable<StandardCookie['sameSite']> {
	switch (value) {
		case 'strict': return 'Strict';
		case 'lax': return 'Lax';
		case 'none': return 'None';
	}
}

/**
 * Normalizes attributes into the canonical internal form used by later phases.
 *
 * It keeps this internal phase aligned with the module's public contract and lifecycle rules.
 *
 * @internal
 */
function normalizeAttributes(name: string, input: CookieAttributes): CookieAttributes {
	const attributes = Object.freeze({
		...input,
		...(input.path !== undefined ? { path: normalizePath(input.path) } : {}),
	});
	if (attributes.sameSite === 'none' && !attributes.secure) throw new TypeError('SameSite=None cookies must be Secure.');
	if (attributes.partitioned && !attributes.secure) throw new TypeError('Partitioned cookies must be Secure.');
	if (name.startsWith('__Secure-') && !attributes.secure) throw new TypeError('__Secure- cookies must be Secure.');
	if (name.startsWith('__Host-')) {
		if (!attributes.secure || attributes.path !== '/' || attributes.domain !== undefined) {
			throw new TypeError('__Host- cookies must be Secure, use Path=/, and omit Domain.');
		}
	}
	return attributes;
}

/**
 * Collects all Set-Cookie header values without collapsing independent cookie occurrences.
 *
 * @internal
 */
function headersOf(input: Request | Headers): Headers {
	return input instanceof Request ? input.headers : input;
}

/**
 * Normalizes path into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizePath(value: string): string {
	if (!value.startsWith('/')) throw new TypeError('Cookie path must begin with /.');
	return value;
}

/**
 * Formats a cookie attribute token for the canonical header representation emitted by the serializer.
 *
 * @internal
 */
function capitalize(value: string): string {
	return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid cookie id ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid cookie name before it can enter authoritative module state.
 *
 * @internal
 */
function assertCookieName(value: string): void {
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new TypeError(`Invalid cookie name ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid schema before it can enter authoritative module state.
 *
 * @internal
 */
function assertSchema(value: unknown): asserts value is import('@standard-schema/spec').StandardSchemaV1<string, string> {
	if (typeof value !== 'object' || value === null || typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate !== 'function') {
		throw new TypeError('Cookie value must implement Standard Schema.');
	}
}

export { cookieCatalog as catalog, deleteCookie as delete };
export type * from './types.ts';
