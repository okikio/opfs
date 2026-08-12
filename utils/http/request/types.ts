/** Stable issue codes emitted by request wire parsing and sanitation. */
export type RequestIssueCode =
	| 'too-many-headers'
	| 'headers-too-large'
	| 'header-too-large'
	| 'invalid-header'
	| 'too-many-query-parameters'
	| 'query-value-too-large'
	| 'invalid-parameter'
	| 'cookies-too-large'
	| 'too-many-cookies'
	| 'invalid-cookie'
	| 'duplicate-cookie'
	| 'invalid-authorization'
	| 'unsupported-authorization'
	| 'body-too-large'
	| 'unsupported-content-type'
	| 'invalid-json'
	| 'invalid-form'
	| 'not-acceptable'
	| 'untrusted-forwarded-header';

/** Structured wire parsing failure. */
export interface RequestIssue {
	readonly code: RequestIssueCode;
	readonly message: string;
	readonly path?: readonly PropertyKey[];
}

/** Error containing one or more transport issues safe for validation reporting. */
export class RequestTransportError extends Error {
	readonly issues: readonly RequestIssue[];
	constructor(issues: RequestIssue | readonly RequestIssue[]) {
		const values = Array.isArray(issues) ? issues : [issues];
		super(values.map((value) => value.message).join('; '));
		this.name = 'RequestTransportError';
		this.issues = Object.freeze(values.map((value) => Object.freeze({ ...value })));
	}
}

/** Bounded defaults for generic Web request parsing. */
export interface RequestParsingLimits {
	readonly maximumHeaders: number;
	readonly maximumHeaderBytes: number;
	readonly maximumHeaderValueBytes: number;
	readonly maximumQueryParameters: number;
	readonly maximumQueryValueLength: number;
	readonly maximumParameterLength: number;
	readonly maximumCookieBytes: number;
	readonly maximumCookies: number;
	readonly maximumBodyBytes: number;
	readonly maximumFormFields: number;
}

/** Partial limit override accepted by parsing functions. */
export type RequestParsingOptions = Partial<RequestParsingLimits>;

/** One normalized wire value, preserving repeated occurrences when present. */
export type WireValue = string | readonly string[];

/** Normalized wire record used for bounded query, header, and parameter values. */
export type WireRecord = Readonly<Record<string, WireValue>>;

/** One parsed form field value. Files remain explicit rather than being coerced to strings. */
export type FormWireValue = string | File | readonly (string | File)[];

/** Bounded form record preserving repeated text values and uploaded files. */
export type FormWireRecord = Readonly<Record<string, FormWireValue>>;
/** Parsed authorization credential. The secret is revealed only by an explicit call. */
export interface SensitiveCredential {
	reveal(): string;
	toString(): '[REDACTED]';
	toJSON(): '[REDACTED]';
}

/** Syntax-level Authorization field, not a verified identity. */
export interface ParsedAuthorization {
	readonly scheme: string;
	readonly normalizedScheme: string;
	readonly credential: SensitiveCredential;
}

/** Cookie duplicate handling policy. */
export type DuplicateCookiePolicy = 'reject' | 'first' | 'last' | 'array';

/** Trusted external-origin resolution policy. */
export interface ForwardedHeaderPolicy {
	readonly trust: boolean;
	readonly allowForwarded?: boolean;
	readonly allowXForwarded?: boolean;
	readonly allowedHosts?: readonly string[];
	readonly allowedProtocols?: readonly ('http:' | 'https:')[];
}

/** Parsed media type. */
export interface MediaType {
	readonly type: string;
	readonly subtype: string;
	readonly parameters: Readonly<Record<string, string>>;
	readonly essence: string;
}
