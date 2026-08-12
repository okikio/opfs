import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { create } from './mod.ts';

describe('@media/plan', () => {
	it('prefers copy, then remux, then transcode', () => {
		expect(create({ format: 'mp4', sourceFormat: 'mp4' }).operation).toBe('copy');
		expect(create({ format: 'mp4', sourceFormat: 'mkv' }).operation).toBe('remux');
		expect(create({ format: 'mp4', sourceFormat: 'mp4', changes: true }).operation).toBe('transcode');
	});
});
