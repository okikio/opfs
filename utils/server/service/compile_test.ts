import { expect } from '@std/expect';
import { describe, it } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';

import * as endpoint from '@utils/server/endpoint';
import * as failure from '@utils/failure';
import * as response from '@utils/http/response';
import * as resilience from '@utils/resilience';
import * as problem from '@utils/http/problem';
import * as resource from '@utils/resource';
import * as service from './mod.ts';

function schema<Output>(jsonSchema: Readonly<Record<string, unknown>>): StandardSchemaV1<unknown, Output> & endpoint.StandardJsonSchemaV1 {
	return {
		'~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as Output }) },
		'~standard-json-schema': { version: 1, vendor: 'test', jsonSchema },
	};
}

const WidgetSchema = schema<{ id: string }>({
	type: 'object',
	properties: { id: { type: 'string' } },
	required: ['id'],
});
const WidgetResponse = response.ok(WidgetSchema, { id: 'widgets:detail', description: 'Widget detail.' });
const ServiceUnavailable = problem.define({
	id: 'widgets:unavailable',
	type: 'https://api.kaiju.land/problems/widgets-unavailable',
	status: 503,
	title: 'Widgets unavailable',
	description: 'The widget service is temporarily unavailable.',
});
const RepositoryFailureData = schema<{ reason: string }>({
	type: 'object',
	properties: { reason: { type: 'string' } },
	required: ['reason'],
});
const WidgetRepositoryUnavailable = failure.define({
	id: 'widgets.repository-unavailable',
	description: 'The widget repository could not be acquired.',
	data: RepositoryFailureData,
});
const WidgetRepository = resource.define<{ readonly read: () => { id: string } }>()({
	id: 'widgets.repository',
	description: 'Widget repository.',
	failures: [WidgetRepositoryUnavailable],
});
const GetWidget = endpoint.get({
	id: 'widgets.get',
	path: '/widgets/:widgetId',
	param: schema<{ widgetId: string }>({
		type: 'object',
		properties: { widgetId: { type: 'string' } },
		required: ['widgetId'],
	}),
	resources: [WidgetRepository],
	problems: [ServiceUnavailable],
	responses: [WidgetResponse],
});
const permission = Object.freeze({ id: 'widgets:read', kind: 'permission', description: 'Read widgets.' });
const policy = service.policy({ id: 'widgets.dashboard', endpoints: [GetWidget], permissions: [permission] });
const definition = service.define({
	id: 'widgets',
	path: '/api/dashboard/v1',
	description: 'Widget APIs.',
	endpoints: [GetWidget],
	policies: [policy],
});
const handler = endpoint.handler(GetWidget, async ({ resources }) => {
	const repository = await resources.get(WidgetRepository);
	return response.create(WidgetResponse, repository.read());
});
const repository = resource.implement(WidgetRepository, {
	create() { return { read: () => ({ id: 'widget_1' }) }; },
});

describe('service compiler', () => {
	it('requires canonical service paths at definition time', () => {
		expect(() => service.define({ id: 'widgets-double-slash', path: '//api', endpoints: [GetWidget] })).toThrow('empty path segments');
		expect(() => service.define({ id: 'widgets-trailing-slash', path: '/api/', endpoints: [GetWidget] })).toThrow('must not end with /');
	});

	it('resolves one authoritative effective operation and manifest', () => {
		const compiled = service.compile(service.implement(definition, {
			endpoints: [handler],
			resources: resource.implementations(repository),
		}));
		expect(compiled.operations).toHaveLength(1);
		expect(compiled.operations[0]?.path).toBe('/api/dashboard/v1/widgets/:widgetId');
		expect(compiled.operations[0]?.permissions).toEqual([permission]);
		expect(compiled.operations[0]?.problems).toContain(ServiceUnavailable);
		expect(compiled.operations[0]?.problems.some((entry) => entry.id === WidgetRepositoryUnavailable.id)).toBe(false);
		expect(compiled.manifest.routes[0]?.endpointId).toBe(GetWidget.id);
	});

	it('fails compilation when exact handler or resource coverage is missing', () => {
		expect(() => service.compile(service.implement(definition, {
			resources: resource.implementations(repository),
		}))).toThrow(service.ServiceCompilationError);
		expect(() => service.compile(service.implement(definition, {
			endpoints: [handler],
		}))).toThrow(service.ServiceCompilationError);
	});

	it('projects the compiler-resolved route and inherited problem envelope to OpenAPI', async () => {
		const compiled = service.compile(service.implement(definition, {
			endpoints: [handler],
			resources: resource.implementations(repository),
		}));
		const document = await service.openapi(compiled, { title: 'Widgets', version: '1.0.0' });
		const operation = document.paths['/api/dashboard/v1/widgets/{widgetId}']?.get as Record<string, unknown>;
		expect(operation.operationId).toBe('widgetsGet');
		expect(Object.keys(operation.responses as Record<string, unknown>)).toContain('503');
		expect(Object.keys(operation.responses as Record<string, unknown>)).toContain('406');
		const responses = operation.responses as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
		expect('Retry-After' in ((responses['503']?.headers as Readonly<Record<string, unknown>> | undefined) ?? {})).toBe(false);
	});

	it('derives content negotiation problems from the effective request and response contract', async () => {
		const Accepted = response.accepted(WidgetSchema, {
			id: 'widgets:accepted',
			description: 'Accepted widget.',
		});
		const CreateWidget = endpoint.post({
			id: 'widgets.create',
			path: '/widgets',
			json: WidgetSchema,
			responses: [Accepted],
		});
		const CreateWidgets = service.define({
			id: 'widgets-write',
			path: '/api/v1',
			endpoints: [CreateWidget],
		});
		const CreateHandler = endpoint.handler(CreateWidget, async ({ input }) =>
			response.create(Accepted, input.json));
		const compiled = service.compile(service.implement(CreateWidgets, { endpoints: [CreateHandler] }));
		const statuses = compiled.operations[0]?.problems.map((entry) => entry.status) ?? [];
		expect(statuses).toContain(406);
		expect(statuses).toContain(415);
		const document = await service.openapi(compiled, { title: 'Widgets', version: '1.0.0' });
		const operation = document.paths['/api/v1/widgets']?.post as Record<string, unknown>;
		const responseStatuses = Object.keys(operation.responses as Record<string, unknown>);
		expect(responseStatuses).toContain('202');
		expect(responseStatuses).toContain('406');
		expect(responseStatuses).toContain('415');
	});

	it('projects idempotency and rate-limit contracts from effective resiliency', async () => {
		const Accepted = response.accepted(WidgetSchema, {
			id: 'widgets:resilient-accepted',
			description: 'Accepted resilient widget.',
		});
		const CreateWidget = endpoint.post({
			id: 'widgets.resilient-create',
			path: '/widgets',
			json: WidgetSchema,
			resiliency: [
				resilience.idempotent(),
				resilience.rateLimit({ limit: 10, window: { minutes: 1 } }),
			],
			responses: [Accepted],
		});
		const ResilientWidgets = service.define({ id: 'widgets-resilient', path: '/api/v1', endpoints: [CreateWidget] });
		const binding = endpoint.handler(CreateWidget, async ({ input }) => response.create(Accepted, input.json));
		const compiled = service.compile(service.implement(ResilientWidgets, { endpoints: [binding] }));
		const statuses = compiled.operations[0]?.problems.map((entry) => entry.status) ?? [];
		expect(statuses).toContain(409);
		expect(statuses).toContain(429);
		const document = await service.openapi(compiled, { title: 'Widgets', version: '1.0.0' });
		const operation = document.paths['/api/v1/widgets']?.post as Record<string, unknown>;
		const parameters = operation.parameters as readonly Readonly<Record<string, unknown>>[];
		expect(parameters.some((entry) => entry.in === 'header' && entry.name === 'Idempotency-Key')).toBe(true);
		const responses = operation.responses as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
		expect('Retry-After' in (responses['429']?.headers as Readonly<Record<string, unknown>>)).toBe(true);
	});

	it('snapshots service contributions and reports nested definition conflicts through one compiler error', () => {
		const inherited = problem.define({
			id: 'widgets:conflict',
			type: 'https://api.kaiju.land/problems/widgets-conflict-inherited',
			status: 409,
			title: 'Inherited conflict',
			description: 'Inherited conflict definition.',
		});
		const operationProblem = problem.define({
			id: 'widgets:conflict',
			type: 'https://api.kaiju.land/problems/widgets-conflict-operation',
			status: 409,
			title: 'Operation conflict',
			description: 'Operation conflict definition.',
		});
		const problems: problem.ProblemDefinition[] = [inherited];
		const NoContent = response.noContent();
		const ConflictingEndpoint = endpoint.get({
			id: 'widgets.conflicting',
			path: '/conflicting',
			problems: [operationProblem],
			responses: [NoContent],
		});
		const ConflictingService = service.define({
			id: 'widgets-conflicting',
			path: '/api',
			endpoints: [ConflictingEndpoint],
			problems,
		});
		problems.push(ServiceUnavailable);
		expect(ConflictingService.problems).toEqual([inherited]);

		const binding = endpoint.handler(ConflictingEndpoint, async () => response.create(NoContent, undefined));
		try {
			service.compile(service.implement(ConflictingService, { endpoints: [binding] }));
			throw new Error('Expected compilation to fail.');
		} catch (error) {
			expect(error).toBeInstanceOf(service.ServiceCompilationError);
			const compilationError = error as service.ServiceCompilationError;
			expect(compilationError.issues.some((entry) => entry.code === 'invalid-definition')).toBe(true);
		}
	});
});
