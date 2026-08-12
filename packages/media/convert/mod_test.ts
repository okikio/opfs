import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { validate } from './mod.ts';

describe('@media/convert', () => {
	it('applies hardware and transcode defaults', () => {
		const request = validate({ source: { kind: 'url', url: 'https://example.com/a.mp4' }, format: 'mp4', video: {} });
		expect(request.video?.hardware).toBe('no-preference');
		expect(request.video?.forceTranscode).toBe(false);
	});
});
