import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { TrackSchema, selectVideo } from './mod.ts';

describe('@media/track', () => {
	it('selects the largest video track', () => {
		const tracks = [
			TrackSchema.parse({ id: '720', kind: 'video', codec: 'avc', width: 1280, height: 720 }),
			TrackSchema.parse({ id: '1080', kind: 'video', codec: 'avc', width: 1920, height: 1080 }),
		];
		expect(selectVideo(tracks)?.id).toBe('1080');
	});
});
