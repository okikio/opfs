# Recovery guarantees and CLI-first refactoring

Use this reference when a reusable library must survive interruption, resume
work, or be extracted from a CLI or application whose abstractions have become
rigid.

## Name the recovery guarantee

### Restartable

The operation can run again from the beginning without corrupting results.
Requirements include deterministic identity, idempotent or reconciled effects,
and duplicate handling.

### Checkpoint-resumable

The operation can continue after a committed checkpoint. Requirements include a
durable checkpoint owner, compatibility metadata, output receipts, replay rules,
and reconciliation.

### Durably orchestrated

Execution state survives process and infrastructure failure through a workflow
or job authority with histories, workers, timers, signals, leases, operator
controls, and versioning. `build-workflows` owns this level.

Do not describe retries, an iterator cursor, an in-memory stage list, or an
Effect dependency graph as durability.

## Checkpoint committed work

A checkpoint should represent outputs that are durable and safe to treat as
complete:

```ts
export interface AnalysisCheckpoint {
  readonly schemaVersion: number;
  readonly requestFingerprint: string;
  readonly engineVersion: string;
  readonly ruleSetVersion: string;
  readonly committedCursor: string;
  readonly outputReceipts: readonly OutputReceipt[];
  readonly committedAt: Temporal.Instant;
}
```

Commit order:

```text
process batch
  -> write required outputs
  -> verify receipts and identities
  -> atomically advance checkpoint
  -> release batch resources
```

If the process dies after output write but before checkpoint, replay occurs.
Sinks must tolerate or reconcile duplicate effects. If checkpoint advances
before output durability, work can be skipped permanently.

## Compatibility and fingerprints

A resume preflight validates:

- request identity and normalized inputs;
- library, schema, rule, and adapter versions;
- source snapshot or version;
- output receipts and target state;
- configuration digest and relevant policy;
- checkpoint schema;
- replay safety at the last committed checkpoint.

A fingerprint is an identity aid, not proof of security or semantic
compatibility. Version the canonicalization algorithm. Do not hash secrets into
logs or user-visible manifests.

## Attempts and logical identity

Separate logical work from attempts:

```text
run ID
  logical operation

batch ID
  deterministic unit of work

attempt ID
  one execution try

output identity
  deterministic destination key or version
```

Retries create new attempts, not new logical outputs. Metrics and diagnostics
should preserve both.

## Library and workflow ownership

A library may own:

- checkpoint schema and compatibility;
- deterministic batch identity;
- replay-safe operation contracts;
- a `resume()` use case;
- storage capability requirements;
- structured recovery events.

A durable workflow system owns:

- persisted execution authority;
- workers and task delivery;
- timers and external signals;
- leases, fencing, heartbeats, and retries;
- deployment and version routing;
- operator controls and histories.

Do not embed a workflow engine into a general library unless durable execution
is the product. Provide an adapter package where appropriate.

## Refactoring a CLI-shaped library

### 0. Preserve evidence

Record current commands, inputs, outputs, errors, artifacts, cancellation,
resource cleanup, and performance. Run the current build and representative
commands before editing.

### 1. Select one representative use case

Choose one vertical path that exercises the important architecture. Avoid
rewriting every command simultaneously.

### 2. Write desired programmatic call sites

Create tests or examples for a common consumer and an advanced consumer. Do not
copy CLI types into the library API.

### 3. Define request, result, failures, and events

Make these the first stable contracts. Keep stages and mutable context private.

### 4. Classify the existing context

For every context field classify it as:

- domain input;
- execution option;
- required capability;
- diagnostic metadata;
- application concern;
- hidden implementation detail.

Remove unrelated fields rather than passing the whole context onward.

### 5. Move orchestration behind a named use case

Existing stages may remain internally during migration. Demote them from public
integration contract to private mechanism or observable event vocabulary.

### 6. Establish resource scopes

Replace hidden globals and manual release conventions with explicit handles and
scoped disposal. Determine which resources are application, run, batch, and item
lifetime.

### 7. Replace accidental materialization

Trace arrays, `Promise.all`, queues, and buffers. Introduce async iteration,
streams, and batches only where the workload requires them.

### 8. Isolate hot kernels

Separate pure or bounded transforms from I/O and lifecycle. Introduce internal
data-oriented representations only after profiling.

### 9. Restore ecosystem owners

Keep c12/defu and CLI source precedence in the application; LogTape sink
configuration in the application; storage guarantees in explicit adapters;
workflow authority in the workflow layer.

### 10. Add a second consumer

Use a service endpoint, worker, direct test, notebook, or another CLI command.
The second consumer exposes residual application coupling.

### 11. Prove selective adoption

Pack the library, import only the use case, and verify unrelated adapters and
dependencies are absent.

### 12. Remove compatibility scaffolding

Delete old run helpers, public stage types, duplicate configuration paths, and
legacy exports when the authorized migration does not require them. Search
code, docs, tests, examples, and package metadata.

## Migration strategy

Prefer an incremental vertical extraction when behavior is valuable and the
current application must remain runnable. Prefer a clean cutover when public
compatibility is explicitly rejected and the old architecture would force
permanent duplication.

Do not maintain two orchestration paths without:

- a named owner;
- parity tests;
- a removal condition;
- a deadline or release condition;
- explicit consumer inventory.

## Failure signatures

- checkpoint stores the last attempted item rather than committed outputs;
- resume ignores version or source compatibility;
- retries create duplicate external effects with no reconciliation;
- a library claims durability because it has stages or serialized JSON;
- extraction begins by moving folders instead of writing consumer calls;
- the new core still accepts CLI config, logger configuration, and terminal
  services;
- old `run...()` helpers remain the only supported entrypoints;
- no second consumer is built;
- compatibility wrappers become permanent undocumented architecture.

## Verification

- kill after output write but before checkpoint and verify safe replay;
- kill after checkpoint commit and verify no completed work repeats;
- change request, schema, source, and rule versions and verify resume rejection
  or named migration;
- duplicate delivery and verify idempotency or reconciliation;
- compare CLI behavior before and after extraction;
- call the new library from a second consumer;
- search and remove legacy exports and docs;
- pack and consume the final artifact;
- route durable engine integration through `build-workflows` verification.

## Sources and freshness

- Library-first guidebook, reviewed 2026-07-23.
- Existing build-workflows durability, checkpoint, and pipeline references.
- Temporal TypeScript documentation for durable orchestration handoffs,
  reviewed 2026-07-23.
- unstorage and ohash source evidence for adapter and fingerprint limitations,
  reviewed 2026-07-23.
