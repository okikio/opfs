import { limits } from './limits.ts';
import { RequestTransportError, type RequestParsingOptions, type WireRecord } from './types.ts';

const fieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parse request fields into a lower-case, bounded record while preserving repetitions where observable. */
export function parseHeaders(input: Headers, options: RequestParsingOptions = {}): WireRecord {
	const policy = limits(options);
	const values: Record<string, string[]> = Object.create(null);
	let count = 0;
	let bytes = 0;
	for (const [rawName, rawValue] of input.entries()) {
		count += 1;
		const name = rawName.toLowerCase();
		if (!fieldNamePattern.test(rawName) || /\0|\r|\n/.test(rawValue)) throw new RequestTransportError({
			code: 'invalid-header', message: `Header ${JSON.stringify(rawName)} is malformed.`, path: ['header', name],
		});
		const size = byteLength(rawName) + byteLength(rawValue);
		bytes += size;
		if (byteLength(rawValue) > policy.maximumHeaderValueBytes) throw new RequestTransportError({
			code: 'header-too-large', message: `Header ${JSON.stringify(name)} exceeds ${policy.maximumHeaderValueBytes} bytes.`, path: ['header', name],
		});
		(values[name] ??= []).push(rawValue);
	}
	if (count > policy.maximumHeaders) throw new RequestTransportError({
		code: 'too-many-headers', message: `At most ${policy.maximumHeaders} request headers are allowed.`, path: ['header'],
	});
	if (bytes > policy.maximumHeaderBytes) throw new RequestTransportError({
		code: 'headers-too-large', message: `Request headers exceed ${policy.maximumHeaderBytes} bytes.`, path: ['header'],
	});
	const result: Record<string, string | readonly string[]> = Object.create(null);
	for (const [name, fieldValues] of Object.entries(values)) result[name] = fieldValues.length === 1 ? fieldValues[0]! : Object.freeze(fieldValues);
	return Object.freeze(result);
}

/** Create a log-safe projection that never exposes credentials or cookie values. */
export function redactHeaders(input: Headers | WireRecord, extraSensitive: readonly string[] = []): WireRecord {
	const source = input instanceof Headers ? parseHeaders(input) : input;
	const sensitive = new Set([
		'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
		...extraSensitive.map((name) => name.toLowerCase()),
	]);
	const result: Record<string, string | readonly string[]> = Object.create(null);
	for (const [name, value] of Object.entries(source)) result[name] = sensitive.has(name.toLowerCase()) ? '[REDACTED]' : value;
	return Object.freeze(result);
}

/**
 * Enforces the byte length before HTTP request normalization admits more data.
 *
 * @internal
 */
function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
