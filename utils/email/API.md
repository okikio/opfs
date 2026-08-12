@utils/email public API usage
=============================

Purpose
-------

This reference maps every public export target declared by `@utils/email` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/email
------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `createEmailDomainClassifier` | function | Creates a runtime-neutral classifier from plain immutable domain data. | `createEmailDomainClassifier(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DEFAULT_EMAIL_DOMAIN_CLASSIFIER` | value | Shared default classifier for callers that do not need policy injection. | `DEFAULT_EMAIL_DOMAIN_CLASSIFIER` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DISPOSABLE_EMAIL_DOMAINS` | value | Vendored disposable-email-domain snapshot. | `DISPOSABLE_EMAIL_DOMAINS` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DomainSource` | interface | Exact provenance for one normalized hostname candidate. | `value: DomainSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DomainSourceKind` | type | How a hostname was extracted from a source value. | `value: DomainSourceKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainClassification` | interface | Multi-trait classification that preserves conflicts instead of hiding them. | `value: EmailDomainClassification` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainClassifier` | interface | Immutable classifier used by extraction and product-specific policy. | `value: EmailDomainClassifier` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainEvidence` | interface | Auditable evidence returned by the classifier. | `value: EmailDomainEvidence` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainRule` | interface | One static rule contributed by a known email provider. | `value: EmailDomainRule` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainRuleMatch` | type | Matching strategy used by a provider-owned domain rule. | `value: EmailDomainRuleMatch` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainTrait` | type | Independent facts supported by evidence about an email domain. | `value: EmailDomainTrait` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailRowDomain` | interface | Domain extraction result for one streamed source row. | `value: EmailRowDomain` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `extractEmailDomains` | function | Streams row-level company-domain candidates from already parsed CSV rows. | `extractEmailDomains(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizeEmailDomain` | function | Normalizes an email-domain value without applying website-specific policy. | `normalizeEmailDomain(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizeWebsiteHostname` | function | Normalizes a website or bare-hostname value to an ASCII hostname. | `normalizeWebsiteHostname(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PRIVACY_EMAIL_DOMAIN_RULES` | value | Provider-owned privacy alias domains that can be recognized from a hostname. | `PRIVACY_EMAIL_DOMAIN_RULES` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PUBLIC_EMAIL_DOMAIN_RULES` | value | High-confidence consumer mailbox domains maintained as reviewed utility data. | `PUBLIC_EMAIL_DOMAIN_RULES` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RowDomainCandidate` | interface | One normalized candidate found in a source row. | `value: RowDomainCandidate` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/email/classify
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `createEmailDomainClassifier` | function | Creates a runtime-neutral classifier from plain immutable domain data. | `createEmailDomainClassifier(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DEFAULT_EMAIL_DOMAIN_CLASSIFIER` | value | Shared default classifier for callers that do not need policy injection. | `DEFAULT_EMAIL_DOMAIN_CLASSIFIER` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/email/extract
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `extractEmailDomains` | function | Streams row-level company-domain candidates from already parsed CSV rows. | `extractEmailDomains(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/email/normalize
----------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `normalizeEmailDomain` | function | Normalizes an email-domain value without applying website-specific policy. | `normalizeEmailDomain(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizeWebsiteHostname` | function | Normalizes a website or bare-hostname value to an ASCII hostname. | `normalizeWebsiteHostname(...)` | `.agents/tests/public-api-repetition.test.ts:74` uses `normalizeWebsiteHostname`. |

Detected uses
~~~~~~~~~~~~~

`normalizeWebsiteHostname` appears in `.agents/tests/public-api-repetition.test.ts:74`:

~~~~ typescript
assert.equal(normalizeWebsiteHostname('https://www.Example.com/path'), 'example.com');
		assert.equal(normalizeWebsiteHostname('not a hostname'), undefined);

		assert.equal(resilience.circuitBreaker({ failureThreshold: 2 }).failureThreshold, 2);
~~~~

@utils/email/types
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `DomainSource` | interface | Exact provenance for one normalized hostname candidate. | `value: DomainSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DomainSourceKind` | type | How a hostname was extracted from a source value. | `value: DomainSourceKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainClassification` | interface | Multi-trait classification that preserves conflicts instead of hiding them. | `value: EmailDomainClassification` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainClassifier` | interface | Immutable classifier used by extraction and product-specific policy. | `value: EmailDomainClassifier` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainEvidence` | interface | Auditable evidence returned by the classifier. | `value: EmailDomainEvidence` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainRule` | interface | One static rule contributed by a known email provider. | `value: EmailDomainRule` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainRuleMatch` | type | Matching strategy used by a provider-owned domain rule. | `value: EmailDomainRuleMatch` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailDomainTrait` | type | Independent facts supported by evidence about an email domain. | `value: EmailDomainTrait` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmailRowDomain` | interface | Domain extraction result for one streamed source row. | `value: EmailRowDomain` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RowDomainCandidate` | interface | One normalized candidate found in a source row. | `value: RowDomainCandidate` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 33 public names across 5 package export targets. 1 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

