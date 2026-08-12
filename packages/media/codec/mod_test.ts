import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { AudioCodecSchema, VideoCodecSchema, getKind } from './mod.ts';

describe('@media/codec', () => {
	it('validates and classifies known codecs', () => {
		expect(VideoCodecSchema.parse('avc')).toBe('avc');
		expect(AudioCodecSchema.parse('aac')).toBe('aac');
		expect(getKind('av1')).toBe('video');
		expect(getKind('opus')).toBe('audio');
	});
});
