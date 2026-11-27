# TSDoc and comments

## Purpose

Documentation should let a reader understand what a symbol does, why it exists, how it participates in the larger flow, and which rules must remain true without reconstructing that knowledge from call sites and tests.

Do not write comments only to satisfy coverage. A comment should add information that the name, types, and syntax do not already make obvious.

## What needs documentation

Every exported symbol needs useful TSDoc unless it is a direct re-export whose source documentation remains complete.

Also document important non-exported symbols. This includes private or internal:

- functions and methods;
- schemas and data types;
- interfaces and classes;
- constants, lookup tables, regular expressions, parser tables, and token maps;
- fields whose unit, ownership, default, or lifecycle is not obvious;
- parser/tokenizer/scanner state;
- state machines and transition tables;
- resource owners and cleanup adapters;
- algorithms whose correctness depends on a hidden invariant;
- performance-sensitive or allocation-sensitive code;
- benchmark fixture builders when they define the workload being measured.

A private helper can contain the most important invariant in a module. Its visibility does not make the invariant less important.

Document internal state with the same care when it controls leases, generations, retirement markers, caches, retry state, parser cursors, sequence numbers, checkpoints, publication order, or cleanup. The review test is semantic importance, not export visibility.

When a Zod object schema is the authoring source for project data, document important fields directly on the schema properties. Include the concrete meaning, unit, default, allowed-value effect, or example that a caller needs. Do not create a duplicate TypeScript interface only to hold those field comments.

For example:

```ts
export const RetrySchema = z.strictObject({
  /** Maximum attempts including the initial request. @default 3 */
  attempts: z.int().min(1).default(3),
});
```

Trivial glue can remain self-explanatory. `return left + right` does not need a paragraph when the function name already communicates the complete rule.

## Narrative shape

For a significant symbol, build the explanation progressively instead of dumping disconnected facts.

A useful order is:

1. Say what the symbol represents or does in concrete terms.
2. Explain the problem or role that makes it necessary.
3. Connect it to the larger operation or lifecycle.
4. Explain important options and their concrete effects.
5. Show a realistic example when the API is reusable.
6. Explain ownership, cancellation, cleanup, limits, failure, and performance only where they affect callers or maintainers.
7. State the invariant or design reason that future changes must preserve.

Use transition sentences when the prose continues the same subject. Add an internal heading only when the reader is entering a substantial new topic.

Do not use generic labels such as `Impact:` merely to manufacture structure. State the concrete effect directly in the prose.

## Local comments

Local comments should explain the rule the following code preserves.

Weak:

```ts
// Write the bytes.
await writer.write(write);
```

Useful:

```ts
// Preserve the explicit position because a muxer can rewrite earlier container metadata during finalization.
await writer.write(write);
```

Good local comments explain one of these:

- why an apparently unnecessary step is required;
- what race, corruption, leak, or compatibility defect the step prevents;
- which source or downstream state the code deliberately preserves;
- why an optimization uses a less obvious representation;
- why cleanup must happen in a specific order;
- why a malformed input is recovered instead of rejected;
- why a limit exists and what resource it protects.

Do not narrate syntax or repeat the identifier names.

## Ground technical terms in this code

If the explanation uses a specialized term, explain what it means here before relying on it.

For example, do not only say that a parser is `chunk-invariant`. State that the same bytes must produce the same semantic events whether they arrive in one chunk, one-byte chunks, or chunks split inside a UTF-8 sequence.

A good explanation answers both:

- What does this term mean?
- What does it mean in this implementation?

## Examples

Use examples when the API is reusable, configurable, surprising, or failure-sensitive.

Prefer examples with real inputs and outputs. A non-trivial public API should normally show the common path and, when useful, one edge case or configuration that reveals a material rule.

Do not bury the only explanation in code comments inside the example. Introduce what the example demonstrates in prose first.

## Diagrams, tables, and lists

Use a small ASCII diagram when order, ownership, state, retries, cleanup, data shape, or publication order is hard to communicate linearly.

Use a table when the reader must compare exact options, states, units, or tradeoffs. Use a list when sequence or membership matters more than relationships.

Do not repeat the same rounded-box flow grammar for every concept. Choose the representation that answers the reader's question.

## Ownership, cancellation, and resources

When a symbol acquires, borrows, transfers, cancels, pauses, resumes, closes, or disposes a live resource, document that lifecycle explicitly.

State:

- who owns the resource;
- whether the caller transfers ownership;
- what cancellation stops;
- what disposal releases;
- whether cleanup is idempotent;
- what happens after partial failure;
- whether a late completion can still change terminal state.

Do not use a generic lifecycle sentence when the actual close/abort/cancel ordering is the important contract.

## Performance and limits

When performance makes the code less obvious, explain the physical work being avoided or reduced.

State the relevant facts, such as:

- bytes retained in JavaScript memory;
- active requests or workers;
- allocation avoided by spans or indexes;
- number of provider operations;
- reason for batching, pooling, or caching;
- maximum queue, part, buffer, or response size;
- semantic effect of disabling the optimization.

Do not write `faster` or `optimized` without the workload and mechanism that make the claim meaningful.

## Style

Use plain technical English by default. Apply formal ASD-STE100 only when the task explicitly asks for it.

Use active voice and concrete nouns. Avoid em dashes, self-reference, HTML-like escaping in prose, and headings that interrupt a continuous explanation.

## Anti-patterns

- coverage-only TSDoc such as `Gets the root.`;
- restating a parameter name without explaining its meaning or effect;
- documenting exports while leaving the internal state machine undocumented;
- describing planned behavior as implemented behavior;
- hiding resource ownership or cancellation in a distant guide when callers need it at the API;
- essay-length doc blocks for trivial wrappers;
- comments that compensate for an imprecise name when the symbol should be renamed;
- stale diagrams or examples that no longer match the implementation.
