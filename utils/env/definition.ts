import type { StandardSchemaV1 } from '@standard-schema/spec';

import { EnvironmentError } from './error.ts';
import { isSource, record } from './source.ts';
import type {
	EnvironmentDefinition,
	EnvironmentField,
	EnvironmentFieldKind,
	EnvironmentFieldMetadata,
	EnvironmentFields,
	EnvironmentIssue,
	EnvironmentParseResult,
	EnvironmentRequirement,
	EnvironmentRequirementField,
	EnvironmentSource,
	EnvironmentSourceInput,
	InferEnvironmentFields,
} from './types.ts';

/** Fields carried by a tuple of composed environment definitions. */
export type ComposeEnvironmentFields<Definitions extends readonly EnvironmentDefinition[]> =
	Definitions extends readonly [
		infer Head extends EnvironmentDefinition,
		...infer Tail extends readonly EnvironmentDefinition[],
	]
		? Head['fields'] & ComposeEnvironmentFields<Tail>
		: Record<never, never>;

/**
 * Builds the source adapter consumed by environment definition and resolution.
 *
 * @internal
 */
function source(input: EnvironmentSourceInput): EnvironmentSource {
	return isSource(input) ? input : record(input);
}

/**
 * Checks whether promise like satisfies the condition required by environment definition and resolution.
 *
 * @internal
 */
function isPromiseLike<Value>(value: Value | PromiseLike<Value>): value is PromiseLike<Value> {
	return typeof value === 'object' && value !== null && 'then' in value &&
		typeof (value as PromiseLike<Value>).then === 'function';
}

/**
 * Checks whether sue path satisfies the condition required by environment definition and resolution.
 *
 * @internal
 */
function issuePath(issue: StandardSchemaV1.Issue): readonly PropertyKey[] | undefined {
	if (!issue.path) return undefined;
	return issue.path.map((segment) =>
		typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment
	);
}

/**
 * Normalizes issue into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeIssue(key: string, rawValue: string | undefined, issue: StandardSchemaV1.Issue): EnvironmentIssue {
	const path = issuePath(issue);
	return {
		key,
		message: issue.message,
		...(path ? { path } : {}),
		source: rawValue === undefined ? 'missing' : 'invalid',
	};
}

/**
 * Create a canonical environment field while preserving the supplied schema.
 *
 * This low-level constructor is used by the Standard Schema, Zod, and Valibot
 * entrypoints after each adapter has normalized its metadata. Most callers use
 * `env.variable()` or `env.secret()` instead.
 */
export function defineEnvironmentField<
	const Schema extends StandardSchemaV1,
	const Kind extends EnvironmentFieldKind,
>(kind: Kind, schema: Schema, metadata: EnvironmentFieldMetadata): EnvironmentField<Schema, Kind> {
	if (metadata.description.trim().length === 0) {
		throw new TypeError('Environment field descriptions cannot be empty.');
	}
	if (kind === 'secret' && metadata.example !== undefined) {
		throw new TypeError('Secret environment fields cannot include example values.');
	}

	// Definitions are the small, static values for which freezing communicates a
	// real invariant. Runtime sources and parsed configuration remain ordinary
	// values and are not recursively frozen.
	return Object.freeze({
		kind,
		schema,
		metadata: Object.freeze({
			...metadata,
			...(metadata.availability ? { availability: Object.freeze([...metadata.availability]) } : {}),
		}),
	});
}

/** Define an ordinary deployment variable with an explicit Standard Schema contract. */
export function variable<const Schema extends StandardSchemaV1>(
	schema: Schema,
	metadata: EnvironmentFieldMetadata,
): EnvironmentField<Schema, 'variable'> {
	return defineEnvironmentField('variable', schema, metadata);
}

/** Define protected secret material with an explicit Standard Schema contract. */
export function secret<const Schema extends StandardSchemaV1>(
	schema: Schema,
	metadata: EnvironmentFieldMetadata,
): EnvironmentField<Schema, 'secret'> {
	return defineEnvironmentField('secret', schema, metadata);
}

/**
 * Parses fields into the validated internal model used by later phases.
 *
 * It keeps environment definitions import-safe and leaves ambient source selection to the application composition root.
 *
 * @internal
 */
async function parseFields<Fields extends EnvironmentFields>(
	fields: Fields,
	keys: readonly Extract<keyof Fields, string>[],
	sourceInput: EnvironmentSourceInput,
): Promise<EnvironmentParseResult<InferEnvironmentFields<Fields>>> {
	const values = source(sourceInput);
	const entries = await Promise.all(keys.map(async (key) => {
		const field = fields[key]!;
		const rawValue = values.get(key);
		try {
			const result = await field.schema['~standard'].validate(rawValue);
			if (result.issues) {
				return {
					key,
					issues: result.issues.map((issue) => normalizeIssue(key, rawValue, issue)),
				} as const;
			}
			return { key, value: result.value } as const;
		} catch (cause) {
			return {
				key,
				issues: [{
					key,
					message: cause instanceof Error ? cause.message : String(cause),
					source: rawValue === undefined ? 'missing' : 'invalid',
				} satisfies EnvironmentIssue],
			} as const;
		}
	}));

	const issues: EnvironmentIssue[] = [];
	for (const entry of entries) {
		if ('issues' in entry && entry.issues) issues.push(...entry.issues);
	}
	if (issues.length > 0) return { success: false, issues };

	return {
		success: true,
		value: Object.fromEntries(
			entries.flatMap((entry) => 'value' in entry ? [[entry.key, entry.value] as const] : []),
		) as InferEnvironmentFields<Fields>,
	};
}

/**
 * Parses fields sync into the validated internal model used by later phases.
 *
 * It keeps environment definitions import-safe and leaves ambient source selection to the application composition root.
 *
 * @internal
 */
function parseFieldsSync<Fields extends EnvironmentFields>(
	fields: Fields,
	keys: readonly Extract<keyof Fields, string>[],
	sourceInput: EnvironmentSourceInput,
): EnvironmentParseResult<InferEnvironmentFields<Fields>> {
	const values = source(sourceInput);
	const parsed = new Map<string, unknown>();
	const issues: EnvironmentIssue[] = [];

	for (const key of keys) {
		const field = fields[key]!;
		const rawValue = values.get(key);
		try {
			const result = field.schema['~standard'].validate(rawValue);
			if (isPromiseLike(result)) {
				issues.push({
					key,
					message: 'This field validates asynchronously. Use environment.parse() instead of parseSync().',
					source: 'invalid',
				});
				continue;
			}
			if (result.issues) {
				issues.push(...result.issues.map((issue) => normalizeIssue(key, rawValue, issue)));
				continue;
			}
			parsed.set(key, result.value);
		} catch (cause) {
			issues.push({
				key,
				message: cause instanceof Error ? cause.message : String(cause),
				source: rawValue === undefined ? 'missing' : 'invalid',
			});
		}
	}

	return issues.length > 0
		? { success: false, issues }
		: { success: true, value: Object.fromEntries(parsed) as InferEnvironmentFields<Fields> };
}

/**
 * Create an import-safe definition from canonical environment fields.
 *
 * The definition describes and validates values; it does not decide where raw
 * strings come from. A host supplies `env.env`, `env.record(...)`, or
 * `env.merge(...)` when it starts.
 *
 * @example Standard Schema definition
 * ```ts
 * import * as env from '@utils/env/standard';
 *
 * const ServiceEnvironment = env.environment({
 *   PORT: env.variable(PortSchema, { description: 'HTTP listener port.' }),
 * });
 * ```
 */
export function environment<const Fields extends EnvironmentFields>(fields: Fields): EnvironmentDefinition<Fields> {
	const entries = Object.entries(fields) as [Extract<keyof Fields, string>, Fields[keyof Fields]][];
	const fieldLookup = Object.create(null) as Record<string, EnvironmentField>;
	for (const [key, field] of entries) fieldLookup[key] = field;
	const fieldSnapshot = Object.freeze(fieldLookup) as unknown as Fields;
	const keys = Object.freeze(entries.map(([key]) => key));

	return Object.freeze({
		fields: fieldSnapshot,
		keys,
		/**
		 * Parses input into the validated internal model used by later phases.
		 *
		 * @internal
		 */
		async parse(sourceInput: EnvironmentSourceInput): Promise<InferEnvironmentFields<Fields>> {
			const result = await parseFields(fieldSnapshot, keys, sourceInput);
			if (!result.success) throw new EnvironmentError('Environment validation failed.', result.issues);
			return result.value;
		},
		/**
		 * Parses sync into the validated internal model used by later phases.
		 *
		 * @internal
		 */
		parseSync(sourceInput: EnvironmentSourceInput): InferEnvironmentFields<Fields> {
			const result = parseFieldsSync(fieldSnapshot, keys, sourceInput);
			if (!result.success) throw new EnvironmentError('Environment validation failed.', result.issues);
			return result.value;
		},
		/**
		 * Attempts parse and returns structured failure information instead of throwing inside environment definition and resolution.
		 *
		 * @internal
		 */
		safeParse(sourceInput: EnvironmentSourceInput) {
			return parseFields(fieldSnapshot, keys, sourceInput);
		},
		/**
		 * Attempts parse sync and returns structured failure information instead of throwing inside environment definition and resolution.
		 *
		 * @internal
		 */
		safeParseSync(sourceInput: EnvironmentSourceInput) {
			return parseFieldsSync(fieldSnapshot, keys, sourceInput);
		},
	});
}

/** Descriptive alias for `environment()` when the call reads better as a verb. */
export const define = environment;

/**
 * Compose definitions through canonical field identity.
 *
 * The same field object may be imported through several definitions and is
 * deduplicated. Different field objects using the same key are rejected because
 * choosing one would silently discard validation or deployment metadata.
 */
export function compose<const Definitions extends readonly EnvironmentDefinition[]>(
	...definitions: Definitions
): EnvironmentDefinition<ComposeEnvironmentFields<Definitions>> {
	const fields = new Map<string, EnvironmentField>();
	const issues: EnvironmentIssue[] = [];

	for (const definition of definitions) {
		for (const key of definition.keys) {
			const field = definition.fields[key]!;
			const existing = fields.get(key);
			if (existing === undefined) fields.set(key, field);
			else if (existing !== field) {
				issues.push({
					key,
					message: `Environment key ${key} was declared by different field objects. ` +
						'Import and reuse one canonical field definition.',
					source: 'conflict',
				});
			}
		}
	}

	if (issues.length > 0) {
		throw new EnvironmentError('Environment definition composition failed.', issues);
	}
	return environment(Object.fromEntries(fields)) as unknown as EnvironmentDefinition<
		ComposeEnvironmentFields<Definitions>
	>;
}

/**
 * Attach operator-facing reasons to selected canonical fields.
 *
 * The returned value stores the actual field references rather than only their
 * string keys. Requirement reports can therefore distinguish unrelated
 * definitions that happen to use the same external name.
 */
export function requirement<
	const Fields extends EnvironmentFields,
	const Reasons extends Readonly<Partial<Record<Extract<keyof Fields, string>, string>>>,
>(id: string, definition: EnvironmentDefinition<Fields>, reasons: Reasons): EnvironmentRequirement<Fields> {
	if (id.trim().length === 0) throw new TypeError('Environment requirement ids cannot be empty.');

	const selected: EnvironmentRequirementField<Fields[keyof Fields]>[] = [];
	for (const [key, rawReason] of Object.entries(reasons)) {
		if (!Object.hasOwn(definition.fields, key)) {
			throw new TypeError(`Environment requirement ${id} references unknown key ${key}.`);
		}
		if (typeof rawReason !== 'string' || rawReason.trim().length === 0) {
			throw new TypeError(`Environment requirement ${id} must explain why ${key} is required.`);
		}
		selected.push({
			key,
			field: definition.fields[key] as Fields[keyof Fields],
			reason: rawReason,
		});
	}

	return Object.freeze({ id, environment: definition, fields: Object.freeze(selected) });
}
