# Examples of questions becoming anchors

The scenarios below illustrate the method. Except where an accompanying
validation record states an actual run, their outcomes are examples, not
measurements of a product or provider.

## A customer export loses variants

The customer expects every product variant. A proposed explanation is that the
queue drops rows. Start by comparing a fixed catalogue with the exporter's
existing direct operation and then the application operation. A four-variant
fixture and exact identifier comparison can distinguish a selection problem
without constructing a new queue.

If the direct operation returns all variants and the application does not,
trace the earliest changed input or option. Record that the native capability
exists for the fixture and the application path loses the requested behavior.
Investigate that path before funding a replacement worker. Verify the real
customer flow before claiming the production issue is fixed. This pack includes
an offline behavioral evaluation of this scenario in its validation material.

## A library says it supports a required feature

The product needs a browser operation and documentation claims support in the
selected PyPanda version. Identify the exact package, version, public API,
runtime, and relevant example. Run that operation directly with the smallest
input that reveals the required behavior. Capture the returned result, error,
elapsed time, and relevant process resource scope.

If it fails because a binary is unavailable, the setup requirement is observed;
the feature remains untested. If it succeeds, the next question is whether the
application uses that operation correctly under the needed lifetime, concurrency,
and workload. Do not expand to an entire service before the direct capability
question has an answer. These are instructions for testing a claim, not a claim
that a particular PyPanda feature or import exists.

## A retrieval path returns errors and loses useful information

Ask three questions separately: can the target be reached, what explains the
wait, and where does information disappear? Capture status, headers, body,
timing, and metadata at the first relevant operation. Inspect the content even
when the status is 404 or 500. Compare each transformation with its captured
input. Distinguish legitimate origin content, a challenge page, an error page,
and a fabricated or empty summary.

Use the browser/proxy matrix in [experiments](experiments.md) for the reachability
question. Use stage timings for the delay. Use retained source content and exact
field or text comparisons for information loss. A successful network request
does not establish extraction fidelity, and retained error metadata does not
establish target reachability. Each useful observation becomes its own scoped
anchor and can progress independently.

## A CSV import feels slow

First check that the import produces the expected rows and errors. Measure the
parser directly, then measure the complete import including storage and UI
completion where relevant. If parsing takes only a small part of the customer's
wait, a faster parser may not justify a migration. If parsing dominates, compare
alternatives on equivalent work, including validation and retained fields.

This sequence is illustrated in the [Okikio Utils benchmark guide](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/benchmarks/01-running.md). Keep its
repository commands in the repository profile; use the same reasoning for any
runtime. Preserve failed attempts, setup time, memory scope, and uncertainty.

## A team wants to build scheduled exports

The product question is whether customers need recurring delivery and can
configure it successfully. Existing usage, support conversations, and observation
of current workarounds can inform the question. A small prototype can test
whether representative customers understand schedule and recipient choices.
A bounded manual service can test an assumed workflow when appropriate.

None of those observations proves that a production scheduler scales. A direct
scheduler experiment can establish a technical behavior, but cannot establish
customer demand. Choose the evidence for the risk that could change the next
product investment, and keep the other questions explicit.

## A result does not distinguish the options

Two configurations produce similar timings on a noisy shared host. Report the
observations and why the comparison is inconclusive. If the product needs a
large improvement, that result may already rule out investing in a tiny apparent
difference. If a small difference affects cost at scale, use a more controlled
comparison. Do not keep repeating until a preferred option appears to win.
