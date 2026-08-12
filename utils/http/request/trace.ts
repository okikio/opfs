import { encodeHex } from '@std/encoding/hex';
import { memoize } from './memo.ts';

const correlationKey = Symbol('kaiju.request-correlation');
const traceParentPattern = /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<parentSpanId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,127}$/;
const traceStateKeyPattern = /^[a-z0-9][a-z0-9_*/@-]{0,255}$/;
const traceStateValuePattern = /^[\x20-\x2B\x2D-\x3C\x3E-\x7E]{1,256}$/;

/** W3C trace and request-correlation values derived from trusted request input. */
export interface RequestCorrelation {
	readonly requestId: string;
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly traceFlags: string;
	readonly traceState?: string;
	readonly traceparent: string;
	readonly source: 'continued' | 'new' | 'replaced-invalid-parent';
}

/** Options used when establishing request correlation. */
export interface RequestCorrelationOptions {
	readonly requestId?: string | ((request: Request) => string | undefined);
	readonly sampled?: boolean;
	readonly maximumTraceStateLength?: number;
}

/**
 * Establish one request-owned correlation value.
 *
 * A valid incoming W3C trace is continued with a newly generated span. Invalid
 * parent material is never propagated. The pending result is memoized by the
 * Request object so authentication, logging, and downstream clients share the
 * same IDs.
 */
export function correlation(
	request: Request,
	options: RequestCorrelationOptions = {},
): Promise<RequestCorrelation> {
	return memoize(request, correlationKey, () => establishCorrelation(request, options));
}


/** Optional stable dimensions added to structured correlation fields. */
export interface RequestCorrelationFieldOptions {
	readonly service?: string;
	readonly operationId?: string;
	readonly routeId?: string;
}

/**
 * Project correlation into redaction-safe structured logging fields.
 *
 * The returned record contains identifiers only; it never includes headers,
 * cookies, authorization credentials, query values, or request bodies.
 */
export function correlationFields(
	value: RequestCorrelation,
	options: RequestCorrelationFieldOptions = {},
): Readonly<Record<string, string>> {
	return Object.freeze({
		request_id: value.requestId,
		trace_id: value.traceId,
		span_id: value.spanId,
		...(value.parentSpanId === undefined ? {} : { parent_span_id: value.parentSpanId }),
		trace_flags: value.traceFlags,
		trace_source: value.source,
		...(options.service === undefined ? {} : { service: options.service }),
		...(options.operationId === undefined ? {} : { operation_id: options.operationId }),
		...(options.routeId === undefined ? {} : { route_id: options.routeId }),
	});
}

/** Build fields safe to propagate to one downstream HTTP request. */
export function propagationHeaders(value: RequestCorrelation): Headers {
	const headers = new Headers({
		'x-request-id': value.requestId,
		traceparent: value.traceparent,
	});
	if (value.traceState !== undefined) headers.set('tracestate', value.traceState);
	return headers;
}

/** Return a bounded caller-provided request ID or generate a new UUID. */
export function requestId(value: string | null | undefined): string {
	if (value !== undefined && value !== null && requestIdPattern.test(value)) return value;
	return crypto.randomUUID();
}

/** Parse an incoming W3C traceparent without accepting zero IDs or future-version ambiguity. */
export function parseTraceParent(value: string | null): Readonly<{
	readonly traceId: string;
	readonly parentSpanId: string;
	readonly flags: string;
}> | undefined {
	if (value === null || value.length !== 55) return undefined;
	const match = traceParentPattern.exec(value.toLowerCase());
	if (!match?.groups || match.groups.version !== '00') return undefined;
	const traceId = match.groups.traceId;
	const parentSpanId = match.groups.parentSpanId;
	const flags = match.groups.flags;
	if (traceId === undefined || parentSpanId === undefined || flags === undefined) return undefined;
	if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return undefined;
	return Object.freeze({ traceId, parentSpanId, flags });
}

/** Validate and normalize W3C tracestate. Invalid state is dropped, never forwarded. */
export function parseTraceState(value: string | null, maximumLength = 512): string | undefined {
	if (value === null || value.length === 0 || value.length > maximumLength) return undefined;
	const members = value.split(',').map((member) => member.trim());
	if (members.length > 32 || members.some((member) => member.length === 0)) return undefined;
	const seen = new Set<string>();
	for (const member of members) {
		const separator = member.indexOf('=');
		if (separator < 1) return undefined;
		const key = member.slice(0, separator);
		const memberValue = member.slice(separator + 1);
		if (!traceStateKeyPattern.test(key) || !traceStateValuePattern.test(memberValue) || seen.has(key)) return undefined;
		seen.add(key);
	}
	return members.join(',');
}

/**
 * Establishes one trusted request correlation ID from accepted upstream metadata or a new generated value.
 *
 * Request internals normalize untrusted protocol metadata before endpoint and service composition consume it.
 *
 * @internal
 */
async function establishCorrelation(
	request: Request,
	options: RequestCorrelationOptions,
): Promise<RequestCorrelation> {
	const suppliedRequestId = typeof options.requestId === 'function'
		? options.requestId(request)
		: options.requestId;
	const resolvedRequestId = requestId(suppliedRequestId ?? request.headers.get('x-request-id'));
	const incomingValue = request.headers.get('traceparent');
	const incoming = parseTraceParent(incomingValue);
	const traceId = incoming?.traceId ?? randomHex(16);
	const spanId = randomHex(8);
	const traceFlags = incoming?.flags ?? (options.sampled === false ? '00' : '01');
	const traceState = incoming === undefined
		? undefined
		: parseTraceState(request.headers.get('tracestate'), options.maximumTraceStateLength ?? 512);
	return Object.freeze({
		requestId: resolvedRequestId,
		traceId,
		spanId,
		...(incoming === undefined ? {} : { parentSpanId: incoming.parentSpanId }),
		traceFlags,
		...(traceState === undefined ? {} : { traceState }),
		traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
		source: incoming !== undefined
			? 'continued'
			: incomingValue === null ? 'new' : 'replaced-invalid-parent',
	});
}

/**
 * Generates bounded hexadecimal correlation entropy when no trusted request ID is available.
 *
 * @internal
 */
function randomHex(bytes: number): string {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return encodeHex(value);
}
