# Readability and ownership

Make every result clear enough for the user to understand, maintain, and share
with someone who has not read the chat. Essential understanding must not depend
on the author, an AI assistant, or missing conversation history. This is a
condition of completion alongside technical correctness and verification.

This rule applies to explanations, research, plans, progress updates, code
structure, names, comments, tests, interface text, errors, documentation, commits,
PRs, release notes, and handoffs. It also applies to delegated work when
delegation is authorized, and to the final response accompanying a deliverable.

For example, a change that prevents an importer from creating duplicate records
needs more than a statement that it is idempotent. Explain what happens when the
same input arrives twice, which identifier determines sameness, where that rule
is enforced, and how failures affect a retry. Supply evidence for the behavior
actually checked. A maintainer needs those facts to change the importer safely.

## Establish the reader's job before work starts

Identify the intended reader, what they need to decide or do, the current source
of truth, and the background needed to follow the work. Infer these from the
request and available context when possible. Ask only when missing information
would materially change the result.

For substantial tasks, include an understandable explanation and usable handoff
in the acceptance criteria from the beginning. Choose where durable knowledge
belongs: code for executable behavior, nearby comments for non-obvious reasons,
and maintained documentation for workflows and system relationships. A chat
summary cannot replace missing information in the artifact that needs it.

## Make the start and finish observable

For a coding change or other substantial task, make the two checks observable
without waiting for a reminder. In the initial work update, name the intended
reader or user, their task, the factual sources you will inspect, and what they
must be able to use or maintain when the work is done. One or two concrete
sentences suffice. Before the final response, review the actual changed code,
tests, and documentation from that reader's position. Repair essential gaps,
then report a specific review finding or explain how a concrete part of the
artifact supports use or maintenance, together with the verification limits.
A list of changed files, passing tests, or a claim that a review happened does
not establish this check. Do not invent a defect to report or add a ritual
checklist; a small coding fix needs only a short orientation and handoff.

## Review readability at several levels

| Level | Required result |
| --- | --- |
| Words and names | Terms identify concrete things. Unfamiliar terms are explained before use. Each concept keeps the same name. Preserve established external and persisted names unless their migration is authorized. |
| Sentences | The reader can tell who or what acts, under which condition, and with which result. Units, owners, and causal relationships are explicit where they matter. |
| Explanation order | Introduce the concrete problem and behavior before detailed conditions and implementation mechanics. Give a representative example when it reveals a contract the reader could otherwise misread. |
| Complete documents and answers | The reader can find the purpose, instructions, evidence, decisions, and limitations without reconstructing scattered fragments. Use headings, lists, tables, or diagrams when they help that task. |
| Code and system behavior | A maintainer can trace responsibilities, inputs, state changes, defaults, failures, retries, cancellation, and cleanup where relevant. Names, module structure, control flow, tests, and comments work together to expose the contract. |
| Ownership and handoff | Another intended reader can use, verify, operate, and maintain the result without the chat or an AI assistant. Durable instructions explain prerequisites, expected outcomes, important failure recovery, and unresolved gaps. |

Readability preserves technical reasons, constraints, tradeoffs, and failure
conditions. Removing those details to shorten an answer can make the result
harder to maintain. Conversely, repetition, unnecessary terminology, and long
lists of mechanics can hide the behavior the reader needs first. Use progressive
detail and links to the actual source of truth rather than repeating everything.

Do not use comments or a polished final explanation to disguise code whose
responsibilities and control flow remain unnecessarily difficult to follow.
Review the implementation itself. Keep abstractions when they express a useful
contract, and explain the invariant or cost that makes necessary complexity
worth retaining. Do not flatten a system in ways that change its guarantees.

## Connect the customer, user, and system flows

For work spanning a product or several components, explain the same
representative flow from three views:

| View | What the reader must be able to follow |
| --- | --- |
| Customer | The outcome the customer needs, why it matters, and the conditions that make it useful. |
| User | The steps a person takes, the results they see, the decisions they make, and their options when something fails. |
| System | The components that own each step, the data they exchange, the state they change, and how they handle failure and recovery. |

Connect these views explicitly. For example, a customer needs a useful account
alert; a user chooses the accounts and receives the alert; the system collects
evidence, determines whether the alert conditions hold, and delivers the result.
A maintainer needs to know where an absent or incorrect alert could originate
and what the user sees in each case. Verify the actual project behavior before
using such a flow as an implementation description.

For tooling work without a product customer, identify the person or team relying
on the result and explain their workflow. Do not invent a customer layer merely
to fill a template. A list of modules or a diagram of service names cannot
replace the steps, causes, and consequences that connect them.

## Explain behavior before compressed implementation terms

Use plain technical English and the existing technical-writing guide to make
causality explicit. Simplified Technical English techniques can help with
consistent terminology, clear actors, and direct instructions. Do not claim
formal standards compliance without selecting and checking that standard.

The linked conversation identified these recurring failures:

| Compressed wording | Explanation the reader needs first |
| --- | --- |
| Version-only workspace releases previously qualified every owner. | Changing only a package's version previously caused CI to check every package in the workspace. |
| Native pnpm reverse closures. | Use pnpm to find packages that depend on the changed package, directly or through other packages. |
| Public-API identity check. | Check that every package named in a release file exists in the workspace. |

These are explanations from that PR critique, not universal replacements for
those terms in every system. Check the actual behavior before reusing them.
Introduce a precise technical term after its meaning is clear when the term
helps the reader follow further detail.

Keep validation evidence attached to the behavior and revision it supports.
Separate checks of the final change from historical failures or tests of another
revision. Finding fewer selected packages supports a claim about selection;
claiming faster CI requires timing evidence. Preserve such distinctions in the
explanation rather than hiding them in a dense qualification paragraph.

## Inspect the deliverable before claiming completion

Read the actual changed artifact as someone with the expected background who
has not seen the conversation. Establish whether that reader can:

- explain the result and why it exists;
- follow the necessary steps and recognize the expected outcome;
- distinguish verified behavior from assumptions, proposals, and unrun checks;
- locate the relevant owner and source of truth;
- maintain the affected behavior, including important failures and constraints;
- share the artifact without supplying missing chat history.

Check each instruction against the available sources: does the reader actually
have the named control, record, permission, or recovery mechanism? If that is
unknown, identify the gap instead of inventing an operational step. Explain
unfamiliar terms at first use in the artifact itself. Before finishing, reread
the artifact for those terms, unsupported actions, and overstated evidence;
repair what you find. A list of topics covered is not evidence of this review.

Revise essential gaps before claiming completion. If a gap cannot be resolved,
state the specific limitation and remaining work; do not call that part complete.
Technical checks support correctness but do not establish human comprehension.
State only the review and verification actually performed.

Scale this review to the task. A small answer needs a brief internal check.
Substantial work warrants a deliberate pass over the deliverable and may benefit
from an independent review when authorized. Do not require a second agent or
turn every final response into a checklist. The completion requirement is the
reader's ability to take ownership, not the performance of a reporting ritual.

## Adoption and maintenance

This guide owns the shared readability contract. Change the authored source,
regenerate the affected skill bundles, and review the resulting content in the
context where a reader will use it. A generated copy is not a second authority.

A project can put a compact version in its existing instruction file so the
requirement remains visible across capabilities. Merge it with the current
instructions and follow the chosen agent host's documented discovery rules;
do not assume every host uses the same paths, inheritance or startup behavior.

After adoption, use a fresh session and a representative task. Inspect the
loaded instruction sources and the resulting work. A saved file or an
instruction summary alone does not establish activation or reader comprehension.
