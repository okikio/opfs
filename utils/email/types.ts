/** Independent facts supported by evidence about an email domain. */
export type EmailDomainTrait = 'public-mailbox' | 'privacy-relay' | 'disposable'

/** Matching strategy used by a provider-owned domain rule. */
export type EmailDomainRuleMatch = 'exact' | 'suffix'

/** One static rule contributed by a known email provider. */
export interface EmailDomainRule {
	/** Fact supported when the rule matches. */
	readonly trait: EmailDomainTrait
	/** Human-readable provider name. */
	readonly provider: string
	/** Lowercase ASCII hostname without a leading `@`. */
	readonly domain: string
	/** Exact hostname or whole-label suffix matching. */
	readonly match: EmailDomainRuleMatch
}

/** Auditable evidence returned by the classifier. */
export interface EmailDomainEvidence {
	readonly trait: EmailDomainTrait
	readonly provider?: string
	readonly matchedDomain: string
	readonly match: 'exact' | 'suffix' | 'parent'
	readonly source: string
}

/** Multi-trait classification that preserves conflicts instead of hiding them. */
export interface EmailDomainClassification {
	readonly domain: string
	readonly evidence: readonly EmailDomainEvidence[]
}

/** Immutable classifier used by extraction and product-specific policy. */
export interface EmailDomainClassifier {
	readonly classify: (domain: string) => EmailDomainClassification
}

/** How a hostname was extracted from a source value. */
export type DomainSourceKind = 'domain' | 'email' | 'website'

/** Exact provenance for one normalized hostname candidate. */
export interface DomainSource {
	readonly row: number
	readonly column: number
	readonly header: string
	readonly value: string
	readonly candidate: string
	readonly kind: DomainSourceKind
}

/** One normalized candidate found in a source row. */
export interface RowDomainCandidate {
	readonly domain: string
	readonly confidence: number
	readonly sources: readonly DomainSource[]
}

/** Domain extraction result for one streamed source row. */
export interface EmailRowDomain {
	readonly row: number
	readonly company?: string
	readonly primary: RowDomainCandidate
	readonly candidates: readonly RowDomainCandidate[]
}
