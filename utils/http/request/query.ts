import { limits } from './limits.ts';
import { RequestTransportError, type RequestParsingOptions, type WireRecord } from './types.ts';

/** Preserve repeated query values without applying endpoint-specific semantics. */
export function parseQuery(input: URLSearchParams, options: RequestParsingOptions = {}): WireRecord {
	const policy = limits(options);
	const values: Record<string, string[]> = Object.create(null);
	let count = 0;
	for (const [name, value] of input.entries()) {
		count += 1;
		if (value.length > policy.maximumQueryValueLength) throw new RequestTransportError({
			code: 'query-value-too-large', message: `Query parameter ${JSON.stringify(name)} exceeds ${policy.maximumQueryValueLength} characters.`, path: ['query', name],
		});
		(values[name] ??= []).push(value);
	}
	if (count > policy.maximumQueryParameters) throw new RequestTransportError({
		code: 'too-many-query-parameters', message: `At most ${policy.maximumQueryParameters} query parameters are allowed.`, path: ['query'],
	});
	const result: Record<string, string | readonly string[]> = Object.create(null);
	for (const [name, fieldValues] of Object.entries(values)) result[name] = fieldValues.length === 1 ? fieldValues[0]! : Object.freeze(fieldValues);
	return Object.freeze(result);
}
