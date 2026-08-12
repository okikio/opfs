import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as env from './standard.ts';

const RequiredString: StandardSchemaV1<unknown, string> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate(value) {
			return typeof value === 'string' && value.length > 0
				? { value }
				: { issues: [{ message: 'Expected a non-empty string.' }] };
		},
	},
};

const DatabaseUrl = env.secret(RequiredString, {
	description: 'PostgreSQL connection string.',
});
const DatabaseEnvironment = env.environment({ DATABASE_URL: DatabaseUrl });

describe('Standard Schema environment definitions', () => {
	it('keeps definition and source selection separate', () => {
		const definition = env.define({
			DATABASE_URL: DatabaseUrl,
			PORT: env.variable(RequiredString, {
				description: 'HTTP listener port.',
				example: '8787',
			}),
		});

		const values = definition.parseSync(env.merge(env.record({
			DATABASE_URL: 'postgres://localhost/kaiju',
			PORT: '8787',
		}), { PORT: '4321' }));

		expect(values).toEqual({
			DATABASE_URL: 'postgres://localhost/kaiju',
			PORT: '4321',
		});
	});

	it('collects every field issue in one validation pass', () => {
		const definition = env.environment({
			FIRST: env.variable(RequiredString, { description: 'First value.' }),
			SECOND: env.variable(RequiredString, { description: 'Second value.' }),
		});

		const result = definition.safeParseSync({});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.issues.map((issue) => issue.key)).toEqual(['FIRST', 'SECOND']);
	});

	it('supports asynchronous Standard Schema validators through parse()', async () => {
		const AsyncUppercase: StandardSchemaV1<unknown, string> = {
			'~standard': {
				version: 1,
				vendor: 'async-test',
				async validate(value) {
					await Promise.resolve();
					return typeof value === 'string'
						? { value: value.toUpperCase() }
						: { issues: [{ message: 'Expected a string.' }] };
				},
			},
		};
		const definition = env.environment({
			VALUE: env.variable(AsyncUppercase, { description: 'Asynchronously normalized value.' }),
		});

		await expect(definition.parse({ VALUE: 'kaiju' })).resolves.toEqual({ VALUE: 'KAIJU' });
		expect(() => definition.parseSync({ VALUE: 'kaiju' })).toThrow(/validates asynchronously/);
	});

	it('deduplicates the same canonical field across definitions', () => {
		const worker = env.environment({ DATABASE_URL: DatabaseUrl });
		const composed = env.compose(DatabaseEnvironment, worker);

		expect(composed.keys).toEqual(['DATABASE_URL']);
		expect(composed.fields.DATABASE_URL).toBe(DatabaseUrl);
	});

	it('rejects a different field object that reuses the same key', () => {
		const conflicting = env.environment({
			DATABASE_URL: env.secret(RequiredString, { description: 'Conflicting declaration.' }),
		});

		expect(() => env.compose(DatabaseEnvironment, conflicting)).toThrow(env.EnvironmentError);
	});

	it('supports prototype-shaped definition keys without false conflicts', () => {
		const fields = Object.fromEntries([
			['__proto__', env.variable(RequiredString, { description: 'Prototype-shaped key.' })],
			['constructor', env.variable(RequiredString, { description: 'Constructor-shaped key.' })],
		]);
		const definition = env.environment(fields);

		expect(Object.getPrototypeOf(definition.fields)).toBeNull();
		expect(definition.parseSync(Object.fromEntries([
			['__proto__', 'first'],
			['constructor', 'second'],
		]))).toEqual(Object.fromEntries([
			['__proto__', 'first'],
			['constructor', 'second'],
		]));
	});
});

describe('environment projections and requirements', () => {
	it('separates variables from secrets without leaking secret examples', () => {
		const definition = env.environment({
			PORT: env.variable(RequiredString, {
				title: 'HTTP port',
				description: 'Port used by the HTTP listener.',
				example: '8787',
			}),
			DATABASE_URL: DatabaseUrl,
		});
		const requirement = env.requirement('postgres', definition, {
			DATABASE_URL: 'Create the database connection.',
		});

		expect(env.manifest(definition)).toEqual({
			version: 1,
			variables: [{
				key: 'PORT',
				kind: 'variable',
				title: 'HTTP port',
				description: 'Port used by the HTTP listener.',
				example: '8787',
			}],
			secrets: [{
				key: 'DATABASE_URL',
				kind: 'secret',
				description: 'PostgreSQL connection string.',
			}],
		});
		expect(env.example(definition)).toContain('DATABASE_URL=<secret>');
		expect(env.requirementReport(definition, [requirement])).toContainEqual(
			expect.objectContaining({
				key: 'DATABASE_URL',
				requiredBy: [{
					requirementId: 'postgres',
					reason: 'Create the database connection.',
				}],
			}),
		);
	});

	it('does not join unrelated requirements through a shared string key', () => {
		const OtherDatabaseUrl = env.secret(RequiredString, {
			description: 'Unrelated database connection string.',
		});
		const other = env.environment({ DATABASE_URL: OtherDatabaseUrl });
		const requirement = env.requirement('other-database', other, {
			DATABASE_URL: 'Create an unrelated connection.',
		});

		expect(env.requirementReport(DatabaseEnvironment, [requirement])).toEqual([{
			key: 'DATABASE_URL',
			kind: 'secret',
			description: 'PostgreSQL connection string.',
			requiredBy: [],
		}]);
	});
});
