# Record the exact acceptance action

Write the action so another person can execute it and recognize the required result. Use the actual consumer, environment and allowed effects.

| Field | Value |
| --- | --- |
| User or caller and starting state | |
| Source or artifact identity | |
| Environment, configuration and intended principal | |
| Input and sequence of actions | |
| Expected output, persisted state and visible result | |
| Required error, refusal, retry or cancellation case | |
| Allowed external effects and cleanup | |
| Observation time and evidence location | |
| Observed result and interpretation limit | |
| Status and remaining action | |

Use passed, failed, blocked, not run or not required. State why a check is unavailable or irrelevant. For several repositories or services, add one activation row per owner: source integrated, setting applied, content published, artifact deployed and final action observed.

Keep component evidence alongside the user action so a failure can be localized. A unit test does not replace an installed consumer check when the claim concerns packaging or runtime behavior.
