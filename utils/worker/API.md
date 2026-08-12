@utils/worker public API usage
==============================

Purpose
-------

This reference maps every public export target declared by `@utils/worker` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/worker
-------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `ControlEnvelope` | type | Parent-to-Worker control envelope. | `value: ControlEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Worker lifecycle event. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `open` | function | Open one owned Deno Worker with correlated, validated, abort-aware requests. | `open(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OpenOptions` | interface | Inputs accepted while opening one Deno Worker. | `value: OpenOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `protocol` | function | Define one immutable validated Worker protocol. | `protocol(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Protocol` | interface | Validated request, response, and expected-failure wire schemas. | `value: Protocol` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProtocolInput` | interface | Input accepted by {@link protocol}. | `value: ProtocolInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RawWorker` | interface | Minimum raw Worker surface used by the handle and test adapters. | `value: RawWorker` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RawWorkerScope` | interface | Worker-global message surface used by the server and test adapters. | `value: RawWorkerScope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `reply` | function | Wrap a Worker response with an explicit transfer list. | `reply(...)` | `.agents/tests/public-api-matrix.test.ts:345` uses `reply`. |
| `Reply` | interface | Explicit response wrapper for transferring ownership of response values. | `value: Reply` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestEnvelope` | interface | Parent-to-Worker request envelope. | `value: RequestEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestHandler` | type | Worker-side request handler. | `value: RequestHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestOptions` | interface | Explicit request transfer and correlation options. | `value: RequestOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseEnvelope` | type | Worker-to-parent response envelope. | `value: ResponseEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `serve` | function | Serve one validated Worker protocol inside a Worker thread. | `serve(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServeOptions` | interface | Inputs accepted while serving one Worker protocol. | `value: ServeOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkerFailureError` | class | Worker returned an expected encoded failure. | `new WorkerFailureError(...)` | `.agents/tests/public-api-matrix.test.ts:362` uses `WorkerFailureError`. |
| `WorkerFaultError` | class | Worker returned or raised an unexpected fault. | `new WorkerFaultError(...)` | `.agents/tests/public-api-matrix.test.ts:363` uses `WorkerFaultError`. |
| `WorkerHandle` | interface | Owned Worker request endpoint. | `value: WorkerHandle` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkerProtocolError` | class | Worker wire protocol was violated. | `new WorkerProtocolError(...)` | `.agents/tests/public-api-matrix.test.ts:364` uses `WorkerProtocolError`. |
| `WorkerServer` | interface | Owned Worker-side protocol server. | `value: WorkerServer` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkerStoppedError` | class | Worker stopped before a pending request completed. | `new WorkerStoppedError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`WorkerFailureError` appears in `.agents/tests/public-api-matrix.test.ts:362`:

~~~~ typescript
assert.equal(new worker.WorkerFailureError({ id: 'failure', data: {}, message: 'failed' }).name, 'WorkerFailureError');
			assert.equal(new worker.WorkerFaultError('fault').name, 'WorkerFaultError');
			assert.equal(new worker.WorkerProtocolError('invalid').name, 'WorkerProtocolError');
			const finalizerInstruction = instructionOf(workflow.wait(workflow.signal({ id: `matrix.finalizer-${index}`, value: StringSchema }), 'value'));
~~~~

`WorkerFaultError` appears in `.agents/tests/public-api-matrix.test.ts:363`:

~~~~ typescript
assert.equal(new worker.WorkerFaultError('fault').name, 'WorkerFaultError');
			assert.equal(new worker.WorkerProtocolError('invalid').name, 'WorkerProtocolError');
			const finalizerInstruction = instructionOf(workflow.wait(workflow.signal({ id: `matrix.finalizer-${index}`, value: StringSchema }), 'value'));
			assert.equal(new workflow.FinalizerInstructionError(finalizerInstruction).instruction, finalizerInstruction);
~~~~

`WorkerProtocolError` appears in `.agents/tests/public-api-matrix.test.ts:364`:

~~~~ typescript
assert.equal(new worker.WorkerProtocolError('invalid').name, 'WorkerProtocolError');
			const finalizerInstruction = instructionOf(workflow.wait(workflow.signal({ id: `matrix.finalizer-${index}`, value: StringSchema }), 'value'));
			assert.equal(new workflow.FinalizerInstructionError(finalizerInstruction).instruction, finalizerInstruction);
		}
~~~~

`reply` appears in `.agents/tests/public-api-matrix.test.ts:345`:

~~~~ typescript
const reply = worker.reply(buffer, [buffer.buffer]);
			assert.equal(reply.transfer.length, 1);
		}
	});
~~~~

@utils/worker/types
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `ControlEnvelope` | type | Parent-to-Worker control envelope. | `value: ControlEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Worker lifecycle event. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OpenOptions` | interface | Inputs accepted while opening one Deno Worker. | `value: OpenOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Protocol` | interface | Validated request, response, and expected-failure wire schemas. | `value: Protocol` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProtocolInput` | interface | Input accepted by {@link protocol}. | `value: ProtocolInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RawWorker` | interface | Minimum raw Worker surface used by the handle and test adapters. | `value: RawWorker` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RawWorkerScope` | interface | Worker-global message surface used by the server and test adapters. | `value: RawWorkerScope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Reply` | interface | Explicit response wrapper for transferring ownership of response values. | `value: Reply` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestEnvelope` | interface | Parent-to-Worker request envelope. | `value: RequestEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestHandler` | type | Worker-side request handler. | `value: RequestHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RequestOptions` | interface | Explicit request transfer and correlation options. | `value: RequestOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResponseEnvelope` | type | Worker-to-parent response envelope. | `value: ResponseEnvelope` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServeOptions` | interface | Inputs accepted while serving one Worker protocol. | `value: ServeOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkerHandle` | interface | Owned Worker request endpoint. | `value: WorkerHandle` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkerServer` | interface | Owned Worker-side protocol server. | `value: WorkerServer` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 38 public names across 2 package export targets. 4 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

