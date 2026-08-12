import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Controls how a host must store and expose one environment value.
 *
 * A `variable` may be projected into ordinary deployment configuration. A
 * `secret` must use the host's protected secret facility and is never emitted
 * with an example value.
 */
export type EnvironmentFieldKind = 'variable' | 'secret';

/**
 * Metadata that belongs to the environment binding rather than its validator.
 *
 * Schema-specific entrypoints can obtain these values from Zod or Valibot
 * metadata. Explicit values supplied to `env.variable` or `env.secret` take
 * precedence because one reusable schema can have a more specific meaning in a
 * particular service.
 */
export interface EnvironmentFieldMetadata {
	/** Short name suitable for generated tables and deployment interfaces. */
	readonly title?: string;
	/** Operator-facing explanation of what the value controls and why it exists. */
	readonly description: string;
	/** Safe example used by `.env.example` projections for ordinary variables. */
	readonly example?: string;
	/** External reference that explains how to obtain or configure the value. */
	readonly documentationUrl?: string;
	/** Named deployment environments where the value is meaningful. */
	readonly availability?: readonly string[];
	/** Whether new deployments should stop defining this field. */
	readonly deprecated?: boolean;
	/** Canonical replacement key when this field is deprecated. */
	readonly replacement?: string;
}

/**
 * Optional metadata accepted by schema-specific authoring helpers.
 *
 * Zod and Valibot may already provide some or all of these values. The adapter
 * combines native schema metadata with this explicit override before creating
 * the canonical field definition.
 */
export type EnvironmentFieldMetadataInput = Readonly<Partial<EnvironmentFieldMetadata>>;

/**
 * Canonical schema-backed environment field.
 *
 * Field object identity is significant. Reusing the same field in several
 * definitions is treated as intentional deduplication; independently creating
 * two fields for the same key is rejected during composition.
 */
export interface EnvironmentField<
	Schema extends StandardSchemaV1 = StandardSchemaV1,
	Kind extends EnvironmentFieldKind = EnvironmentFieldKind,
> {
	/** Deployment classification for this value. */
	readonly kind: Kind;
	/** Original caller-owned validation schema. */
	readonly schema: Schema;
	/** Normalized metadata used by documentation and deployment projections. */
	readonly metadata: EnvironmentFieldMetadata;
}

/** Named canonical fields accepted by a generic environment definition. */
export type EnvironmentFields = Readonly<Record<string, EnvironmentField>>;

/** Parsed output inferred from one field's Standard Schema implementation. */
export type InferEnvironmentField<Field extends EnvironmentField> =
	StandardSchemaV1.InferOutput<Field['schema']>;

/** Parsed output inferred from a complete field collection. */
export type InferEnvironmentFields<Fields extends EnvironmentFields> = {
	readonly [Key in keyof Fields]: InferEnvironmentField<Fields[Key]>;
};

/**
 * Pull-based access to raw environment strings.
 *
 * The getter shape lets Deno retain per-key environment permissions and lets
 * browser-compatible packages avoid importing a Node-only module.
 */
export interface EnvironmentSource {
	/** Return the raw value for `key`, or `undefined` when no source provides it. */
	readonly get: (key: string) => string | undefined;
}

/** Plain-record input accepted wherever an environment source is accepted. */
export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

/** Runtime input accepted by parsing and source-composition operations. */
export type EnvironmentSourceInput = EnvironmentSource | EnvironmentRecord;

/** Normalized validation or composition issue. */
export interface EnvironmentIssue {
	/** Environment key responsible for the failure. */
	readonly key: string;
	/** Human-readable explanation supplied by the schema or composition check. */
	readonly message: string;
	/** Optional schema-relative path for structured values or transforms. */
	readonly path?: readonly PropertyKey[];
	/** High-level failure category used by hosts and tests. */
	readonly source: 'missing' | 'invalid' | 'conflict';
}

/** Result returned by non-throwing parsing functions. */
export type EnvironmentParseResult<Value> =
	| Readonly<{ readonly success: true; readonly value: Value }>
	| Readonly<{ readonly success: false; readonly issues: readonly EnvironmentIssue[] }>;

/**
 * Import-safe contract that validates raw environment values.
 *
 * Definitions do not read ambient state when they are created. A service or
 * application composition root selects a source and passes it to one of the
 * parse methods when startup actually occurs.
 */
export interface EnvironmentDefinition<Fields extends EnvironmentFields = EnvironmentFields> {
	/** Canonical fields keyed by the external environment variable name. */
	readonly fields: Fields;
	/**
	 * Stable declaration order used by parsing and deterministic projections.
	 *
	 * The runtime list is intentionally widened to `string[]`. Literal field names
	 * remain available through `fields`; coupling this iteration list to
	 * `keyof Fields` makes otherwise compatible definitions invariant in
	 * TypeScript and prevents projection and composition helpers from accepting
	 * concrete Zod, Valibot, or Standard Schema definitions.
	 */
	readonly keys: readonly string[];
	/** Validate all fields, including schemas with asynchronous refinements. */
	parse(source: EnvironmentSourceInput): Promise<InferEnvironmentFields<Fields>>;
	/** Validate all fields synchronously and reject asynchronous validators. */
	parseSync(source: EnvironmentSourceInput): InferEnvironmentFields<Fields>;
	/** Validate asynchronously without throwing for ordinary schema issues. */
	safeParse(source: EnvironmentSourceInput): Promise<EnvironmentParseResult<InferEnvironmentFields<Fields>>>;
	/** Validate synchronously without throwing for ordinary schema issues. */
	safeParseSync(source: EnvironmentSourceInput): EnvironmentParseResult<InferEnvironmentFields<Fields>>;
}

/** Parsed output inferred from an environment definition. */
export type InferEnvironment<Definition extends EnvironmentDefinition> =
	Definition extends EnvironmentDefinition<infer Fields> ? InferEnvironmentFields<Fields> : never;

/** One canonical field selected by a resource or host requirement. */
export interface EnvironmentRequirementField<Field extends EnvironmentField = EnvironmentField> {
	/** External environment key used by the selected definition. */
	readonly key: string;
	/** Canonical field reference used to prevent string-only cross-definition joins. */
	readonly field: Field;
	/** Operator-facing explanation of why the resource needs this value. */
	readonly reason: string;
}

/**
 * Resource- or host-specific reasons for requiring environment fields.
 *
 * Requirements retain canonical field references. A report therefore cannot
 * accidentally attach a reason from another definition that happens to reuse
 * the same string key.
 */
export interface EnvironmentRequirement<Fields extends EnvironmentFields = EnvironmentFields> {
	/** Stable identifier for the resource, host, or deployment requirement. */
	readonly id: string;
	/** Definition from which the selected fields originated. */
	readonly environment: EnvironmentDefinition<Fields>;
	/** Canonical selected fields and their operator-facing reasons. */
	readonly fields: readonly EnvironmentRequirementField<Fields[keyof Fields]>[];
}

/** One field in a generated environment manifest. */
export interface EnvironmentManifestField extends EnvironmentFieldMetadata {
	/** External environment variable name. */
	readonly key: string;
	/** Deployment classification used by the target host. */
	readonly kind: EnvironmentFieldKind;
}

/** Deterministic deployment and documentation projection. */
export interface EnvironmentManifest {
	/** Manifest format version. */
	readonly version: 1;
	/** Ordinary host variables ordered by key. */
	readonly variables: readonly EnvironmentManifestField[];
	/** Protected host secrets ordered by key. */
	readonly secrets: readonly EnvironmentManifestField[];
}

/** One reason attached to a field by a resource requirement. */
export interface EnvironmentRequirementReason {
	/** Stable requirement identifier. */
	readonly requirementId: string;
	/** Explanation of why the requirement selects the field. */
	readonly reason: string;
}

/** Field metadata plus every imported requirement that depends on it. */
export interface EnvironmentRequirementReportField extends EnvironmentManifestField {
	/** Requirements that reference this exact canonical field. */
	readonly requiredBy: readonly EnvironmentRequirementReason[];
}
