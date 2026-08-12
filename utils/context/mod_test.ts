import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as context from './mod.ts';

describe('context', () => {
	it('inherits parent cancellation and preserves its cause', () => {
		const parentController = new AbortController();
		using parent = context.create({ id: 'request-1', signal: parentController.signal });
		using child = context.child(parent);
		parentController.abort('client disconnected');
		expect(context.cause(child)).toBe('client disconnected');
		expect(() => context.check(child)).toThrow(context.ContextCancelledError);
	});

	it('does not allow a child deadline or timeout to exceed its parent deadline', () => {
		const clock = new context.TestClock('2026-08-05T00:00:00Z');
		using parent = context.create({
			id: 'request-2',
			clock,
			deadline: Temporal.Instant.from('2026-08-05T00:00:05Z'),
		});
		using later = context.deadline(parent, Temporal.Instant.from('2026-08-05T00:00:30Z'));
		using timeout = context.timeout(parent, { seconds: 30 });
		expect(later.deadline?.toString()).toBe('2026-08-05T00:00:05Z');
		expect(timeout.deadline?.toString()).toBe('2026-08-05T00:00:05Z');
	});

	it('round-trips serializable fields while creating a new local signal', () => {
		const clock = new context.TestClock('2026-08-05T00:00:00Z');
		using original = context.create({ id: 'request-3', traceId: 'trace-3', clock });
		const snapshot = context.snapshot(original);
		using restored = context.restore(snapshot, { clock });
		expect(restored.id).toBe('request-3');
		expect(restored.traceId).toBe('trace-3');
		expect(restored.signal).not.toBe(original.signal);
	});

	it('clears owned lifecycle state and resolves closed exactly once', async () => {
		const owned = context.create({ id: 'request-4' });
		owned[Symbol.dispose]();
		owned[Symbol.dispose]();
		await owned.closed;
		expect(owned.signal.aborted).toBe(true);
	});
});
