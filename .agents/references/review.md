
# Code Review

Apply these rules only when:
- reviewing a diff
- generating review comments
- summarizing review findings
- evaluating correctness, risk, or maintainability of a change

Do not apply these rules to ordinary coding, docs writing, or commit/PR authoring
unless the task is explicitly a review.

## Review priorities

Prioritize correctness, clarity, maintainability, and standards alignment.

Review for whether the code tells one understandable story from top to bottom.
Smaller functions are not automatically clearer; extraction is useful when a
helper names a real concept, policy, lifecycle operation, reusable validation
rule, deterministic algorithm, or independently testable transformation.

Prefer fewer, higher-signal comments over noisy review spam.

## Review order

### Preflight: source ownership and the smallest sufficient design

For material or stacked PRs, identify the current base, head, and incremental
diff before reviewing a large cumulative file list. Use a TypeScript/Oxc AST
trace where useful to follow imports, exports, call sites, runtime entrypoints,
schema definitions, handlers, package consumers, task commands, and resource
lifetime. Then inspect the relevant code manually. A syntax match is a review
candidate, not a demonstrated defect.

Ask what each new module, public interface, validation pass, test harness,
registry, and task contributes that an existing owner does not. Check whether
it duplicates a schema or route, reverses a service/package dependency, hides
side effects, or creates an independent state owner without an actual caller.
Prefer the smallest design that preserves the required normal and failure
paths. Preserve framework-required classes, real lazy imports, runtime-specific
tests, and other justified exceptions.

For material findings, record `path:symbol`, the caller and intended owner,
the observed failure or maintenance cost, the controlling rule, a proposed
replacement, and the proof required. Resolve assertion aliases and helper
calls before flagging tests with no oracle. Do not recommend a new mandatory
CI scanner for a judgment that requires following runtime behavior.

### Runtime-coupling review

Inventory direct Node/Deno global accesses and static builtin imports in shared
code, including imports that merely make a host global explicit. Report concrete
sites and affected consumers; replacing `process` with `node:process` does not
make a browser entrypoint portable. Inspect the repository's existing `utils/`
or focused capability before recommending new detection or wrappers. Exclude
justified host adapters and test-runner imports from production defects, while
retaining the candidate inventory and the reason for each exception. Apply the
[TypeScript runtime model](typescript.md) and verify the actual public graph.

### 1. Correctness and contracts

Check:
- does the code do what it claims
- are edge cases handled
- are public contracts consistent across implementation and usage
- does important operation order remain explicit and correct
- do batching, retry, persistence, cache, audit, or lifecycle changes preserve their invariants

### 2. Failure modes and safety

Check:
- are errors explicit
- are trust transitions clear
- are unsafe patterns introduced
- are inputs validated at input entrypoints
- does the change introduce hidden assumptions
- does the change affect `deno doc --lint` compliance

### 3. Types and narrowing

Check:
- avoid `any`
- use unions, generics, and narrowing where appropriate
- public signatures only reference exported public types
- return types are explicit and narrow at module APIs

### 4. Readability and educational clarity

Check:
- names reveal intent
- non-obvious or complex logic is explained
- comments explain why, and when needed what or how
- comments connect local logic to the larger behavior instead of labeling vague concepts
- cohesive logic is kept together unless extraction improves naming, reuse, policy isolation, or testability
- early returns are preferred when they let each branch show validation, work, and result together
- diagrams preserve enough detail to explain lifecycle, ownership, state, and failure-sensitive order
- diagrams are not overcompressed into tidy pipelines that hide the behavior being reviewed
- the diff is understandable without guessing the motivation

If the code is correct but its purpose is hard to infer, suggest improving:
- naming
- docstrings
- PR description
- examples
- diagrams

When suggesting diagrams, prefer chaptered walkthroughs for lifecycle-heavy
changes. Ask for a smaller diagram only when the current one repeats information
or obscures the main path; do not ask to simplify away branches, handoffs,
stored state, or cleanup that are needed to reason about correctness.

### 5. Consistency and style

Check:
- formatting matches the repo
- import structure matches the repo
- public docs follow the repo rules
- tests and benchmarks follow the repo rules where applicable

## Review output tags

Use:
- `[BLOCKER]`
- `[IMPORTANT]`
- `[SUGGESTION]`
- `[NIT]`

For every `[BLOCKER]` or `[IMPORTANT]`, provide a concrete fix suggestion.

Do not leave vague comments such as `improve quality` or `clean this up`.

Tie every comment to:
- a concrete risk
- a broken contract
- a correctness concern
- a readability problem
- or a standards mismatch
