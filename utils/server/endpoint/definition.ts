import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as catalog from '@utils/catalog';
import type { CatalogEntryIdentity, DefinitionInput } from '@utils/catalog';
import * as resilience from '@utils/resilience';
import { joinPath, normalizePathTemplate, pathParameters } from './path.ts';
import type { ProblemDefinition } from '@utils/http/problem';

import type {
	EndpointCompositionInput,
	EndpointDefinition,
	EndpointResourceDefinition,
	EndpointDefinitionInput,
	EndpointDocument,
	EndpointEntry,
	EndpointExample,
	EndpointGroup,
	EndpointGroupInput,
	EndpointGroupMembers,
	EndpointGroupSelection,
	EndpointInput,
	EndpointInputSlot,
	EndpointInputSlots,
	EndpointInputSource,
	EndpointMethod,
	EndpointOperation,
	EndpointOperationDocument,
	DefinedEndpointOperation,
	EndpointOperationInput,
	EndpointOperationProblems,
	EndpointOperationResources,
	EndpointOperationResponses,
	EndpointDefinitionProblems,
	EndpointDefinitionResources,
	EndpointSchema,
	EndpointValidationIssue,
	EndpointValidationResult,
	PickEndpointInputSlots,
	SingleMethodEndpointInput,
} from './types.ts';

const inputSources = Object.freeze([
	'param',
	'query',
	'header',
	'cookie',
	'json',
	'form',
	'raw',
] as const satisfies readonly EndpointInputSource[]);
const methods = Object.freeze([
	'get',
	'post',
	'put',
	'patch',
	'delete',
	'options',
	'head',
] as const satisfies readonly EndpointMethod[]);

/** Add transport documentation to a first-class Standard Schema value. */
export function input<const Schema extends EndpointSchema>(
	schema: Schema,
	metadata: Omit<EndpointInput<Schema>, 'kind' | 'schema'> = {},
): EndpointInput<Schema> {
	assertSchema(schema);
	return Object.freeze({
		kind: 'endpoint-input',
		schema,
		...metadata,
		...(metadata.examples ? { examples: Object.freeze([...metadata.examples]) } : {}),
	});
}

/** Return the Standard Schema carried by a bare or documented input slot. */
export function schemaOf<Schema extends EndpointSchema>(slot: EndpointInputSlot<Schema>): Schema {
	return isInput(slot) ? slot.schema : slot;
}

/** Return whether a value is a documented endpoint input. */
export function isInput(value: unknown): value is EndpointInput {
	return typeof value === 'object' && value !== null &&
		(value as { kind?: unknown }).kind === 'endpoint-input' &&
		isSchema((value as { schema?: unknown }).schema);
}

/** Define one path-independent HTTP method operation. */
export function defineOperation<
	const Method extends EndpointMethod,
	const Input extends EndpointOperationInput,
>(method: Method, definition: Input): DefinedEndpointOperation<Method, Input> {
	assertId(definition.id, 'operation');
	if (!methods.includes(method)) throw new TypeError(`Unsupported endpoint method ${JSON.stringify(method)}.`);
	const inputs = pickInputs(definition);
	assertBodyCompatibility(method, inputs);
	return Object.freeze({
		...pickContributions(definition),
		...pickDocumentation(definition, definition.operationId ?? camelOperationId(definition.id)),
		kind: 'endpoint-operation',
		id: definition.id,
		description: definition.description,
		method,
		operationId: definition.operationId ?? camelOperationId(definition.id),
		inputs,
		rawResponse: definition.rawResponse ?? false,
	}) as DefinedEndpointOperation<Method, Input>;
}

/** Define a multi-method endpoint path. */
export function define<
	const Input extends EndpointDefinitionInput,
>(definition: Input): EndpointDefinition<
	Input['path'],
	PickEndpointInputSlots<Input>,
	Input['operations'],
	EndpointDefinitionResources<Input>,
	EndpointDefinitionProblems<Input>
> {
	assertId(definition.id, 'endpoint');
	assertPath(definition.path);
	if (definition.operations.length === 0) throw new TypeError('An endpoint must define at least one operation.');
	const seen = new Set<EndpointMethod>();
	for (const operation of definition.operations) {
		if (seen.has(operation.method)) {
			throw new TypeError(`Endpoint ${JSON.stringify(definition.id)} defines ${operation.method.toUpperCase()} twice.`);
		}
		seen.add(operation.method);
	}
	const inputs = pickInputs(definition);
	if (pathParameters(definition.path).length > 0 && (inputs as EndpointInputSlots).param === undefined) {
		throw new TypeError(`Endpoint ${JSON.stringify(definition.id)} has route parameters but no param schema.`);
	}
	return Object.freeze({
		...pickContributions(definition),
		...pickDocumentation(definition),
		kind: 'endpoint',
		id: definition.id,
		description: definition.description,
		path: definition.path,
		inputs,
		operations: Object.freeze([...definition.operations]),
	}) as EndpointDefinition<
		Input['path'],
		PickEndpointInputSlots<Input>,
		Input['operations'],
		EndpointDefinitionResources<Input>,
		EndpointDefinitionProblems<Input>
	>;
}

/**
 * Requires a catalog selection to contain exactly one definition when an endpoint field permits only one owner.
 *
 * Endpoint internals keep routes, schemas, responses, problems, resources, and documentation metadata in one import-safe definition model.
 *
 * @internal
 */
function single<
	const Method extends EndpointMethod,
	const Path extends string,
	const Input extends SingleMethodEndpointInput<Path>,
>(method: Method, definition: Input): EndpointDefinition<
	Path,
	PickEndpointInputSlots<Pick<Input, 'param'>>,
	readonly [DefinedEndpointOperation<Method, Input>],
	EndpointResourceDefinition,
	ProblemDefinition
> {
	assertPath(definition.path);
	if (pathParameters(definition.path).length > 0 && definition.param === undefined) {
		throw new TypeError(`Endpoint ${JSON.stringify(definition.id)} has route parameters but no param schema.`);
	}
	const operation = defineOperation(method, definition);
	const pathInputs = definition.param === undefined
		? Object.freeze(Object.create(null))
		: Object.freeze({ param: definition.param });
	return Object.freeze({
		kind: 'endpoint',
		id: definition.id,
		...(definition.description !== undefined ? { description: definition.description } : {}),
		...(definition.summary !== undefined ? { summary: definition.summary } : {}),
		...(definition.tags !== undefined ? { tags: Object.freeze([...definition.tags]) } : {}),
		...(definition.deprecated !== undefined ? { deprecated: definition.deprecated } : {}),
		...(definition.internal !== undefined ? { internal: definition.internal } : {}),
		path: definition.path,
		inputs: pathInputs,
		operations: Object.freeze([operation] as const),
	}) as EndpointDefinition<
		Path,
		PickEndpointInputSlots<Pick<Input, 'param'>>,
		readonly [DefinedEndpointOperation<Method, Input>],
		EndpointOperationResources<Input>,
		EndpointOperationProblems<Input>
	>;
}

/** Define a complete `GET` endpoint. */
export const get = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('get', definition);
/** Define a complete `POST` endpoint. */
export const post = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('post', definition);
/** Define a complete `PUT` endpoint. */
export const put = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('put', definition);
/** Define a complete `PATCH` endpoint. */
export const patch = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('patch', definition);
/** Define a complete `DELETE` endpoint. */
export const del = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('delete', definition);
/** Define a complete `OPTIONS` endpoint. */
export const options = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('options', definition);
/** Define a complete `HEAD` endpoint. */
export const head = <const Path extends string, const Input extends SingleMethodEndpointInput<Path>>(
	definition: Input,
) => single('head', definition);

/** Define a static endpoint group with shared prefix and contributions. */
export function group<
	const Path extends string,
	const Members extends EndpointGroupMembers,
>(
	definition: EndpointGroupInput<Path, Members>,
): EndpointGroup<Path, Members extends Readonly<Record<string, EndpointEntry>> ? Members : undefined> {
	assertId(definition.id, 'endpoint group');
	assertPath(definition.path);
	const named = isNamedMemberRecord(definition.endpoints) ? freezeNamedEntries(definition.endpoints) : undefined;
	const endpoints = named ? Object.values(named) : flattenComposition(definition.endpoints as EndpointCompositionInput);
	if (endpoints.length === 0) throw new TypeError('An endpoint group must contain at least one endpoint or group.');
	return Object.freeze({
		...pickContributions(definition),
		...pickDocumentation(definition),
		kind: 'endpoint-group',
		id: definition.id,
		description: definition.description,
		path: definition.path,
		endpoints: Object.freeze(endpoints),
		...(named ? { entries: named } : {}),
	}) as EndpointGroup<Path, Members extends Readonly<Record<string, EndpointEntry>> ? Members : undefined>;
}

/** Select named members from an endpoint group without copying definitions. */
export function select<
	Group extends EndpointGroup<string, Entries>,
	const Entries extends Readonly<Record<string, EndpointEntry>>,
	const Keys extends readonly (keyof Entries & string)[],
>(source: Group, keys: Keys): EndpointGroupSelection<Group, Pick<Entries, Keys[number]>> {
	if (!source.entries) throw new TypeError(`Endpoint group ${JSON.stringify(source.id)} has no named entry record.`);
	const selected: EndpointEntry[] = [];
	const uniqueKeys: string[] = [];
	const seen = new Set<string>();
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		if (!Object.hasOwn(source.entries, key)) {
			throw new TypeError(`Endpoint group ${JSON.stringify(source.id)} does not contain key ${JSON.stringify(key)}.`);
		}
		uniqueKeys.push(key);
		selected.push(source.entries[key]!);
	}
	return Object.freeze({
		kind: 'endpoint-group-selection',
		id: `${source.id}:selection:${uniqueKeys.join(',')}`,
		description: `Selection from endpoint group ${source.id}.`,
		source,
		keys: Object.freeze(uniqueKeys),
		endpoints: Object.freeze(selected),
	}) as EndpointGroupSelection<Group, Pick<Entries, Keys[number]>>;
}

/** Compose endpoint paths, groups, selections, and nested arrays. */
export function compose(...inputs: readonly EndpointCompositionInput[]): readonly EndpointEntry[] {
	const flattened = flattenComposition(inputs);
	const result: EndpointEntry[] = [];
	const seen = new Set<EndpointEntry>();
	const ids = new Map<string, EndpointEntry>();
	for (const entry of flattened) {
		const owner = ids.get(entry.id);
		if (owner && owner !== entry) throw new TypeError(`Endpoint identifier ${JSON.stringify(entry.id)} is duplicated.`);
		ids.set(entry.id, entry);
		if (seen.has(entry)) continue;
		seen.add(entry);
		result.push(entry);
	}
	return Object.freeze(result);
}

/** Validate a complete endpoint composition without acquiring runtime values. */
export function validate(input: EndpointCompositionInput): EndpointValidationResult {
	const issues: EndpointValidationIssue[] = [];
	const endpoints: EndpointDefinition[] = [];
	const endpointIds = new Map<string, EndpointEntry>();
	const operationIds = new Map<string, EndpointOperation>();
	const operationEndpoints = new Map<EndpointOperation, EndpointDefinition>();
	const routeOwners = new Map<string, EndpointDefinition>();

	walkComposition(input, '', [], (endpoint, fullPath, groups) => {
		endpoints.push(endpoint);
		const endpointOwner = endpointIds.get(endpoint.id);
		if (endpointOwner && endpointOwner !== endpoint) {
			issues.push(issue('duplicate-id', `Endpoint ID ${JSON.stringify(endpoint.id)} is duplicated.`, endpoint));
		}
		endpointIds.set(endpoint.id, endpoint);
		if (endpoint.operations.length === 0) issues.push(issue('missing-operation', `Endpoint ${endpoint.id} has no operations.`, endpoint));
		if (pathParameters(fullPath).length > 0 && endpoint.inputs.param === undefined) {
			issues.push(issue('missing-path-schema', `Endpoint ${endpoint.id} has route parameters but no param schema.`, endpoint));
		}
		const seenMethods = new Set<EndpointMethod>();
		for (const operation of endpoint.operations) {
			if (seenMethods.has(operation.method)) {
				issues.push(issue('duplicate-method', `${endpoint.id} defines ${operation.method.toUpperCase()} twice.`, operation));
			}
			seenMethods.add(operation.method);
			const operationOwner = operationIds.get(operation.id);
			if (operationOwner && operationOwner !== operation) {
				issues.push(issue('duplicate-operation-id', `Operation ID ${JSON.stringify(operation.id)} is duplicated.`, operation));
			}
			operationIds.set(operation.id, operation);
			const owningEndpoint = operationEndpoints.get(operation);
			if (owningEndpoint && owningEndpoint !== endpoint) {
				issues.push(issue(
					'duplicate-operation-id',
					`Operation ${JSON.stringify(operation.id)} is attached to both ${JSON.stringify(owningEndpoint.id)} and ${JSON.stringify(endpoint.id)}. Each imported operation must have one endpoint path owner.`,
					operation,
				));
			}
			operationEndpoints.set(operation, endpoint);
			const declaredResponses = contributionIds(operation.responses);
			const declaredProblems = [
				...groups.flatMap((group) => contributionIds(group.problems)),
				...contributionIds(endpoint.problems),
				...contributionIds(operation.problems),
			];
			if (!operation.rawResponse && declaredResponses.length === 0 && declaredProblems.length === 0) {
				issues.push(issue(
					'missing-result',
					`Operation ${operation.id} declares neither a response nor a problem result.`,
					operation,
				));
			}
			validateBody(operation, issues);
			const routeKey = `${operation.method} ${normalizePathTemplate(fullPath)}`;
			const routeOwner = routeOwners.get(routeKey);
			if (routeOwner && routeOwner !== endpoint) {
				issues.push(issue('ambiguous-route', `${routeKey} is owned by both ${routeOwner.id} and ${endpoint.id}.`, endpoint));
			}
			routeOwners.set(routeKey, endpoint);
		}
	});

	return issues.length === 0
		? Object.freeze({ valid: true, endpoints: Object.freeze(endpoints) })
		: Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

/** Create deterministic JSON-safe endpoint documentation. */
export function document(input: EndpointCompositionInput): readonly EndpointDocument[] {
	const documents: EndpointDocument[] = [];
	walkComposition(input, '', [], (endpoint, fullPath, groups) => {
		documents.push(Object.freeze({
			id: endpoint.id,
			path: fullPath,
			groupIds: Object.freeze(groups.map((item) => item.id)),
			operations: Object.freeze(endpoint.operations.map((operation): EndpointOperationDocument => Object.freeze({
				id: operation.id,
				method: operation.method,
				operationId: operation.operationId,
				...(operation.summary !== undefined ? { summary: operation.summary } : {}),
				...(operation.description !== undefined ? { description: operation.description } : {}),
				tags: operation.tags ?? Object.freeze([]),
				deprecated: operation.deprecated ?? false,
				internal: operation.internal ?? false,
				inputs: Object.freeze(inputSources.filter((source) => operation.inputs[source] !== undefined || endpoint.inputs[source] !== undefined)),
				responses: contributionIds(operation.responses),
				problems: Object.freeze([...contributionIds(endpoint.problems), ...contributionIds(operation.problems)]),
				resources: Object.freeze([...contributionIds(endpoint.resources), ...contributionIds(operation.resources)]),
			}))),
		}));
	});
	return Object.freeze(documents);
}

/** Validate a value against any Standard Schema-compatible contract. */
export async function match<Schema extends EndpointSchema>(
	schema: Schema,
	value: unknown,
): Promise<
	| Readonly<{ readonly success: true; readonly value: StandardSchemaV1.InferOutput<Schema> }>
	| Readonly<{ readonly success: false; readonly issues: readonly StandardSchemaV1.Issue[] }>
> {
	const result = await schema['~standard'].validate(value);
	return result.issues
		? Object.freeze({ success: false, issues: Object.freeze([...result.issues]) })
		: Object.freeze({ success: true, value: result.value as StandardSchemaV1.InferOutput<Schema> });
}

/**
 * Builds the operation helper consumed by endpoint definition and request contracts.
 *
 * @internal
 */
function operationHelper<const Method extends EndpointMethod>(method: Method) {
	return <const Input extends EndpointOperationInput>(definition: Input) => defineOperation(method, definition);
}

/** Path-independent operation constructors. */
export const operation = Object.freeze({
	define: <const Method extends EndpointMethod, const Input extends EndpointOperationInput>(definition: Input & { readonly method: Method }) =>
		defineOperation(definition.method, definition),
	get: operationHelper('get'),
	post: operationHelper('post'),
	put: operationHelper('put'),
	patch: operationHelper('patch'),
	delete: operationHelper('delete'),
	options: operationHelper('options'),
	head: operationHelper('head'),
});

/**
 * Traverses composition in deterministic order for endpoint definition and request contracts.
 *
 * Endpoint internals keep routes, schemas, responses, problems, resources, and documentation metadata in one import-safe definition model.
 *
 * @internal
 */
function walkComposition(
	input: EndpointCompositionInput,
	prefix: string,
	groups: readonly EndpointGroup[],
	accept: (endpoint: EndpointDefinition, fullPath: string, groups: readonly EndpointGroup[]) => void,
): void {
	for (const entry of flattenComposition(input)) {
		if (entry.kind === 'endpoint') {
			accept(entry, joinPath(prefix, entry.path), groups);
			continue;
		}
		if (entry.kind === 'endpoint-group-selection') {
			walkComposition(entry.endpoints, prefix, groups, accept);
			continue;
		}
		walkComposition(entry.endpoints, joinPath(prefix, entry.path), [...groups, entry], accept);
	}
}

/**
 * Flattens composition into the ordered representation consumed by endpoint definition and request contracts.
 *
 * @internal
 */
function flattenComposition(input: EndpointCompositionInput): EndpointEntry[] {
	if (Array.isArray(input)) return input.flatMap((item) => flattenComposition(item));
	return [input as EndpointEntry];
}

/**
 * Selects inputs needed by the next phase without redefining them.
 *
 * @internal
 */
function pickInputs<Input extends EndpointInputSlots>(definition: Input): PickEndpointInputSlots<Input> {
	const result: Record<string, EndpointInputSlot> = Object.create(null);
	for (const source of inputSources) {
		const slot = definition[source];
		if (slot === undefined) continue;
		assertSchema(schemaOf(slot));
		result[source] = slot;
	}
	return Object.freeze(result) as PickEndpointInputSlots<Input>;
}

/**
 * Selects contributions needed by the next phase without redefining them.
 *
 * It keeps route, input, response, resource, and generated-documentation semantics in one import-safe endpoint model.
 *
 * @internal
 */
function pickContributions(definition: object): EndpointContributionsRecord {
	const source = definition as Readonly<Record<PropertyKey, unknown>>;
	const result: EndpointContributionsRecord = {};
	for (const key of ['middleware', 'authentication', 'permissions', 'entitlements', 'billing', 'resources', 'problems', 'responses', 'resiliency'] as const) {
		const value = source[key];
		if (value === undefined) continue;
		if (key === 'resiliency') {
			result[key] = resilience.compose(value as import('@utils/resilience').ResilienceInput);
			continue;
		}
		result[key] = snapshotInput(value);
	}
	return result;
}

type EndpointContributionsRecord = Record<string, unknown>;

/**
 * Captures the snapshot input as immutable state for endpoint definition and request contracts.
 *
 * @internal
 */
function snapshotInput<Value>(value: Value): Value {
	if (!Array.isArray(value)) return value;
	return Object.freeze(value.map((entry) => snapshotInput(entry))) as Value;
}

/**
 * Selects documentation needed by the next phase without redefining them.
 *
 * It keeps route, input, response, resource, and generated-documentation semantics in one import-safe endpoint model.
 *
 * @internal
 */
function pickDocumentation(
	definition: object,
	operationId?: string,
): Readonly<Record<string, unknown>> {
	const source = definition as Readonly<Record<PropertyKey, unknown>>;
	return {
		...(operationId !== undefined ? { operationId } : {}),
		...(source.summary !== undefined ? { summary: source.summary } : {}),
		...(source.description !== undefined ? { description: source.description } : {}),
		...(source.tags !== undefined ? { tags: Object.freeze([...(source.tags as readonly string[])]) } : {}),
		...(source.deprecated !== undefined ? { deprecated: source.deprecated } : {}),
		...(source.internal !== undefined ? { internal: source.internal } : {}),
	};
}

/**
 * Checks body and preserves the deterministic issues needed by callers.
 *
 * @internal
 */
function validateBody(operation: EndpointOperation, issues: EndpointValidationIssue[]): void {
	const inputs = operation.inputs;
	const bodySources = [inputs.json, inputs.form, inputs.raw].filter((value) => value !== undefined).length;
	if (bodySources > 1) {
		issues.push(issue('raw-body-conflict', `${operation.id} declares more than one body input mode (json, form, or raw).`, operation));
	}
	if ((operation.method === 'get' || operation.method === 'head') &&
		(inputs.raw !== undefined || inputs.json !== undefined || inputs.form !== undefined)) {
		issues.push(issue('body-method-conflict', `${operation.method.toUpperCase()} operation ${operation.id} cannot declare a body.`, operation));
	}
}

/**
 * Rejects invalid body compatibility before it can enter authoritative module state.
 *
 * @internal
 */
function assertBodyCompatibility(method: EndpointMethod, inputs: EndpointInputSlots): void {
	const issues: EndpointValidationIssue[] = [];
	validateBody({ id: 'operation', kind: 'endpoint-operation', description: '', method, operationId: '', inputs, rawResponse: false } as EndpointOperation, issues);
	if (issues.length > 0) throw new TypeError(issues[0]!.message);
}

/**
 * Collects the contribution ids used to preserve stable identity in endpoint definition and request contracts.
 *
 * @internal
 */
function contributionIds(value: unknown): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	try {
		return Object.freeze(catalog.values(value as DefinitionInput<CatalogEntryIdentity>).map((entry) => entry.id));
	} catch {
		return Object.freeze([]);
	}
}


/**
 * Derives a stable camel-case OpenAPI operation ID from the endpoint method and route identity.
 *
 * @internal
 */
function camelOperationId(id: string): string {
	return id.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part, index) =>
		index === 0 ? part.toLowerCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`
	).join('');
}

/**
 * Checks whether named member record satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isNamedMemberRecord(value: EndpointGroupMembers): value is Readonly<Record<string, EndpointEntry>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) &&
		!('kind' in value) && Object.values(value).every((entry) => isEntry(entry));
}

/**
 * Snapshots named entries so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeNamedEntries<Entries extends Readonly<Record<string, EndpointEntry>>>(entries: Entries): Entries {
	const result: Record<string, EndpointEntry> = Object.create(null);
	for (const [key, entry] of Object.entries(entries)) result[key] = entry;
	return Object.freeze(result) as Entries;
}

/**
 * Checks whether entry satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isEntry(value: unknown): value is EndpointEntry {
	return typeof value === 'object' && value !== null &&
		['endpoint', 'endpoint-group', 'endpoint-group-selection'].includes(String((value as { kind?: unknown }).kind));
}

/**
 * Rejects invalid schema before it can enter authoritative module state.
 *
 * @internal
 */
function assertSchema(value: unknown): asserts value is EndpointSchema {
	if (!isSchema(value)) throw new TypeError('Endpoint input must implement Standard Schema.');
}

/**
 * Checks whether schema satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function isSchema(value: unknown): value is EndpointSchema {
	return typeof value === 'object' && value !== null &&
		typeof (value as { ['~standard']?: { validate?: unknown } })['~standard']?.validate === 'function';
}

/**
 * Rejects invalid id before it can enter authoritative module state.
 *
 * @internal
 */
function assertId(id: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(id)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(id)}.`);
}

/**
 * Rejects invalid path before it can enter authoritative module state.
 *
 * @internal
 */
function assertPath(path: string): void {
	if (!path.startsWith('/')) throw new TypeError(`Endpoint path ${JSON.stringify(path)} must begin with /.`);
	if (path.includes('?') || path.includes('#')) throw new TypeError('Endpoint paths cannot contain query strings or fragments.');
	if (path.includes('//')) throw new TypeError(`Endpoint path ${JSON.stringify(path)} must not contain empty path segments.`);
	if (path.length > 1 && path.endsWith('/')) throw new TypeError(`Endpoint path ${JSON.stringify(path)} must not end with /.`);
}

/**
 * Checks whether sue satisfies the condition required by endpoint definition and request contracts.
 *
 * @internal
 */
function issue(
	code: EndpointValidationIssue['code'],
	message: string,
	definition?: EndpointEntry | EndpointOperation,
): EndpointValidationIssue {
	return Object.freeze({ code, message, ...(definition !== undefined ? { definition } : {}) });
}

/**
 * Rejects invalid definition description before it can enter authoritative module state.
 *
 * @internal
 */
function assertDefinitionDescription(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
