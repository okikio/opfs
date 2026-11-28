# Recover from the observed failure

Use recovery when preparation, mutation, migration, startup or acceptance fails. The first goal is a known safe state and a justified next operation. Preserve the earliest useful error and inspect actual state before another writer acts.

1. Stop additional conflicting mutations and retain bounded evidence: source, artifact, plan, phase, error and affected resource identities.
2. Read the actual application, provider and data state. Separate completed, pending and unknown effects.
3. Identify the earliest causal failure and keep alternative explanations distinct from observations.
4. Determine whether writers, migrations or jobs remain active. Control their effects through the supported mechanism.
5. Choose a valid retry, forward repair, compatible code rollback or restore. Use the repository's real command and state contract.
6. Execute the authorized recovery action and record its phase. Reassess if new evidence changes the state.
7. Repeat the affected service and user checks, then assign a verifiable prevention action.

| Observed state | Decision |
| --- | --- |
| Verified absent | Confirm the intended target and initialization inputs before first creation. |
| Initialized but empty | Inspect native history and resource counts; preserve generated identity and inputs. |
| Metadata only | Preserve known credentials and metadata; use the specifically supported retry shape. |
| External resources or migration present | Inventory ownership, schema and active writers before choosing continuation or a new plan. |
| Pending, unreadable or unclassified | Keep the state unknown and resolve it before initialization, deletion or another mutation. |

A timeout or cancelled terminal does not prove that a provider operation stopped. A phase journal is evidence of an attempted operation, not an atomic snapshot of external state. Access errors remain unknown state; they do not establish an empty installation.

Reuse the existing artifact to diagnose unchanged runtime behavior. Rebuild when source or effective build inputs change. A repaired credential usually calls for repeating the failed access check, while a changed application contract needs its affected checks and a new candidate identity.

Preserve saved-plan checks, stable resource identities and generated credentials across retries. Do not invent a resume command, fabricate missing continuation evidence or downgrade data because an older image starts. A supported retry must account for effects that may already have occurred.

Use the [incident record](../project/incidents.md) and [failure diagnosis](../failures/diagnosis.md). Keep cleanup failures and unresolved state visible even after the original user action recovers.
