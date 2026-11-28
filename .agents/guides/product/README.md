# Anchor-based product development

Start with the customer problem and the decision that needs evidence. Find the
consequential unknowns, run the smallest useful experiments early, and share what
the results let the team decide. An **anchor** is a dated observation with its
scope, evidence, product meaning, and next decision. It can support an option,
rule one out, expose a different problem, or explain precisely why a question
remains unanswered. It need not be a positive result.

This method applies to product discovery, technical research, diagnosis,
implementation, performance work, and progress reports. Use the current project's language, runtime, customers, and deployment
contracts. The name describes this pack's synthesis of established discovery
and experiment practices; it does not claim a new scientific method.

## Establish the question before substantial implementation

For each meaningful task, identify:

1. **Customer and outcome:** who is affected, what they are trying to do, and
   which observed problem or desired outcome prompted the work.
2. **Decision:** what the team will choose or change when it has an answer.
3. **Known evidence and unknowns:** distinguish observations, user reports,
   documentation claims, hypotheses, constraints, and untested assumptions.
4. **First useful probe:** what existing executable, public operation, small
   fixture, or customer interaction could answer the most consequential question.
5. **Evidence and next branch:** what to retain, what each plausible result would
   change, and what this probe cannot establish.

A small, well-understood change may need only a short paragraph. Complex work
needs a question list and an experiment plan. Discovery reads and narrow,
authorized probes can start immediately to establish this contract. Substantial
solution implementation waits until the important questions and intended proof
are explicit. Do not require an exhaustive list of every possible unknown.

Extract the questions already present in the request. Trace adjacent contracts
to find missing ones. Investigate technical unknowns yourself. Ask the user when
a missing customer priority, intended outcome, acceptable tradeoff, or authority
would materially change the work and cannot be resolved from supplied context.
Do not ask them to perform a lookup or repeat an authorization already given.

Proceed when evidence supports the next implementation decision or the remaining
uncertainty is explicitly bounded by an assumption, consequence, owner, and
validation or revisit condition. Keep a high-consequence unresolved decision
from silently becoming an implementation fact. During an active incident, do
the authorized stabilization needed to protect users and preserve evidence,
then continue the research/experiment loop. Do not postpone urgent stabilization
to complete discovery paperwork.

## Alternate research and experiments

Read enough current source and documentation to formulate a useful probe. Run it
as soon as it can distinguish relevant possibilities. Use the observation to
choose the next research question or experiment. A documentation claim creates
a testable expectation, not proof that the current environment supports it.

Run the first useful probe early and alternate research with observations.
Choose a timebox from the consequence of the decision and the cost of the next
probe. A project can set a research/experiment cadence; record it as local
policy, not a universal optimum or a proxy for evidence quality. Count an
experiment only when it includes an executed relevant probe or direct
observation. Preparation or interpretation alone cannot establish the result.
If execution is blocked, retain setup evidence and leave the intended question
open. Do not invent timing compliance or build a general harness to satisfy a
quota.

If a quick experiment answers the decision sooner, stop at sufficient evidence.
Do not pad time or repeat an irrelevant experiment to meet a ratio. If execution
is genuinely blocked, name the blocked operation and missing prerequisite, seek
an authorized smaller substitute, and report which question remains unanswered.
Keep independent work moving. A failed setup can establish a setup limitation;
it cannot establish the result of the intended feature test.

## Strip the probe to the necessary mechanism

Try an existing executable or public API directly with a small representative
input. Change configuration before introducing a service, worker, queue,
container stack, or test framework. Add a tiny fixture only when the existing
entrypoint cannot expose the distinction. Keep the actual mechanism needed to
answer the question. Remove unrelated machinery, not the cause under study.

For example, use a browser directly to investigate a browser configuration
question. Use a parser directly to investigate parsing. Then test the relevant
application path to find whether that component explains the customer's actual
failure or wait. A component result has a limited scope; it does not prove a
complete customer flow.

Change factors separately when that helps diagnosis, then test combinations
when interactions could matter. Repeated, comparable runs are needed for claims
about reliability or speed. A useful exploratory observation can come sooner.
Keep correctness, all attempts, failed responses, metadata, raw observations,
configuration identity, and measurement limits visible.

## Turn results into shared anchors

After a useful probe, report the customer question, observed result, supporting
artifact and conditions, what the result means, the next decision, and the next
unanswered question. Use language that a nontechnical teammate can act on. Name
an inconclusive or blocked result precisely instead of forcing a verdict.

An implementation activity is not proof of customer benefit. A passing unit
test establishes only the behavior it exercises. Mark evidence as component,
integration, customer-flow, or customer-outcome evidence as appropriate. Anchors
can be superseded when versions, inputs, environment, or new observations change
their applicability. Retain the previous observation and the reason for revision.

Once evidence supports implementation, write the exact plan with the applicable
skills and guides. Bind it to verified files, symbols, tools, consumers,
contracts, expected outputs, failure and cleanup behavior, and acceptance
evidence. Check the completed result through the customer's relevant path.

## Read the detail for the decision in front of you

| Need | Read |
| --- | --- |
| Identify and rank unknowns; decide when to ask | [Questions](questions.md) |
| Design direct probes and interpret mixed results | [Experiments](experiments.md) |
| Measure correctness, latency, resources, and failures | [Metrics](metrics.md) |
| Write a concrete, evidence-backed implementation plan | [Planning](planning.md) |
| Share progress and preserve revisable evidence | [Anchors](anchors.md) |
| See product, browser, library, and export examples | [Examples](examples.md) |
| Check the research and distinguish local rules | [Sources](sources.md) |

Use the [brief](templates/brief.md), [experiment](templates/experiment.md),
[anchor](templates/anchor.md), [plan](templates/plan.md), and
[issue](templates/issue.md) templates only when their fields help the task.
They are prompts for judgment, not paperwork quotas. The shared
[software-quality contract](../software-quality.md) remains the owner of
engineering quality, authority, and completion.
