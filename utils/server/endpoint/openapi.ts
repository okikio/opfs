import { joinPath, pathParameters } from './path.ts';
import * as catalog from '@utils/catalog'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ProblemDefinition } from '@utils/http/problem'
import type { ResponseDefinition, ResponseExample } from '@utils/http/response'

import { schemaOf, validate } from './definition.ts'
import type {
	EndpointCompositionInput,
	EndpointDefinition,
	EndpointEntry,
	EndpointExample,
	EndpointGroup,
	EndpointInputSlot,
	EndpointInputSource,
	EndpointOperation,
} from './types.ts'

/** Minimal Standard JSON Schema trait used without coupling to a schema library. */
export interface StandardJsonSchemaV1 {
	readonly '~standard-json-schema': {
		readonly version: 1
		readonly vendor: string
		readonly jsonSchema: unknown | (() => unknown | Promise<unknown>)
	}
}

/** OpenAPI 3.1 document generated from one endpoint composition. */
export interface OpenApiDocument {
	readonly openapi: '3.1.0'
	readonly info: Readonly<{
		readonly title: string
		readonly version: string
		readonly description?: string
	}>
	readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/** Options for the endpoint-only OpenAPI projection. */
export interface OpenApiOptions {
	readonly title: string
	readonly version: string
	readonly description?: string
	readonly includeInternal?: boolean
}

interface EndpointVisit {
	readonly endpoint: EndpointDefinition
	readonly path: string
	readonly groups: readonly EndpointGroup[]
}

/**
 * Generate an endpoint-only OpenAPI document from the exact imported graph.
 *
 * Service-level authentication schemes, servers, and compiler-generated
 * failures are added after effective-operation resolution by `service.openapi`.
 */
export async function openapi(
	input: EndpointCompositionInput,
	options: OpenApiOptions,
): Promise<OpenApiDocument> {
	const validation = validate(input)
	if (!validation.valid) {
		throw new TypeError(
			`Cannot project invalid endpoint definitions:\n${validation.issues.map((issue) => `- ${issue.message}`).join('\n')}`,
		)
	}

	const paths: Record<string, Record<string, unknown>> = Object.create(null)
	for (const visit of walk(input)) {
		const path = openApiPath(visit.path)
		const pathItem = paths[path] ??= Object.create(null) as Record<string, unknown>
		for (const operation of visit.endpoint.operations) {
			const internal = isInternal(visit.groups, visit.endpoint, operation)
			if (internal && !options.includeInternal) continue
			if (pathItem[operation.method] !== undefined) {
				throw new TypeError(
					`OpenAPI path ${operation.method.toUpperCase()} ${path} is declared more than once.`,
				)
			}
			pathItem[operation.method] = await operationObject(visit, operation, internal)
		}
	}

	return deepFreeze({
		openapi: '3.1.0' as const,
		info: {
			title: options.title,
			version: options.version,
			...(options.description !== undefined ? { description: options.description } : {}),
		},
		paths,
	})
}

/**
 * Projects one endpoint operation into its OpenAPI request parameters, body, responses, and internal-operation metadata.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
async function operationObject(
	visit: EndpointVisit,
	operation: EndpointOperation,
	internal: boolean,
): Promise<Readonly<Record<string, unknown>>> {
	const parameters: unknown[] = []
	let requestBody: unknown
	for (const source of [
		'param',
		'query',
		'header',
		'cookie',
		'json',
		'form',
		'raw',
	] as const satisfies readonly EndpointInputSource[]) {
		const slot = operation.inputs[source] ?? visit.endpoint.inputs[source]
		if (!slot) continue
		const schema = await projectSchema(slot, internal)
		if (source === 'json' || source === 'form' || source === 'raw') {
			requestBody = requestBodyObject(source, slot, schema)
			continue
		}
		parameters.push(...parameterObjects(source, slot, schema, visit.path))
	}

	const responses = await responseObjects(
		operation,
		problemDefinitions(visit.groups, visit.endpoint, operation),
		internal,
	)
	const tags = uniqueStrings([
		...visit.groups.flatMap((group) => group.tags ?? []),
		...(visit.endpoint.tags ?? []),
		...(operation.tags ?? []),
	])

	return deepFreeze({
		operationId: operation.operationId,
		...(operation.summary !== undefined ? { summary: operation.summary } : {}),
		...(operation.description !== undefined ? { description: operation.description } : {}),
		...(tags.length > 0 ? { tags } : {}),
		...(operation.deprecated === true ? { deprecated: true } : {}),
		...(parameters.length > 0 ? { parameters } : {}),
		...(requestBody !== undefined ? { requestBody } : {}),
		responses,
	})
}

/**
 * Projects a validated endpoint input slot into OpenAPI parameter objects with the correct source and requiredness.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function parameterObjects(
	source: 'param' | 'query' | 'header' | 'cookie',
	slot: EndpointInputSlot,
	schema: unknown,
	path: string,
): readonly Readonly<Record<string, unknown>>[] {
	const object = asJsonObject(schema)
	const documentedInput = documented(slot)
	if (!object || !isRecord(object.properties)) {
		if (source === 'param') {
			throw new TypeError(`Path schema for ${path} must project an object with one property per route parameter.`)
		}
		return [deepFreeze({
			in: source,
			name: source,
			required: documentedInput?.required ?? false,
			schema,
			...(documentedInput?.description !== undefined ? { description: documentedInput.description } : {}),
			...examplesObject(documentedInput?.examples),
		})]
	}

	const properties = object.properties
	const required = new Set(Array.isArray(object.required) ? object.required.filter(isString) : [])
	const pathNames = source === 'param' ? pathParameters(path) : []
	if (source === 'param') {
		const projectedNames = Object.keys(properties)
		const missing = pathNames.filter((name) => !projectedNames.includes(name))
		const extra = projectedNames.filter((name) => !pathNames.includes(name))
		if (missing.length > 0 || extra.length > 0) {
			throw new TypeError(
				`Path parameter schema for ${path} does not match the route template ` +
				`(missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`,
			)
		}
	}

	return Object.freeze(Object.entries(properties).map(([name, property]) => {
		const nestedObject = asJsonObject(property)?.type === 'object'
		const nestedArray = asJsonObject(property)?.type === 'array'
		return deepFreeze({
			in: source,
			name,
			required: source === 'param' || required.has(name),
			schema: property,
			...(documentedInput?.description !== undefined && Object.keys(properties).length === 1
				? { description: documentedInput.description }
				: {}),
			...(source === 'query' && nestedObject ? { style: 'deepObject', explode: true } : {}),
			...(source === 'query' && nestedArray ? { style: 'form', explode: false } : {}),
		})
	}))
}

/**
 * Projects JSON, form, or raw endpoint input into the OpenAPI request-body shape.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function requestBodyObject(
	source: 'json' | 'form' | 'raw',
	slot: EndpointInputSlot,
	schema: unknown,
): Readonly<Record<string, unknown>> {
	const input = documented(slot)
	const mediaType = input?.contentType ?? defaultContentType(source)
	return deepFreeze({
		required: input?.required ?? true,
		...(input?.description !== undefined ? { description: input.description } : {}),
		content: {
			[mediaType]: {
				schema,
				...examplesObject(input?.examples),
			},
		},
	})
}

/**
 * Projects declared successful responses and problems into the OpenAPI response map for one operation.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
async function responseObjects(
	operation: EndpointOperation,
	problems: readonly ProblemDefinition[],
	internal: boolean,
): Promise<Readonly<Record<string, unknown>>> {
	const byStatus = new Map<string, Readonly<Record<string, unknown>>[]>()
	for (const definition of definitionValues<ResponseDefinition>(operation.responses)) {
		appendStatus(byStatus, String(definition.status), await successResponseObject(definition, internal))
	}
	for (const definition of problems) {
		if (definition.exposure === 'internal' && !internal) continue
		appendStatus(byStatus, String(definition.status), await problemResponseObject(definition, internal))
	}
	if (byStatus.size === 0) {
		if (!operation.rawResponse) {
			throw new TypeError(`Public operation ${operation.id} declares no response or problem definitions.`)
		}
		byStatus.set('default', [deepFreeze({ description: 'Undocumented raw response.' })])
	}

	const result: Record<string, unknown> = Object.create(null)
	for (const [status, candidates] of byStatus) {
		result[status] = candidates.length === 1 ? candidates[0] : mergeResponses(candidates)
	}
	return deepFreeze(result)
}

/**
 * Builds the success response object consumed by the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
async function successResponseObject(
	definition: ResponseDefinition,
	internal: boolean,
): Promise<Readonly<Record<string, unknown>>> {
	const contentType = definition.contentType ?? defaultResponseContentType(definition)
	const result: Record<string, unknown> = {
		description: definition.description,
	}
	if (definition.headers && Object.keys(definition.headers).length > 0) {
		result.headers = Object.fromEntries(Object.entries(definition.headers).map(([name, value]) => [
			name,
			deepFreeze({ schema: { type: 'string' }, example: value }),
		]))
	}
	if (definition.schema !== undefined && definition.mode !== 'empty' && definition.mode !== 'redirect') {
		const projected = await projectBareSchema(definition.schema, internal)
		result.content = {
			[contentType]: {
				schema: responseBodySchema(definition, projected),
				...responseExamplesObject(definition.examples),
			},
		}
	}
	if (definition.mode === 'redirect') {
		result.headers = {
			...(isRecord(result.headers) ? result.headers : {}),
			Location: { schema: { type: 'string', format: 'uri-reference' } },
		}
	}
	return deepFreeze(result)
}

/**
 * Builds the response body schema used to validate data entering the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function responseBodySchema(definition: ResponseDefinition, schema: unknown): unknown {
	if (definition.mode === 'page') {
		const pagination = definition.pagination
		return deepFreeze({
			type: 'object',
			required: ['data', 'meta'],
			properties: {
				data: { type: 'array', items: schema },
				meta: {
					type: 'object',
					required: ['pagination'],
					properties: {
						pagination: paginationMetadataSchema(
							pagination?.totals === 'body' || pagination?.totals === 'both',
						),
					},
					additionalProperties: true,
				},
				...((pagination?.links === 'body' || pagination?.links === 'both')
					? { links: paginationLinksSchema() }
					: {}),
			},
			additionalProperties: false,
		})
	}
	if (definition.envelope === 'data' || definition.timestamp) {
		return deepFreeze({
			type: 'object',
			required: ['data'],
			properties: {
				data: schema,
				meta: {
					type: 'object',
					...(definition.timestamp
						? { properties: { timestamp: { type: 'string', format: 'date-time' } } }
						: {}),
					additionalProperties: true,
				},
			},
			additionalProperties: false,
		})
	}
	return schema
}

/**
 * Builds the pagination metadata schema used to validate data entering the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function paginationMetadataSchema(includeTotals: boolean): Readonly<Record<string, unknown>> {
	return deepFreeze({
		type: 'object',
		required: ['kind', 'limit', 'hasMore'],
		properties: {
			kind: { type: 'string', enum: ['cursor', 'offset'] },
			limit: { type: 'integer', minimum: 1 },
			hasMore: { type: 'boolean' },
			cursor: { type: 'string' },
			offset: { type: 'integer', minimum: 0 },
			page: { type: 'integer', minimum: 1 },
			perPage: { type: 'integer', minimum: 1 },
			...(includeTotals
				? {
					total: { type: 'integer', minimum: 0 },
					approximateTotal: { type: 'integer', minimum: 0 },
					totalPages: { type: 'integer', minimum: 0 },
				}
				: {}),
			expiresAt: { type: 'string', format: 'date-time' },
		},
		additionalProperties: false,
	})
}

/**
 * Builds the pagination links schema used to validate data entering the endpoint OpenAPI projection.
 *
 * @internal
 */
function paginationLinksSchema(): Readonly<Record<string, unknown>> {
	const link = { type: 'string', format: 'uri-reference' }
	return deepFreeze({
		type: 'object',
		properties: { self: link, first: link, previous: link, next: link, last: link },
		additionalProperties: false,
	})
}

/**
 * Builds the problem response object consumed by the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
async function problemResponseObject(
	definition: ProblemDefinition,
	internal: boolean,
): Promise<Readonly<Record<string, unknown>>> {
	const extensionSchema = definition.extensions === undefined
		? undefined
		: await projectBareSchema(definition.extensions.schema, internal)
	const extensionObject = asJsonObject(extensionSchema)
	const properties = {
		type: { type: 'string', const: definition.type, format: 'uri-reference' },
		title: { type: 'string', const: definition.title },
		status: { type: 'integer', const: definition.status },
		detail: { type: 'string' },
		instance: { type: 'string', format: 'uri-reference' },
		...(extensionObject && isRecord(extensionObject.properties) ? extensionObject.properties : {}),
	}
	return deepFreeze({
		description: definition.description,
		content: {
			'application/problem+json': {
				schema: {
					type: 'object',
					properties,
					required: ['type', 'title', 'status'],
					additionalProperties: extensionObject?.additionalProperties ?? true,
				},
				...problemExamplesObject(definition),
			},
		},
	})
}

/**
 * Merges response projections while rejecting status-code collisions between success and problem definitions.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function mergeResponses(
	responses: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> {
	const descriptions = uniqueStrings(responses.map((response) => String(response.description ?? '')).filter(Boolean))
	const media = new Map<string, unknown[]>()
	const headers: Record<string, unknown> = Object.create(null)
	for (const response of responses) {
		if (isRecord(response.headers)) Object.assign(headers, response.headers)
		if (!isRecord(response.content)) continue
		for (const [contentType, value] of Object.entries(response.content)) {
			if (!isRecord(value)) continue
			const schemas = media.get(contentType) ?? []
			if (value.schema !== undefined) schemas.push(value.schema)
			media.set(contentType, schemas)
		}
	}
	const content: Record<string, unknown> = Object.create(null)
	for (const [contentType, schemas] of media) {
		content[contentType] = {
			schema: schemas.length === 1 ? schemas[0] : { oneOf: schemas },
		}
	}
	return deepFreeze({
		description: descriptions.join(' / ') || 'Response.',
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(Object.keys(content).length > 0 ? { content } : {}),
	})
}

/**
 * Adds one status-code response to the OpenAPI map and rejects a duplicate status owner.
 *
 * @internal
 */
function appendStatus(
	byStatus: Map<string, Readonly<Record<string, unknown>>[]>,
	status: string,
	value: Readonly<Record<string, unknown>>,
): void {
	const values = byStatus.get(status) ?? []
	values.push(value)
	byStatus.set(status, values)
}

/**
 * Projects schema into the narrower representation used by the endpoint OpenAPI projection.
 *
 * @internal
 */
async function projectSchema(slot: EndpointInputSlot, internal: boolean): Promise<unknown> {
	const input = documented(slot)
	if (input?.jsonSchema !== undefined) return deepFreeze(input.jsonSchema)
	return await projectBareSchema(schemaOf(slot), internal)
}

/**
 * Projects bare schema into the narrower representation used by the endpoint OpenAPI projection.
 *
 * @internal
 */
async function projectBareSchema(schema: StandardSchemaV1, internal: boolean): Promise<unknown> {
	const trait = (schema as StandardSchemaV1 & Partial<StandardJsonSchemaV1>)['~standard-json-schema']
	if (!trait) {
		if (internal) return deepFreeze({})
		throw new TypeError('Public endpoint schema has no Standard JSON Schema projection.')
	}
	return deepFreeze(typeof trait.jsonSchema === 'function' ? await trait.jsonSchema() : trait.jsonSchema)
}

/**
 * Collects the problem definitions that the endpoint OpenAPI projection can expose as transport failures.
 *
 * @internal
 */
function problemDefinitions(
	groups: readonly EndpointGroup[],
	endpoint: EndpointDefinition,
	operation: EndpointOperation,
): readonly ProblemDefinition[] {
	return uniqueDefinitions([
		...groups.flatMap((group) => definitionValues<ProblemDefinition>(group.problems)),
		...definitionValues<ProblemDefinition>(endpoint.problems),
		...definitionValues<ProblemDefinition>(operation.problems),
	])
}

/**
 * Returns the definition values consumed by the endpoint OpenAPI projection.
 *
 * @internal
 */
function definitionValues<Entry extends { readonly id: string; readonly kind: string }>(
	input: unknown,
): readonly Entry[] {
	if (input === undefined) return Object.freeze([])
	return catalog.values(input as Parameters<typeof catalog.values<Entry>>[0])
}

/**
 * Traverses walk in deterministic order for the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function walk(input: EndpointCompositionInput): readonly EndpointVisit[] {
	const result: EndpointVisit[] = []
	const visit = (
		value: EndpointCompositionInput,
		prefix: string,
		groups: readonly EndpointGroup[],
	): void => {
		for (const entry of flatten(value)) {
			if (entry.kind === 'endpoint') {
				result.push(Object.freeze({ endpoint: entry, path: joinPath(prefix, entry.path), groups }))
				continue
			}
			if (entry.kind === 'endpoint-group-selection') {
				visit(entry.endpoints, prefix, groups)
				continue
			}
			visit(entry.endpoints, joinPath(prefix, entry.path), Object.freeze([...groups, entry]))
		}
	}
	visit(input, '', Object.freeze([]))
	return Object.freeze(result)
}

/**
 * Flattens flatten into the ordered representation consumed by the endpoint OpenAPI projection.
 *
 * @internal
 */
function flatten(input: EndpointCompositionInput): readonly EndpointEntry[] {
	return Array.isArray(input)
		? Object.freeze(input.flatMap((entry) => flatten(entry)))
		: Object.freeze([input as EndpointEntry])
}

/**
 * Checks whether internal satisfies the condition required by the endpoint OpenAPI projection.
 *
 * @internal
 */
function isInternal(
	groups: readonly EndpointGroup[],
	endpoint: EndpointDefinition,
	operation: EndpointOperation,
): boolean {
	return groups.some((group) => group.internal === true) ||
		endpoint.internal === true ||
		operation.internal === true
}

/**
 * Projects schema documentation metadata only when the Standard Schema implementation exposes it.
 *
 * @internal
 */
function documented(slot: EndpointInputSlot) {
	return typeof slot === 'object' && slot !== null && (slot as { kind?: unknown }).kind === 'endpoint-input'
		? slot as Extract<EndpointInputSlot, { kind: 'endpoint-input' }>
		: undefined
}

/**
 * Builds the examples object consumed by the endpoint OpenAPI projection.
 *
 * @internal
 */
function examplesObject(examples: readonly EndpointExample[] | undefined): Readonly<Record<string, unknown>> {
	if (!examples || examples.length === 0) return Object.freeze({})
	return deepFreeze({
		examples: Object.fromEntries(examples.map((example) => [example.key, {
			...(example.summary !== undefined ? { summary: example.summary } : {}),
			...(example.description !== undefined ? { description: example.description } : {}),
			value: example.value,
		}])),
	})
}

/**
 * Builds the response examples object consumed by the endpoint OpenAPI projection.
 *
 * @internal
 */
function responseExamplesObject(examples: readonly ResponseExample[] | undefined): Readonly<Record<string, unknown>> {
	if (!examples || examples.length === 0) return Object.freeze({})
	return deepFreeze({
		examples: Object.fromEntries(examples.map((example) => [example.key, {
			...(example.summary !== undefined ? { summary: example.summary } : {}),
			...(example.description !== undefined ? { description: example.description } : {}),
			value: example.value,
		}])),
	})
}

/**
 * Builds the problem examples object consumed by the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function problemExamplesObject(definition: ProblemDefinition): Readonly<Record<string, unknown>> {
	if (!definition.examples || definition.examples.length === 0) return Object.freeze({})
	return deepFreeze({
		examples: Object.fromEntries(definition.examples.map((example) => [example.key, {
			...(example.summary !== undefined ? { summary: example.summary } : {}),
			value: {
				type: definition.type,
				title: definition.title,
				status: definition.status,
				...example.value,
			},
		}])),
	})
}

/**
 * Creates the fallback content type used when the endpoint OpenAPI projection receives no explicit value.
 *
 * @internal
 */
function defaultContentType(source: 'json' | 'form' | 'raw'): string {
	if (source === 'json') return 'application/json'
	if (source === 'form') return 'application/x-www-form-urlencoded'
	return 'application/octet-stream'
}

/**
 * Creates the fallback response content type used when the endpoint OpenAPI projection receives no explicit value.
 *
 * @internal
 */
function defaultResponseContentType(definition: ResponseDefinition): string {
	if (definition.mode === 'download' || definition.mode === 'stream') return 'application/octet-stream'
	if (definition.mode === 'html') return 'text/html; charset=utf-8'
	return 'application/json'
}

/**
 * Opens api path for the endpoint OpenAPI projection and leaves its cleanup with the established owner.
 *
 * @internal
 */
function openApiPath(path: string): string {
	return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
}



/**
 * Builds the as json object consumed by the endpoint OpenAPI projection.
 *
 * @internal
 */
function asJsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return isRecord(value) ? value : undefined
}

/**
 * Checks whether record satisfies the condition required by the endpoint OpenAPI projection.
 *
 * @internal
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether string satisfies the condition required by the endpoint OpenAPI projection.
 *
 * @internal
 */
function isString(value: unknown): value is string {
	return typeof value === 'string'
}

/**
 * Generates the unique strings without colliding with identities already owned by the endpoint OpenAPI projection.
 *
 * @internal
 */
function uniqueStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)])
}

/**
 * Generates the unique definitions without colliding with identities already owned by the endpoint OpenAPI projection.
 *
 * The projection is derived from the exact imported endpoint graph so generated documentation cannot drift from executable contracts.
 *
 * @internal
 */
function uniqueDefinitions<Entry extends { readonly id: string }>(values: readonly Entry[]): readonly Entry[] {
	const result: Entry[] = []
	const owners = new Map<string, Entry>()
	const seen = new Set<Entry>()
	for (const value of values) {
		const owner = owners.get(value.id)
		if (owner && owner !== value) throw new TypeError(`Definition ID ${JSON.stringify(value.id)} belongs to different objects.`)
		owners.set(value.id, value)
		if (!seen.has(value)) {
			seen.add(value)
			result.push(value)
		}
	}
	return Object.freeze(result)
}

/**
 * Recursively freezes the value graph so the endpoint OpenAPI projection cannot observe later caller mutation.
 *
 * @internal
 */
function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
	for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
	return Object.freeze(value)
}
