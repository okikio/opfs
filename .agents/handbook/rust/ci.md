# Make Rust builds efficient while keeping required execution

Use Cargo and the repository's native task system for Rust-owned build mechanics. Inspect packages, targets, generated inputs and feature combinations before choosing the affected work or dividing jobs.

Bind gates to the declared contract: formatting and lint, meaningful tests, target builds, artifact inspection, host execution and foreign consumers as applicable. An all-targets or all-features command does not by itself establish every supported feature/host combination. Verify that required targets were actually selected.

Measure cold and warm builds under the actual source, toolchain, features and environment. Separate dependency downloads, compiler results, task results and final artifacts. Shared cache state and mutable target output have different ownership requirements.

Concurrent checkouts need isolated mutable build outputs unless the selected tool explicitly supports the sharing model. Use compatible compiler caching when justified and measure contention, transfer and invalidation. Retain failed or contaminated measurements with their limits.

Check added, excluded and renamed targets, shared build scripts, locks, feature changes and generated definitions against the complete-work oracle. Unknown selection must not become a skipped success. Shard only after measuring duplicated compilation and setup as well as wall time.

Required runtime behavior survives every build optimization. An unavailable host remains unverified, and a failing required host remains a delivery blocker. Use [selection and caching](../engineering/selection-cache.md) for shared controls and the skill for exact Cargo and cache configuration.
