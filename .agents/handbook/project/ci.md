# Record engineering evidence

Use this record when changing builds, tests, task selection, caching or release tooling. Keep the complete required-work inventory separate from whether a selected result can be reused.

| Field | Value |
| --- | --- |
| Intended engineering outcome and affected user workflow | |
| Exact baseline and candidate source | |
| Native tools, versions and command definitions | |
| Complete discovered tasks/tests and dependency relationships | |
| Affected-work rule and conservative fallback | |
| Task inputs, outputs, relevant environment and cache owner | |
| Cold, warm, fresh-runner and invalidation cases | |
| Source, artifact, package-consumer and required runtime checks | |
| Wall time, total runner time, transfer and setup costs | |
| Failed attempts, confounders and unrun checks | |
| Result, next decision and recovery | |

For each changed input class, compare selected work with the complete-work oracle. Explain why a task ran, reused a result or was skipped. Include new, renamed and deleted files and shared configuration changes when they can affect selection.

Use the [engineering procedures](../engineering/README.md) for the required controls. A faster job that omits required behavior is not an equal-work improvement.
