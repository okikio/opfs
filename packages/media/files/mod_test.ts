import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { supports } from './mod.ts';

describe('@media/files', () => {
	it('reports browser support without throwing in Node', () => {
		expect(typeof supports()).toBe('boolean');
	});
});
