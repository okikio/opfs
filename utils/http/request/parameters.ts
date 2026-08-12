import { limits } from './limits.ts';
import { RequestTransportError, type RequestParsingOptions } from './types.ts';

/** Parse canonical `:name` route parameters from a matched path. */
export function parseParameters(routePath: string, pathname: string, options: RequestParsingOptions = {}): Readonly<Record<string, string>> {
	const policy = limits(options);
	const route = routePath.split('/').filter(Boolean);
	const actual = pathname.split('/').filter(Boolean);
	const result: Record<string, string> = Object.create(null);
	for (let index = 0; index < route.length; index += 1) {
		const segment = route[index]!;
		if (!segment.startsWith(':')) continue;
		const name = segment.slice(1);
		const raw = actual[index];
		if (!raw) throw new RequestTransportError({ code: 'invalid-parameter', message: `Route parameter ${name} is missing.`, path: ['param', name] });
		let value: string;
		try { value = decodeURIComponent(raw); } catch { throw new RequestTransportError({ code: 'invalid-parameter', message: `Route parameter ${name} is not valid percent-encoding.`, path: ['param', name] }); }
		if (value.length === 0 || value.length > policy.maximumParameterLength || /[\0\r\n]/.test(value)) throw new RequestTransportError({
			code: 'invalid-parameter', message: `Route parameter ${name} is empty, oversized, or contains a control character.`, path: ['param', name],
		});
		result[name] = value;
	}
	return Object.freeze(result);
}
