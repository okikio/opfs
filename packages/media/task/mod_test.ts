import { describe, it } from 'node:test';
import { expect } from '@std/expect';
import { create } from './mod.ts';

describe('@media/task', () => {
	it('keeps terminal completion separate from current state', async () => {
		const task = create(async (_signal, set) => { set({ status: 'running', phase: 'convert', ratio: 0 }); return 42; });
		expect(await task.done).toBe(42);
		expect(task.getState().status).toBe('running');
	});
});
