# Measure what can change the product decision

Choose measurements from the question. Do not collect every metric by default.
Correctness and useful output come first: a faster incomplete result does not
meet the same product promise. Then measure the relevant waiting, resource use,
reliability, or cost. Use the existing runtime's tools before installing a stack.

## Define the units and scope

| Question | Useful observations | Interpretation limit |
| --- | --- | --- |
| Did the customer receive the required result? | Expected identifiers, fields, ordering, qualifiers, content, durable state, and completion path | A successful exit, HTTP 200, or trace alone does not prove the result |
| Where does the customer wait? | End-to-end wall time plus queue, connect, TLS, first byte, load, extraction, serialization, and delivery stages where observable | Stages may overlap; do not sum overlapping spans as a latency budget |
| Is the work CPU-limited? | CPU time, wall time, utilization with its denominator, cores, quotas, and throttled periods/time | A utilization percentage without process and quota scope is ambiguous |
| Is memory or allocation a constraint? | Peak RSS, retained heap, allocation rate, GC activity, process tree, container limit, OOM events | Parent heap is not total browser memory; summing RSS can double-count shared pages |
| Does repeated work create churn? | Context/process/connection creation and destruction, allocation, retries, cache misses, disposal and reuse | Name the kind of churn; infrastructure churn and customer churn are different measures |
| Does load change behavior? | Concurrency, arrival rate, completed and failed work, saturation, queues, rate-limit responses and throttling | Configured concurrency is not necessarily achieved concurrency |
| Is the change reliable and economical? | Valid completions over all attempts, failure kinds, observed cost inputs, and confidence limits when justified | A few successful trials do not establish production reliability or a current provider price |

Record exact runtime and dependency versions, source revision, host/OS, hardware
or allocation, environment, input, configuration, process scope, instrument, and
sample count when they can affect interpretation. Keep secrets out of receipts.
Record omissions explicitly. "Not measured" is better than a guessed number.

## Preserve comparable work

Check semantics before ranking timings. A raw iterator, validating parser,
retaining extractor, and summarized response may perform different work. State
which guarantees each includes. Use the same dataset and independent expected
output when making a like-for-like claim. Record failures and invalid outputs
alongside elapsed time; a timed-out attempt cannot disappear from the success
rate or make throughput look better.

Separate cold startup, warm operation, and complete lifetime including cleanup.
Use an existing customer-flow measurement as a baseline when it is available.
Do not build the whole flow before running an immediately answerable direct
probe. A direct library probe can identify a capability or hotspot. Measure the
larger flow when needed to determine how much that operation contributes to the
customer's delay, then isolate the relevant stages.

Repeat sufficiently for the claim. For noisy comparisons, use balanced order,
fresh processes or controlled warm state, comparable inputs, and an account of
host contention. Report individual observations or an appropriate distribution,
not only a selected best run. Use percentiles only when the sample supports
them. Do not infer equivalence from an interval that crosses equality. Do not
infer a causal explanation from correlated measurements alone.

## Distinguish diagnosis from proof of improvement

Use profiling to locate work and formulate a smaller change. Confirm a speed
claim with comparable unprofiled runs because instrumentation can alter timing.
Inclusive CPU costs overlap; they cannot be added as independent savings.
Further repetitions on a changing shared host do not remove systematic bias.

If the question is deterministic correctness, a tiny exact comparison may be
enough. State that timing from such a probe is incidental. If the question is
production capacity, capture representative load, saturation, failures, and
resource limits. Measurement effort follows the claim's consequence.

For full benchmark design, use [benchmarking](../../references/benchmarks.md)
and the installed benchmark-code skill. The [Okikio Utils benchmark guide](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/benchmarks/01-running.md)
provides a source example of scoped measurements; repository commands remain
local bindings.
