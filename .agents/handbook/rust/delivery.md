# Deliver Rust with usable evidence and continuation

Reconcile the intended operation, supported-host matrix, final code, packaged artifact and actual checks. Inspect the produced library or executable, public exports, bindings and required resources.

Run the checks that support the declared behavior and record exact compiler, target, features, host, input and result. Keep native, browser, WASI, FFI and GPU claims separate. State unavailable or unrun configurations without treating a cross-build as their runtime evidence.

Review the public API, rustdoc, examples and important internal invariants from a consumer's position. Explain errors, memory ownership, cancellation, resource bounds and unsupported operations that affect safe use.

Preserve the plan, observations, failed attempts, support decisions, source identities and next action through a handoff. When a previous experiment is inaccessible or stale, use current primary sources and a new relevant probe; do not repeat its claimed result without evidence.

A required unsupported operation calls for a concrete design or scope decision. Keep the best recoverable result and identify that gap. A native-only artifact can complete when that is the agreed support contract and its meaningful checks pass.
