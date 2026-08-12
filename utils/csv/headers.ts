import type {
	CsvColumnRole,
	CsvHeaderAliases,
	CsvHeaderAliasOverrides,
} from './types.ts'

/** Default domain-oriented aliases derived from the supplied CRM fixture pack. */
export const DEFAULT_CSV_HEADER_ALIASES = {
	company: [
		'Account Name',
		'Associated company',
		'Company',
		'Company Name',
		'Lead Name',
		'Organization - Name',
		'Organization Name',
		'Person - Organization',
	],
	domain: [
		'Company Domain Name',
		'Company Domains',
		'Domain',
		'Domains',
		'Email Domain',
	],
	email: [
		'Business Email',
		'Company Email',
		'Email',
		'Email Address',
		'Email addresses',
		'Person - Email (Work)',
		'Primary Contact Emails',
		'Work Email',
	],
	website: [
		'Account website',
		'Company Website',
		'Organization Website',
		'URL',
		'URLs',
		'Web Site',
		'Website',
		'Website URL',
	],
} as const satisfies CsvHeaderAliases

const OBJECT_PREFIX = /^(?:account|company|contact|deal|organization|person)\s+/i

/** Normalizes a source header for stable alias matching and generated keys. */
export function normalizeCsvHeader(header: string): string {
	return header
		.replace(/^\ufeff/, '')
		.normalize('NFKC')
		.trim()
		.replace(/([a-z\d])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.replace(/[\u2010-\u2015]/g, '-')
		.replace(/[*:]/g, ' ')
		.replace(/[_./\\()[\]-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

/**
 * Builds alias lookup from validated inputs without changing source identity.
 *
 * It keeps CSV discovery and parsing bounded while preserving diagnostics that higher-level import code can act on.
 *
 * @internal
 */
function buildAliasLookup(
	additionalAliases: CsvHeaderAliasOverrides = {},
): ReadonlyMap<string, Exclude<CsvColumnRole, 'unknown'>> {
	const lookup = new Map<string, Exclude<CsvColumnRole, 'unknown'>>()
	for (const [role, defaults] of Object.entries(DEFAULT_CSV_HEADER_ALIASES) as [
		Exclude<CsvColumnRole, 'unknown'>,
		readonly string[],
	][]) {
		for (const value of defaults) lookup.set(normalizeCsvHeader(value), role)
		for (const value of additionalAliases[role] ?? []) {
			lookup.set(normalizeCsvHeader(value), role)
		}
	}
	return lookup
}

const DEFAULT_ALIAS_LOOKUP = buildAliasLookup()

/** Builds a reusable classifier by extending, rather than replacing, the default aliases. */
export function createCsvHeaderClassifier(
	additionalAliases: CsvHeaderAliasOverrides = {},
): (header: string) => CsvColumnRole {
	const lookup = Object.keys(additionalAliases).length === 0
		? DEFAULT_ALIAS_LOOKUP
		: buildAliasLookup(additionalAliases)

	return (header) => {
		const normalized = normalizeCsvHeader(header)
		return lookup.get(normalized) ?? lookup.get(normalized.replace(OBJECT_PREFIX, '')) ?? 'unknown'
	}
}

/** Classifies a header only when it matches an explicit default alias. */
export function classifyCsvHeader(header: string): CsvColumnRole {
	const normalized = normalizeCsvHeader(header)
	return DEFAULT_ALIAS_LOOKUP.get(normalized) ??
		DEFAULT_ALIAS_LOOKUP.get(normalized.replace(OBJECT_PREFIX, '')) ??
		'unknown'
}
