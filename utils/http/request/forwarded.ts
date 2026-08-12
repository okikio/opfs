import { RequestTransportError, type ForwardedHeaderPolicy } from './types.ts';

/** Resolve the externally visible URL only when forwarding fields are explicitly trusted. */
export function externalUrl(request: Request, policy: ForwardedHeaderPolicy): URL {
	const result = new URL(request.url);
	const hasForwarding = request.headers.has('forwarded') || [...request.headers.keys()].some((name) => name.startsWith('x-forwarded-'));
	if (!policy.trust) {
		if (hasForwarding) return result;
		return result;
	}
	let protocol: string | undefined;
	let host: string | undefined;
	if (policy.allowForwarded !== false) {
		const first = request.headers.get('forwarded')?.split(',', 1)[0];
		if (first) {
			for (const pair of first.split(';')) {
				const [name, raw] = pair.split('=', 2).map((value) => value.trim());
				const value = raw?.replace(/^"|"$/g, '');
				if (name?.toLowerCase() === 'proto') protocol = value;
				if (name?.toLowerCase() === 'host') host = value;
			}
		}
	}
	if (policy.allowXForwarded !== false) {
		protocol ??= request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim();
		host ??= request.headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim();
	}
	if (protocol) {
		const normalized = protocol.endsWith(':') ? protocol : `${protocol}:`;
		if (policy.allowedProtocols && !policy.allowedProtocols.includes(normalized as 'http:' | 'https:')) throw new RequestTransportError({ code: 'untrusted-forwarded-header', message: `Forwarded protocol ${JSON.stringify(protocol)} is not allowed.`, path: ['header', 'forwarded'] });
		result.protocol = normalized;
	}
	if (host) {
		if (/[\0\r\n/@\\]/.test(host)) throw new RequestTransportError({ code: 'untrusted-forwarded-header', message: 'Forwarded host is malformed.', path: ['header', 'forwarded'] });
		if (policy.allowedHosts && !policy.allowedHosts.some((allowed) => allowed.toLowerCase() === host!.toLowerCase())) throw new RequestTransportError({ code: 'untrusted-forwarded-header', message: `Forwarded host ${JSON.stringify(host)} is not allowed.`, path: ['header', 'forwarded'] });
		const forwarded = new URL(`${result.protocol}//${host}`);
		result.hostname = forwarded.hostname;
		result.port = forwarded.port;
	}
	return result;
}
