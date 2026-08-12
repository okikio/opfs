import type { EmailDomainRule } from '../types.ts'

/** High-confidence consumer mailbox domains maintained as reviewed utility data. */
export const PUBLIC_EMAIL_DOMAIN_RULES = Object.freeze([
	'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
	'yahoo.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
	'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'fastmail.com', 'fastmail.fm',
	'aol.com', 'gmx.com', 'gmx.net', 'mail.com', 'hey.com', 'qq.com', '163.com',
	'126.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'naver.com', 'web.de', 'tuta.com',
	'tuta.io', 'tutanota.com', 'tutanota.de', 'tutamail.com',
].map((domain) => Object.freeze({ trait: 'public-mailbox', provider: 'Public mailbox provider', domain, match: 'exact' })) satisfies readonly EmailDomainRule[])

/**
 * Provider-owned privacy alias domains that can be recognized from a hostname.
 *
 * Custom domains and self-hosted installations remain intentionally
 * undetectable from a static list. Unknown therefore never means corporate.
 */
export const PRIVACY_EMAIL_DOMAIN_RULES = Object.freeze([
	{ trait: 'privacy-relay', provider: 'Apple Hide My Email', domain: 'privaterelay.appleid.com', match: 'exact' },
	{ trait: 'privacy-relay', provider: 'Firefox Relay', domain: 'mozmail.com', match: 'suffix' },
	{ trait: 'privacy-relay', provider: 'SimpleLogin', domain: 'simplelogin.co', match: 'suffix' },
	{ trait: 'privacy-relay', provider: 'SimpleLogin', domain: 'aleeas.com', match: 'suffix' },
	{ trait: 'privacy-relay', provider: 'addy.io', domain: 'addy.io', match: 'suffix' },
	{ trait: 'privacy-relay', provider: 'addy.io', domain: 'anonaddy.me', match: 'exact' },
	{ trait: 'privacy-relay', provider: 'DuckDuckGo Email Protection', domain: 'duck.com', match: 'exact' },
] as const satisfies readonly EmailDomainRule[])
