import { accepts } from '@std/http/negotiation';
import { RequestTransportError, type MediaType } from './types.ts';

/** Parse a Content-Type or Accept media-range token. */
export function parseMediaType(value: string): MediaType {
	const [rawEssence, ...rawParameters] = value.split(';');
	const [type, subtype, extra] = rawEssence!.trim().toLowerCase().split('/');
	if (!type || !subtype || extra !== undefined || !token(type) || !token(subtype)) throw new RequestTransportError({
		code: 'unsupported-content-type', message: `Invalid media type ${JSON.stringify(value)}.`, path: ['header', 'content-type'],
	});
	const parameters: Record<string, string> = Object.create(null);
	for (const raw of rawParameters) {
		const separator = raw.indexOf('=');
		if (separator < 1) continue;
		const name = raw.slice(0, separator).trim().toLowerCase();
		let parameter = raw.slice(separator + 1).trim();
		if (parameter.startsWith('"') && parameter.endsWith('"')) parameter = parameter.slice(1, -1);
		parameters[name] = parameter;
	}
	return Object.freeze({ type, subtype, essence: `${type}/${subtype}`, parameters: Object.freeze(parameters) });
}

/** Require one of the supported request content types. */
export function requireContentType(request: Request, supported: readonly string[]): MediaType {
	const raw = request.headers.get('content-type');
	if (!raw) throw new RequestTransportError({ code: 'unsupported-content-type', message: 'Content-Type is required.', path: ['header', 'content-type'] });
	const parsed = parseMediaType(raw);
	if (!supported.some((candidate) => mediaRangeMatches(candidate, parsed.essence))) throw new RequestTransportError({
		code: 'unsupported-content-type', message: `Content-Type ${JSON.stringify(parsed.essence)} is not supported.`, path: ['header', 'content-type'],
	});
	return parsed;
}

/** Select the best supported representation using the Deno standard HTTP negotiator. */
export function negotiateContent(accept: string | null, supported: readonly string[]): string {
	if (supported.length === 0) throw new TypeError('At least one supported media type is required.');
	const request = { headers: new Headers(accept === null ? undefined : { accept }) };
	const selected = accepts(request, ...supported);
	if (selected !== undefined) return selected;

	// `@std/http` handles RFC quality, wildcard, and specificity ordering. This
	// focused fallback retains the documented structured-suffix range such
	// as `application/*+json`, which is useful for vendor JSON media types.
	for (const range of acceptedStructuredSuffixRanges(accept)) {
		const match = supported.find((candidate) => mediaRangeMatches(range, candidate));
		if (match !== undefined) return match;
	}
	throw new RequestTransportError({
		code: 'not-acceptable',
		message: `None of the requested media types are supported: ${supported.join(', ')}.`,
		path: ['header', 'accept'],
	});
}

/**
 * Expands accepted media ranges with structured-suffix matches such as `+json` without widening unrelated content types.
 *
 * @internal
 */
function acceptedStructuredSuffixRanges(accept: string | null): readonly string[] {
	if (accept === null) return Object.freeze([]);
	return Object.freeze(accept.split(',').map((part) => part.split(';', 1)[0]!.trim().toLowerCase())
		.filter((range) => range.includes('*+')));
}

/**
 * Checks one parsed media range against a concrete content type using wildcard and structured-suffix rules.
 *
 * @internal
 */
function mediaRangeMatches(range: string, essence: string): boolean {
	const normalized = range.split(';', 1)[0]!.trim().toLowerCase();
	if (normalized === '*/*') return true;
	const [type, subtype] = normalized.split('/');
	const [candidateType, candidateSubtype] = essence.split('/');
	return type === candidateType && (
		subtype === '*' ||
		subtype === candidateSubtype ||
		(subtype?.startsWith('*+') === true && candidateSubtype?.endsWith(subtype.slice(1)) === true)
	);
}

/**
 * Converts the source value to ken expected by HTTP request normalization.
 *
 * @internal
 */
function token(value: string): boolean {
	return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}
