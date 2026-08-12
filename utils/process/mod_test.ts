import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as context from '@utils/context';
import * as process from './mod.ts';

const decoder = new TextDecoder();

describe('Deno child process ownership', () => {
	it('captures bounded stdout and stderr for finite execution', async () => {
		await using ctx = context.create({ id: 'process-capture' });
		const exit = await process.exec(ctx, {
			command: Deno.execPath(),
			arguments: ['eval', 'console.log("output"); console.error("diagnostic");'],
			stdout: { type: 'capture', maximumBytes: 1024 },
			stderr: { type: 'capture', maximumBytes: 1024 },
		});
		expect(exit.success).toBe(true);
		expect(decoder.decode(exit.stdout)).toBe('output\n');
		expect(decoder.decode(exit.stderr)).toBe('diagnostic\n');
	});

	it('writes piped input before waiting for completion', async () => {
		await using ctx = context.create({ id: 'process-input' });
		const exit = await process.exec(ctx, {
			command: Deno.execPath(),
			arguments: ['eval', 'const text = await new Response(Deno.stdin.readable).text(); console.log(text.toUpperCase());'],
			stdin: 'piped',
			input: 'hello',
			stdout: { type: 'capture', maximumBytes: 1024 },
			stderr: { type: 'capture', maximumBytes: 1024 },
		});
		expect(decoder.decode(exit.stdout)).toBe('HELLO\n');
	});

	it('fails bounded capture when output exceeds its limit', async () => {
		await using ctx = context.create({ id: 'process-limit' });
		await expect(process.exec(ctx, {
			command: Deno.execPath(),
			arguments: ['eval', 'console.log("x".repeat(2048));'],
			stdout: { type: 'capture', maximumBytes: 64 },
			stderr: { type: 'discard' },
			shutdown: { grace: { milliseconds: 10 }, force: { seconds: 1 } },
		})).rejects.toThrow(process.OutputLimitError);
	});

	it('stops on parent cancellation and makes repeated stop calls harmless', async () => {
		const controller = new AbortController();
		await using ctx = context.create({ id: 'process-cancel', signal: controller.signal });
		const child = await process.start(ctx, {
			command: Deno.execPath(),
			arguments: ['eval', 'await new Promise(() => {});'],
			stdout: { type: 'discard' },
			stderr: { type: 'discard' },
			shutdown: { grace: { milliseconds: 10 }, force: { seconds: 1 } },
		});
		controller.abort('cancel process');
		await Promise.all([child.stop(), child.stop(), child[Symbol.asyncDispose]()]);
		const exit = await child.wait();
		expect(exit.success).toBe(false);
	});

	it('rejects unsupported process-tree guarantees instead of silently degrading them', async () => {
		await using ctx = context.create({ id: 'process-tree' });
		await expect(process.start(ctx, {
			command: Deno.execPath(),
			tree: 'posix-process-group',
		})).rejects.toThrow(process.UnsupportedTreeModeError);
	});
});
