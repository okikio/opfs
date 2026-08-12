import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import * as v from 'valibot';

import * as env from './valibot.ts';

describe('Valibot environment authoring', () => {
	it('accepts a bare schema and reads native metadata actions', () => {
		const Port = v.pipe(
			v.string(),
			v.title('HTTP port'),
			v.description('Port used by the service listener.'),
			v.examples(['8787']),
		);
		const definition = env.define({ PORT: Port });

		expect(definition.parseSync({ PORT: '4321' })).toEqual({ PORT: '4321' });
		expect(env.manifest(definition).variables).toEqual([{
			key: 'PORT',
			kind: 'variable',
			title: 'HTTP port',
			description: 'Port used by the service listener.',
			example: '8787',
		}]);
	});

	it('reads custom metadata and applies explicit overrides', () => {
		const Region = v.pipe(
			v.string(),
			v.description('Generic region description.'),
			v.metadata({ availability: ['staging', 'production'] }),
		);
		const definition = env.define({
			REGION: env.variable(Region, {
				description: 'Region used by this worker.',
			}),
		});

		expect(env.manifest(definition).variables[0]).toEqual({
			key: 'REGION',
			kind: 'variable',
			description: 'Region used by this worker.',
			availability: ['staging', 'production'],
		});
	});

	it('keeps secret classification explicit and suppresses native examples', () => {
		const Token = v.pipe(
			v.string(),
			v.description('Provider API token.'),
			v.examples(['do-not-project']),
		);
		const definition = env.define({ TOKEN: env.secret(Token) });

		expect(env.manifest(definition).secrets).toEqual([{
			key: 'TOKEN',
			kind: 'secret',
			description: 'Provider API token.',
		}]);
	});

	it('reuses one canonical field for a repeated bare schema object', () => {
		const Mode = v.pipe(v.string(), v.description('Service mode.'));
		const first = env.define({ MODE: Mode });
		const second = env.define({ MODE: Mode });

		expect(env.compose(first, second).fields.MODE).toBe(first.fields.MODE);
	});
});
