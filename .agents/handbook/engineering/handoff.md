# Deliver recoverable source and truthful evidence

Before review, compare the final source with the intended outcome and current plan. Inspect the actual diff, output and affected consumers. Keep functional changes distinguishable from formatting or generated refreshes.

Run relevant type checks, meaningful tests, reproducible dependency preparation, builds and output inspection. Exercise the installed package, executable, required host or user journey when making that claim. Stop optional repeated testing once the remaining concrete risk and required gates are resolved.

Record exact revisions, commands, environments, outcomes and failed or unrun checks. A successful local build does not establish remote CI; a push does not establish a published artifact. Verify each claim at its own destination.

Preserve recoverable source and the full plan, questions, observations, decisions, task status, active operations and next action under the project's history rules. Include dirty or untracked work that matters. Use the appropriate independent patches or ancestry-preserving bundle when required and verify read-back.

Explain the result from the maintainer's position: what changed, why, how to use it, the checks that support it and the material limits. Reconcile concurrent work at the combined revision before declaring that integration verified. Follow [resumption](../agents/resume.md) if work must continue later.
