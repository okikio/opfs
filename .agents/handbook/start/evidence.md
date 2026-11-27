# Match completion to the evidence

Describe what happened at the level actually checked. A successful command can establish one stage while later stages remain open.

| Observation | What it can establish | What still needs its own evidence |
| --- | --- | --- |
| Source or documentation inspected | A contract or implementation fact at a known revision. | Execution in the intended environment. |
| Types, lint or unit tests pass | The properties those checks exercise. | Installed artifacts, external services and user actions outside that scope. |
| Artifact built and inspected | Its bytes, contents, entrypoints and supported metadata. | Startup and meaningful operations on the required host. |
| Plan created | A proposed operation against identified inputs and state. | Application of the plan and resulting state. |
| Process or service is healthy | The configured health condition passes. | Required background work and the complete user journey. |
| User action succeeds | The named action works under the recorded conditions. | Broader reliability, performance or customer value beyond those observations. |

Use the evidence categories in the [anchor guide](../../guides/product/anchors.md). Keep observed results separate from interpretation and from untested expectations. A negative result may settle an investigation without completing a promised implementation.

For each check, record passed, failed, blocked, not run or not required, with a reason. A missing runtime is a limit on the claim. A skipped required test is not a pass. Retain failed attempts and their conditions when they affect interpretation or recovery.

Before handoff, compare the requested outcome with the actual artifact and evidence. State the usable result first, then its meaningful limits and next action.
