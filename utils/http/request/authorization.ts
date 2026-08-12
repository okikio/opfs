import { RequestTransportError, type ParsedAuthorization, type SensitiveCredential } from './types.ts';

const schemePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Owns the internal credential state used by HTTP request normalization.
 *
 * Request internals normalize untrusted protocol metadata before endpoint and service composition consume it.
 *
 * @internal
 */
class Credential implements SensitiveCredential {
	readonly #value: string;
	constructor(value: string) { this.#value = value; Object.freeze(this); }
	/**
	 * Reveals a secret authorization credential only inside the parser operation that has explicit authority to inspect it.
	 *
	 * @internal
	 */
	reveal(): string { return this.#value; }
	/**
	 * Converts the source value to string expected by HTTP request normalization.
	 *
	 * @internal
	 */
	toString(): '[REDACTED]' { return '[REDACTED]'; }
	/**
	 * Converts the source value to json expected by HTTP request normalization.
	 *
	 * @internal
	 */
	toJSON(): '[REDACTED]' { return '[REDACTED]'; }
}

/** Parse Authorization syntax without verifying the credential or establishing identity. */
export function parseAuthorization(
	value: string | null,
	options: { readonly allowedSchemes?: readonly string[] } = {},
): ParsedAuthorization | undefined {
	if (value === null || value.trim() === '') return undefined;
	if (/\0|\r|\n/.test(value)) throw new RequestTransportError({ code: 'invalid-authorization', message: 'Authorization contains a forbidden control character.', path: ['header', 'authorization'] });
	const match = /^([^\s]+)[ \t]+([^\s].*)$/.exec(value);
	if (!match || !schemePattern.test(match[1]!)) throw new RequestTransportError({ code: 'invalid-authorization', message: 'Authorization must contain a valid scheme and credential.', path: ['header', 'authorization'] });
	const scheme = match[1]!;
	const credential = match[2]!.trim();
	if (credential.length === 0 || /[\r\n]/.test(credential)) throw new RequestTransportError({ code: 'invalid-authorization', message: 'Authorization credential is empty or malformed.', path: ['header', 'authorization'] });
	const normalizedScheme = scheme.toLowerCase();
	if (options.allowedSchemes && !options.allowedSchemes.some((candidate) => candidate.toLowerCase() === normalizedScheme)) {
		throw new RequestTransportError({ code: 'unsupported-authorization', message: `Authorization scheme ${JSON.stringify(scheme)} is not supported.`, path: ['header', 'authorization'] });
	}
	return Object.freeze({ scheme, normalizedScheme, credential: new Credential(credential) });
}
