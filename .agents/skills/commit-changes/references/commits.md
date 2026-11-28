
# Commit messages

Apply these rules only when writing or revising commit messages.

Do not apply them to changelog entries, release notes, PR prose, docs, code comments, or TSDoc unless the task is specifically about commit messages.

A good commit message should let someone scan `git log` and understand the work without opening every diff. Each message should make clear:

1. what changed
2. where it changed
3. what specific surface area was affected
4. what behavior, guarantee, workflow, edge case, or maintenance outcome is now true
5. why it mattered
6. whether there is migration or upgrade impact

Keep messages changelog-friendly, but preserve enough context that the commit history still tells the story of the work.


## Start with the commit, not the wording

A strong message cannot rescue a badly composed commit.

Before writing the subject or body, derive the commit from the actual source change. Read the relevant diff, surrounding implementation, tests, public API, and documentation. Do not write from an earlier summary when the source is available.

The commit should contain one coherent behavior, contract, implementation step, or maintenance outcome. File boundaries are not commit boundaries. A single file may contain changes for several commits, and one commit may need small hunks from several files.

Use partial staging when it makes the history more accurate:

```text
one file
  ├─ hunk A -> commit about parser behavior
  ├─ hunk B -> later API migration commit
  └─ hunk C -> formatting-only change, restore or separate
```

Interactive `git add -p` is useful for manual work. Deterministic patch series may use an exact index-only patch such as `git apply --cached` when reproducibility matters.

Do not create a commit merely because a changed file needs somewhere to go. If a change is accidental, contradicted by tests, obsolete, formatting-only, or unsupported by the current implementation, restore it or isolate it instead of inventing a rationale.

A good message describes a coherent commit. It does not manufacture coherence after staging.

## Derive every claim from the source

Commit prose is historical evidence. Treat factual accuracy as more important than elegance.

Before stating that a package now owns something, a value is authoritative, a file is obsolete, a workflow is durable, or a behavior is newly introduced, verify that the changed code actually establishes that claim.

Distinguish:

- behavior introduced by this commit
- behavior that already existed and is only renamed, documented, or wired differently
- behavior implemented in another commit in the same series
- design intent that is not yet implemented

Do not pull later behavior backward into an earlier commit message.

Bad:

```text
refactor(registry): make extractors define collection requirements
```

when extractor collection planning already existed and the actual change only renames an identifier.

Better:

```text
refactor(browser)!: record content probes by extractor ID
```

when Browser changes `technologyId`/`technology_id` to `extractorId`/`extractor_id` through the stored observation path.

If the tests or callers contradict a proposed explanation, fix the grouping or downgrade the claim before polishing the prose.

## Use concrete actors instead of invented architecture shorthand

Name the package, function, command, record, table, route, field, process, or user-visible state that actually participates in the change.

A reader who knows the repository names should not need to memorize an architecture vocabulary to decode the message.

Avoid compressed phrases such as:

```text
semantic owner
executable owner
publication authority
runtime composition owner
projection authority
lifecycle owner
```

unless those are established project terms and the sentence immediately makes the concrete behavior clear.

Prefer:

```text
Registry describes technologies and their evidence rules.
Browser stores the extractor ID attached to each compiled content probe.
The report builder reads one published semantic commit from ClickHouse.
The Account service resolves membership before loading the workspace.
```

The concrete noun usually makes the architecture clearer than the category invented to summarize it.

## Explain the causal change in plain English

The strongest bodies usually follow a natural causal sequence:

```text
what the code did before
        ↓
what these hunks change
        ↓
what is now true
        ↓
why that matters in a real call, failure, retry, migration, or user flow
```

Write this as smooth prose. Do not force headings such as `Previous behavior:`, `New behavior:`, or `Why it matters:` unless the commit is unusually complex and the labels genuinely improve scanning.

A useful body often needs only two paragraphs:

```text
The importer previously treated every normalized CSV header as if the generic
CSV package understood company fields. Import now assigns company, domain,
email, website, and unknown roles after structural CSV parsing.

That keeps CRM vocabulary in the import feature. A caller can reuse the CSV
parser without inheriting application account-column semantics.
```

The body should answer the natural follow-up questions created by the subject. Do not repeat the subject with more words.

## Use examples as evidence, not decoration

A concrete example is valuable when it proves the changed behavior.

Good examples name an actual:

- field
- route
- command
- state transition
- error
- retry
- record
- table
- fixture
- caller
- migration step

Do not invent a hypothetical example that the diff does not support.

Prefer:

```text
A repeated ResultReady delivery with the same signed bytes reuses the existing
inbox record, while conflicting bytes for that durable identity are rejected.
```

over:

```text
This makes callbacks more robust.
```

Examples should reduce ambiguity, not lengthen the message for its own sake.

## Keep the series readable as one story

For multi-commit work, review the whole `git log` sequence after drafting individual messages.

Order commits so a reader can follow the implementation dependency:

```text
data contract
  -> generic mechanism
  -> persistence
  -> package behavior
  -> service composition
  -> executable host
  -> product UI
  -> integration coverage
  -> documentation
```

The exact order depends on the work, but each subject should explain one step and prepare the reader for the next.

Avoid two failure modes:

1. chronological activity logs such as `update schema`, `update service`, `update UI`
2. subjects that all restate the final architecture instead of describing the specific step

Adjacent bodies should not claim the same behavior was introduced several times. Name the exact responsibility added at each step.

## Prefer narrow commits over broad messages

When a proposed subject needs `and`, check whether the commit contains two independently reviewable outcomes.

Not every `and` is wrong. A fix may need two inseparable sides of one contract. But large subjects are often a signal that the staging should be split.

Generated artifacts follow the same rule:

- stage a generated migration with the schema change that requires it when they are one reviewable contract
- stage a lockfile with the dependency changes that produced it when practical
- use a focused lockfile refresh commit when many earlier dependency changes converge and splitting generated hunks would be misleading
- do not hide unrelated source changes inside `build(deps)` or another generated-file commit

Formatting, import sorting, line-ending changes, permission changes, and other mechanical churn should not be used to fill out a functional commit.

## Core shape

Use Conventional Commits:

`type(scope?): plain-english change to a specific surface area and the concrete outcome of the change`

The subject is the scan line. The body carries the nuance.

Write the subject around the most important changed surface and the concrete outcome, not the activity that produced it. A good subject answers the first pass of `what changed, where, and what is now true?` without forcing the reader to open the diff.

Good:
- `fix(parser): keep trailing text after unmatched table row delimiters`
- `feat(cli): print extraction counts in --json summaries`
- `docs(diagnostics): document UTF-16 ranges on "Unexpected token" recovery errors`
- `docs(api): add parser recovery range example for editor diagnostics`
- `test(storage): keep stale reads from extending per-origin cache expiry`

Bad:
- `fix: improve parser`
- `feat: add support`
- `docs: update docs`
- `docs(api): document offset stability`
- `test(storage): pin cache behavior`

## Subject rules

- Use a lowercase type.
- Use a scope only when it helps a reader locate the area quickly.
- Do not end the subject with a period.
- Name the result, not the effort.
- Prefer the behavior, guarantee, workflow, or contract that changed with specific concrete implementation detail.
- Name the changed surface area as specifically as the subject can reasonably carry.
- Include the concrete "and what": what is now true, fixed, protected, clarified, possible, or intentionally different.
- Include a concrete example when it makes the changed surface easier to scan, such as an exact title, route, command, field, output key, state, error message, or fixture case.
- If the commit includes several changes, lead with the highest-value surface and outcome, then leave supporting detail for the body.
- Avoid vague verbs such as `improve`, `update`, `enhance`, `clean up`, or `address` unless the object makes the outcome concrete.
- Avoid turning the subject into a shopping list.

Useful scopes include areas like `parser`, `events`, `cli`, `deps`, `scripts`, or `instructions`. Skip vague scopes such as `misc`, `general`, or `stuff`.

## Plain-English subjects

Prefer plain-English subject lines wherever possible.

A commit subject should be specific without becoming stiff or abstract. Name the changed surface area and the outcome in words a maintainer would naturally use while scanning `git log`.

Use technical terms when they are the clearest name for the surface, but do not make the subject sound more abstract than the change actually is.

Good:

```text
fix(parser): keep trailing text after unmatched table row delimiters
docs(diagnostics): document "Unexpected token" errors keep recovered UTF-16 ranges
refactor(popup): keep refresh buttons disabled during active analysis requests
bench(matcher): compare script-url indexing with full registry scans
```

Weak:

```text
refactor(popup): isolate refresh lifecycle state derivation owner
docs(api): document offset contract semantics
fix(parser): remediate malformed table continuation behavior
```

## Subject specificity and surface area

Prefer plain-english subject lines that name the changed surface area and the concrete outcome. The subject should be natural to read, but specific enough that `git log` remains useful without opening every patch.

A good subject answers:

- what changed?
- where did it change?
- what specific surface, behavior, guarantee, workflow, or contract is affected?
- when or for whom does that matter?

Avoid broad guarantees that still force the reader to ask `for what?`, `where?`, or `who depends on this?`.

Weak:

```text
docs(api): explain UTF-16 offset guarantees
docs(api): document UTF-16 offset stability after parser recovery
test(storage): pin cache behavior
fix(parser): handle malformed tables
refactor(popup): improve refresh state
```

Better:

```text
docs(diagnostics): document "Unexpected token" errors keep recovered UTF-16 ranges
docs(api): add editor diagnostic example with recovered UTF-16 ranges
docs(parser): clarify recovered node spans used by source map output
test(storage): keep stale reads from extending per-origin cache expiry
fix(parser): preserve trailing paragraph after malformed table row delimiters
refactor(popup): keep refresh buttons disabled during active analysis requests
```

The body can carry nuance, tradeoffs, and secondary cases. The subject should still include enough of the affected surface and concrete result that the commit is useful as a scan line. When a subject says `stability`, `guarantee`, `behavior`, or `contract`, attach it to the exact consumer, output, field, route, command, state, or workflow that receives that guarantee.

## Concrete examples in subjects

Use a concrete example in the subject when it makes the changed surface easier to understand. Prefer naming the exact route, title, command, field, output key, state, error, or representative behavior over summarizing the change abstractly.

Weak:

```text
fix(page): correct document title
docs(api): document diagnostic range behavior
fix(parser): improve recovery message
test(storage): pin cache behavior
```

Better:

```text
fix(page): change settings title to "Lorem Ipsum"
docs(diagnostics): document "Unexpected token" errors keep recovered UTF-16 ranges
fix(parser): attach "unterminated table row" errors to the recovered node
test(storage): keep stale analysis reads from extending per-origin cache expiry
```

Concrete examples are especially useful for visible copy, error messages, command names, routes, field names, event names, output keys, state names, fallback behavior, test fixtures, and API guarantees. Do not overload the subject with every changed value. Name the example that best represents the changed surface, then put secondary examples in the body.

A concrete example should still say what the example proves. `document "Unexpected token" recovery errors` is better than `document diagnostic behavior`, but `document "Unexpected token" errors keep recovered UTF-16 ranges` is stronger because it names the diagnostic, the affected range surface, and the documented guarantee.

## Documentation subject verbs

Prefer verbs that describe the documentation change directly.

- Use `add` when the commit adds a concrete example, guide, section, table, command, or note.
- Use `document` when the commit records a guarantee, behavior, limitation, migration step, or contract.
- Use `clarify` only when the subject names the ambiguity being resolved.
- Use `describe` when the commit explains how a workflow or mechanism operates.
- Avoid `show` unless the commit literally changes a displayed UI, screenshot, demo, or rendered example.

Good:

```text
docs(api): add editor diagnostic example with recovered UTF-16 ranges
docs(diagnostics): document "Unexpected token" errors keep recovered UTF-16 ranges
docs(parser): clarify recovered node spans used by source map output
docs(cli): describe --json count fields in batch extraction summaries
```

Weak:

```text
docs(api): show parser recovery keeps UTF-16 ranges
docs(parser): clarify parser behavior
docs(cli): explain --json output
docs(api): document guarantees
```

## Documentation subjects as mini-summaries

A `docs` subject should act as a mini-summary of the documentation that was written. It should not only say that documentation exists. It should compress the actual documentation claim, example, workflow, limitation, or guarantee into the scan line.

A good `docs` subject answers:

- what did the new or revised documentation teach?
- which reader, command, output, API, error, route, or workflow is affected?
- what concrete example, guarantee, limitation, or migration step is now captured?

Weak:

```text
docs(api): add parser recovery docs
docs(cli): update --json section
docs(parser): clarify source maps
docs(auth): document redirect behavior
```

Better:

```text
docs(api): add editor diagnostic example with recovered UTF-16 ranges
docs(cli): describe --json count fields in batch extraction summaries
docs(parser): clarify recovered node spans used by source map output
docs(auth): document login redirects preserving return_to on expired sessions
```

The subject should read like a short summary of the added paragraph, table, example, or section. If `add`, `document`, `clarify`, or `describe` is followed by a broad noun, keep going until the changed documentation surface and its concrete point are visible.

## Body

Add a body when the subject alone would hide important context. Typical cases:

- the change is not obvious from the subject
- the commit fixes or covers more than one important case
- the behavior is subtle or easy to misread
- the change affects migration, compatibility, rollout, or upgrade work
- the commit includes performance or measurement claims that need support

A good body usually explains:

- what was wrong or limited before
- what is true now
- why the change matters
- the most important secondary cases or tradeoffs
- any migration or rollout note a future reader will need

Prefer short bullets or short paragraphs. Avoid filler such as `add tests`, `cleanup`, or `misc fixes` unless tied to the behavior they protect or enable.

## Body narrative pattern

When the change needs context, use a smooth before-and-after narrative.

Default to one or two short paragraphs rather than hard sections. Start from the concrete limitation, describe the changed behavior, then explain the consequence that matters.

Good:

```text
The queue previously removed a claim before every waiter had observed its
terminal result. Drain now keeps the claim alive until those waiters settle.

A second consumer therefore cannot receive the same item while the first
claim's completion is still being observed.
```

Avoid template-shaped prose unless the structure genuinely helps a very complex migration:

```text
Previous behavior:
New behavior:
Why it matters:
```

Do not use labels merely because they are available. Smooth prose usually makes causality easier to read and avoids repeating the same facts under several headings.

## Scope governance

Use scopes as project navigation, not decoration.

A scope should name a real subsystem, package, workflow, interface, or toolchain area. Avoid scopes that merely name a file location, vague layer, activity, or bucket for unrelated work.

For mature projects, keep a small scope map that documents:

- scope name
- what subsystem or workflow it represents
- when to use it
- when not to use it
- rejected or merged alternatives

Reject vague scopes such as `misc`, `cleanup`, `core`, `utils`, `shared`, `common`, and `app` unless the project has given one of those names a precise meaning.

## Commit plans for multi-step work

For migrations, refactors, and patch series, plan each commit before writing it.

A useful commit plan records:

- commit message
- why this step exists
- changes included
- files likely touched
- verification steps
- acceptance criteria
- risk
- rollback path

Keep this planning detail in the PR, design note, or patch plan. Do not force all of it into the final commit body.

## Reviewability and rollback

A good commit should be reviewable and revertible as one coherent unit.

Before finalizing, check:

- does the commit change one subsystem, workflow, or contract?
- are unrelated cleanups excluded?
- can the reviewer understand the intent without reconstructing the whole diff?
- can the commit be reverted without undoing unrelated work?

## Type guidance

Choose the type that best matches the outcome:

- `feat`: a new capability now exists
- `fix`: broken behavior now works correctly
- `docs`: a specific fact, contract, rule, limitation, example, workflow, or migration step is now clear
- `refactor`: internal structure changed with no intended behavior change
- `perf`: something got faster, smaller, or cheaper in a way worth naming
- `test`: a behavior or regression case is now protected
- `bench`: benchmark coverage or measurement trust improved
- `chore`: maintenance outcome changed, but not a user-visible behavior
- `build`: build, packaging, or dependency behavior changed
- `ci`: pipeline or automation behavior changed

Type-specific precision matters. For example:

- `feat` should name the new capability, not just "support"
- `fix` should name the broken behavior that now works
- `docs` should summarize the fact, example, workflow, limitation, or guarantee now documented, not the writing effort
- `refactor` and `chore` should not be used to hide meaningful behavior changes
- `perf` should say what got cheaper and where it matters; include the practical effect in the body when useful

## Breaking changes

Mark breaking changes with `!` and explain the migration impact in the body or footer.

Example:

```text
feat(api)!: remove implicit trim from align()

BREAKING CHANGE: Callers that relied on implicit trimming must call trimEnd() explicitly before align().
```

Make the impact easy to spot. State what changed, who is affected, and what they now need to do.

## Source and series review

Before accepting a message, compare it with the staged diff rather than only with the work plan.

Check:

- every behavioral claim is visible in the staged source or its tests
- the message does not describe behavior that belongs to a later commit
- no important staged hunk is missing from the explanation
- no unrelated hunk is being justified only because it shares a file
- concrete package, API, field, route, state, or process names replace unnecessary architecture shorthand
- a maintainer unfamiliar with the design discussion can understand the body from repository terminology alone
- examples are supported by real code paths or tests
- generated files and lock changes are attached to the behavior that produced them, or have a clearly explained focused refresh commit
- mechanical churn is excluded or intentionally isolated
- adjacent commits form a dependency story without claiming the same change twice

If the staged diff and the prose disagree, change the commit or change the message. Do not rationalize the mismatch.

## Final check

Before finalizing a commit message, check:

- was the message derived from the staged source rather than an earlier summary?
- is the commit itself one coherent unit, including partial-file staging where needed?
- can someone tell what changed from the subject alone?
- does the body name concrete actors instead of requiring invented architecture vocabulary?
- does it clearly separate what already existed from what this commit actually introduces?
- does the subject name the affected surface area precisely enough for `git log` scanning?
- does the subject include the concrete behavior, guarantee, workflow, or example that makes the change understandable?
- for `docs` commits, does the subject read like a mini-summary of the documentation rather than a note that docs changed?
- does the subject avoid vague nouns such as `stability`, `behavior`, `contract`, or `guarantee` unless the exact affected surface is named?
- if they read the body, can they understand the important context without opening the diff?
- does the commit preserve the details a future changelog writer would want?
- if several commits are viewed together in `git log`, do their subjects read like a coherent story instead of a list of activities?
- if the change is breaking, is the migration step explicit?
