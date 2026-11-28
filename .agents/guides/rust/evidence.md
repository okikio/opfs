# Match the Rust claim to the evidence that can establish it

Use this when researching support, reviewing a PR, measuring an optimization,
or reporting progress. Keep one task record with the product question, exact
source, important unknowns, probe, raw observations, and next decision.
The [product experiment guide](../product/experiments.md) governs the loop.

## Identify the next unknown before building around it

Separate questions answerable now from those requiring a named host, permission,
fixture, toolchain, or longer observation. Test cheap consequential questions
early. A direct function call or tiny Rust program often answers a compiler,
ownership, SIMD, or stream question before a full worker is needed.

Read current primary sources, then test their relevant claim in the selected
version. Run an early relevant probe and use the observation to choose the next
question. Stop at sufficient evidence. A cycle that claims an experimental
result must include execution or direct observation. Record setup blockers
instead of treating preparation as proof of the intended capability.

## Keep these evidence stages distinct

| Evidence | What it establishes | What remains open |
| --- | --- | --- |
| Documentation/source inspection | A stated contract or implementation at a revision | Behavior in the intended environment |
| Compile/link result | Accepted source, features, and target linkage | Imports, runtime facilities, actual behavior |
| Artifact validation/instantiation | A host accepts the concrete file and imports | Correctness of required operations |
| Direct operation test | The tested behavior under recorded inputs/conditions | Untested failures and connected consumers |
| Adapter/consumer test | Binding, ownership and integration for that consumer | The complete customer journey |
| Product-flow observation | The exercised journey and its acceptance result | Broader reliability or untested workloads |

Use observed, documented, inferred, blocked, and inconclusive labels where they
clarify the result. A runtime returning `Unsupported` after a successful build
is evidence of an unmet capability, not successful Wasm delivery.

## Make experiments interpretable

Record toolchain and dependency revisions, target/host/features, commands,
input identity, expected output, time, errors, metadata, and resource limits.
Preserve failed attempts. If a probe is wrong, keep its output, identify the
measurement defect, repair it, and distinguish the corrected result.

Check full output against an independent oracle before measuring speed.
For streams, vary partitions and final states. For SIMD, vary lane widths,
alignment, tails, and numerical edge cases. For FFI, use the actual consumer
and ownership protocol. For concurrency, observe completion and cleanup.

Measure equivalent work under comparable conditions. Report relevant latency,
throughput, allocation count, peak/retained memory, linear-memory growth,
artifact size, and build/CI cost separately. Keep exploratory timings distinct
from a representative performance result. Record failures in denominators.

## Review a PR at a fixed source state

Pin base and full head SHA, local dirty state, and requested scope. Inventory
all Rust surfaces and trace callers, manifests, generated files, build steps,
CI, docs, and package consumers. A diff is not the whole behavior. Respect
paused-build instructions and read-only authority; a review does not authorize
fixes. Link findings to exact source, consequences, and a useful next check.

A prior review belongs to its pinned revision and coverage record. Recheck
current source before applying its findings to another branch or project.

## Report a usable anchor

State the question, dated observation, scope/evidence, customer meaning, next
decision, and remaining unknown. Implementation activity alone is insufficient.
An inconclusive timebox can finish while the original question remains open.
Preserve the full plan and next executable action before handoff.
