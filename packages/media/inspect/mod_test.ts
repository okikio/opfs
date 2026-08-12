import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { inspect } from './mod.ts';

describe('@media/inspect', () => {
	it('preserves explicit inspection depth', async () => {
		const result = await inspect({ kind: 'url', url: 'https://example.com/a.mp4', parallelism: 2, cacheBytes: 1024 }, 'support');
		expect(result).toEqual({ sourceKind: 'url', depth: 'support' });
	});
});
