# Documentation writing

## Start from the reader's job

Choose the document's primary job before writing: tutorial, how-to, reference, concept, troubleshooting guide, design note, review, handoff, changelog, or operating procedure.

A document can contain supporting material from another mode, but it should not make the reader guess whether it is teaching, specifying, reviewing, or proposing.

## Build the mental model progressively

For explanatory documentation, prefer this narrative progression:

1. what the thing is;
2. the concrete problem it solves;
3. what the reader gains from it;
4. the high-level mechanics;
5. a representative example or end-to-end flow;
6. important options and alternatives;
7. failure modes, limits, lifecycle, and deeper implementation detail.

This is a narrative default, not a template. A reference page can move directly to exact contracts after a short orientation. A design note may lead with the decision and evidence.

Explain concrete behavior before specialized terminology when that helps a new reader. Define one technical noun once and use that noun consistently throughout the document.

## Plain technical English is the default

Use clear, direct technical English. Formal ASD-STE100 or a repository-specific STE profile applies only when the current task explicitly requests it.

Even without formal STE, prefer:

- active voice;
- concrete nouns and verbs;
- one main idea per sentence where practical;
- short sentences when a longer one hides causality;
- explicit units, states, owners, and effects;
- transitions that connect one idea to the next.

Avoid em dashes, vague adjectives such as `better`, and self-referential filler such as `this section will explain` when the explanation can begin directly.

## Distinguish fact from proposal

A document must make the status of a claim clear.

Use precise language for:

- **implemented behavior**: verified in current source or runtime;
- **documented upstream behavior**: supported by a current primary source;
- **inference**: a conclusion drawn from evidence but not directly specified;
- **proposal**: a recommended change that does not exist yet;
- **future work**: explicitly deferred capability.

Do not let a package name or architecture diagram imply that the implementation already provides the complete target capability.

When documents and code disagree, say which one is current for the question being answered.

## Headings and transitions

Add a heading only when it marks a substantial new topic or materially improves navigation. If the next paragraph continues the same argument, use a transition sentence instead.

A heading should tell the reader what changed in the subject, not merely label the next paragraph with `Details`, `Impact`, or `Notes`.

## Examples

Use examples when they reveal behavior a reader cannot safely infer from the signature alone.

For reusable APIs, prefer a common-path example first. Add an edge case or configuration example when it teaches a material rule such as cancellation, ownership, precedence, limits, or malformed input behavior.

Introduce each code block with prose that tells the reader what to notice. Do not make code comments carry the only explanation.

## Visual explanations

Choose the visual form from the reader's question.

Examples:

| Reader needs to understand | Prefer |
| --- | --- |
| Order between participants | Sequence diagram or ordered ASCII lifecycle |
| Ownership across stages | Swimlane or owner-labelled lifecycle |
| Legal state changes | State machine |
| Exact condition combinations | Decision table |
| Components and dependencies | Component/dependency map |
| Data shape changes | Data-flow diagram |
| Quantitative comparison | Chart suited to the measure, not an architecture box diagram |
| Exact mappings | Table |

Use the least complicated representation that preserves the truth the reader needs. Do not force every problem into Mermaid or a box-and-arrow diagram.

Always explain what the visual shows, how to read it, and which detail it intentionally omits.

## Architecture and lifecycle documents

For systems with several owners, runtimes, or durable states, show enough of the lifecycle to explain correctness.

A useful sequence is:

1. the user or caller goal;
2. the major owners;
3. the complete normal path;
4. the shapes that move between important owners;
5. cancellation, failure, retry, stale-work rejection, and cleanup;
6. resource and throughput limits;
7. current risks and the proposed change.

Do not compress a complex lifecycle into a five-box pipeline when the missing publication order, lease, generation, retry, or cleanup step is the reason the system works.

## API and package documentation

A package README should orient the consumer around real use cases. An API reference should state exact contracts. Architecture docs should explain why the pieces compose the way they do.

For package docs, cover as applicable:

- purpose and current implementation status;
- public entry points and normal call sites;
- schemas/types and behavioral interfaces;
- ownership and disposal;
- cancellation and progress;
- limits and memory behavior;
- expected failures and unsupported cases;
- runtime differences;
- examples that compose into an end-to-end workflow.

Do not duplicate the same prose in README, API reference, and source TSDoc. Give each document a job and link between them when necessary.

## Preserve authored Markdown

Do not run a broad Markdown formatter unless the user explicitly requests formatting.

Preserve unrelated wrapping, spacing, table layout, headings, and code-block structure. Make narrow semantic patches. A code formatter must not rewrite unrelated Markdown as collateral work.

Read-only link, syntax, and spelling checks are appropriate.

## Design notes and handoffs

For a design or implementation handoff, make the authority and status explicit. A useful shape is:

- current state;
- problem and evidence;
- goals and non-goals;
- decisions;
- data/API/lifecycle model;
- alternatives and tradeoffs;
- failure and resource analysis;
- implementation sequence;
- validation plan;
- known gaps.

A handoff should be usable by someone who did not participate in the earlier conversation. Define project terms and show the flow instead of relying on chat history.

## Anti-patterns

- many tiny headings that break one continuous explanation;
- abstract language with no concrete code path, input, output, or failure;
- generic feature lists before explaining why the feature exists;
- documentation that promises target behavior the current code does not implement;
- diagrams chosen because a tool is convenient rather than because the grammar fits the question;
- exact limits or guarantees copied from old upstream versions without current verification;
- broad prose rewrites mixed into a functional code change.
