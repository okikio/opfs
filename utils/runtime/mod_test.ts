import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as runtime from './mod.ts';

describe('runtime definitions', () => {
	it('composes exact immutable definitions and documents them deterministically', () => {
		const Browser = runtime.define({ id: 'browser', description: 'Runs browser activities.' });
		const Analysis = runtime.define({ id: 'analysis', description: 'Runs analysis activities.' });
		const Runtimes = runtime.catalog('test.runtimes', { Browser, Analysis });
		expect(runtime.compose(Runtimes)).toEqual([Browser, Analysis]);
		expect(runtime.document(Runtimes)).toEqual([
			{ id: 'browser', description: 'Runs browser activities.' },
			{ id: 'analysis', description: 'Runs analysis activities.' },
		]);
	});

	it('rejects empty or unstable identifiers', () => {
		expect(() => runtime.define({ id: 'bad id', description: 'Invalid.' })).toThrow(TypeError);
		expect(() => runtime.define({ id: 'valid', description: '   ' })).toThrow(TypeError);
	});
});
