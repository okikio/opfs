const requestCaches = new WeakMap<object, Map<unknown, unknown>>();

/** Compute one request-owned capability once, sharing a pending promise across consumers. */
export async function memoize<Value>(
	request: object,
	key: unknown,
	load: () => Value | Promise<Value>,
	options: { readonly cacheRejected?: boolean } = {},
): Promise<Value> {
	let cache = requestCaches.get(request);
	if (!cache) { cache = new Map(); requestCaches.set(request, cache); }
	if (cache.has(key)) return await cache.get(key) as Value;
	const pending = Promise.resolve().then(load);
	cache.set(key, pending);
	try {
		const value = await pending;
		cache.set(key, value);
		return value;
	} catch (error) {
		if (!options.cacheRejected) cache.delete(key);
		throw error;
	}
}

/** Invalidate one memoized request capability or the complete request cache. */
export function invalidate(request: object, key?: unknown): void {
	if (key === undefined) requestCaches.delete(request);
	else requestCaches.get(request)?.delete(key);
}

/** Dispose memoized values exposing native disposal protocols, then clear the request cache. */
export async function dispose(request: object): Promise<void> {
	const cache = requestCaches.get(request);
	requestCaches.delete(request);
	if (!cache) return;
	const values = new Set(cache.values());
	for (const value of [...values].reverse()) {
		const resolved = await value;
		if (resolved && typeof resolved === 'object') {
			const asyncDispose = (resolved as { [Symbol.asyncDispose]?: () => PromiseLike<void> })[Symbol.asyncDispose];
			if (asyncDispose) await asyncDispose.call(resolved);
			else (resolved as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.call(resolved);
		}
	}
}
