import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { GenericSchema, GenericSchemaAsync } from 'valibot';
import { getDescription, getExamples, getMetadata, getTitle } from 'valibot';

import {
	compose as composeStandard,
	defineEnvironmentField,
	environment as environmentStandard,
	requirement,
} from './definition.ts';
import { EnvironmentError } from './error.ts';
import { resolveMetadata } from './metadata.ts';
import { example, manifest, requirementReport } from './projection.ts';
import { env, isSource, merge, record, select } from './source.ts';
import type {
	EnvironmentDefinition,
	EnvironmentField,
	EnvironmentFieldKind,
	EnvironmentFieldMetadata,
	EnvironmentFieldMetadataInput,
	EnvironmentFields,
	EnvironmentIssue,
	EnvironmentManifest,
	EnvironmentManifestField,
	EnvironmentParseResult,
	EnvironmentRecord,
	EnvironmentRequirement,
	EnvironmentRequirementField,
	EnvironmentRequirementReason,
	EnvironmentRequirementReportField,
	EnvironmentSource,
	EnvironmentSourceInput,
	InferEnvironment,
	InferEnvironmentField,
	InferEnvironmentFields,
} from './types.ts';

/**
 * Valibot schema accepted by the environment adapter.
 *
 * The concrete Valibot contract is retained because this entrypoint reads
 * Valibot metadata. The Standard Schema intersection is the validation contract
 * shared with the environment core.
 */
export type ValibotEnvironmentSchema<Input = unknown, Output = Input> =
	| (GenericSchema<Input, Output> & StandardSchemaV1<Input, Output>)
	| (GenericSchemaAsync<Input, Output> & StandardSchemaV1<Input, Output>);

/** A Valibot schema or an explicitly classified environment field. */
export type ValibotEnvironmentFieldInput<Schema extends ValibotEnvironmentSchema = ValibotEnvironmentSchema> =
	| Schema
	| EnvironmentField<Schema>;

/** Named inputs accepted by `env.define()` in the Valibot entrypoint. */
export type ValibotEnvironmentFieldInputs = Readonly<Record<string, ValibotEnvironmentFieldInput>>;

/** Canonical fields inferred from Valibot authoring inputs. */
export type InferValibotEnvironmentFields<Inputs extends ValibotEnvironmentFieldInputs> = {
	readonly [Key in keyof Inputs]: Inputs[Key] extends EnvironmentField<infer Schema>
		? EnvironmentField<Schema>
		: Inputs[Key] extends ValibotEnvironmentSchema
			? EnvironmentField<Inputs[Key], 'variable'>
			: never;
};

const bareVariables = new WeakMap<object, EnvironmentField<ValibotEnvironmentSchema, 'variable'>>();

/**
 * Reads metadata under the module's cancellation and ownership rules.
 *
 * It keeps environment definitions import-safe and leaves ambient source selection to the application composition root.
 *
 * @internal
 */
function readMetadata(schema: ValibotEnvironmentSchema): Readonly<Record<string, unknown>> {
	const custom = getMetadata(schema);
	const examples = getExamples(schema);
	const title = getTitle(schema);
	const description = getDescription(schema);
	return {
		...custom,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(examples.length > 0 ? { examples } : {}),
	};
}

/**
 * Checks whether field satisfies the condition required by environment definition and resolution.
 *
 * @internal
 */
function isField(value: ValibotEnvironmentFieldInput): value is EnvironmentField<ValibotEnvironmentSchema> {
	return typeof value === 'object' && value !== null &&
		('kind' in value && (value.kind === 'variable' || value.kind === 'secret')) &&
		'schema' in value && 'metadata' in value;
}

/**
 * Normalizes d metadata into the canonical internal form used by later phases.
 *
 * It keeps environment definitions import-safe and leaves ambient source selection to the application composition root.
 *
 * @internal
 */
function normalizedMetadata(
	kind: 'variable' | 'secret',
	schema: ValibotEnvironmentSchema,
	explicit?: EnvironmentFieldMetadataInput,
	key?: string,
) {
	if (kind === 'secret' && explicit?.example !== undefined) {
		throw new TypeError('Secret environment fields cannot include example values.');
	}
	const resolved = resolveMetadata(readMetadata(schema), explicit, key);
	if (kind === 'variable' || resolved.example === undefined) return resolved;
	const { example: _example, ...safe } = resolved;
	return safe;
}

/**
 * Normalizes field into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeField(input: ValibotEnvironmentFieldInput, key: string): EnvironmentField<ValibotEnvironmentSchema> {
	if (isField(input)) return input;

	const existing = bareVariables.get(input);
	if (existing) return existing;

	const field = defineEnvironmentField('variable', input, normalizedMetadata('variable', input, undefined, key));
	bareVariables.set(input, field);
	return field;
}

/**
 * Define a Valibot-backed environment while preserving each concrete schema.
 *
 * Bare schemas become ordinary variables. The adapter reads Valibot's public
 * `title`, `description`, `metadata`, and `examples` pipeline annotations.
 *
 * @example Pure Valibot metadata
 * ```ts
 * import * as env from '@utils/env/valibot';
 * import * as v from 'valibot';
 *
 * const Port = v.pipe(
 *   v.string(),
 *   v.title('HTTP port'),
 *   v.description('Port used by the service listener.'),
 *   v.examples(['8787']),
 * );
 * const ServiceEnvironment = env.define({ PORT: Port });
 * ```
 *
 * @example Explicit secret classification
 * ```ts
 * const DatabaseUrl = v.pipe(v.string(), v.description('PostgreSQL connection string.'));
 * const ServiceEnvironment = env.define({ DATABASE_URL: env.secret(DatabaseUrl) });
 * ```
 */
export function environment<const Inputs extends ValibotEnvironmentFieldInputs>(
	inputs: Inputs,
): EnvironmentDefinition<InferValibotEnvironmentFields<Inputs>> {
	const fields = Object.fromEntries(
		Object.entries(inputs).map(([key, input]) => [key, normalizeField(input, key)]),
	) as InferValibotEnvironmentFields<Inputs>;
	return environmentStandard(fields);
}

/** Descriptive alias for `environment()` in Valibot authoring code. */
export const define = environment;

/** Define an ordinary Valibot-backed deployment variable. */
export function variable<const Schema extends ValibotEnvironmentSchema>(
	schema: Schema,
	metadataOverride?: EnvironmentFieldMetadataInput,
): EnvironmentField<Schema, 'variable'> {
	return defineEnvironmentField(
		'variable',
		schema,
		normalizedMetadata('variable', schema, metadataOverride),
	);
}

/** Define Valibot-backed secret material without projecting schema examples. */
export function secret<const Schema extends ValibotEnvironmentSchema>(
	schema: Schema,
	metadataOverride?: EnvironmentFieldMetadataInput,
): EnvironmentField<Schema, 'secret'> {
	return defineEnvironmentField(
		'secret',
		schema,
		normalizedMetadata('secret', schema, metadataOverride),
	);
}

/** Compose Valibot-authored definitions through the shared canonical field protocol. */
export const compose = composeStandard;

export {
	EnvironmentError,
	env,
	example,
	isSource,
	manifest,
	merge,
	record,
	requirement,
	requirementReport,
	select,
};
export type { ComposeEnvironmentFields } from './definition.ts';
export type {
	EnvironmentDefinition,
	EnvironmentField,
	EnvironmentFieldKind,
	EnvironmentFieldMetadata,
	EnvironmentFieldMetadataInput,
	EnvironmentFields,
	EnvironmentIssue,
	EnvironmentManifest,
	EnvironmentManifestField,
	EnvironmentParseResult,
	EnvironmentRecord,
	EnvironmentRequirement,
	EnvironmentRequirementField,
	EnvironmentRequirementReason,
	EnvironmentRequirementReportField,
	EnvironmentSource,
	EnvironmentSourceInput,
	InferEnvironment,
	InferEnvironmentField,
	InferEnvironmentFields,
};
