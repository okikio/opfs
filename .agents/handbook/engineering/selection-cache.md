# Prove task selection and cache reuse separately

Affected-work selection decides which tasks must run. Cache admission decides whether a selected task's prior result can be reused. A cache key must not hide a changed consumer from the required-work inventory.

For each result-owning task, record source and transitive inputs, discovered tests, manifests and locks, command and flags, toolchain, relevant environment, platform, declared outputs and downstream consumers. Keep credential values out of cache metadata. Identify one authoritative result-cache owner for the task.

Distinguish dependency downloads, compiler intermediates, deterministic task results, container layers and immutable release artifacts. A hit in one layer does not prove reuse in another. Measure the bytes transferred, restore/save duration, hit reason and validated outputs when those affect the decision.

Choose task granularity from behavior and ownership. Splitting a test file can enable independent execution, but does not by itself create per-file result caching. Use supported discovery and selection rather than a maintained task for every file. Preserve shared setup and integration contracts.

## Exercise invalidation and restoration

Check edited, added, renamed and deleted files; changed fixtures, imports, permissions, environment, tools, task definitions and generated output. Compare selected work against the complete discovered suite. Unknown edges require broader execution.

Prove a cache miss executes the task and a hit restores usable output on a fresh runner. Check failed, cancelled and unexpectedly skipped tasks, absent or corrupt cache data, output validation and trust separation. A protected release must not consume untrusted writable cache results as if they were admitted artifacts.

Compare restore/save order under the actual dependency contract. An authenticated, content-addressed result may sometimes avoid expensive preparation, but source and dependency identity still need verification. Keep one result authority when several tools offer caching.

Never reuse old timing samples as a new benchmark. Live credentials, provider readiness, migrations and environment mutations require their own current evidence. Cache setup when valid, then execute the operation whose behavior is being claimed.

For container builds, inspect build context, stable dependency layers, per-platform outputs and remote cache behavior. A restored image layer does not establish that another runner reused a writable build cache. Keep the final artifact and consumer checks independent of the reported cache hit.
