import { DISPOSABLE_EMAIL_DOMAINS } from './data/disposable.ts'
import { PRIVACY_EMAIL_DOMAIN_RULES, PUBLIC_EMAIL_DOMAIN_RULES } from './data/providers.ts'
import { normalizeEmailDomain } from './normalize.ts'
import type {
	EmailDomainClassification,
	EmailDomainClassifier,
	EmailDomainEvidence,
	EmailDomainRule,
	EmailDomainRuleMatch,
	EmailDomainTrait,
} from './types.ts'

const EMAIL_DOMAIN_TRAITS = new Set<EmailDomainTrait>([
	'public-mailbox',
	'privacy-relay',
	'disposable',
])
const EMAIL_DOMAIN_RULE_MATCHES = new Set<EmailDomainRuleMatch>(['exact', 'suffix'])

/** Default immutable provider rules evaluated by the classifier. */
const DEFAULT_RULES = Object.freeze([
	...PUBLIC_EMAIL_DOMAIN_RULES,
	...PRIVACY_EMAIL_DOMAIN_RULES,
])
/** Exact lookup table for the vendored disposable snapshot. */
const DEFAULT_DISPOSABLE_DOMAINS = new Set<string>(DISPOSABLE_EMAIL_DOMAINS)

/** Returns whether a hostname matches an exact or whole-label suffix rule. */
function matchesRule(domain: string, rule: EmailDomainRule): boolean {
	return rule.match === 'exact'
		? domain === rule.domain
		: domain === rule.domain || domain.endsWith(`.${rule.domain}`)
}

/** Finds the closest blocklisted parent without ever checking a top-level suffix alone. */
function matchDisposableParent(
	domain: string,
	domains: ReadonlySet<string>,
): string | undefined {
	let candidate = domain
	while (candidate.includes('.')) {
		if (domains.has(candidate)) return candidate
		const separator = candidate.indexOf('.')
		candidate = candidate.slice(separator + 1)
	}
	return undefined
}

/**
 * Normalizes rule into the canonical internal form used by later phases.
 *
 * It turns email and hostname rules into reusable evidence without making a product-level company-domain decision.
 *
 * @internal
 */
function normalizeRule(rule: EmailDomainRule, index: number): EmailDomainRule {
	if (!EMAIL_DOMAIN_TRAITS.has(rule.trait)) {
		throw new TypeError(`Email-domain rule ${index + 1} has an unsupported trait.`)
	}
	if (!EMAIL_DOMAIN_RULE_MATCHES.has(rule.match)) {
		throw new TypeError(`Email-domain rule ${index + 1} has an unsupported match strategy.`)
	}
	const provider = rule.provider.trim()
	if (!provider) {
		throw new TypeError(`Email-domain rule ${index + 1} requires a provider name.`)
	}
	const domain = normalizeEmailDomain(rule.domain)
	if (!domain) {
		throw new TypeError(`Email-domain rule ${index + 1} has an invalid domain.`)
	}
	return Object.freeze({
		trait: rule.trait,
		provider,
		domain,
		match: rule.match,
	})
}

/**
 * Normalizes rules into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeRules(rules: readonly EmailDomainRule[]): readonly EmailDomainRule[] {
	const normalized = new Map<string, EmailDomainRule>()
	for (const [index, rule] of rules.entries()) {
		const value = normalizeRule(rule, index)
		const key = `${value.trait}:${value.provider}:${value.domain}:${value.match}`
		normalized.set(key, value)
	}
	return Object.freeze([...normalized.values()])
}

/**
 * Normalizes disposable domains into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeDisposableDomains(domains: readonly string[]): ReadonlySet<string> {
	const normalized = new Set<string>()
	for (const [index, value] of domains.entries()) {
		const domain = normalizeEmailDomain(value)
		if (!domain) {
			throw new TypeError(`Disposable email domain ${index + 1} is invalid.`)
		}
		normalized.add(domain)
	}
	return normalized
}

/** Creates a runtime-neutral classifier from plain immutable domain data. */
export function createEmailDomainClassifier(options: {
	readonly rules?: readonly EmailDomainRule[]
	readonly disposableDomains?: readonly string[]
} = {}): EmailDomainClassifier {
	const rules = options.rules === undefined ? DEFAULT_RULES : normalizeRules(options.rules)
	const disposable = options.disposableDomains === undefined
		? DEFAULT_DISPOSABLE_DOMAINS
		: normalizeDisposableDomains(options.disposableDomains)

	return Object.freeze({
		/**
		 * Classifies input into the classify used by email and hostname classification.
		 *
		 * Email internals produce reusable classification evidence without making product-level company or account decisions.
		 *
		 * @internal
		 */
		classify(value: string): EmailDomainClassification {
			const domain = normalizeEmailDomain(value)
			if (!domain) {
				return Object.freeze({
					domain: value.trim().toLowerCase(),
					evidence: Object.freeze([]),
				})
			}

			const evidence: EmailDomainEvidence[] = []
			for (const rule of rules) {
				if (!matchesRule(domain, rule)) continue
				evidence.push(Object.freeze({
					trait: rule.trait,
					provider: rule.provider,
					matchedDomain: rule.domain,
					match: rule.match,
					source: 'builtin-provider-rules',
				}))
			}

			const matchedDomain = matchDisposableParent(domain, disposable)
			if (matchedDomain) {
				evidence.push(Object.freeze({
					trait: 'disposable',
					matchedDomain,
					match: matchedDomain === domain ? 'exact' : 'parent',
					source: 'disposable-email-domains',
				}))
			}

			return Object.freeze({ domain, evidence: Object.freeze(evidence) })
		},
	})
}

/** Shared default classifier for callers that do not need policy injection. */
export const DEFAULT_EMAIL_DOMAIN_CLASSIFIER = createEmailDomainClassifier()
