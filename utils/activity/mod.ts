/**
 * External-work definitions and host execution for iterator workflows.
 *
 * Definitions are import-safe. Concrete provider work begins only through
 * {@link execute}; {@link run} only creates a workflow instruction.
 *
 * @module
 */
import * as catalogCore from '@utils/catalog';
import type { DefinitionInput as CatalogDefinitionInput } from '@utils/catalog';
import * as contextCore from '@utils/context';
import * as resilienceCore from '@utils/resilience';
import * as resultCore from '@utils/result';
import * as schema from '@utils/schema';
import * as workflow from '@utils/workflow';

import type {
	ActivityCatalog,
	ActivitySelection,
	Context,
	Definition,
	DefinitionInput,
	Document,
	ExecuteOptions,
	Failures,
	Implementation,
	ImplementationInput,
	Input,
	Result,
	RunOperation,
	RunOptions,
	TryResult,
} from './types.ts';

/** Error raised when an implementation selects a runtime the activity does not allow. */
export class InvalidRuntimeError extends TypeError {
	constructor(activityId: string, runtimeId: string) {
		super(`Activity ${JSON.stringify(activityId)} does not allow runtime ${JSON.stringify(runtimeId)}.`);
		this.name = 'InvalidRuntimeError';
	}
}

/** Error raised when an activity throws an expected failure it did not declare. */
export class UndeclaredFailureError extends Error {
	readonly activity: Definition;
	readonly failure: import('@utils/failure').Occurrence;

	constructor(activity: Definition, failure: import('@utils/failure').Occurrence) {
		super(`Activity ${JSON.stringify(activity.id)} threw undeclared failure ${JSON.stringify(failure.definition.id)}.`, { cause: failure });
		this.name = 'UndeclaredFailureError';
		this.activity = activity;
		this.failure = failure;
	}
}

/** Define one immutable external-work contract. */
export function define<const Authoring extends DefinitionInput>(input: Authoring): Definition<Authoring> {
	assertIdentifier(input.id, 'activity');
	assertIdentifier(input.version, 'activity version');
	schema.assert(input.input, 'activity input schema');
	schema.assert(input.result, 'activity result schema');
	const runtimes = catalogCore.compose(input.runtimes);
	if (runtimes.length === 0) throw new TypeError('Activity definitions must allow at least one runtime.');
	const failures = input.failures === undefined ? Object.freeze([]) : catalogCore.compose(input.failures);
	const resources = input.resources === undefined ? Object.freeze([]) : catalogCore.compose(input.resources);
	const permissions = input.permissions === undefined ? Object.freeze([]) : catalogCore.compose(input.permissions);
	const resilience = input.resilience === undefined ? Object.freeze([]) : resilienceCore.compose(input.resilience);
	return Object.freeze({
		kind: 'activity',
		id: input.id,
		version: input.version,
		...(input.description === undefined ? {} : { description: input.description }),
		input: input.input,
		result: input.result,
		failures,
		runtimes,
		resources,
		permissions,
		resilience,
	}) as Definition<Authoring>;
}

/** Bind one exact activity to one concrete allowed runtime implementation. */
export function implement<ActivityDefinition extends Definition>(
	definition: ActivityDefinition,
	input: ImplementationInput<ActivityDefinition>,
): Implementation<ActivityDefinition> {
	if (!definition.runtimes.includes(input.runtime)) throw new InvalidRuntimeError(definition.id, input.runtime.id);
	if (typeof input.execute !== 'function') throw new TypeError('Activity implementation execute must be a function.');
	return Object.freeze({ definition, runtime: input.runtime, execute: input.execute });
}

/** Create a named immutable activity catalog. */
export function activityCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
>(namespace: Namespace, entries: Entries): ActivityCatalog<Entries> {
	return catalogCore.create(namespace, entries);
}

/** Select a key-preserving activity catalog subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: ActivityCatalog<Entries>,
	keys: Keys,
): ActivitySelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogCore.select(source, keys);
}

/** Compose activities, catalogs, selections, and nested arrays. */
export function compose<Entry extends Definition>(...input: readonly CatalogDefinitionInput<Entry>[]): readonly Entry[] {
	return catalogCore.compose(...input);
}

/** Create a durable workflow operation for one activity. No work starts yet. */
export function run<ActivityDefinition extends Definition>(
	definition: ActivityDefinition,
	input: Input<ActivityDefinition>,
	options: RunOptions = {},
): RunOperation<ActivityDefinition> {
	return workflow.activity<Result<ActivityDefinition>, Failures<ActivityDefinition>>(definition, input, options);
}

/** Create a durable activity operation that returns an explicit declared-failure result. */
export function try_<ActivityDefinition extends Definition>(
	definition: ActivityDefinition,
	input: Input<ActivityDefinition>,
	options: RunOptions = {},
): workflow.Operation<TryResult<ActivityDefinition>, never> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<workflow.Instruction, TryResult<ActivityDefinition>, workflow.AnyCompletion> {
			try {
				return resultCore.ok(yield* run(definition, input, options));
			} catch (reason) {
				if (isDeclaredFailure(definition, reason)) return resultCore.fail(reason as Failures<ActivityDefinition>);
				throw reason;
			}
		},
	});
}

/** Execute one concrete activity implementation immediately in the current host. */
export async function execute<ActivityDefinition extends Definition>(
	options: ExecuteOptions<ActivityDefinition>,
): Promise<Result<ActivityDefinition>> {
	assertJobId(options.jobId);
	if (!Number.isSafeInteger(options.attempt) || options.attempt < 1) {
		throw new TypeError('Activity attempt must be a positive safe integer.');
	}
	const definition = options.implementation.definition;
	if (!definition.runtimes.includes(options.implementation.runtime)) {
		throw new InvalidRuntimeError(definition.id, options.implementation.runtime.id);
	}
	const input = await schema.parse(definition.input, options.input) as Input<ActivityDefinition>;
	await using owned = contextCore.child(options.ctx, { id: options.jobId });
	const ctx: Context<ActivityDefinition> = Object.freeze({
		id: owned.id,
		...(owned.traceId === undefined ? {} : { traceId: owned.traceId }),
		...(owned.deploymentId === undefined ? {} : { deploymentId: owned.deploymentId }),
		...(owned.idempotencyKey === undefined ? {} : { idempotencyKey: owned.idempotencyKey }),
		startedAt: owned.startedAt,
		...(owned.deadline === undefined ? {} : { deadline: owned.deadline }),
		signal: owned.signal,
		clock: owned.clock,
		activity: definition,
		runtime: options.implementation.runtime,
		jobId: options.jobId,
		attempt: options.attempt,
		input,
		resources: options.resources,
		heartbeat: options.heartbeat ?? (() => {}),
	});
	try {
		const value = await options.implementation.execute(ctx);
		return await schema.parse(definition.result, value) as Result<ActivityDefinition>;
	} catch (reason) {
		if (isFailureOccurrence(reason) && !isDeclaredFailure(definition, reason)) {
			throw new UndeclaredFailureError(definition, reason);
		}
		throw reason;
	}
}

/** Return whether a reason is one of an activity's exact declared failures. */
export function isDeclaredFailure<ActivityDefinition extends Definition>(
	definition: ActivityDefinition,
	reason: unknown,
): reason is Failures<ActivityDefinition> {
	return isFailureOccurrence(reason) && definition.failures.includes(reason.definition);
}

/** Create deterministic JSON-safe activity documentation. */
export function document(input: CatalogDefinitionInput<Definition>): readonly Document[] {
	return Object.freeze(catalogCore.values(input).map((definition) => Object.freeze({
		id: definition.id,
		version: definition.version,
		...(definition.description === undefined ? {} : { description: definition.description }),
		inputVendor: definition.input['~standard'].vendor,
		resultVendor: definition.result['~standard'].vendor,
		failures: Object.freeze(definition.failures.map((entry) => entry.id)),
		runtimes: Object.freeze(definition.runtimes.map((entry) => entry.id)),
		resources: Object.freeze(definition.resources.map((entry) => entry.id)),
		permissions: Object.freeze(definition.permissions.map((entry) => entry.id)),
		resilience: Object.freeze(definition.resilience.map((entry) => entry.type)),
	})));
}

/**
 * Checks whether failure occurrence satisfies the condition required by the surrounding module.
 *
 * @internal
 */
function isFailureOccurrence(value: unknown): value is import('@utils/failure').Occurrence {
	return value instanceof Error &&
		typeof (value as Partial<import('@utils/failure').Occurrence>).definition === 'object' &&
		(value as Partial<import('@utils/failure').Occurrence>).definition?.kind === 'failure';
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid job id before it can enter authoritative module state.
 *
 * @internal
 */
function assertJobId(value: string): void {
	if (value.trim().length === 0) throw new TypeError('Activity jobId must not be empty.');
	if (value.length > 512) throw new TypeError('Activity jobId must not exceed 512 characters.');
}

export { activityCatalog as catalog, try_ as try };
export type * from './types.ts';
