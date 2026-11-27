# Retry at the smallest valid scope

Choose the next operation from the failure and actual state. Preserve evidence whose inputs remain valid; repeat checks that the repair invalidates.

| Failure | Next scope to investigate |
| --- | --- |
| Access or environment, unchanged artifact | Repair the prerequisite and repeat the failed consumer operation. |
| Runtime behavior of a published artifact | Inspect that exact artifact and host before rebuilding. |
| Configuration or infrastructure | Check effective inputs and current state; reuse the artifact only when its contract permits it. |
| Application behavior or build input | Rebuild and verify the affected candidate and required gates. |
| Unknown side effects or missing continuation evidence | Inspect actual state and use the supported recovery path. |

A timeout can leave a mutation active. A lost terminal can leave a process running. Before retrying, identify ongoing work, ownership, idempotency and already completed effects.

Do not bypass saved-plan checks, exact-source admission or migration compatibility to force a successful exit. Do not rerun an expensive full pipeline merely because a narrow unrelated probe failed. Broaden checks to resolve a concrete remaining risk or meet a required gate.

Record the reason for the retry, changed inputs, resulting observation and remaining uncertainty. Use [recovery](../procedures/recovery.md) when durable or external state is involved.
