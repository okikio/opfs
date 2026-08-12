import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { PathSchema, supports } from './mod.ts';

describe('@media/storage', () => {
	it('rejects parent traversal', () => {
		expect(PathSchema.safeParse('../secret').success).toBe(false);
		expect(typeof supports()).toBe('boolean');
	});
});
