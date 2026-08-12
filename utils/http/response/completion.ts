/** Final outcome of delivering a response body to the host/client. */
export interface ResponseCompletion {
	readonly outcome: 'completed' | 'cancelled' | 'errored';
	readonly bytes: number;
	readonly reason?: unknown;
}

/** Observe full response-body completion without buffering or cloning the body. */
export function onComplete(
	response: Response,
	observe: (completion: ResponseCompletion) => void | Promise<void>,
): Response {
	let settled = false;
	const notify = (completion: ResponseCompletion): void => {
		if (settled) return;
		settled = true;
		Promise.resolve(observe(Object.freeze(completion))).catch(() => {
			// Completion observation is diagnostic/cleanup behavior and cannot
			// replace an already produced response.
		});
	};
	if (response.body === null || response.status === 101 || 'webSocket' in response) {
		queueMicrotask(() => notify({ outcome: 'completed', bytes: 0 }));
		return response;
	}
	const reader = response.body.getReader();
	let bytes = 0;
	const body = new ReadableStream<Uint8Array>({
		/**
		 * Pulls the next value only when logical HTTP response construction is ready to accept it.
		 *
		 * Response internals build framework-neutral response data before a server adapter creates the native Response.
		 *
		 * @internal
		 */
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					notify({ outcome: 'completed', bytes });
					return;
				}
				bytes += value.byteLength;
				controller.enqueue(value);
			} catch (reason) {
				controller.error(reason);
				notify({ outcome: 'errored', bytes, reason });
			}
		},
		/**
		 * Checks whether cel is currently allowed by logical HTTP response construction.
		 *
		 * @internal
		 */
		async cancel(reason) {
			try { await reader.cancel(reason); } finally { notify({ outcome: 'cancelled', bytes, reason }); }
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
