import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expect } from '@std/expect';
import { describe, it } from 'node:test';

import * as context from '@utils/context';
import * as workflow from './mod.ts';

function testSchema<Output>(validate: (value: unknown) => Output): StandardSchemaV1<unknown, Output> {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1,
			vendor: 'test',
			validate(value: unknown) {
				try { return { value: validate(value) }; }
				catch (error) { return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }; }
			},
		}),
	});
}

const AnySchema = testSchema((value) => value);
const StringSchema = testSchema((value) => {
	if (typeof value !== 'string') throw new TypeError('Expected a string.');
	return value;
});

const TestActivity: workflow.ActivityReference = Object.freeze({
	kind: 'activity',
	id: 'test.operation',
	version: '1',
	input: AnySchema,
	result: AnySchema,
	failures: Object.freeze([]),
});

function operation<Value = unknown, Failure = unknown>(input: unknown, key?: string): workflow.Operation<Value, Failure> {
	return workflow.activity<Value, Failure>(TestActivity, input, key === undefined ? {} : { key });
}

function definition(result = StringSchema): workflow.Definition {
	return workflow.define({
		id: 'test.workflow',
		version: '1',
		input: AnySchema,
		result,
		activities: [TestActivity],
	});
}

async function execute(
	program: workflow.Implementation['program'],
	command: (ctx: workflow.Context, command: workflow.Command, path: string) => Promise<workflow.AnyCompletion>,
	result = StringSchema,
): Promise<unknown> {
	await using parent = context.create({ id: 'test-parent', clock: new context.TestClock() });
	const contract = definition(result);
	const implementation = workflow.implement(contract, program);
	await using ctx = await workflow.createContext({ definition: contract, runId: 'test-run', input: {}, ctx: parent });
	return await workflow.execute({ ctx, implementation, engine: workflow.live({ command }) });
}

function deferred<Value = void>(): Readonly<{
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
}> {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	const promise = new Promise<Value>((resolved) => resolve = resolved);
	return Object.freeze({ promise, resolve });
}

describe('workflow programming model', () => {
	it('creates lazy operations and does not start work before interpretation', () => {
		const value = operation({ value: 1 }, 'operation:one');
		const step = value[Symbol.iterator]().next();
		expect(step.done).toBe(false);
		if (!step.done) {
			expect(step.value).toMatchObject({
				category: 'command',
				type: 'activity',
				key: 'operation:one',
				input: { value: 1 },
			});
		}
	});

	it('uses deterministic sequential paths and lets programs catch declared failures', async () => {
		const paths: string[] = [];
		const expected = new Error('expected failure');
		const output = await execute(function* () {
			const first = yield* operation<string>('first');
			try {
				yield* operation('fail');
			} catch (error) {
				expect(error).toBe(expected);
			}
			const third = yield* operation<string>('third', 'stable-third');
			return `${first}:${third}`;
		}, async (_ctx, command, path) => {
			paths.push(path);
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			if (command.input === 'fail') return workflow.failed(expected);
			return workflow.success(command.input);
		});
		expect(output).toBe('first:third');
		expect(paths).toEqual([
			'test.workflow@1/0:activity',
			'test.workflow@1/1:activity',
			'test.workflow@1/stable-third:activity',
		]);
	});

	it('passes every nested instruction through one lifecycle wrapper', async () => {
		const paths: string[] = [];
		await using parent = context.create({ id: 'instruction-wrapper', clock: new context.TestClock() });
		const contract = definition();
		const implementation = workflow.implement(contract, function* () {
			const values = yield* workflow.parallel({
				first: operation<string>('first'),
				second: workflow.retry(operation<string, Error>('second'), { maximumAttempts: 1 }),
			});
			return `${values.first}:${values.second}`;
		});
		await using ctx = await workflow.createContext({ definition: contract, runId: 'instruction-wrapper-run', input: {}, ctx: parent });
		const result = await workflow.execute({
			ctx,
			implementation,
			engine: workflow.live({
				async instruction({ path, next }) {
					paths.push(path);
					return await next();
				},
				async command(_ctx, command) {
					return command.type === 'activity'
						? workflow.success(command.input)
						: workflow.fault(new Error('unexpected command'));
				},
			}),
		});
		expect(result).toBe('first:second');
		expect(paths).toEqual([
			'test.workflow@1/0:parallel',
			'test.workflow@1/0:parallel/first/0:activity',
			'test.workflow@1/0:parallel/second/0:retry',
			'test.workflow@1/0:parallel/second/0:retry/attempt:1/0:activity',
		]);
	});

	it('preserves undefined as an explicit declared failure value', async () => {
		let rejected = false;
		try {
			await execute(function* () {
				yield* operation<never, undefined>('undefined-failure');
				return 'unreachable';
			}, async () => workflow.failed(undefined));
		} catch (error) {
			rejected = true;
			expect(error).toBe(undefined);
		}
		expect(rejected).toBe(true);
	});

	it('settles parallel branches without cancelling expected failures', async () => {
		const expected = new Error('branch failed');
		const output = await execute(function* () {
			const values = yield* workflow.parallel({
				first: operation<string>('first'),
				second: operation<string, Error>('fail'),
			}, { failure: 'settle' });
			return values.first.ok && !values.second.ok ? `${values.first.value}:${values.second.failure.message}` : 'invalid';
		}, async (_ctx, command) => {
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			return command.input === 'fail' ? workflow.failed(expected) : workflow.success(command.input);
		});
		expect(output).toBe('first:branch failed');
	});

	it('cancels and awaits active siblings before fail-fast parallel resumes', async () => {
		const blockerStarted = deferred();
		let blockerStopped = false;
		const expected = new Error('primary branch failure');
		const output = await execute(function* () {
			try {
				yield* workflow.parallel({
					blocker: operation('block'),
					failure: operation('fail'),
				});
			} catch (error) {
				expect(error).toBe(expected);
			}
			expect(blockerStopped).toBe(true);
			return 'cancelled and awaited';
		}, async (ctx, command) => {
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			if (command.input === 'block') {
				blockerStarted.resolve();
				if (!ctx.signal.aborted) await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
				blockerStopped = true;
				return workflow.cancelled(ctx.signal.reason);
			}
			await blockerStarted.promise;
			return workflow.failed(expected);
		});
		expect(output).toBe('cancelled and awaited');
	});

	it('returns a deterministic race winner and stops losing branches', async () => {
		const loserStarted = deferred();
		let loserStopped = false;
		const output = await execute(function* () {
			const winner = yield* workflow.race({
				loser: operation('lose'),
				winner: operation('win'),
			});
			expect(loserStopped).toBe(true);
			return `${String(winner.key)}:${String(winner.value)}`;
		}, async (ctx, command) => {
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			if (command.input === 'lose') {
				loserStarted.resolve();
				if (!ctx.signal.aborted) await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
				loserStopped = true;
				return workflow.cancelled(ctx.signal.reason);
			}
			await loserStarted.promise;
			return workflow.success('won');
		});
		expect(output).toBe('winner:won');
	});

	it('preserves mapped output order and rejects duplicate keys before execution', async () => {
		let commandCount = 0;
		const output = await execute(function* () {
			const values = yield* workflow.map([3, 1, 2], (value) => operation<number>(value), {
				concurrency: 2,
				key: (value) => String(value),
			});
			return values.join(',');
		}, async (_ctx, command) => {
			commandCount += 1;
			return command.type === 'activity' ? workflow.success(command.input) : workflow.fault(new Error('unexpected command'));
		});
		expect(output).toBe('3,1,2');
		expect(commandCount).toBe(3);
		expect(() => workflow.map([1, 1], (value) => operation(value), {
			concurrency: 1,
			key: (value) => String(value),
		})).toThrow('duplicate key');
	});

	it('uses a fresh retry path for each attempt and does not retry faults', async () => {
		const paths: string[] = [];
		let attempt = 0;
		const output = await execute(function* () {
			return String(yield* workflow.retry(operation<string, Error>('retry'), { maximumAttempts: 3, key: 'verification' }));
		}, async (_ctx, command, path) => {
			paths.push(path);
			attempt += 1;
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			return attempt < 3 ? workflow.failed(new Error(`failure ${attempt}`)) : workflow.success('verified');
		});
		expect(output).toBe('verified');
		expect(paths).toEqual([
			'test.workflow@1/verification:retry/attempt:1/0:activity',
			'test.workflow@1/verification:retry/attempt:2/0:activity',
			'test.workflow@1/verification:retry/attempt:3/0:activity',
		]);

		let faultAttempts = 0;
		await expect(execute(function* () {
			yield* workflow.retry(operation('fault'), { maximumAttempts: 3 });
			return 'unreachable';
		}, async () => {
			faultAttempts += 1;
			return workflow.fault(new Error('fault'));
		})).rejects.toThrow(workflow.FaultError);
		expect(faultAttempts).toBe(1);
	});

	it('runs registered cleanups in reverse order, including after cancellation', async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		await using parent = context.create({ id: 'cleanup-parent', signal: controller.signal, clock: new context.TestClock() });
		const contract = definition();
		const implementation = workflow.implement(contract, function* () {
			yield* workflow.ensure(operation('cleanup:first'));
			yield* workflow.ensure(operation('cleanup:second'));
			yield* operation('cancel');
			return 'unreachable';
		});
		await using ctx = await workflow.createContext({ definition: contract, runId: 'cleanup-run', input: {}, ctx: parent });
		await expect(workflow.execute({
			ctx,
			implementation,
			engine: workflow.live({
				async command(_ctx, command) {
					if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
					if (command.input === 'cancel') {
						controller.abort('cancelled by test');
						return workflow.cancelled('cancelled by test');
					}
					calls.push(String(command.input));
					return workflow.success(undefined);
				},
			}),
		})).rejects.toThrow(workflow.CancelledError);
		expect(calls).toEqual(['cleanup:second', 'cleanup:first']);
	});

	it('preserves primary and cleanup failures together', async () => {
		const primary = new Error('primary');
		const cleanup = new Error('cleanup');
		try {
			await execute(function* () {
				yield* workflow.ensure(operation('cleanup'));
				yield* operation('primary');
				return 'unreachable';
			}, async (_ctx, command) => {
				if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
				return command.input === 'primary' ? workflow.failed(primary) : workflow.failed(cleanup);
			});
			throw new Error('Expected workflow execution to fail.');
		} catch (error) {
			expect(error).toBeInstanceOf(workflow.CleanupFailureError);
			if (error instanceof workflow.CleanupFailureError) {
				expect(error.primary).toBe(primary);
				expect(error.cleanupFailures).toEqual([cleanup]);
			}
		}
	});

	it('keeps faults, cancellation, and continue-as-new outside program catch blocks while running finally', async () => {
		for (const mode of ['fault', 'cancel', 'continue'] as const) {
			let caught = false;
			let finalized = false;
			const execution = execute(function* () {
				try {
					if (mode === 'continue') yield* workflow.continue({ cursor: 2 });
					else yield* operation(mode);
				} catch {
					caught = true;
				} finally {
					finalized = true;
				}
				return 'unreachable';
			}, async (_ctx, command) => {
				if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
				return mode === 'fault' ? workflow.fault(new Error('fault')) : workflow.cancelled('cancelled');
			});
			if (mode === 'fault') await expect(execution).rejects.toThrow(workflow.FaultError);
			else if (mode === 'cancel') await expect(execution).rejects.toThrow(workflow.CancelledError);
			else await expect(execution).rejects.toThrow(workflow.ContinueAsNewError);
			expect(caught).toBe(false);
			expect(finalized).toBe(true);
		}
	});

	it('propagates continue-as-new through nested control instructions', async () => {
		const execution = execute(function* () {
			yield* workflow.parallel({ next: workflow.continue({ cursor: 4 }) });
			return 'unreachable';
		}, async () => workflow.fault(new Error('no leaf command expected')));
		await expect(execution).rejects.toThrow(workflow.ContinueAsNewError);
	});

	it('preserves an undefined finalizer failure beside the primary failure', async () => {
		try {
			await execute(function* () {
				try {
					yield* operation('primary');
				} finally {
					throw undefined;
				}
				return 'unreachable';
			}, async () => workflow.failed(new Error('primary')));
			throw new Error('Expected cleanup aggregation.');
		} catch (error) {
			expect(error).toBeInstanceOf(workflow.CleanupFailureError);
			if (error instanceof workflow.CleanupFailureError) expect(error.cleanupFailures).toEqual([undefined]);
		}
	});

	it('rejects non-durable command input before an instruction can enter history', () => {
		expect(() => operation(new Date())).toThrow(TypeError);
		expect(() => operation({ callback: () => undefined })).toThrow(TypeError);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => operation(cyclic)).toThrow('cycle');
		expect(() => workflow.continue(Promise.resolve('not durable'))).toThrow(TypeError);
	});

	it('creates stable instruction fingerprints from normalized data and changes them when durable identity changes', async () => {
		const firstStep = operation({ b: 2, a: 1 }, 'stable')[Symbol.iterator]().next();
		const secondStep = operation({ a: 1, b: 2 }, 'stable')[Symbol.iterator]().next();
		if (firstStep.done || secondStep.done) throw new Error('Expected activity instructions.');
		const first = await workflow.identifyInstruction(firstStep.value, 'test.workflow@1/stable:activity');
		const second = await workflow.identifyInstruction(secondStep.value, 'test.workflow@1/stable:activity');
		const moved = await workflow.identifyInstruction(secondStep.value, 'test.workflow@1/other:activity');
		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first.description.payload).toMatchObject({ activity: { id: 'test.operation', version: '1' } });
		expect(first.fingerprint === moved.fingerprint).toBe(false);
	});

	it('passes instruction identity through the lifecycle wrapper before command execution', async () => {
		const identities: workflow.InstructionIdentity[] = [];
		await using parent = context.create({ id: 'identity-wrapper', clock: new context.TestClock() });
		const contract = definition();
		const implementation = workflow.implement(contract, function* () {
			return yield* operation<string>('value', 'stable');
		});
		await using ctx = await workflow.createContext({ definition: contract, runId: 'identity-run', input: {}, ctx: parent });
		const output = await workflow.execute({
			ctx,
			implementation,
			engine: workflow.live({
				instruction: async ({ identity, next }) => {
					identities.push(identity);
					return await next();
				},
				command: async (_ctx, command) => workflow.success(command.type === 'activity' ? command.input : undefined),
			}),
		});
		expect(output).toBe('value');
		expect(identities.length).toBe(1);
		expect(identities[0]!.description.path).toBe('test.workflow@1/stable:activity');
		expect(identities[0]!.fingerprint.length).toBe(64);
	});

	it('persists deterministic retry delays as nested sleep instructions', async () => {
		const sleeps: string[] = [];
		let attempts = 0;
		const output = await execute(function* () {
			return yield* workflow.retry(operation<string, Error>('retry-me'), {
				maximumAttempts: 3,
				delay: 'PT0.1S',
				backoff: 2,
				maximumDelay: 'PT0.25S',
				jitter: 0,
			});
		}, async (_ctx, command) => {
			if (command.type === 'sleep') {
				sleeps.push(command.duration.toString());
				return workflow.success(Temporal.Instant.from('2026-08-08T00:00:00Z'));
			}
			if (command.type !== 'activity') return workflow.fault(new Error('unexpected command'));
			attempts += 1;
			return attempts < 3 ? workflow.failed(new Error(`attempt ${attempts}`)) : workflow.success('done');
		});
		expect(output).toBe('done');
		expect(sleeps).toEqual(['PT0.1S', 'PT0.2S']);
	});

	it('persists ensure registration before the workflow body advances and only accepts named durable cleanup commands', async () => {
		let bodyAdvanced = false;
		let sawRegistrationBeforeBody = false;
		const calls: string[] = [];
		await using parent = context.create({ id: 'ensure-registration', clock: new context.TestClock() });
		const contract = definition();
		const implementation = workflow.implement(contract, function* () {
			yield* workflow.ensure(operation('cleanup', 'cleanup-command'), { key: 'register-cleanup' });
			bodyAdvanced = true;
			return 'done';
		});
		await using ctx = await workflow.createContext({ definition: contract, runId: 'ensure-run', input: {}, ctx: parent });
		const output = await workflow.execute({
			ctx,
			implementation,
			engine: workflow.live({
				instruction: async ({ instruction, next }) => {
					if (instruction.type === 'ensure') sawRegistrationBeforeBody = !bodyAdvanced;
					return await next();
				},
				command: async (_ctx, command) => {
					if (command.type === 'activity') calls.push(String(command.input));
					return workflow.success(undefined);
				},
			}),
		});
		expect(output).toBe('done');
		expect(sawRegistrationBeforeBody).toBe(true);
		expect(calls).toEqual(['cleanup']);
		expect(() => workflow.ensure(workflow.sleep('PT1S'))).toThrow('must be one activity or child-workflow operation');
	});

	it('rejects raw instructions without a positive protocol version', () => {
		expect(() => workflow.operation({
			category: 'command',
			type: 'continue',
			input: {},
		} as unknown as workflow.Instruction)).toThrow('version');
	});

	it('rejects duplicate explicit instruction keys in one program scope', async () => {
		await expect(execute(function* () {
			yield* operation('first', 'same');
			yield* operation('second', 'same');
			return 'unreachable';
		}, async (_ctx, command) => workflow.success(command.type === 'activity' ? command.input : undefined))).rejects.toThrow('duplicate instruction key');
	});
});
