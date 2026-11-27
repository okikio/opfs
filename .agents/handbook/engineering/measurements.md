# Compare equivalent work and total cost

State the question before collecting measurements. Choose the outcomes and costs that can change the decision: correctness, elapsed time, runner time, CPU, memory, resource churn, requests, transfer, retries or retained failure information.

Record units, source and tool versions, workload, input size, concurrency, warmup, sample count and relevant environmental conditions. Preserve failed and inconclusive attempts. A faster result with missing required output is not a speed improvement for the same operation.

For task-selection or CI changes, choose representative change classes from the actual project. Include shared dependencies, types, data or migrations, tests, frontend or workers, locks, documentation, tooling, container inputs and release configuration when they affect the work graph.

For each case, compare complete required work with selected work and explain whether each task executed, reused a cache or was skipped. Include newly discovered packages/tests, file rename/deletion and shared fixture changes. Check test names and inventory, not only exit status.

Measure both workflow wall time and total executed runner time, including setup, cache traffic, repeated fixtures and failed attempts. Compare cold and warm paths and fresh runners where the proposed gain depends on reuse. Lower wall time can consume more total compute.

Use verified current rates only when reporting monetary cost. Otherwise report resource units. Link the evidence to the exact candidate and state what remains unverified. The [metrics guide](../../guides/product/metrics.md) owns broader experimental controls and interpretation.
