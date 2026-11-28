# Adopt Rust rules at the existing decision and execution owners

Use this when adding the Rust skill to a repository or bringing existing Rust
work under the [policy](policy.md). Preserve the project's original guides,
task families, source history, and current user instructions.

## Connect the complete guidance

Route Rust tasks from the repository's skills entrypoint to
[`rust-software`](../../skills/rust-software/SKILL.md). Link its mandatory
contract to this guide and the [Rust handbook](../../handbook/rust/README.md).
Keep the product-question method and existing planning, review, benchmark,
documentation, and delivery rules in force. Install the short topic files as
well as the entrypoint; a summary cannot replace the implementation guidance.

Record the adopted pack version, actual starting repository/branch/SHA, and
selected rules in the existing task record. Do not declare a historic archive
canonical over an unmerged or newer verified source line.

## Establish the actual package and capability graph

Find every Cargo manifest, workspace, excluded member, binary, build script,
generated input, lockfile, native dependency, and consumer. Confirm the pinned
compiler, Cargo, target components, and Mise ownership. Use current command
help and repository tasks; do not invent task names from a guide example.

Create an operation/host matrix for every maintained package and binary.
Identify missing capabilities and direct probes before proposing a broad
crate relocation or worker rewrite. Keep Rust placement aligned with the
capability owner and real consumers, not a mandatory folder aesthetic.

## Put behavioral gates in the existing task system

Register format/lint, unit/property tests, doctests, native builds, required
Wasm builds, actual host execution, FFI consumers, and artifact inspection.
Select the relevant feature combinations explicitly. A workspace default or
`required-features` filter must not silently omit a required binary.

Compilation is followed by meaningful operation and failure tests on each
declared host. A required unavailable host remains unverified. Add a visible
release gate that fails when the capability matrix loses an artifact or its
required evidence. Do not turn missing work into a green skipped job.

Only reduce CI work after proving complete affected selection. Compare it
with a full oracle, include shared Cargo/config/build inputs, and fail safely
on unknown paths. Prove shard union and duplicates independently of caching.
Keep doctests and nonstandard host runners visible.

## Measure build reuse without mixing mutable state

Use the current Cargo/cache facilities and exact cache identity. Share download
or compiler caches where supported, while isolating mutable build outputs by
worktree and configuration as required. Measure cold, restored, repeated, and
small-edit builds, including cache transfer, contention, runner time, and cost.
Faster wall time is insufficient if required checks disappear.

Use [Rust adoption details](../../skills/rust-software/references/adoption.md)
for command forms and [CI](../../skills/rust-software/references/ci.md),
[worktrees](../../skills/rust-software/references/worktrees.md), and
[caching](../../skills/rust-software/references/caching.md) for scoped decisions.

## Verify adoption and make resumption reliable

Run one representative task from the router through the skill, guide, handbook,
actual host gates, and final artifact. Check that a fresh operator can find the
required policy and next action. Verify relative links and copied task prompts.

Keep the full plan, chosen references, operation matrix, raw attempts, latest
anchors, exact stopping point, and next command in the existing task record.
After a context reset, reread the entrypoint and current record before acting.
Short files reduce truncation risk; executable gates enforce mechanical
requirements that prose alone cannot guarantee.
