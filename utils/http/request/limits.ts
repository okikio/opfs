import type { RequestParsingLimits, RequestParsingOptions } from './types.ts';

/** These defaults allow common web requests and keep parsing work within a clear bound. */
export const DefaultRequestParsingLimits: RequestParsingLimits = Object.freeze({
	// Allow common auth, trace, and forwarding fields. Reject very large header sets.
	maximumHeaders: 128,
	// Allow normal headers from browsers and proxies. Stop very large headers before they raise memory use or smuggling risk.
	maximumHeaderBytes: 64 * 1024,
	// Allow large single fields such as cookies, policy headers, and auth data. Reject very large field values.
	maximumHeaderValueBytes: 16 * 1024,
	// Allow complex filter and search URLs. Reject query strings with too many parameters.
	maximumQueryParameters: 512,
	// Allow large query values for search and redirect flows. Reject very large single values.
	maximumQueryValueLength: 8 * 1024,
	// Keep route and parameter keys within a fixed size. This stops malformed input from growing lookup keys without limit.
	maximumParameterLength: 4 * 1024,
	// Allow modern cookie payloads, including sign-in and session data. Keep the Cookie header from using too much request memory.
	maximumCookieBytes: 16 * 1024,
	// Allow many cookies from busy apps and frameworks. Reject clearly excessive cookie counts.
	maximumCookies: 128,
	// Limit read-to-completion body parsing to a practical size for JSON and forms. This helps prevent large memory spikes from one request.
	maximumBodyBytes: 8 * 1024 * 1024,
	// Allow large forms with repeated fields. Reject very large field counts that can turn form parsing into a denial-of-service path.
	maximumFormFields: 1_000,
});

/** Resolve and validate request parsing limits without erasing the known key set. */
export function limits(options: RequestParsingOptions = {}): RequestParsingLimits {
	const value: RequestParsingLimits = Object.freeze({
		maximumHeaders: options.maximumHeaders ?? DefaultRequestParsingLimits.maximumHeaders,
		maximumHeaderBytes: options.maximumHeaderBytes ?? DefaultRequestParsingLimits.maximumHeaderBytes,
		maximumHeaderValueBytes: options.maximumHeaderValueBytes ?? DefaultRequestParsingLimits.maximumHeaderValueBytes,
		maximumQueryParameters: options.maximumQueryParameters ?? DefaultRequestParsingLimits.maximumQueryParameters,
		maximumQueryValueLength: options.maximumQueryValueLength ?? DefaultRequestParsingLimits.maximumQueryValueLength,
		maximumParameterLength: options.maximumParameterLength ?? DefaultRequestParsingLimits.maximumParameterLength,
		maximumCookieBytes: options.maximumCookieBytes ?? DefaultRequestParsingLimits.maximumCookieBytes,
		maximumCookies: options.maximumCookies ?? DefaultRequestParsingLimits.maximumCookies,
		maximumBodyBytes: options.maximumBodyBytes ?? DefaultRequestParsingLimits.maximumBodyBytes,
		maximumFormFields: options.maximumFormFields ?? DefaultRequestParsingLimits.maximumFormFields,
	});
	for (const [name, amount] of Object.entries(value)) {
		if (!Number.isSafeInteger(amount) || amount < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}
