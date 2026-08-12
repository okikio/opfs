import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { CatalogEntryIdentity } from '@utils/catalog';

import * as middleware from './mod.ts';

const Authentication = middleware.context<{ readonly actorId: string }>()({
	id: 'identity.authentication',
	description: 'Verified authentication.',
});
const Organization = middleware.context<{ readonly organizationId: string }>()({
	id: 'identity.organization',
	description: 'Active organization.',
});

const ResolveOrganization = middleware.define({
	id: 'identity.resolve-organization',
	description: 'Resolve the active organization.',
	requires: [Authentication],
	provides: [Organization],
});
const Diagnostics = middleware.define({ id: 'server.diagnostics', description: 'Request diagnostics.' });

describe('middleware composition', () => {
	it('preserves deterministic lanes and authored order', () => {
		const plan = middleware.plan([
			middleware.wholeRequest(Diagnostics),
			ResolveOrganization,
			middleware.aroundOperation(Diagnostics),
		]);
		expect(plan.wholeRequest).toEqual([Diagnostics]);
		expect(plan.afterValidation).toEqual([ResolveOrganization]);
		expect(plan.aroundOperation).toEqual([Diagnostics]);
	});

	it('rejects unavailable context requirements at startup', () => {
		const invalid = middleware.validate([ResolveOrganization]);
		expect(invalid.valid).toBe(false);
		if (!invalid.valid) expect(invalid.issues[0]?.code).toBe('missing-required-context');
		const valid = middleware.validate([ResolveOrganization], [Authentication]);
		expect(valid.valid).toBe(true);
	});

	it('binds runtime behavior to the exact middleware definition', () => {
		const binding = middleware.handler(ResolveOrganization, async (_context, next) => await next());
		expect(binding.definition).toBe(ResolveOrganization);
	});

	it('can make one exact runtime handler execute once per Request without skipping the onion', async () => {
		const definition = middleware.define({ id: 'request.once', description: 'Once per request.' });
		let calls = 0;
		const binding = middleware.once(middleware.handler(definition, async (_context, next) => {
			calls += 1;
			return await next();
		}));
		const request = new Request('https://example.test');
		const context = {
			request,
			host: undefined,
			values: { has: () => false, get: () => { throw new Error('missing'); }, set: () => undefined },
			resources: { has: () => false, get: async () => { throw new Error('missing'); } },
			ctx: {} as never,
		};
		let continuations = 0;
		await binding.handle(context, async () => { continuations += 1; });
		await binding.handle(context, async () => { continuations += 1; });
		expect(calls).toBe(1);
		expect(continuations).toBe(2);
		await binding.handle({ ...context, request: new Request('https://example.test') }, async () => undefined);
		expect(calls).toBe(2);
	});

	it('snapshots nested contribution arrays at definition time', () => {
		const read = Object.freeze({ id: 'widgets:read', kind: 'permission', description: 'Read widgets.' });
		const write = Object.freeze({ id: 'widgets:write', kind: 'permission', description: 'Write widgets.' });
		const permissions: CatalogEntryIdentity[][] = [[read]];
		const definition = middleware.define({
			id: 'widgets.policy',
			description: 'Widget policy.',
			permissions,
		});
		permissions[0]?.push(write);
		expect(definition.permissions).toEqual([[read]]);
	});
});
