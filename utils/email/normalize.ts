/** Returns true when a normalized value has the shape of a DNS hostname. */
function isHostname(hostname: string): boolean {
	if (hostname.length > 253 || !hostname.includes('.') || hostname.includes('..')) return false
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false
	return hostname.split('.').every((label) =>
		label.length > 0 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-') && /^[a-z\d-]+$/iu.test(label)
	)
}

/**
 * Normalizes an email-domain value without applying website-specific policy.
 *
 * Unlike website normalization, this function never strips `www.` because an
 * email domain must be interpreted exactly as supplied after IDNA conversion.
 */
export function normalizeEmailDomain(value: string): string | undefined {
	const candidate = value.trim().replace(/^@/u, '').replace(/\.$/u, '')
	if (!candidate || /[\s/@:]/u.test(candidate)) return undefined
	try {
		const hostname = new URL(`https://${candidate}`).hostname.toLowerCase().replace(/\.$/u, '')
		return isHostname(hostname) ? hostname : undefined
	} catch {
		return undefined
	}
}

/** Normalizes a website or bare-hostname value to an ASCII hostname. */
export function normalizeWebsiteHostname(value: string): string | undefined {
	const candidate = value.trim().replace(/^'+/u, '').replace(/^["<([{]+|[">)\]},.]+$/gu, '')
	if (!candidate) return undefined
	try {
		const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate) ? candidate : `https://${candidate}`)
		const hostname = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^www\./u, '')
		return isHostname(hostname) ? hostname : undefined
	} catch {
		return undefined
	}
}
