import { describe, it } from 'node:test'
import { expect } from '@std/expect'

import type { CsvColumn, CsvRow } from '@utils/csv/types'

import {
	createEmailDomainClassifier,
	DEFAULT_EMAIL_DOMAIN_CLASSIFIER,
	extractEmailDomains,
	normalizeEmailDomain,
} from './mod.ts'

async function* rows(...values: CsvRow[]): AsyncGenerator<CsvRow> {
	yield* values
}

describe('email-domain utilities', () => {
	it('normalizes IDNA email domains without stripping labels', () => {
		expect(normalizeEmailDomain('BÜCHER.example.')).toBe('xn--bcher-kva.example')
	})

	it('classifies privacy suffixes only on whole DNS labels', () => {
		expect(
			DEFAULT_EMAIL_DOMAIN_CLASSIFIER.classify('person.aleeas.com').evidence
				.some((evidence) => evidence.trait === 'privacy-relay'),
		).toBe(true)
		expect(
			DEFAULT_EMAIL_DOMAIN_CLASSIFIER.classify('notaleeas.com').evidence
				.some((evidence) => evidence.trait === 'privacy-relay'),
		).toBe(false)
	})

	it('normalizes custom disposable domains and matches their parents', () => {
		const classifier = createEmailDomainClassifier({
			disposableDomains: ['Temporary.Example.'],
		})
		expect(classifier.classify('mail.temporary.example').evidence).toContainEqual({
			trait: 'disposable',
			matchedDomain: 'temporary.example',
			match: 'parent',
			source: 'disposable-email-domains',
		})
	})

	it('rejects invalid caller-supplied rules instead of silently misclassifying', () => {
		expect(() => createEmailDomainClassifier({
			rules: [{
				trait: 'public-mailbox',
				provider: 'Example',
				domain: 'not a hostname',
				match: 'exact',
			}],
		})).toThrow(TypeError)
	})

	it('extracts ranked immutable company-domain evidence from streamed rows', async () => {
		const columns: readonly CsvColumn[] = Object.freeze([
			Object.freeze({ index: 0, name: 'Company', key: 'company', normalizedName: 'company', role: 'company' }),
			Object.freeze({ index: 1, name: 'Website', key: 'website', normalizedName: 'website', role: 'website' }),
			Object.freeze({ index: 2, name: 'Email', key: 'email', normalizedName: 'email', role: 'email' }),
		])
		const sourceRow = Object.freeze({
			row: 2,
			values: Object.freeze(['Northstar', 'https://www.northstar.example', 'sales@northstar.example; owner@gmail.com']),
			diagnostics: Object.freeze([]),
		})
		const extracted = await Array.fromAsync(extractEmailDomains(rows(sourceRow), columns))

		expect(extracted).toHaveLength(1)
		expect(extracted[0]?.primary.domain).toEqual('northstar.example')
		expect(extracted[0]?.primary.confidence).toEqual(80)
		expect(extracted[0]?.candidates.map((candidate) => candidate.domain)).toEqual(['northstar.example'])
		expect(Object.isFrozen(extracted[0])).toBe(true)
		expect(Object.isFrozen(extracted[0]?.candidates)).toBe(true)
		expect(Object.isFrozen(extracted[0]?.primary.sources)).toBe(true)
	})
})
