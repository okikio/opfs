import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as result from './mod.ts';

describe('result', () => {
	it('narrows success and failure variants', () => {
		const success: result.Result<number, Error> = result.ok(4);
		expect(result.isOk(success) && success.value).toBe(4);
		const failure: result.Result<number, Error> = result.fail(new Error('nope'));
		expect(result.isFailure(failure) && failure.failure.message).toBe('nope');
	});

	it('matches both variants and unwraps success', () => {
		expect(result.match(result.ok(2), { ok: (value) => value * 2, failure: () => 0 })).toBe(4);
		expect(result.unwrap(result.ok('ready'))).toBe('ready');
	});

	it('throws the exact failure occurrence when unwrapping a failed result', () => {
		const failure = new Error('failed');
		expect(() => result.unwrap(result.fail(failure))).toThrow(failure);
	});
});
