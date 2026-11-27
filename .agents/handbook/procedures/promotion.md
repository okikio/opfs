# Promote the selected candidate

Use this procedure when the reviewed candidate has been selected for an authorized production change. Verify the authorization already supplied for the action and destination. If an additional approval is required, prepare the exact candidate, impact and plan so that review concerns a concrete result.

| Step | Action | Required evidence |
| --- | --- | --- |
| 1 | Compare the candidate with current production source and state. | Source, artifact, locks, configuration and target are unambiguous. |
| 2 | Check production-specific capabilities. | The intended CI and runtime identities can perform required operations. |
| 3 | Classify data and schema changes. | Online-compatible, maintenance-required or unchanged behavior, with unknowns resolved. |
| 4 | Verify the applicable recovery path. | Data backup and restore evidence when required; artifact/configuration recovery for stateless work. |
| 5 | Inspect the production-specific operation or saved plan. | Expected resources, replacements, retained data and candidate identity. |
| 6 | Establish one deployment owner. | Competing operators cannot race the same state or migration through the supported workflow. |
| 7 | Apply the required rollout and migration order. | Writers, jobs and consumers follow the verified compatibility contract. |
| 8 | Check deployed identity and the critical user action. | The intended artifact and settings are active and their behavior passes. |
| 9 | Observe the project's release signals. | Applicable errors, latency, queues and recovery signals meet the declared acceptance window. |
| 10 | Save the receipt and operating handoff. | Prior/current identities, evidence, limits and recovery owner are recoverable. |

Trace every changed credential or feature setting from its source through validation, injection and the actual consumer. A published feature with a disabled flag has not established an enabled user journey.

Migration ownership must be explicit. Do not let every replica race to change the same schema unless the actual migration mechanism provides that contract. Keep irreversible work out of speculative preview steps. A configured backup schedule alone does not prove that retained data can be restored.

Use the platform's existing gradual rollout mechanism when selected by the project. Define comparison signals and representative work; a small replica count alone does not establish a useful canary test.

On failure, preserve the phase and enter [recovery](recovery.md). A completed workflow and an accepted release remain different states until the promised behavior has been checked.
