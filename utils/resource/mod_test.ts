import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as context from '@utils/context';
import * as env from '@utils/env';
import * as resource from './mod.ts';

function createTestContext(): context.Owned {
	return context.create({ id: crypto.randomUUID(), clock: new context.TestClock() });
}

describe('resource definitions and collections', () => {
	it('rejects dependency cycles and missing implementations before runtime creation', () => {
		const dependenciesA: Record<string, resource.Definition> = Object.create(null);
		const dependenciesB: Record<string, resource.Definition> = Object.create(null);
		const A = Object.freeze({ kind: 'resource', id: 'test.a', description: 'A.', dependencies: dependenciesA }) as resource.Definition;
		const B = Object.freeze({ kind: 'resource', id: 'test.b', description: 'B.', dependencies: dependenciesB }) as resource.Definition;
		dependenciesA.b = B;
		dependenciesB.a = A;

		const cycle = resource.validate([A, B]);
		expect(cycle.valid).toBe(false);
		if (!cycle.valid) expect(cycle.issues.some((issue) => issue.code === 'dependency-cycle')).toBe(true);

		const Database = resource.define<{ readonly connected: true }>()({
			id: 'test.database',
			description: 'Database.',
		});
		const Repository = resource.define<{ readonly database: { readonly connected: true } }>()({
			id: 'test.repository',
			description: 'Repository.',
			dependencies: { database: Database },
		});
		const RepositoryImplementation = resource.implement(Repository, {
			create({ dependencies }) {
				return { database: dependencies.database };
			},
		});
		const coverage = resource.validate(resource.implementations(RepositoryImplementation));
		expect(coverage.valid).toBe(false);
		if (!coverage.valid) expect(coverage.issues.some((issue) => issue.code === 'missing-implementation')).toBe(true);
	});

	it('deduplicates concurrent lazy acquisition and retries after failure', async () => {
		await using ctx = createTestContext();
		const Value = resource.define<{ readonly sequence: number }>()({
			id: 'test.value',
			description: 'Retryable value.',
		});
		let sequences = 0;
		const implementation = resource.implement(Value, {
			async create() {
				sequences += 1;
				await Promise.resolve();
				if (sequences === 1) throw new Error('first acquisition failed');
				return { sequence: sequences };
			},
		});
		await using collection = resource.create(resource.implementations(implementation), { host: {}, ctx });
		await expect(collection.get(Value)).rejects.toThrow('first acquisition failed');
		const [first, second] = await Promise.all([collection.get(Value), collection.get(Value)]);
		expect(first).toBe(second);
		expect(first.sequence).toBe(2);
		expect(sequences).toBe(2);
	});

	it('projects environment fields and passes the exact host and collection context', async () => {
		await using ctx = createTestContext();
		const StringSchema = Object.freeze({
			'~standard': Object.freeze({
				version: 1 as const,
				vendor: 'test',
				validate(value: unknown) {
					return typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string.' }] };
				},
			}),
		});
		const environment = env.define({
			DATABASE_URL: env.variable(StringSchema, { description: 'Database URL.' }),
		});
		const requirement = env.requirement('test.resource-environment', environment, {
			DATABASE_URL: 'Connect to the test database.',
		});
		const Database = resource.define<Readonly<{ readonly url: string; readonly hostName: string; readonly requestId: string }>>()({
			id: 'test.projected-database',
			description: 'Database with projected environment.',
			environment: requirement,
		});
		const host = Object.freeze({ name: 'test-host' });
		const implementation = resource.implement<typeof Database, resource.Value<typeof Database>, typeof host>(Database, {
			create({ environment, host: receivedHost, ctx: receivedContext }) {
				return { url: environment.DATABASE_URL, hostName: receivedHost.name, requestId: receivedContext.id };
			},
		});
		await using collection = resource.create(resource.implementations(implementation), {
			environment: { DATABASE_URL: 'postgres://example', UNUSED: 'not projected' },
			host,
			ctx,
		});
		expect(await collection.get(Database)).toEqual({
			url: 'postgres://example',
			hostName: 'test-host',
			requestId: ctx.id,
		});
	});

	it('disposes acquired resources in reverse dependency order', async () => {
		await using ctx = createTestContext();
		const events: string[] = [];
		const Database = resource.define<AsyncDisposable>()({ id: 'test.database-disposal', description: 'Database.' });
		const Repository = resource.define<AsyncDisposable>()({
			id: 'test.repository-disposal',
			description: 'Repository.',
			dependencies: { database: Database },
		});
		const database = resource.implement(Database, {
			create() {
				return { async [Symbol.asyncDispose]() { events.push('database'); } };
			},
		});
		const repository = resource.implement(Repository, {
			create() {
				return { async [Symbol.asyncDispose]() { events.push('repository'); } };
			},
		});
		const collection = resource.create(resource.implementations(database, repository), { host: {}, ctx });
		await collection.get(Repository);
		await collection[Symbol.asyncDispose]();
		expect(events).toEqual(['repository', 'database']);
		await expect(collection.get(Database)).rejects.toThrow(resource.CollectionDisposedError);
		await collection[Symbol.asyncDispose]();
	});

	it('cancels in-flight acquisition when the collection is disposed', async () => {
		await using ctx = createTestContext();
		const Slow = resource.define<never>()({ id: 'test.slow', description: 'Slow resource.' });
		const implementation = resource.implement(Slow, {
			create({ ctx }) {
				return new Promise<never>((_resolve, reject) => {
					ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
				});
			},
		});
		const collection = resource.create(resource.implementations(implementation), { host: {}, ctx });
		const acquisition = collection.get(Slow);
		const disposal = collection[Symbol.asyncDispose]();
		await expect(acquisition).rejects.toThrow(resource.CollectionDisposedError);
		await disposal;
	});

	it('disposes a value that finishes creation after collection disposal begins', async () => {
		await using ctx = createTestContext();
		const events: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => release = resolve);
		const Late = resource.define<AsyncDisposable>()({ id: 'test.late', description: 'Late resource.' });
		const implementation = resource.implement(Late, {
			async create() {
				await gate;
				return { async [Symbol.asyncDispose]() { events.push('late-disposed'); } };
			},
		});
		const collection = resource.create(resource.implementations(implementation), { host: {}, ctx });
		const acquisition = collection.get(Late);
		const disposal = collection[Symbol.asyncDispose]();
		release();
		await expect(acquisition).rejects.toThrow(resource.CollectionDisposedError);
		await disposal;
		expect(events).toEqual(['late-disposed']);
	});
});
