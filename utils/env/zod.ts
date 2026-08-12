import type { StandardSchemaV1 } from '@standard-schema/spec';

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

/** Zod 4 schema surface used by the environment metadata adapter. */
export interface ZodEnvironmentSchema<Input = unknown, Output = Input> extends StandardSchemaV1<Input, Output> {
	/** Return metadata registered on this exact Zod schema instance. */
	meta(): unknown;
}

/** A Zod schema or an explicitly classified environment field. */
export type ZodEnvironmentFieldInput<Schema extends ZodEnvironmentSchema = ZodEnvironmentSchema> =
	| Schema
	| EnvironmentField<Schema>;

/** Named inputs accepted by `env.define()` in the Zod entrypoint. */
export type ZodEnvironmentFieldInputs = Readonly<Record<string, ZodEnvironmentFieldInput>>;

/** Canonical fields inferred from Zod authoring inputs. */
export type InferZodEnvironmentFields<Inputs extends ZodEnvironmentFieldInputs> = {
	readonly [Key in keyof Inputs]: Inputs[Key] extends EnvironmentField<infer Schema>
		? EnvironmentField<Schema>
		: Inputs[Key] extends ZodEnvironmentSchema
			? EnvironmentField<Inputs[Key], 'variable'>
			: never;
};

const bareVariables = new WeakMap<object, EnvironmentField<ZodEnvironmentSchema, 'variable'>>();

/**
 * Returns the metadata required to interpret values handled by environment definition and resolution.
 *
 * @internal
 */
function metadata(schema: ZodEnvironmentSchema): Readonly<Record<string, unknown>> | undefined {
	const value = schema.meta();
	return typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : undefined;
}

/**
 * Checks whether field satisfies the condition required by environment definition and resolution.
 *
 * @internal
 */
function isField(value: ZodEnvironmentFieldInput): value is EnvironmentField<ZodEnvironmentSchema> {
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
	schema: ZodEnvironmentSchema,
	explicit?: EnvironmentFieldMetadataInput,
	key?: string,
) {
	if (kind === 'secret' && explicit?.example !== undefined) {
		throw new TypeError('Secret environment fields cannot include example values.');
	}
	const resolved = resolveMetadata(metadata(schema), explicit, key);
	if (kind === 'variable' || resolved.example === undefined) return resolved;
	const { example: _example, ...safe } = resolved;
	return safe;
}

/**
 * Normalizes field into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeField(input: ZodEnvironmentFieldInput, key: string): EnvironmentField<ZodEnvironmentSchema> {
	if (isField(input)) return input;

	const existing = bareVariables.get(input);
	if (existing) return existing;

	const field = defineEnvironmentField('variable', input, normalizedMetadata('variable', input, undefined, key));
	bareVariables.set(input, field);
	return field;
}

/**
 * Define a Zod-backed environment while preserving each concrete schema.
 *
 * Bare schemas become ordinary variables and obtain metadata through Zod's
 * public `.meta()`/`.describe()` API. Wrap a schema with `env.secret()` when the
 * host must protect the raw value.
 *
 * @example Pure Zod metadata
 * ```ts
 * import * as env from '@utils/env/zod';
 * import { z } from 'zod';
 *
 * const ServiceEnvironment = env.define({
 *   PORT: z.coerce.number().int().positive().default(8787).meta({
 *     title: 'HTTP port',
 *     description: 'Port used by the service listener.',
 *     examples: ['8787'],
 *   }),
 * });
 * ```
 *
 * @example Explicit secret classification
 * ```ts
 * const ServiceEnvironment = env.define({
 *   DATABASE_URL: env.secret(z.string().min(1).describe('PostgreSQL connection string.')),
 * });
 * ```
 */
export function environment<const Inputs extends ZodEnvironmentFieldInputs>(
	inputs: Inputs,
): EnvironmentDefinition<InferZodEnvironmentFields<Inputs>> {
	const fields = Object.fromEntries(
		Object.entries(inputs).map(([key, input]) => [key, normalizeField(input, key)]),
	) as InferZodEnvironmentFields<Inputs>;
	return environmentStandard(fields);
}

/** Descriptive alias for `environment()` in Zod authoring code. */
export const define = environment;

/** Define an ordinary Zod-backed deployment variable. */
export function variable<const Schema extends ZodEnvironmentSchema>(
	schema: Schema,
	metadataOverride?: EnvironmentFieldMetadataInput,
): EnvironmentField<Schema, 'variable'> {
	return defineEnvironmentField(
		'variable',
		schema,
		normalizedMetadata('variable', schema, metadataOverride),
	);
}

/** Define Zod-backed secret material without projecting schema examples. */
export function secret<const Schema extends ZodEnvironmentSchema>(
	schema: Schema,
	metadataOverride?: EnvironmentFieldMetadataInput,
): EnvironmentField<Schema, 'secret'> {
	return defineEnvironmentField(
		'secret',
		schema,
		normalizedMetadata('secret', schema, metadataOverride),
	);
}

/** Compose Zod-authored definitions through the shared canonical field protocol. */
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
