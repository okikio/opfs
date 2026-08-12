import * as problem from '@utils/http/problem';

/** Framework-owned failures emitted before an origin service receives a request. */
export const GatewayProblems = problem.catalog('gateway', {
	NotFound: problem.define({
		id: 'gateway:not-found',
		type: 'https://api.kaiju.land/problems/gateway-route-not-found',
		status: 404,
		title: 'Route not found',
		description: 'The gateway does not own the requested method and path.',
	}),
	BodyTooLarge: problem.define({
		id: 'gateway:body-too-large',
		type: 'https://api.kaiju.land/problems/gateway-body-too-large',
		status: 413,
		title: 'Request body too large',
		description: 'The request body exceeds the configured gateway limit.',
	}),
	DeadlineExceeded: problem.define({
		id: 'gateway:deadline-exceeded',
		type: 'https://api.kaiju.land/problems/gateway-deadline-exceeded',
		status: 504,
		title: 'Gateway timeout',
		description: 'The origin did not complete before the gateway deadline.',
	}),
	InvalidRedirect: problem.define({
		id: 'gateway:invalid-redirect',
		type: 'https://api.kaiju.land/problems/gateway-invalid-redirect',
		status: 502,
		title: 'Invalid upstream redirect',
		description: 'The origin returned a redirect location forbidden by gateway policy.',
	}),
	Unavailable: problem.define({
		id: 'gateway:unavailable',
		type: 'https://api.kaiju.land/problems/gateway-unavailable',
		status: 503,
		title: 'Service unavailable',
		description: 'The selected origin is currently unavailable.',
	}),
	Internal: problem.define({
		id: 'gateway:internal',
		type: 'https://api.kaiju.land/problems/gateway-internal',
		status: 500,
		title: 'Internal gateway error',
		description: 'The gateway encountered an unexpected internal failure.',
		exposure: 'internal',
	}),
});
