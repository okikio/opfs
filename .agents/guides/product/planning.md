# Make the plan executable from evidence

A plan should let another person understand what must change, why, how to do it,
and how to tell whether it solved the intended problem. Detail earns its place
by removing ambiguity about a real decision. A long list of invented files or
commands creates false certainty.

## Establish the current contract

Read the repository's instructions, the installed skill entrypoints, and the
applicable original guides. Confirm the starting branch/revision and preserve
local changes. Compare supplied archives or previous plans against the current
source. Name the customer outcome, consequential questions, existing anchors,
and remaining assumptions. Do the cheap direct probes before committing to
substantial architecture.

Trace the actual entrypoint, reusable owner, exports, callers, data shape,
state, lifecycle, failure behavior, and relevant deployment/runtime. Use exact
symbols and paths from that source. Mark a new proposed file as new. If an API,
tool flag, or command is uncertain, inspect its current documentation or help
and test the material claim before making it a dependency of the plan.

Record the selected skills and the specific rules they affect. For example,
benchmark-code controls semantic comparability and measurement; build-workflows
controls a replay change; write-docs controls the explanation and examples. Do
not list every installed skill. The [shared quality contract](../software-quality.md)
still applies to all selected capabilities.

## Specify each meaningful change

Each work item should identify the following when relevant:

- The question or anchor that justifies it and the customer behavior it changes.
- The actual file, symbol, contract, or configuration to change, and its owner.
- Input and output shapes, units, invariants, state transitions, and defaults.
- Exact verified tooling, working directory, prerequisites, and expected output.
- Dependencies and order; which investigations or changes can run independently.
- Failure, retry, cancellation, cleanup, persistence, and recovery behavior.
- Consumers, exports, docs, examples, UI, configuration, and persisted data that
  need migration; removal of the old path when the task replaces it.
- Acceptance evidence through the relevant customer path and component checks
  that isolate failures. Name what each check proves and what it cannot prove.
- A decision branch for important unresolved results, rather than a single
  assumed happy path.

Explain system logic in simple steps or pseudocode when it prevents a mistake.
Do not encode a speculative implementation merely to make the plan look
complete. Keep unresolved choices tied to the experiment that will resolve
them. Include the whole authorized outcome, including artifact inspection and
documentation, so implementation cannot silently stop after an easy component.

## Use evidence checkpoints

Replace milestones such as "implement proxy support" with checkpoints such as
"run the existing browser through the selected route, retain the returned body
and route evidence, then decide whether application integration is justified."
The implementation is still tracked, but a checkpoint says what the team will
know afterward. An unsuccessful result can complete an investigation and change
the next plan. It does not complete a promised product fix.

Use the research/experiment cadence in the [core method](README.md), including
an early first probe. Set a time limit for an uncertain investigation and an
alternative next step. If a prerequisite blocks one branch, continue independent
questions. Avoid plans that postpone all decisive evidence to final integration.

## Reconcile before calling the work complete

Compare the original outcome, the current plan, the implemented artifact, and
the observed behavior. Check that all authorized work and meaningful cleanup are
covered. Retain exact results, failures, skipped checks, and remaining limits.
Inspect the produced output, not only the command's exit status.

A discovery plan is complete when the requested decision has sufficient
traceable evidence or a specifically scoped limit. A product implementation is
complete only when its promised behavior has been verified at the necessary
level. An experiment succeeding does not close unrelated acceptance criteria.

Use the [plan template](templates/plan.md) for substantial work. The existing
[plan-changes skill](../../skills/plan-changes/SKILL.md) owns the integrated plan;
this guide supplies its product questions and evidence checkpoints.
