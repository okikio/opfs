import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { SourceSchema, isRandom } from './mod.ts';

describe('@media/source', () => {
	it('applies bounded network defaults', () => {
		const source = SourceSchema.parse({ kind: 'url', url: 'https://example.com/video.mp4' });
		expect(source.parallelism).toBe(2);
		expect(source.cacheBytes).toBe(8 * 1024 * 1024);
		expect(isRandom(source)).toBe(true);
	});
});
