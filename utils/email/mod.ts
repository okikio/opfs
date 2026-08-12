/**
 * Runtime-neutral email-domain normalization, classification, and extraction.
 *
 * Classification returns independent evidence rather than forcing public,
 * privacy, and disposable domains into one mutually exclusive enum.
 *
 * @module
 */
export { DEFAULT_EMAIL_DOMAIN_CLASSIFIER, createEmailDomainClassifier } from './classify.ts'
export { DISPOSABLE_EMAIL_DOMAINS } from './data/disposable.ts'
export { PRIVACY_EMAIL_DOMAIN_RULES, PUBLIC_EMAIL_DOMAIN_RULES } from './data/providers.ts'
export { extractEmailDomains } from './extract.ts'
export { normalizeEmailDomain, normalizeWebsiteHostname } from './normalize.ts'
export type { DomainSource, DomainSourceKind, EmailDomainClassification, EmailDomainClassifier, EmailDomainEvidence, EmailDomainRule, EmailDomainRuleMatch, EmailDomainTrait, EmailRowDomain, RowDomainCandidate } from './types.ts'
