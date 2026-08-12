import * as endpoint from '@utils/server/endpoint';
import * as resource from '@utils/resource';

import type {
	ServiceDefinition,
	ServiceImplementation,
	ServiceImplementationInput,
} from './types.ts';

/** Bind an exact service definition to its HTTP endpoint, middleware, and resource implementations. */
export function implement<
	Definition extends ServiceDefinition,
	Host extends object = import('@utils/server/endpoint').EmptyEndpointHost,
>(
	definition: Definition,
	input: ServiceImplementationInput<Host>,
): ServiceImplementation<Definition, Host> {
	const endpointBindings = endpoint.handlers(...(input.endpoints ?? []));
	const middleware = Object.freeze([...(input.middleware ?? [])]);
	const resources = input.resources ?? resource.implementations();
	return Object.freeze({
		kind: 'service-implementation',
		definition,
		endpoints: endpointBindings,
		middleware,
		resources,
		...(input.hostType !== undefined ? { hostType: input.hostType } : {}),
	});
}
