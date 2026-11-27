# Resume from current source and actual state

Before interruption or handoff, preserve the latest outcome, accepted decisions, full evolving plan, research, task status, exact stopping point, checks and next action. Follow the repository's durable-history and recovery rules when present.

Protect meaningful source work. Depending on the project's recovery contract, that can require coherent commits, independent patches, a bundle for exact ancestry, or separate recovery of dirty, staged and untracked files. Verify saved recovery artifacts can be read back. A temporary working directory alone is not durable recovery.

On resumption:

1. Read current instructions and the latest task record. Reconcile the original goal, later steering and existing authorization.
2. Check the actual branch, remote revisions, local changes and other writers. Compare ancestry with the recorded starting point; a newer timestamp alone does not establish authority.
3. Inspect active jobs and real external state before starting another writer. A cancelled local session does not prove remote work stopped.
4. Compare current source, artifacts, configuration and runtime with the recorded evidence. Keep applicable proof and repeat checks invalidated by changed inputs.
5. State the current milestone, next bounded action and stop condition. Resume that action and update the record.

Verify an integrated revision after concurrent work is combined. Confirm a pushed remote revision separately from CI and artifact publication. Carry failed attempts, unresolved confounders and unrun environments alongside successful results.

Use a continuation that another maintainer can act on without the earlier chat. Link the full plan and evidence instead of reducing them to a summary that hides unfinished work.
