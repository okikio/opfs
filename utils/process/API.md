@utils/process public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/process` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/process
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Event` | type | Process lifecycle event. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `exec` | function | Run one finite process and return its terminal status and captured output. | `exec(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ExecOptions` | interface | Options accepted by the finite exec helper. | `value: ExecOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Exit` | interface | Terminal process status and optionally captured output. | `value: Exit` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OutputLimitError` | class | Captured child output exceeded its configured byte limit. | `new OutputLimitError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OutputMode` | type | Explicit output ownership policy. | `value: OutputMode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Process` | interface | Owned child process. | `value: Process` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ProcessStopTimeoutError` | class | Child process did not stop within the graceful and forced shutdown periods. | `new ProcessStopTimeoutError(...)` | `.agents/tests/public-api-matrix.test.ts:352` uses `ProcessStopTimeoutError`. |
| `ShutdownPolicy` | interface | Graceful then forced shutdown policy. | `value: ShutdownPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `start` | function | Start one directly owned child process. | `start(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StartOptions` | interface | Inputs accepted while starting an operating-system process. | `value: StartOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `TreeMode` | type | Process-tree ownership guarantee implemented by the selected adapter. | `value: TreeMode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `UnsupportedTreeModeError` | class | Requested process-tree ownership mode is not implemented by this adapter. | `new UnsupportedTreeModeError(...)` | `.agents/tests/public-api-matrix.test.ts:353` uses `UnsupportedTreeModeError`. |

Detected uses
~~~~~~~~~~~~~

`UnsupportedTreeModeError` appears in `.agents/tests/public-api-matrix.test.ts:353`:

~~~~ typescript
assert.equal(new process.UnsupportedTreeModeError('posix-process-group').tree, 'posix-process-group');
			assert.equal(new query.QueryValidationError([{ code: 'invalid-value', message: 'invalid', path: ['value'] }]).issues.length, 1);
			assert.equal(query.desc('id').direction, 'desc');
			assert.equal(new queue.QueueItemNotFoundError(`item-${index}`).itemId, `item-${index}`);
~~~~

`ProcessStopTimeoutError` appears in `.agents/tests/public-api-matrix.test.ts:352`:

~~~~ typescript
assert.equal(new process.ProcessStopTimeoutError(index + 1).pid, index + 1);
			assert.equal(new process.UnsupportedTreeModeError('posix-process-group').tree, 'posix-process-group');
			assert.equal(new query.QueryValidationError([{ code: 'invalid-value', message: 'invalid', path: ['value'] }]).issues.length, 1);
			assert.equal(query.desc('id').direction, 'desc');
~~~~

@utils/process/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Event` | type | Process lifecycle event. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ExecOptions` | interface | Options accepted by the finite exec helper. | `value: ExecOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Exit` | interface | Terminal process status and optionally captured output. | `value: Exit` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OutputMode` | type | Explicit output ownership policy. | `value: OutputMode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Process` | interface | Owned child process. | `value: Process` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ShutdownPolicy` | interface | Graceful then forced shutdown policy. | `value: ShutdownPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StartOptions` | interface | Inputs accepted while starting an operating-system process. | `value: StartOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `TreeMode` | type | Process-tree ownership guarantee implemented by the selected adapter. | `value: TreeMode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 21 public names across 2 package export targets. 2 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

