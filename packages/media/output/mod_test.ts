import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { createMemory } from './mod.ts';

describe('@media/output', () => {
	it('supports positional rewrites', async () => {
		const writer = createMemory(16);
		await writer.write({ position: 0, data: new Uint8Array([1, 2, 3]) });
		await writer.write({ position: 1, data: new Uint8Array([9]) });
		expect([...writer.get()]).toEqual([1, 9, 3]);
	});
});
