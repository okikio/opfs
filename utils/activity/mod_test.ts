import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as context from '@utils/context';
import * as failure from '@utils/failure';
import * as resource from '@utils/resource';
import * as runtime from '@utils/runtime';
import * as workflow from '@utils/workflow';
import * as activity from './mod.ts';

function schema<Output>(validate: (value: unknown) => Output): StandardSchemaV1<unknown, Output> {
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

const InputSchema = schema((value) => {
	if (typeof value !== 'object' || value === null || typeof (value as { value?: unknown }).value !== 'string') {
		throw new TypeError('Expected a value string.');
	}
	return { value: (value as { value: string }).value };
});
const ResultSchema = schema((value) => {
	if (typeof value !== 'object' || value === null || typeof (value as { stored?: unknown }).stored !== 'boolean') {
		throw new TypeError('Expected a stored boolean.');
	}
	return { stored: (value as { stored: boolean }).stored };
});
const FailureData = schema((value) => {
	if (typeof value !== 'object' || value === null || typeof (value as { reason?: unknown }).reason !== 'string') {
		throw new TypeError('Expected a reason string.');
	}
	return { reason: (value as { reason: string }).reason };
});

const Browser = runtime.define({ id: 'browser', description: 'Runs browser activities.' });
const Analysis = runtime.define({ id: 'analysis', description: 'Runs analysis activities.' });
const Store = resource.define<{ readonly save(value: string): Promise<void> }>()({
	id: 'test.store',
	description: 'Stores values.',
});
const StoreUnavailable = failure.define({
	id: 'test.store-unavailable',
	description: 'The store is unavailable.',
	data: FailureData,
});
const StoreValue = activity.define({
	id: 'test.store-value',
	version: '1',
	description: 'Stores one value.',
	input: InputSchema,
	result: ResultSchema,
	failures: [StoreUnavailable],
	runtimes: [Browser],
	resources: [Store],
});

function resolver(store: resource.Value<typeof Store>): resource.Resolver<typeof Store> {
	return Object.freeze({
		has(definition) { return definition === Store; },
		async get(definition) {
			if (definition !== Store) throw new resource.MissingImplementationError(definition);
			return store as resource.Value<typeof definition>;
		},
	});
}

describe('activity definitions and execution', () => {
	it('uses the activity version as part of its durable definition identity and documentation', () => {
		expect(StoreValue.version).toBe('1');
		expect(activity.document([StoreValue])).toMatchObject([{ id: 'test.store-value', version: '1' }]);
		expect(() => activity.define({
			id: 'test.invalid-version',
			version: 'not valid!',
			input: InputSchema,
			result: ResultSchema,
		})).toThrow(TypeError);
	});

	it('creates a lazy activity command without starting external work', () => {
		const operation = activity.run(StoreValue, { value: 'example' }, { key: 'store:example' });
		const iterator = operation[Symbol.iterator]();
		const step = iterator.next();
		expect(step.done).toBe(false);
		if (!step.done) expect(step.value).toMatchObject({
			category: 'command',
			type: 'activity',
			activity: StoreValue,
			input: { value: 'example' },
			key: 'store:example',
		});
	});

	it('executes a concrete implementation with validated input and a narrowed resource resolver', async () => {
		await using ctx = context.create({ id: 'activity-parent', clock: new context.TestClock() });
		const values: string[] = [];
		const implementation = activity.implement(StoreValue, {
			runtime: Browser,
			async execute(ctx) {
				const store = await ctx.resources.get(Store);
				await store.save(ctx.input.value);
				ctx.heartbeat({ completed: 1 });
				return { stored: true };
			},
		});
		const heartbeats: unknown[] = [];
		const output = await activity.execute({
			implementation,
			input: { value: 'example' },
			ctx,
			resources: resolver({ async save(value) { values.push(value); } }),
			jobId: 'job:store-example',
			attempt: 1,
			heartbeat(value) { heartbeats.push(value); },
		});
		expect(output).toEqual({ stored: true });
		expect(values).toEqual(['example']);
		expect(heartbeats).toEqual([{ completed: 1 }]);
	});

	it('accepts deterministic workflow instruction paths as activity job identities', async () => {
		await using ctx = context.create({ id: 'activity-workflow-path', clock: new context.TestClock() });
		const implementation = activity.implement(StoreValue, {
			runtime: Browser,
			execute: async (activityContext) => ({ stored: activityContext.jobId.includes('/attempt:2/') }),
		});
		const jobId = 'test.workflow@1/finalize:parallel/persist%3Aimport/attempt:2/0:activity';
		const output = await activity.execute({
			implementation,
			input: { value: 'example' },
			ctx,
			resources: resolver({ async save() {} }),
			jobId,
			attempt: 2,
		});
		expect(output).toEqual({ stored: true });
	});

	it('rejects invalid input, invalid results, and disallowed runtimes', async () => {
		await using ctx = context.create({ id: 'activity-invalid', clock: new context.TestClock() });
		expect(() => activity.implement(StoreValue, {
			runtime: Analysis as never,
			execute: async () => ({ stored: true }),
		})).toThrow(activity.InvalidRuntimeError);
		const invalidResult = activity.implement(StoreValue, {
			runtime: Browser,
			execute: async () => ({ stored: 'yes' } as never),
		});
		await expect(activity.execute({
			implementation: invalidResult,
			input: { value: 'valid' },
			ctx,
			resources: resolver({ async save() {} }),
			jobId: 'job:invalid-result',
			attempt: 1,
		})).rejects.toThrow('Expected a stored boolean.');
		await expect(activity.execute({
			implementation: invalidResult,
			input: { value: 42 },
			ctx,
			resources: resolver({ async save() {} }),
			jobId: 'job:invalid-input',
			attempt: 1,
		})).rejects.toThrow('Expected a value string.');
		await expect(activity.execute({
			implementation: invalidResult,
			input: { value: 'valid' },
			ctx,
			resources: resolver({ async save() {} }),
			jobId: ' ',
			attempt: 1,
		})).rejects.toThrow('jobId must not be empty');
	});

	it('returns declared failures from activity.try and preserves unexpected faults', async () => {
		await using parent = context.create({ id: 'workflow-parent', clock: new context.TestClock() });
		const Workflow = workflow.define({
			id: 'test.activity-try',
			version: '1',
			input: InputSchema,
			result: schema((value) => value as activity.TryResult<typeof StoreValue>),
			activities: [StoreValue],
		});
		const implementation = workflow.implement(Workflow, function* (ctx) {
			return yield* activity.try(StoreValue, ctx.input);
		});
		await using workflowContext = await workflow.createContext({
			definition: Workflow,
			runId: 'run:activity-try',
			input: { value: 'example' },
			ctx: parent,
		});
		const occurrence = await failure.create(StoreUnavailable, { data: { reason: 'offline' } });
		const output = await workflow.execute({
			ctx: workflowContext,
			implementation,
			engine: workflow.live({
				async command(_ctx, command) {
					if (command.type === 'activity') return workflow.failed(occurrence);
					return workflow.fault(new Error('unexpected command'));
				},
			}),
		});
		expect(output).toEqual({ ok: false, failure: occurrence });
	});
});
