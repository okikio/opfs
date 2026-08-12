import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { FormatSchema, getExtension, getMime } from './mod.ts';

describe('@media/format', () => {
	it('maps a format to standard file metadata', () => {
		expect(FormatSchema.parse('mp4')).toBe('mp4');
		expect(getExtension('mp4')).toBe('.mp4');
		expect(getMime('webm')).toContain('webm');
	});
});
