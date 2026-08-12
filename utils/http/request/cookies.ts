import { limits } from './limits.ts';
import { RequestTransportError, type DuplicateCookiePolicy, type RequestParsingOptions, type WireRecord } from './types.ts';

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Parse a Cookie field with explicit duplicate and decoding policy. Provider cookies remain opaque strings. */
export function parseCookies(
	header: string | null,
	options: RequestParsingOptions & { readonly duplicates?: DuplicateCookiePolicy; readonly percentDecode?: boolean } = {},
): WireRecord {
	if (!header) return Object.freeze({});
	const policy = limits(options);
	if (new TextEncoder().encode(header).byteLength > policy.maximumCookieBytes) throw new RequestTransportError({
		code: 'cookies-too-large', message: `Cookie header exceeds ${policy.maximumCookieBytes} bytes.`, path: ['cookie'],
	});
	const duplicatePolicy = options.duplicates ?? 'array';
	const collected: Record<string, string[]> = Object.create(null);
	let count = 0;
	for (const part of header.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 1) throw new RequestTransportError({ code: 'invalid-cookie', message: 'Cookie fields must contain name=value pairs.', path: ['cookie'] });
		const name = part.slice(0, separator).trim();
		let value = part.slice(separator + 1).trim();
		count += 1;
		if (!cookieNamePattern.test(name) || /[\0\r\n]/.test(value)) throw new RequestTransportError({
			code: 'invalid-cookie', message: `Cookie ${JSON.stringify(name)} is malformed.`, path: ['cookie', name],
		});
		if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
		if (options.percentDecode) {
			try { value = decodeURIComponent(value); } catch { throw new RequestTransportError({ code: 'invalid-cookie', message: `Cookie ${JSON.stringify(name)} is not valid percent-encoding.`, path: ['cookie', name] }); }
		}
		const existing = collected[name];
		if (existing && duplicatePolicy === 'reject') throw new RequestTransportError({
			code: 'duplicate-cookie', message: `Cookie ${JSON.stringify(name)} occurs more than once.`, path: ['cookie', name],
		});
		if (!existing) collected[name] = [value];
		else if (duplicatePolicy === 'first') continue;
		else if (duplicatePolicy === 'last') collected[name] = [value];
		else existing.push(value);
	}
	if (count > policy.maximumCookies) throw new RequestTransportError({
		code: 'too-many-cookies', message: `At most ${policy.maximumCookies} cookies are allowed.`, path: ['cookie'],
	});
	const result: Record<string, string | readonly string[]> = Object.create(null);
	for (const [name, values] of Object.entries(collected)) result[name] = values.length === 1 ? values[0]! : Object.freeze(values);
	return Object.freeze(result);
}
