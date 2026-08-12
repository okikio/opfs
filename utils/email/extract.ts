import type { CsvColumn, CsvRow } from '@utils/csv/types'

import { DEFAULT_EMAIL_DOMAIN_CLASSIFIER } from './classify.ts'
import { normalizeEmailDomain, normalizeWebsiteHostname } from './normalize.ts'
import type {
	DomainSource,
	DomainSourceKind,
	EmailDomainClassifier,
	EmailRowDomain,
	RowDomainCandidate,
} from './types.ts'

/** Ranking used only to choose among candidates within one source row. */
const SOURCE_CONFIDENCE = Object.freeze({
	domain: 100,
	website: 80,
	email: 60,
} satisfies Readonly<Record<DomainSourceKind, number>>)

/** Splits cells using rules appropriate to their semantic source. */
function splitCell(value: string, kind: DomainSourceKind): readonly string[] {
	if (kind === 'email') {
		return Object.freeze(Array.from(value.matchAll(/@([^\s>,;]+)/gu), (match) => match[1] ?? ''))
	}
	return Object.freeze(value.split(/[,;\n|]+/u).map((part) => part.trim()).filter(Boolean))
}

/** Creates a stable key for deduplicating repeated source evidence within a row. */
function sourceKey(source: DomainSource): string {
	return `${source.row}:${source.column}:${source.kind}:${source.candidate}:${source.value}`
}

/** Product-neutral policy used by company-domain extraction. */
function excludesCompanyCandidate(
	classifier: EmailDomainClassifier,
	domain: string,
): boolean {
	return classifier.classify(domain).evidence.some(({ trait }) =>
		trait === 'public-mailbox' || trait === 'privacy-relay' || trait === 'disposable'
	)
}

/**
 * Snapshots candidate so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeCandidate(
	domain: string,
	value: { readonly confidence: number; readonly sources: readonly DomainSource[] },
): RowDomainCandidate {
	return Object.freeze({
		domain,
		confidence: value.confidence,
		sources: Object.freeze([...value.sources]),
	})
}

/**
 * Streams row-level company-domain candidates from already parsed CSV rows.
 *
 * CSV parsing and email-domain policy remain independent utilities. This
 * function is the explicit composition point where column roles, hostname
 * normalization, and mailbox classification are used together.
 */
export async function* extractEmailDomains(
	rows: AsyncIterable<CsvRow>,
	columns: readonly CsvColumn[],
	classifier: EmailDomainClassifier = DEFAULT_EMAIL_DOMAIN_CLASSIFIER,
): AsyncGenerator<EmailRowDomain> {
	const companyColumn = columns.find((column) => column.role === 'company')

	for await (const row of rows) {
		const candidates = new Map<string, { confidence: number; sources: DomainSource[] }>()
		for (const column of columns) {
			if (column.role !== 'domain' && column.role !== 'website' && column.role !== 'email') continue
			const value = row.values[column.index]?.trim()
			if (!value) continue

			for (const part of splitCell(value, column.role)) {
				const domain = column.role === 'email'
					? normalizeEmailDomain(part)
					: normalizeWebsiteHostname(part)
				if (!domain || (column.role === 'email' && excludesCompanyCandidate(classifier, domain))) continue

				const source = Object.freeze({
					row: row.row,
					column: column.index + 1,
					header: column.name,
					value,
					candidate: part,
					kind: column.role,
				}) satisfies DomainSource
				const current = candidates.get(domain) ?? {
					confidence: SOURCE_CONFIDENCE[column.role],
					sources: [],
				}
				current.confidence = Math.max(current.confidence, SOURCE_CONFIDENCE[column.role])
				if (!current.sources.some((item) => sourceKey(item) === sourceKey(source))) {
					current.sources.push(source)
				}
				candidates.set(domain, current)
			}
		}

		const ranked = Object.freeze([...candidates.entries()]
			.map(([domain, value]) => freezeCandidate(domain, value))
			.sort((left, right) =>
				right.confidence - left.confidence || left.domain.localeCompare(right.domain)
			))
		const primary = ranked[0]
		if (!primary) continue
		const company = companyColumn ? row.values[companyColumn.index]?.trim() || undefined : undefined
		yield Object.freeze({
			row: row.row,
			...(company ? { company } : {}),
			primary,
			candidates: ranked,
		})
	}
}
