# Start a focused engineering task

These prompts carry one task's outcome, source, capability selection and evidence requirements into a new session. They are templates, not authority to act on an unspecified repository or environment.

Skills: `plan-changes`, `explore-ecosystems`, `build-devtools`, `benchmark-code`, `verify-behavior`, `test-code`, `review-code`, `build-libraries`, `release-software`, `refactor-code`, `write-docs`, `rust-software`.

## Use the complete prompt

Choose the task, fill its source, mode, outcome and allowed effects, and provide current project context. Read the linked procedure and selected installed skills. Add runtime or domain companions only when their contracts are affected.

Keep the existing task record and plan. A prompt for review does not authorize fixes; a plan does not authorize implementation; preparation does not authorize publication. Preserve authorization already established for the same action and destination.

An existing operation or small fixture can answer the first consequential question. No prompt requires a new platform, a fixed research-time ratio or every possible check. Completion follows the promised outcome and evidence needed to establish it.

| Task | When to use it |
| --- | --- |
| [Map the source owners of a change](source-owners.md) | Before changing CI, tests, packages or a contract with several consumers. |
| [Audit custom tooling against native capabilities](native-capabilities.md) | When a repository maintains selection, caching, discovery or build logic. |
| [Record the CI baseline before changing it](ci-baseline.md) | Before claiming that an engineering change reduces time or cost. |
| [Regenerate a lock and verify reproducible preparation](frozen-install.md) | When dependency resolution changes or installations differ between environments. |
| [Prove affected-work selection against complete discovery](affected-selection.md) | When changed paths determine jobs, packages or tests to run. |
| [Record a task’s inputs, outputs and environment](task-inputs.md) | Before caching a result or reconciling competing task definitions. |
| [Pilot one result cache on a bounded task](task-cache.md) | After a task’s deterministic inputs and outputs are understood. |
| [Order caches and constrain their writers](cache-order.md) | After a cache is correct and before expanding it across jobs. |
| [Select and shard tests with their native runner](test-shards.md) | When a test job is slow or selection depends on a maintained file list. |
| [Use controlled clocks for deterministic timing logic](test-clocks.md) | When tests wait on real time without needing to prove real timing. |
| [Evaluate a compiler or build-tool change](build-tool.md) | Before replacing or upgrading a compiler, bundler or major toolchain. |
| [Verify container build cache reuse](image-cache.md) | When image construction is a measured source of engineering cost. |
| [Report CI impact by change class](ci-impact.md) | After an engineering change alters selection, caching or execution cost. |
| [Review the final candidate against the agreed outcome](final-review.md) | Before handing off a substantial CI or tooling change. |
| [Classify tests by the contract they protect](test-purpose.md) | When a suite mixes durable tests with temporary investigation or source-text checks. |
| [Adopt an existing utility through its public contract](reuse-utilities.md) | When a project duplicates a maintained mechanism or chooses a utility dependency. |
| [Replace source reach-through with a package contract](package-exports.md) | When a consumer imports another package’s private source or checkout layout. |
| [Consolidate tests on a selected runner](test-runner.md) | When the project explicitly chooses one compatible runner and assertion contract. |
| [Answer one question with the smallest useful experiment](product-question.md) | Before implementation depends on an uncertain product or technical claim. |
| [Report an observation the team can act on](team-anchor.md) | When a progress update must connect evidence to the next decision. |
| [Make the next implementation step concrete](implementation-plan.md) | When findings must become an executable change plan. |
| [Deliver a Rust capability on its required hosts](rust.md) | For Rust implementation, reviews, host support, ownership, performance, FFI or builds. |

For ordinary API, authentication, data, workflow, CLI or web implementation, select the actual capability through the [main router](../../START.md) and follow the [playbook](../playbook.md). These prompts supplement those skills; they do not form a second technical rulebook.
