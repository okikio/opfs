# Choose documentation around the reader's job

A developer adding an authenticated download needs different help from someone
learning the API for the first time. The experienced developer needs the
required steps and rejection behavior; the learner needs a controlled exercise
with visible results. Decide which job this document serves before deciding
its headings or length.

Use the supplied request and verified repository context to identify audience,
goal and source of truth. Ask only when missing information materially changes
the result. Documentation work does not require a new intake interview when
those facts are already available.

## Select one primary form

Diátaxis distinguishes four needs. Use them to set the document's promise,
then include enough supporting detail to let the reader complete that promise.
The forms are navigation aids, not a reason to remove essential context.

| Reader's question | Primary form | Useful shape | Result the document must support |
| --- | --- | --- | --- |
| “Help me learn this by doing it.” | Tutorial | Concrete goal, prerequisites, controlled steps, observations, final working example. | A learner can follow the exercise and recognize success or a recoverable failure. |
| “Help me finish this task.” | How-to guide | Goal and assumptions, ordered actions, choices, expected result, failure and recovery. | A reader with baseline knowledge can complete the job without reconstructing omitted setup. |
| “What does this option or API mean?” | Reference | Predictable entries for names, types, defaults, units, behavior, failures and minimal examples. | A reader can find an exact contract and know its authority and version. |
| “Why is it designed this way?” | Explanation | Problem, concepts, causal mechanism, alternatives, constraints and tradeoffs. | A reader can explain the reasons and consequences and locate practical instructions when needed. |

A title should make that promise visible: a task for a how-to, a concrete
learning outcome for a tutorial, the thing being specified for reference, and
the concept or decision for explanation. A single page may support more than
one need, but the reader must not have to guess which parts are instructions,
which describe a contract and which are proposed alternatives.

## Build the useful path for each form

For a tutorial, choose a bounded example with real input and a visible output.
State prerequisites before the step that needs them. Explain just enough for
the next action; link deeper reasoning separately. Run the full example with
the intended setup where authorized, and record what was not executed. An
expected-output block is an assertion to verify, not evidence that a run passed.

For a how-to, state the starting state, authority to act and destination.
Keep required steps distinct from optional choices. Include consequences,
expected outputs and a way to diagnose or recover from material failures.
Avoid broad introductory teaching when the task needs a precise procedure,
but retain reasons where omitting them could cause misuse.

For reference, use consistent per-entry structure. Put units, defaults,
validation, ownership and unsupported cases beside the field or operation that
owns them. Follow public exports, schemas and source comments rather than
creating a second hand-maintained API inventory. Date or version-pin facts
that otherwise appear timeless, and distinguish generated material from
maintained explanation.

For explanation, introduce the concrete problem before specialized vocabulary.
Show how the chosen mechanism produces the outcome and why alternatives cost
something different. Use a representative flow when several owners or states
matter. Diagrams should expose actual relationships, failures and recovery;
the [diagram guide](../../../references/diagrams.md) owns representation and fidelity decisions.
Do not turn an explanation into an operational command sequence accidentally.

## Connect pages without competing authorities

Cross-link the tutorial to the precise reference and the how-to to the relevant
explanation. Keep terminology and headings consistent across that route.
One owner should maintain each exact contract. A second page may explain its
use, but should link to the owner rather than repeat defaults or commands that
can drift independently.

When restructuring existing docs, identify the reader's current entry route
and preserve a usable destination for necessary links. Separate historical
reports, design proposals, generated reference and current procedures. A dated
successful run proves only its recorded snapshot; a proposal does not become
implemented behavior because it appears beside a how-to.

## Check the actual result as a first reader

Read the artifact without relying on the chat. Check whether the intended
reader can find the starting state, follow the instructions or locate the
contract, recognize the result and handle a meaningful failure. Verify names,
paths, commands, examples and source links against the owning repository.
For explanations, inspect whether cause, ownership and tradeoffs can be
followed from the document itself.

Report the particular check performed and its limits. Source inspection does
not prove that an example runs; a passing example does not establish beginner
usability, renderer behavior or human comprehension. Avoid fixed lookup-time
or “without external help” guarantees unless that outcome was actually studied.
Repair missing essential context before presenting the artifact as complete.

## Provenance and further reading

Adapted from the supplied `mcollina/documentation` guidance, version 0.1.0,
Copyright (c) 2026 Matteo Collina, under the retained
[MIT license](documentation-LICENSE). The active reference keeps its four
reader needs and form-specific practices while replacing mandatory repeated
questions, rigid content separation and unmeasured comprehension guarantees
with the workspace's reader and evidence contract. Package-distribution
metadata and the former skill entrypoint are not maintained runtime resources.

The [Diátaxis framework](https://diataxis.fr/) is the primary conceptual source
for the four forms and their relationships. For local prose and API comments,
follow the active write-docs skill's shared documentation and comment routes.
