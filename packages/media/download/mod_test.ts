import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { DownloadSchema } from './mod.ts';

describe('@media/download', () => {
	it('validates direct download input', () => {
		expect(DownloadSchema.parse({ url: 'https://example.com/file.mp4' }).headers).toEqual({});
	});
});
