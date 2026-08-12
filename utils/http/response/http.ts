import { ifNoneMatch } from '@std/http/etag';
import type { HeaderInput, ResponseHeaders } from './headers.ts';
import { headerValues, headers } from './headers.ts';

/** Result of parsing one HTTP byte-range request. */
export type ByteRange =
	| Readonly<{ readonly kind: 'none' }>
	| Readonly<{ readonly kind: 'unsupported-multiple' }>
	| Readonly<{ readonly kind: 'unsatisfiable'; readonly contentRange: string }>
	| Readonly<{
		readonly kind: 'satisfiable';
		readonly start: number;
		readonly end: number;
		readonly length: number;
		readonly contentRange: string;
	}>;

/**
 * Evaluate GET/HEAD conditional request fields against response validators.
 *
 * `If-None-Match` takes precedence over `If-Modified-Since`. ETag comparison
 * uses the weak comparison required for cache validation and supports `*`.
 */
export function notModified(request: Request, responseHeaders: HeaderInput): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const etag = firstHeader(responseHeaders, 'etag');
	const ifNoneMatchValue = request.headers.get('if-none-match');
	if (ifNoneMatchValue !== null) return !ifNoneMatch(ifNoneMatchValue, etag);
	const lastModified = firstHeader(responseHeaders, 'last-modified');
	const ifModifiedSince = request.headers.get('if-modified-since');
	if (lastModified === undefined || ifModifiedSince === null) return false;
	const modified = Date.parse(lastModified);
	const since = Date.parse(ifModifiedSince);
	return Number.isFinite(modified) && Number.isFinite(since) && modified <= since;
}


/** Retain the representation metadata fields permitted on a generated 304 response. */
export function conditionalHeaders(input: HeaderInput): ResponseHeaders {
	const allowed = new Set(['cache-control', 'content-location', 'date', 'etag', 'expires', 'last-modified', 'vary']);
	const result: [string, string][] = [];
	for (const name of allowed) {
		for (const value of headerValues(input, name)) result.push([name, value]);
	}
	return headers(result);
}

/** Parse a single RFC 9110 bytes range without allocating or reading a body. */
export function byteRange(value: string | null, size: number): ByteRange {
	if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Byte range size must be a non-negative safe integer.');
	if (value === null || value.trim().length === 0) return Object.freeze({ kind: 'none' });
	const match = /^bytes\s*=\s*(.+)$/i.exec(value);
	if (!match) return Object.freeze({ kind: 'none' });
	const specification = match[1]!.trim();
	if (specification.includes(',')) return Object.freeze({ kind: 'unsupported-multiple' });
	const range = /^(?<start>\d*)-(?<end>\d*)$/.exec(specification);
	if (!range?.groups || (range.groups.start === '' && range.groups.end === '')) {
		return Object.freeze({ kind: 'unsatisfiable', contentRange: `bytes */${size}` });
	}
	let start: number;
	let end: number;
	if (range.groups.start === '') {
		const suffix = Number(range.groups.end);
		if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
			return Object.freeze({ kind: 'unsatisfiable', contentRange: `bytes */${size}` });
		}
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(range.groups.start);
		end = range.groups.end === '' ? size - 1 : Number(range.groups.end);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
			return Object.freeze({ kind: 'unsatisfiable', contentRange: `bytes */${size}` });
		}
		end = Math.min(end, size - 1);
	}
	return Object.freeze({
		kind: 'satisfiable',
		start,
		end,
		length: end - start + 1,
		contentRange: `bytes ${start}-${end}/${size}`,
	});
}

/** Return standard fields for one satisfiable or unsatisfiable byte-range decision. */
export function byteRangeHeaders(range: Exclude<ByteRange, { readonly kind: 'none' | 'unsupported-multiple' }>): Readonly<Record<string, string>> {
	const candidate: Readonly<{ readonly kind?: string; readonly contentRange?: string; readonly length?: number }> = range;
	if (candidate.kind !== 'satisfiable' && candidate.kind !== 'unsatisfiable') {
		throw new TypeError(`Byte range headers require a satisfiable or unsatisfiable range, received ${JSON.stringify(candidate.kind)}.`);
	}
	if (typeof candidate.contentRange !== 'string' || candidate.contentRange.length === 0) {
		throw new TypeError('Byte range contentRange must be a non-empty string.');
	}
	if (candidate.kind === 'satisfiable' && (!Number.isSafeInteger(candidate.length) || candidate.length! < 1)) {
		throw new TypeError('A satisfiable byte range must have a positive safe integer length.');
	}
	return Object.freeze({
		'Accept-Ranges': 'bytes',
		'Content-Range': candidate.contentRange,
		...(candidate.kind === 'satisfiable' ? { 'Content-Length': String(candidate.length) } : {}),
	});
}

/**
 * Selects or builds the first header used by logical HTTP response construction.
 *
 * @internal
 */
function firstHeader(headers: HeaderInput, name: string): string | undefined {
	return headerValues(headers, name)[0];
}
