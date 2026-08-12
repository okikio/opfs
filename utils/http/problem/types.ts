import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CatalogEntryIdentity } from '@utils/catalog';
import type { HeaderInput, ResponseHeaders } from '@utils/http/response/headers';

/** Supported RFC 9457 HTTP error status. */
export type ProblemStatus = number;

/** Public severity classification used by documentation and diagnostics. */
export type ProblemSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Retry guidance attached to a problem definition. */
export type ProblemRetryPolicy =
	| { readonly kind: 'never' }
	| { readonly kind: 'immediate'; readonly maximumAttempts?: number }
	| { readonly kind: 'after'; readonly header?: string; readonly defaultSeconds?: number };

/** Provider metadata retained for internal problem catalogs. */
export interface ProblemProviderMetadata {
	readonly name: string;
	readonly code?: string;
	readonly documentation?: string;
}

/** Concrete problem example retained for generated references. */
export interface ProblemExample {
	readonly key: string;
	readonly summary?: string;
	readonly value: Readonly<Record<string, unknown>>;
}

/** Contract for extension members appended to the RFC 9457 body. */
export interface ProblemExtensionContract<Schema extends StandardSchemaV1 = StandardSchemaV1> {
	readonly schema: Schema;
	readonly description?: string;
}

/** Static immutable RFC 9457 problem definition. */
export interface ProblemDefinition<
	Extensions extends ProblemExtensionContract | undefined = ProblemExtensionContract | undefined,
	Status extends ProblemStatus = ProblemStatus,
> extends CatalogEntryIdentity {
	readonly kind: 'problem';
	readonly type: string;
	readonly status: Status;
	readonly title: string;
	readonly description: string;
	readonly remediation?: string;
	readonly externalDocumentation?: string;
	readonly localizationKey?: string;
	readonly examples?: readonly ProblemExample[];
	readonly retry?: ProblemRetryPolicy;
	readonly severity?: ProblemSeverity;
	readonly extensions?: Extensions;
	readonly exposure: 'public' | 'internal';
	readonly provider?: ProblemProviderMetadata;
}

/** Input accepted by {@link define}. */
export interface ProblemDefinitionInput<
	Extensions extends ProblemExtensionContract | undefined,
	Status extends ProblemStatus,
> {
	readonly id: string;
	readonly type: string;
	readonly status: Status;
	readonly title: string;
	readonly description: string;
	readonly remediation?: string;
	readonly externalDocumentation?: string;
	readonly localizationKey?: string;
	readonly examples?: readonly ProblemExample[];
	readonly retry?: ProblemRetryPolicy;
	readonly severity?: ProblemSeverity;
	readonly extensions?: Extensions;
	readonly exposure?: 'public' | 'internal';
	readonly provider?: ProblemProviderMetadata;
}

/** Canonical RFC 9457 members plus definition-specific extensions. */
export type ProblemBody<Definition extends ProblemDefinition = ProblemDefinition> = Readonly<{
	type: Definition['type'];
	title: Definition['title'];
	status: Definition['status'];
	detail?: string;
	instance?: string;
	[key: string]: unknown;
}>;

/** Immutable headers attached to a problem result. */
export type ProblemHeaders = ResponseHeaders;

/** Options supplied while creating one problem occurrence. */
export interface CreateProblemOptions<Extensions extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
	readonly detail?: string;
	readonly instance?: string;
	readonly extensions?: Extensions;
	readonly headers?: HeaderInput;
	readonly cause?: unknown;
}

/** Hidden metadata retained by a problem tuple. */
export interface ProblemResultMetadata<Definition extends ProblemDefinition = ProblemDefinition> {
	readonly definition: Definition;
	readonly cause?: unknown;
}

/** Logical RFC 9457 response tuple returned before server materialization. */
export type ProblemResult<
	Definition extends ProblemDefinition = ProblemDefinition,
	Body extends ProblemBody<Definition> = ProblemBody<Definition>,
	Headers extends ProblemHeaders = ProblemHeaders,
> = readonly [body: Body, status: Definition['status'], headers: Headers];

/** JSON-safe problem documentation projection. */
export interface ProblemDocument {
	readonly key?: string;
	readonly id: string;
	readonly type: string;
	readonly status: ProblemStatus;
	readonly title: string;
	readonly description: string;
	readonly remediation?: string;
	readonly externalDocumentation?: string;
	readonly retry: ProblemRetryPolicy;
	readonly severity: ProblemSeverity;
	readonly exposure: 'public' | 'internal';
	readonly examples: readonly ProblemExample[];
	readonly provider?: ProblemProviderMetadata;
}
