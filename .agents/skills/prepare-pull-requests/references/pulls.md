# Pull Requests

Apply this reference to PR titles, descriptions, merge summaries, and
reviewer-facing change explanations. Keep commit, TSDoc, and API reference
writing under their own rules.

## Title

Use a concise, outcome-focused Conventional Commit title:
`type(scope): observable change`. Name the affected capability. Avoid vague
subjects such as `improve quality` or `update parser`.

## Lead with what changes, why, and how

Write for a reviewer who knows software but does not know this feature or its
history. Inspect the affected code, callers, contracts, and relevant product or
architecture docs before explaining the change. Distinguish implemented behavior,
planned composition, and deployed proof. Do not invent background to connect a
story, or copy a plan as evidence that a system already runs.

Open with a short, self-contained summary answering **what changes, why it
matters, and how the change achieves that result**. A few bullets or sentences
usually suffice. Name the actual behavior and consequence; "makes authoring more
reliable" alone is not enough. Include any material required action or release
limit early. Define only the terms needed to understand this summary.

Do not make an experienced reviewer read onboarding, architecture, history, or a
large diagram before learning the point of the PR. Do not replace the summary
with links to background. A reader should be able to stop after the opening and
understand the change; a new reader can then continue for the context behind it.
A PR is a guided review, not a file list or an implementation transcript.

Use connected explanations rather than compressing the PR into feature labels
and file paths. If the user provides an explanation that already works, preserve
its causal story and structure as the baseline. Add the missing context; do not
replace it with a checklist merely to reduce the word count. Brevity means
removing repetition and irrelevant detail, not removing the reason a fact matters.

For a substantial behavioral change, this progression often works:

1. **Opening:** state the purpose, concrete change and high-level mechanism in a
   short paragraph or bullets. Surface material required actions and release gaps.
2. **Product level:** use a real example to explain the user's goal, old failure,
   consequence and resulting behavior. Add enough onboarding or neighboring
   product context to show why this step exists, after the opening.
3. **Usage level:** explain the user's actual steps, which stay the same, and
   which change. Connect operator or developer tasks to why new observations,
   configuration or actions matter. Keep stakeholder reasoning with the relevant
   behavior rather than forcing another matrix or repeated section.
4. **System level:** explain the owning systems and handoffs, then the changed
   contracts, failure behavior and limits. A small diagram can supply an ownership
   or sequence relationship that is harder to infer from prose.
5. **Review priorities and evidence:** give a short ordered route to the risky
   decisions and code, checks actually run, their scope, and remaining release work.

This is a useful reading pattern, not a fixed template. Keep the description
proportionate to the change, and link deep architecture or operational procedure.
Do not duplicate a full explanation in the opening, a diagram, a stakeholder
section and a mechanism section. Do not optimize for the fewest words or the most
visuals at the expense of comprehension.

These are reading needs, not mandatory headings. Combine them when that makes
reading easier. A small local fix can satisfy them in a short paragraph, a
before/after example, and test evidence. Do not force an onboarding diagram into
a spelling fix. In the background section for a change deep in a product flow,
start far enough upstream that a first-time reviewer can understand why the
changed step exists. When onboarding establishes inputs or authorization, show
that connection there. Preserve the summary-first order.

## Make the context visible

Add a diagram only when it makes an important relationship easier to understand
than prose alone. It should support the explanation, not replace the product,
usage or system reasoning. A compact flow or ownership map is often sufficient;
additional views need an independent purpose.

Choose ASCII for a small flow that remains readable in raw Markdown and on a
narrow screen. Choose Mermaid or another rendered chart when its layout explains
branching, sequence or ownership more clearly. Neither format is mandatory or
forbidden. Avoid both wide ASCII canvases and stacks of tall rendered charts.
Evaluate explanatory value, total scrolling and narrow-screen readability rather
than treating diagram count or format as a quality score. Link full architecture
or lifecycle documentation when it would overwhelm the PR. Respect the user's
current preference without turning a situational correction into a blanket ban.

Mark the changed step with words. Keep journey chronology separate from system
handoffs: neighboring steps must not imply an invented call or data transfer.
Distinguish draft, approval, and evidence. Preserve relevant refusal, unknown,
retry, or cost conditions in the diagram or nearby prose.

Follow [diagrams.md](../../../references/diagrams.md) for representation and fidelity. Check every
node and arrow against source or clearly label it as a proposal. Never imply a
new integration, deployed path, durable store, or successful live call merely
because a diagram makes the story simpler.

## Choose the format by the reader's question

- Use short bullets for fast facts, actions, and parallel outcomes.
- Use tables for compact comparisons and exact mappings. Each cell must answer
  its column's question without relying on private background. Do not force
  causal explanations or long file paths into a wide table.
- For stakeholder impact, prefer short role-based paragraphs when explaining
  why takes more than a concise cell. A useful chain is: their task -> problem
  -> changed behavior -> consequence or required action. Keep that chain explicit
  in the prose; do not use bare labels such as "effect" or "attention" as a
  substitute for it. Separate a new requirement from an existing responsibility.
- Use connected prose for the background and causal explanation.
- Use a diagram for movement, sequence, ownership, and branching.
- Put long command output and secondary implementation detail behind a disclosure
  or link. Keep configuration breaks, spend risks, and verification gaps visible.

Do not substitute a long checklist, an unexplained noun list, or an exhaustive
file inventory for an explanation. Explain the effect first; use paths and
symbols to help reviewers find its implementation afterward.

## Help the reviewer choose where to spend time

Use an ordered list for review decisions with substantial explanation or long
paths. A compact table can work when the entries stay short:

| Priority | Decision or risk | Code to inspect | Evidence and limits |
| --- | --- | --- | --- |
| 1 | Highest-impact contract or failure condition | Exact path or symbol | Relevant test, result, and unverified boundary |
| 2 | Next independent behavior | Exact path or symbol | Relevant proof |

Fill this with the actual PR's decisions. Separate review decisions from routine
mechanics. Mention affected consumers, configuration, persisted data, recovery,
privacy, and operating cost when they are real consequences. Link relevant
background or dependent PRs, but retain enough context to read this PR alone.
For a stack, explain what the parent provides and what this slice changes.

Report real checks and their scope. A passing unit test does not prove deployment,
provider behavior, storage durability, or customer acceptance. State remaining
release work and meaningful rollout conditions without turning hypothetical risks
into a generic warning checklist. Do not invent alternatives, issue numbers,
links, or verification results.

## Check the description as a first-time reviewer

Before publishing, answer these questions from the description alone:

- Can I learn what changes, why it matters, and how it works from the opening
  alone, before reading background or diagrams?
- What problem does this solve, for whom, and at what point in their work?
- What inputs and approvals lead here, and what result comes next?
- Which systems own the surrounding steps, and which parts does this PR change?
- What example makes the new behavior concrete, including relevant failure cases?
- For each affected person, why does this change affect their work, and why is
  any requested action necessary?
- Can I scan the review without excessive scrolling or repeated explanations?
  Have I preserved the example and causal explanations that make the change
  understandable, while removing repetition?
- Does the chosen view remain readable on a narrow screen?
- Where should I review first, why, and what evidence supports that decision?

If a new reader needs private conversation history to answer these, add the
missing context or simplify the view. Do not add more headings merely to make
an explanation look complete.
