# Verify a required service from its consumer

Use this procedure when a required dependency is introduced, its environment or identity changes, or previous evidence no longer applies. Read the relevant [service card](../services/README.md) and identify the operation that the user journey actually needs.

| Step | Action | Evidence |
| --- | --- | --- |
| 1 | Identify the consuming process, environment, principal and client version. | The test has the same relevant scope as the intended use. |
| 2 | Validate endpoint, region, resource, protocol and configuration references. | Settings agree without exposing credentials. |
| 3 | Exercise the smallest authorized operation that proves the contract. | Expected and observed results, time and request identity. |
| 4 | Exercise a relevant refusal, interruption or recovery case in isolation. | Errors and partial results follow the required contract. |
| 5 | Confirm cleanup or explicit retention. | Remaining resources have an owner and expiry or retention rule. |
| 6 | Reconcile required and optional capabilities. | Every required row has a truthful status and next action. |

Credential availability has four distinct states: the credential exists, the operator can retrieve it, the intended job can use it, and the service accepts its scope. An inaccessible value is not an absent value. Inspect only the agreed configuration and service-specific sources before reporting a gap.

Use the operation's documented value-input interface. Do not assume a wrapper forwards standard input or that human-readable task output is a safe secret channel. When a private value file is the supported interface, protect it, verify the intended input and clean it up.

Some checks require the new application runtime. Mark them pending at intake and execute them before claiming that runtime's journey works. A laptop request proves only its own environment. An unavailable local dependency can block an application test without demonstrating an application defect.

Reuse evidence while its client, operation, identity, configuration and environment remain applicable. Recheck the affected contract after changes to credentials, topology, ports, schema or provider behavior. A warm download cache does not validate live access.

Record results in the [service template](../project/services.md). Keep failed required capabilities visible. A failed setup can support a setup finding while leaving the intended service behavior untested.
