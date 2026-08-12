/** HTTP route-template path helpers shared by endpoint, service, and gateway compilation. */

/**
 * Join HTTP route-template fragments with one leading slash.
 *
 * This is deliberately not implemented with `@std/path`: filesystem paths are
 * operating-system dependent, while HTTP route templates always use `/` and
 * preserve parameter tokens such as `:importId`.
 */
export function joinPath(...parts: readonly string[]): string {
	const joined = parts
		.flatMap((part) => part.split('/'))
		.filter((part) => part.length > 0)
		.join('/');
	return joined.length === 0 ? '/' : `/${joined}`;
}

/** Convert parameter names to a stable shape used for route-collision checks. */
export function normalizePathTemplate(path: string): string {
	return joinPath(path).replace(/:[A-Za-z0-9_]+/g, ':parameter');
}

/** Return parameter names declared by one route template in authored order. */
export function pathParameters(path: string): readonly string[] {
	return Object.freeze([...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!));
}
