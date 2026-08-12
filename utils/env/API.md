@utils/env public API usage
===========================

Purpose
-------

This reference maps every public export target declared by `@utils/env` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/env
----------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compose` | function | Compose definitions through canonical field identity. | `compose(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ComposeEnvironmentFields` | type | Fields carried by a tuple of composed environment definitions. | `value: ComposeEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | value | Descriptive alias for `environment()` when the call reads better as a verb. | `define` | `utils/resource/mod_test.ts:78` uses `define`. |
| `env` | value | Lazy ambient environment source for Deno and supported Node.js runtimes. | `env` | `apps/frontend/src/lib/database.server.ts:23` uses `env`. |
| `environment` | function | Create an import-safe definition from canonical environment fields. | `environment(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentDefinition` | interface | Import-safe contract that validates raw environment values. | `value: EnvironmentDefinition` | `utils/server/service/types.ts:72` uses `EnvironmentDefinition`. |
| `EnvironmentError` | class | Error raised when environment composition or validation fails. | `new EnvironmentError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentField` | interface | Canonical schema-backed environment field. | `value: EnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldKind` | type | Controls how a host must store and expose one environment value. | `value: EnvironmentFieldKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadata` | interface | Metadata that belongs to the environment binding rather than its validator. | `value: EnvironmentFieldMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadataInput` | type | Optional metadata accepted by schema-specific authoring helpers. | `value: EnvironmentFieldMetadataInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFields` | type | Named canonical fields accepted by a generic environment definition. | `value: EnvironmentFields` | `utils/resource/types.ts:70` uses `EnvironmentFields`. |
| `EnvironmentIssue` | interface | Normalized validation or composition issue. | `value: EnvironmentIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifest` | interface | Deterministic deployment and documentation projection. | `value: EnvironmentManifest` | `utils/server/service/types.ts:171` uses `EnvironmentManifest`. |
| `EnvironmentManifestField` | interface | One field in a generated environment manifest. | `value: EnvironmentManifestField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentParseResult` | type | Result returned by non-throwing parsing functions. | `value: EnvironmentParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRecord` | type | Plain-record input accepted wherever an environment source is accepted. | `value: EnvironmentRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirement` | interface | Resource- or host-specific reasons for requiring environment fields. | `value: EnvironmentRequirement` | `utils/resource/types.ts:32` uses `EnvironmentRequirement`. |
| `EnvironmentRequirementField` | interface | One canonical field selected by a resource or host requirement. | `value: EnvironmentRequirementField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReason` | interface | One reason attached to a field by a resource requirement. | `value: EnvironmentRequirementReason` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReportField` | interface | Field metadata plus every imported requirement that depends on it. | `value: EnvironmentRequirementReportField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSource` | interface | Pull-based access to raw environment strings. | `value: EnvironmentSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSourceInput` | type | Runtime input accepted by parsing and source-composition operations. | `value: EnvironmentSourceInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `example` | function | Render a safe `.env.example` template from a definition. | `example(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironment` | type | Parsed output inferred from an environment definition. | `value: InferEnvironment` | `apps/frontend/src/lib/server-environment.server.ts:72` uses `InferEnvironment`. |
| `InferEnvironmentField` | type | Parsed output inferred from one field's Standard Schema implementation. | `value: InferEnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentFields` | type | Parsed output inferred from a complete field collection. | `value: InferEnvironmentFields` | `utils/resource/types.ts:71` uses `InferEnvironmentFields`. |
| `isSource` | function | Return whether a value already implements the pull-based source contract. | `isSource(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `manifest` | function | Project a definition into deterministic variable and secret collections. | `manifest(...)` | `utils/server/service/compile.ts:653` uses `manifest`. |
| `merge` | function | Merge sparse sources from lowest to highest precedence. | `merge(...)` | `.agents/tests/public-api-repetition.test.ts:70` uses `merge`. |
| `record` | function | Capture raw values as a deterministic environment source. | `record(...)` | `.agents/tests/public-api-repetition.test.ts:69` uses `record`. |
| `requirement` | function | Attach operator-facing reasons to selected canonical fields. | `requirement(...)` | `utils/resource/mod_test.ts:81` uses `requirement`. |
| `requirementReport` | function | Combine field metadata with requirements that reference the same field. | `requirementReport(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `secret` | function | Define protected secret material with an explicit Standard Schema contract. | `secret(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Read a bounded set of raw values without defining a validation schema. | `select(...)` | `.agents/tests/public-api-repetition.test.ts:69` uses `select`. |
| `variable` | function | Define an ordinary deployment variable with an explicit Standard Schema contract. | `variable(...)` | `utils/resource/mod_test.ts:79` uses `variable`. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `utils/resource/mod_test.ts:78`:

~~~~ typescript
const environment = env.define({
			DATABASE_URL: env.variable(StringSchema, { description: 'Database URL.' }),
		});
		const requirement = env.requirement('test.resource-environment', environment, {
~~~~

`requirement` appears in `utils/resource/mod_test.ts:81`:

~~~~ typescript
const requirement = env.requirement('test.resource-environment', environment, {
			DATABASE_URL: 'Connect to the test database.',
		});
		const Database = resource.define<Readonly<{ readonly url: string; readonly hostName: string; readonly requestId: string }>>()({
~~~~

`variable` appears in `utils/resource/mod_test.ts:79`:

~~~~ typescript
DATABASE_URL: env.variable(StringSchema, { description: 'Database URL.' }),
		});
		const requirement = env.requirement('test.resource-environment', environment, {
			DATABASE_URL: 'Connect to the test database.',
~~~~

`manifest` appears in `utils/server/service/compile.ts:653`:

~~~~ typescript
...(definition.environment !== undefined ? { environment: env.manifest(definition.environment) } : {}),
		resources: Object.freeze(resources.map((entry) => entry.id)),
		resourceGraph: resource.document(resources, implementations),
		permissions: Object.freeze(uniqueByIdentity(operations.flatMap((operation) => operation.permissions)).map((entry) => entry.id)),
~~~~

`env` appears in `apps/frontend/src/lib/database.server.ts:23`:

~~~~ typescript
const environment = DatabaseEnvironment.parseSync(env);
		database = createDatabase(createDatabaseConfig(environment));
		return database;
	} catch (cause) {
~~~~

`merge` appears in `.agents/tests/public-api-repetition.test.ts:70`:

~~~~ typescript
const selectedEnvironment = env.select(env.merge({ HOST: 'base' }, { HOST: 'override' }), ['HOST', '__proto__']);
		assert.equal(selectedEnvironment.HOST, 'override');
		assert.equal(Object.hasOwn(selectedEnvironment, '__proto__'), true);
		assert.equal(selectedEnvironment.__proto__, undefined);
~~~~

`record` appears in `.agents/tests/public-api-repetition.test.ts:69`:

~~~~ typescript
assert.deepEqual(env.select(env.record({ HOST: 'one', PORT: '1' }), ['HOST']), { HOST: 'one' });
		const selectedEnvironment = env.select(env.merge({ HOST: 'base' }, { HOST: 'override' }), ['HOST', '__proto__']);
		assert.equal(selectedEnvironment.HOST, 'override');
		assert.equal(Object.hasOwn(selectedEnvironment, '__proto__'), true);
~~~~

`select` appears in `.agents/tests/public-api-repetition.test.ts:69`:

~~~~ typescript
assert.deepEqual(env.select(env.record({ HOST: 'one', PORT: '1' }), ['HOST']), { HOST: 'one' });
		const selectedEnvironment = env.select(env.merge({ HOST: 'base' }, { HOST: 'override' }), ['HOST', '__proto__']);
		assert.equal(selectedEnvironment.HOST, 'override');
		assert.equal(Object.hasOwn(selectedEnvironment, '__proto__'), true);
~~~~

`EnvironmentDefinition` appears in `utils/server/service/types.ts:72`:

~~~~ typescript
readonly environment?: EnvironmentDefinition;
	readonly endpoints: readonly EndpointEntry[];
	readonly workflows: readonly WorkflowDefinition[];
	readonly policies: readonly ServicePolicy[];
~~~~

`EnvironmentFields` appears in `utils/resource/types.ts:70`:

~~~~ typescript
Requirement extends EnvironmentRequirement<infer Fields extends EnvironmentFields>
		? InferEnvironmentFields<Fields>
		: Readonly<Record<string, never>>;
~~~~

`EnvironmentManifest` appears in `utils/server/service/types.ts:171`:

~~~~ typescript
readonly environment?: EnvironmentManifest;
	readonly resources: readonly string[];
	readonly resourceGraph: readonly ResourceDocument[];
	readonly permissions: readonly string[];
~~~~

`EnvironmentRequirement` appears in `utils/resource/types.ts:32`:

~~~~ typescript
EnvironmentRequirement_ extends EnvironmentRequirement | undefined = EnvironmentRequirement | undefined,
> extends ValuedCatalogEntry<'resource', ResourceValue> {
	readonly description: string;
	readonly dependencies: Dependencies;
~~~~

`InferEnvironment` appears in `apps/frontend/src/lib/server-environment.server.ts:72`:

~~~~ typescript
export type FrontendServerEnvironmentValues = InferEnvironment<
	typeof FrontendServerEnvironment
>
~~~~

`InferEnvironmentFields` appears in `utils/resource/types.ts:71`:

~~~~ typescript
? InferEnvironmentFields<Fields>
		: Readonly<Record<string, never>>;

/** Arguments supplied while creating one concrete resource value. */
~~~~

@utils/env/standard
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compose` | function | Compose definitions through canonical field identity. | `compose(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ComposeEnvironmentFields` | type | Fields carried by a tuple of composed environment definitions. | `value: ComposeEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | value | Descriptive alias for `environment()` when the call reads better as a verb. | `define` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `env` | value | Lazy ambient environment source for Deno and supported Node.js runtimes. | `env` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `environment` | function | Create an import-safe definition from canonical environment fields. | `environment(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentDefinition` | interface | Import-safe contract that validates raw environment values. | `value: EnvironmentDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentError` | class | Error raised when environment composition or validation fails. | `new EnvironmentError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentField` | interface | Canonical schema-backed environment field. | `value: EnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldKind` | type | Controls how a host must store and expose one environment value. | `value: EnvironmentFieldKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadata` | interface | Metadata that belongs to the environment binding rather than its validator. | `value: EnvironmentFieldMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadataInput` | type | Optional metadata accepted by schema-specific authoring helpers. | `value: EnvironmentFieldMetadataInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFields` | type | Named canonical fields accepted by a generic environment definition. | `value: EnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentIssue` | interface | Normalized validation or composition issue. | `value: EnvironmentIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifest` | interface | Deterministic deployment and documentation projection. | `value: EnvironmentManifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifestField` | interface | One field in a generated environment manifest. | `value: EnvironmentManifestField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentParseResult` | type | Result returned by non-throwing parsing functions. | `value: EnvironmentParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRecord` | type | Plain-record input accepted wherever an environment source is accepted. | `value: EnvironmentRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirement` | interface | Resource- or host-specific reasons for requiring environment fields. | `value: EnvironmentRequirement` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementField` | interface | One canonical field selected by a resource or host requirement. | `value: EnvironmentRequirementField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReason` | interface | One reason attached to a field by a resource requirement. | `value: EnvironmentRequirementReason` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReportField` | interface | Field metadata plus every imported requirement that depends on it. | `value: EnvironmentRequirementReportField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSource` | interface | Pull-based access to raw environment strings. | `value: EnvironmentSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSourceInput` | type | Runtime input accepted by parsing and source-composition operations. | `value: EnvironmentSourceInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `example` | function | Render a safe `.env.example` template from a definition. | `example(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironment` | type | Parsed output inferred from an environment definition. | `value: InferEnvironment` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentField` | type | Parsed output inferred from one field's Standard Schema implementation. | `value: InferEnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentFields` | type | Parsed output inferred from a complete field collection. | `value: InferEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isSource` | function | Return whether a value already implements the pull-based source contract. | `isSource(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `manifest` | function | Project a definition into deterministic variable and secret collections. | `manifest(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `merge` | function | Merge sparse sources from lowest to highest precedence. | `merge(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `record` | function | Capture raw values as a deterministic environment source. | `record(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirement` | function | Attach operator-facing reasons to selected canonical fields. | `requirement(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirementReport` | function | Combine field metadata with requirements that reference the same field. | `requirementReport(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `secret` | function | Define protected secret material with an explicit Standard Schema contract. | `secret(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Read a bounded set of raw values without defining a validation schema. | `select(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `variable` | function | Define an ordinary deployment variable with an explicit Standard Schema contract. | `variable(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/env/valibot
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compose` | value | Compose Valibot-authored definitions through the shared canonical field protocol. | `compose` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ComposeEnvironmentFields` | type | Fields carried by a tuple of composed environment definitions. | `value: ComposeEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | value | Descriptive alias for `environment()` in Valibot authoring code. | `define` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `env` | export | Public contract documented by the source declaration. | `env` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `environment` | function | Define a Valibot-backed environment while preserving each concrete schema. | `environment(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentDefinition` | type | Public contract documented by the source declaration. | `value: EnvironmentDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentError` | export | Public contract documented by the source declaration. | `EnvironmentError` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentField` | type | Public contract documented by the source declaration. | `value: EnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldKind` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadata` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadataInput` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldMetadataInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFields` | type | Public contract documented by the source declaration. | `value: EnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentIssue` | type | Public contract documented by the source declaration. | `value: EnvironmentIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifest` | type | Public contract documented by the source declaration. | `value: EnvironmentManifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifestField` | type | Public contract documented by the source declaration. | `value: EnvironmentManifestField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentParseResult` | type | Public contract documented by the source declaration. | `value: EnvironmentParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRecord` | type | Public contract documented by the source declaration. | `value: EnvironmentRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirement` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirement` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementField` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReason` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementReason` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReportField` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementReportField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSource` | type | Public contract documented by the source declaration. | `value: EnvironmentSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSourceInput` | type | Public contract documented by the source declaration. | `value: EnvironmentSourceInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `example` | export | Public contract documented by the source declaration. | `example` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironment` | type | Public contract documented by the source declaration. | `value: InferEnvironment` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentField` | type | Public contract documented by the source declaration. | `value: InferEnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentFields` | type | Public contract documented by the source declaration. | `value: InferEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferValibotEnvironmentFields` | type | Canonical fields inferred from Valibot authoring inputs. | `value: InferValibotEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isSource` | export | Public contract documented by the source declaration. | `isSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `manifest` | export | Public contract documented by the source declaration. | `manifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `merge` | export | Public contract documented by the source declaration. | `merge` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `record` | export | Public contract documented by the source declaration. | `record` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirement` | export | Public contract documented by the source declaration. | `requirement` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirementReport` | export | Public contract documented by the source declaration. | `requirementReport` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `secret` | function | Define Valibot-backed secret material without projecting schema examples. | `secret(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | export | Public contract documented by the source declaration. | `select` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValibotEnvironmentFieldInput` | type | A Valibot schema or an explicitly classified environment field. | `value: ValibotEnvironmentFieldInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValibotEnvironmentFieldInputs` | type | Named inputs accepted by `env.define()` in the Valibot entrypoint. | `value: ValibotEnvironmentFieldInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ValibotEnvironmentSchema` | type | Valibot schema accepted by the environment adapter. | `value: ValibotEnvironmentSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `variable` | function | Define an ordinary Valibot-backed deployment variable. | `variable(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/env/zod
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compose` | value | Compose Zod-authored definitions through the shared canonical field protocol. | `compose` | `apps/frontend/src/lib/auth-provider-environment.server.ts:13` uses `compose`. |
| `ComposeEnvironmentFields` | type | Fields carried by a tuple of composed environment definitions. | `value: ComposeEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | value | Descriptive alias for `environment()` in Zod authoring code. | `define` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `env` | export | Public contract documented by the source declaration. | `env` | `apps/frontend/src/lib/auth-provider-environment.server.ts:27` uses `env`. |
| `environment` | function | Define a Zod-backed environment while preserving each concrete schema. | `environment(...)` | `apps/frontend/src/lib/auth-provider-environment.server.ts:15` uses `environment`. |
| `EnvironmentDefinition` | type | Public contract documented by the source declaration. | `value: EnvironmentDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentError` | export | Public contract documented by the source declaration. | `EnvironmentError` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentField` | type | Public contract documented by the source declaration. | `value: EnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldKind` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadata` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFieldMetadataInput` | type | Public contract documented by the source declaration. | `value: EnvironmentFieldMetadataInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentFields` | type | Public contract documented by the source declaration. | `value: EnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentIssue` | type | Public contract documented by the source declaration. | `value: EnvironmentIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifest` | type | Public contract documented by the source declaration. | `value: EnvironmentManifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentManifestField` | type | Public contract documented by the source declaration. | `value: EnvironmentManifestField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentParseResult` | type | Public contract documented by the source declaration. | `value: EnvironmentParseResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRecord` | type | Public contract documented by the source declaration. | `value: EnvironmentRecord` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirement` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirement` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementField` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReason` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementReason` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentRequirementReportField` | type | Public contract documented by the source declaration. | `value: EnvironmentRequirementReportField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSource` | type | Public contract documented by the source declaration. | `value: EnvironmentSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnvironmentSourceInput` | type | Public contract documented by the source declaration. | `value: EnvironmentSourceInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `example` | export | Public contract documented by the source declaration. | `example` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironment` | type | Public contract documented by the source declaration. | `value: InferEnvironment` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentField` | type | Public contract documented by the source declaration. | `value: InferEnvironmentField` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEnvironmentFields` | type | Public contract documented by the source declaration. | `value: InferEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferZodEnvironmentFields` | type | Canonical fields inferred from Zod authoring inputs. | `value: InferZodEnvironmentFields` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isSource` | export | Public contract documented by the source declaration. | `isSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `manifest` | export | Public contract documented by the source declaration. | `manifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `merge` | export | Public contract documented by the source declaration. | `merge` | `apps/frontend/src/lib/auth-provider-environment.server.ts:27` uses `merge`. |
| `record` | export | Public contract documented by the source declaration. | `record` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `requirement` | export | Public contract documented by the source declaration. | `requirement` | `packages/billing/polar/src/env.ts:200` uses `requirement`. |
| `requirementReport` | export | Public contract documented by the source declaration. | `requirementReport` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `secret` | function | Define Zod-backed secret material without projecting schema examples. | `secret(...)` | `packages/billing/polar/src/env.ts:53` uses `secret`. |
| `select` | export | Public contract documented by the source declaration. | `select` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `variable` | function | Define an ordinary Zod-backed deployment variable. | `variable(...)` | `apps/frontend/src/lib/auth-provider-environment.server.ts:16` uses `variable`. |
| `ZodEnvironmentFieldInput` | type | A Zod schema or an explicitly classified environment field. | `value: ZodEnvironmentFieldInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ZodEnvironmentFieldInputs` | type | Named inputs accepted by `env.define()` in the Zod entrypoint. | `value: ZodEnvironmentFieldInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ZodEnvironmentSchema` | interface | Zod 4 schema surface used by the environment metadata adapter. | `value: ZodEnvironmentSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`environment` appears in `apps/frontend/src/lib/auth-provider-environment.server.ts:15`:

~~~~ typescript
env.environment({
		VITE_CLERK_PUBLISHABLE_KEY: env.variable(
			z.preprocess(blankStringToUndefined, z.string().optional()),
			{
~~~~

`variable` appears in `apps/frontend/src/lib/auth-provider-environment.server.ts:16`:

~~~~ typescript
VITE_CLERK_PUBLISHABLE_KEY: env.variable(
			z.preprocess(blankStringToUndefined, z.string().optional()),
			{
				description:
~~~~

`secret` appears in `packages/billing/polar/src/env.ts:53`:

~~~~ typescript
export const PolarAccessToken = env.secret(OptionalStringSchema, {
	description: 'Polar organization access token used for sandbox or production API calls.',
});
/**
~~~~

`compose` appears in `apps/frontend/src/lib/auth-provider-environment.server.ts:13`:

~~~~ typescript
const CurrentProviderEnvironment = env.compose(
	ClerkEnvironment,
	env.environment({
		VITE_CLERK_PUBLISHABLE_KEY: env.variable(
~~~~

`env` appears in `apps/frontend/src/lib/auth-provider-environment.server.ts:27`:

~~~~ typescript
env.merge(env.env, {
		CLERK_PUBLISHABLE_KEY:
			env.env.get('CLERK_PUBLISHABLE_KEY') ??
			env.env.get('VITE_CLERK_PUBLISHABLE_KEY'),
~~~~

`merge` appears in `apps/frontend/src/lib/auth-provider-environment.server.ts:27`:

~~~~ typescript
env.merge(env.env, {
		CLERK_PUBLISHABLE_KEY:
			env.env.get('CLERK_PUBLISHABLE_KEY') ??
			env.env.get('VITE_CLERK_PUBLISHABLE_KEY'),
~~~~

`requirement` appears in `packages/billing/polar/src/env.ts:200`:

~~~~ typescript
export const PolarEnvironmentRequirement = env.requirement(
	'polar',
	PolarEnvironment,
	{
~~~~

Coverage note
-------------

This generated map contains 152 public names across 4 package export targets. 21 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

