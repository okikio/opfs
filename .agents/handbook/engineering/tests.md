# Keep tests meaningful and independently runnable

Use a small direct probe to investigate an unknown, then keep a durable regression test when changed behavior needs ongoing protection. The probe and the committed test serve different purposes.

Classify each check by its contract. Syntax or AST inspection is appropriate when syntax, dependency ownership or export shape is the real requirement. Assertions that mirror private implementation spelling should not replace behavioral evidence. Keep security, schema, compatibility, lifecycle and release tests that protect durable contracts.

Use the selected runner's native discovery and supported sharding. Verify which unit it shards and which setup it repeats. A new matching test must be discovered; renamed or removed tests must change the inventory and cache identity. Shared fixtures and runner configuration must select affected consumers.

Split a broad file when its independent capabilities or resource needs justify the separation. Keep an integration journey together when splitting would obscure its contract or duplicate expensive setup. Tests must not depend on file execution order, shared mutable state or leaked resources.

Use controlled clocks for deterministic deadline and retry logic when real elapsed time is not the contract. Keep a real timing test when actual scheduling, timeout integration or external behavior is what needs proof. Exercise cancellation, cleanup, errors and concurrency where they can change the outcome.

Cross-check selective execution against complete discovery in a cold run. Measure duplicated setup and contention before increasing shard count. Keep expensive browser, database and live-provider checks explicit, with truthful unavailable or unrun status.
