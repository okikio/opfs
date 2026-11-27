# `@okikio/wikitext`

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Evidence and maturity line](#evidence-and-maturity-line)
- [Architectural model](#architectural-model)
- [Choose the cheapest result](#choose-the-cheapest-result)
- [Text and position contracts](#text-and-position-contracts)
- [Token and event layers](#token-and-event-layers)
- [Tree materialization](#tree-materialization)
- [Malformed-input policies](#malformed-input-policies)
- [Findings-first workflows](#findings-first-workflows)
- [Sessions and cache lanes](#sessions-and-cache-lanes)
- [Filtering and diagnostics](#filtering-and-diagnostics)
- [Ecosystem integration](#ecosystem-integration)
- [Unsupported and planned surfaces](#unsupported-and-planned-surfaces)
- [Failure signatures](#failure-signatures)
- [Verification](#verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for wikitext tokenization, structural extraction, linting,
indexing, syntax trees, diagnostics, tolerant parsing, editor tooling, or
integration with unist and unified utilities.

Do not load it for general Markdown, MediaWiki template expansion, HTML
rendering, or serialization unless the task also requires the current parser
surface and its limitations.

## Evidence and maturity line

The reviewed repository declares version `0.0.0` and is explicitly
experimental. Confirm the target revision and public export map before using an
exact API. Current source, tests, and exports are authoritative when prose
describes planned work.

The package is a source parser. It does not expand templates, evaluate parser
functions, resolve wiki pages, render MediaWiki-compatible HTML, or currently
serialize a tree back to wikitext.

## Architectural model

The package is event-stream-first and range-first:

```text
TextSource
  -> tokenizer
  -> block events
  -> inline-enriched events
  -> optional tree materialization
  -> filters, diagnostics, or downstream tools
```

The event stream is the fundamental interchange format. A unist-shaped
`wikist` tree is a consumer-facing convenience when random access outweighs
allocation cost.

Keep these layers separate:

| Layer | Owns | Does not own |
|---|---|---|
| `TextSource` | UTF-16 source access and slicing | decoded MediaWiki semantics |
| tokenizer | lexical ranges and token types | nested document meaning |
| block parser | headings, lists, tables, paragraphs, block ranges | inline markup expansion |
| inline parser | inline events inside block text | tree policy |
| tree builder | materialization and recovery policy | source parsing itself |
| filters | selection and traversal | parsing or mutation persistence |
| session | cached lanes for one immutable source | editable-document history |

## Choose the cheapest result

Use a cost ladder, not `parse()` by habit:

1. `tokens(source)` for lexical inspection.
2. `outlineEvents(source)` for block-only structure.
3. `events(source)` for the full streaming syntax model.
4. `parse(source)` for the cheapest materialized default tree.
5. diagnostics or recovery wrappers for malformed-input visibility.
6. `analyze()` plus `materialize()` when one parse must support inspection or
   multiple tree policies.
7. `createSession()` when repeated lanes operate on the same immutable source.

Examples:

```ts
import {
  events,
  outlineEvents,
  parse,
  tokens,
} from "@okikio/wikitext";

for (const token of tokens(source)) {
  indexToken(token.type, token.start, token.end);
}

for (const event of outlineEvents(source)) {
  collectOutlineEntry(event);
}

for (const event of events(source)) {
  runStreamingRule(event);
}

const tree = parse(source);
```

Do not materialize a full tree merely to count headings or find an event type.
Conversely, do not build ad hoc state machines over events when a task needs
repeated parent/child navigation and a tree is the clearer representation.

## Text and position contracts

A string satisfies `TextSource`. The source abstraction exposes character-code
access and slicing so parsing can retain offsets rather than eagerly allocate
every text value.

Offsets use UTF-16 code units, aligning with JavaScript string indices and LSP
positions. They are not Unicode code-point indices, grapheme indices, or byte
offsets.

When integrating with a byte-oriented store or a grapheme-oriented editor:

- retain the source and UTF-16 range as the parser's authority;
- perform explicit coordinate conversion at the handoff;
- never treat `start`/`end` as UTF-8 byte offsets;
- test astral emoji, combining sequences, CRLF, and non-Latin text.

Range-first output makes exact source slices and diagnostics possible, but a
range is meaningful only with the source revision it came from.

## Token and event layers

The reviewed public root re-exports token types, `TokenType`, `isToken()`, and
`tokenize()`, plus event types, constructors, and guards.

Events include enter, exit, text, token, and error forms. Use the exported type
guards rather than loosely matching arbitrary objects:

```ts
import {
  events,
  isEnterEvent,
  isErrorEvent,
} from "@okikio/wikitext";

for (const event of events(source, { diagnostics: true })) {
  if (isEnterEvent(event) && event.node_type === "heading") {
    collectHeading(event);
  }

  if (isErrorEvent(event)) {
    reportParserFinding(event);
  }
}
```

`outlineEvents()` keeps inline content as text ranges. `events()` enriches the
outline with inline parsing. Diagnostics are an explicit option because error
events add work; they are not silently included in the cheapest lane.

Low-level composition is available through `tokenize()`, `blockEvents()`, and
`inlineEvents()`. Use it for focused parser integration or testing. Most
consumers should prefer the orchestration wrappers so stage ownership stays
consistent.

## Tree materialization

The AST is a unist-shaped `wikist` model. Reviewed node categories include root,
heading, paragraph, preformatted text, lists and list items, definition lists,
tables, formatting, wiki and external links, images, templates and arguments,
parser functions, HTML-like tags, redirects, galleries, references, thematic
breaks, category links, magic words, behavior switches, signatures, breaks,
text, entities, and nowiki regions.

The existence of a node type does not imply MediaWiki evaluation. For example,
a template node records syntax; it does not fetch or expand the template.

Programmatic builders and type guards are public. Downstream tools can use
unist utilities, but must verify compatibility with the target revision and
preserve package-specific positions and node fields.

```ts
import { filterTemplates, parse, visit } from "@okikio/wikitext";

const tree = parse(source);
const templates = filterTemplates(tree);

visit(tree, (node, context) => {
  inspectNode(node, context.path);
});
```

## Malformed-input policies

"Never throws on arbitrary input" does not mean every input is valid or every
consumer should accept the tolerant tree. Choose a result family deliberately:

| API | Tree policy | Diagnostics | Recovery summary |
|---|---|---|---|
| `parse()` | default HTML-like/tolerant | discarded | no |
| `parseWithDiagnostics()` | same default tree | preserved | no |
| `parseWithRecovery()` | same default tree | preserved | `recovered` |
| `parseStrictWithDiagnostics()` | conservative/source-strict | preserved | no |

The source-strict lane collapses recovery-heavy wrappers back toward text when
the source did not clearly commit to the recovered structure. It is useful for
linting and editors that must show a finding without presenting a speculative
wrapper as authoritative syntax.

Known recovery classifications in the reviewed source include:

- missing close;
- unterminated opener;
- unclosed table;
- mismatched exit;
- orphan exit;
- end-of-file autoclose.

Treat the recovery taxonomy as versioned API. Do not infer future classes from
diagnostic prose.

## Findings-first workflows

`analyze()` separates parser facts from tree policy. It returns collected,
replayable events, diagnostics, and optionally a structured recovery list.
`materialize()` can then produce default or source-strict trees without
rerunning tokenization and parsing.

```ts
import {
  analyze,
  materialize,
  TreeMaterializationPolicy,
} from "@okikio/wikitext";

const findings = analyze(source);

for (const recovery of findings.recovery ?? []) {
  reviewRecovery(recovery.kind, recovery.position, recovery.anchor);
}

const tolerant = materialize(findings);
const conservative = materialize(findings, {
  policy: TreeMaterializationPolicy.SOURCE_STRICT,
});
```

Use this lane when:

- a tool needs diagnostics before deciding whether to build a tree;
- the same parse needs two materialization policies;
- recovery decisions must be auditable;
- an editor or linter presents parser facts separately from fixes.

Diagnostic anchors in findings are resolved against the documented default
materialization. A strict materialization returns diagnostics retargeted to its
own tree. Do not reuse a tree path across policy shapes without resolution.

## Sessions and cache lanes

`createSession(source)` and `BasicSession` wrap one immutable source with
separate caches for:

- outlines with and without diagnostics;
- full events with and without diagnostics;
- default tree;
- tree plus diagnostics;
- source-strict tree;
- recovery-aware result;
- findings.

```ts
import { createSession } from "@okikio/wikitext";

const session = createSession(source);
const outline = Array.from(session.outline());
const diagnostics = session.parseWithDiagnostics();
const findings = session.analyze();
```

The session is a cache wrapper, not a mutable incremental document. It does not
own edit application, revision rebasing, edit-stable anchors, async chunking,
or cross-document cache invalidation. Create a new session when source changes.

Do not assume every lane shares one cache. The separation is intentional so a
cheap parse does not pay for diagnostics unless another requested lane has
already produced reusable work.

## Filtering and diagnostics

The reviewed filter surface includes generic `visit()` and `filter()`, focused
tree filters for templates, links, images, lists, tables, categories, and
references, plus `filterEvents()` and `collectEvents()` for streaming output.

Diagnostic helpers include tree-path and anchor resolution. Keep three
authorities explicit:

1. source range locates exact input;
2. diagnostic code drives machine behavior;
3. human-readable message explains the issue.

Do not branch business logic on diagnostic messages. Resolve an anchor against
the tree policy and source revision it belongs to.

For one-pass extraction over large input, prefer event filters. For multiple
queries or parent/child context, materialize once and reuse tree filters.

## Ecosystem integration

### unist and unified

The tree is designed to be unist-compatible, so `unist-util-visit` and related
utilities may apply. Verify node naming, position semantics, and whether a
plugin assumes Markdown/HAST-specific nodes before reusing it. "Unist-shaped"
does not make every unified plugin semantically compatible.

### Editor and LSP tooling

- UTF-16 offsets align with common LSP coordinates, but line/column conversion
  still needs a tested index;
- diagnostics and recoveries should remain visible rather than silently fixing
  source;
- session caches are per immutable source, so edits require revision ownership;
- a quick outline can use block events while full inline diagnostics run later.

### Indexers and analyzers

- tokenize or stream events when ordering and ranges are enough;
- materialize only for repeated structural queries;
- persist the parser version with derived indexes if syntax behavior can change;
- keep source slices or content hashes so stored ranges remain auditable.

### MediaWiki systems

Parsing source is only one interface. Template expansion, link resolution,
namespace rules, HTML rendering, sanitization, permissions, and remote fetches
belong to connected systems. Do not attribute their behavior to this package.

## Unsupported and planned surfaces

The reviewed README, manifest include list, or design documents mention
`stringify()` and `parseChunked()`, but current source has no `stringify.ts` and
the root module does not export either function. Lazy tree building is also
listed as in progress.

This is an anti-hallucination rule:

```ts
// Do not write this against the reviewed revision.
import { parseChunked, stringify } from "@okikio/wikitext";
```

Documentation intent and publish configuration do not override the actual
export map. If a later version adds these APIs, re-read implementation, tests,
and limitations before teaching their semantics.

## Failure signatures

| Symptom | Likely cause | Next inspection |
|---|---|---|
| Large extraction allocates excessively | Full AST built for a streaming query | Reclassify to tokens, outline, or events |
| Emoji makes locations drift | UTF-16 offsets treated as code points or bytes | Audit coordinate conversion |
| Linter silently accepts malformed structure | `parse()` discarded diagnostics | Use diagnostics, strict, recovery, or findings lane |
| Tree differs between tolerant and strict results | Recovery policy legitimately changes shape | Inspect diagnostics and structured recovery entries |
| Diagnostic path resolves to wrong node | Anchor reused across policies or source revisions | Resolve against matching tree and source |
| Repeated operations reparse content | Stateless wrappers used for one immutable source | Consider a session and measure |
| Updated text returns old results | Session reused after source edit | Create a new session; own revisions externally |
| Import for `stringify` fails | Planned surface mistaken for shipped export | Inspect `mod.ts` and target version |
| Template output lacks expanded content | Source parser mistaken for MediaWiki evaluator | Add an explicit expansion/resolution layer |
| Unified plugin corrupts nodes | Plugin assumes mdast/hast semantics | Add an adapter or use compatible utilities only |

## Verification

Test invariants at the selected layer:

- tokens tile the expected source ranges without overlap or gaps where the
  contract requires it;
- enter/exit events are properly nested and deterministic;
- outline and full-event results agree on block edges;
- source slices match UTF-16 ranges for ASCII, astral, combining, RTL, and
  newline-heavy fixtures;
- arbitrary malformed input does not throw;
- diagnostics and recovery kinds are stable for committed fixtures;
- default, source-strict, and recovery-aware results differ only where policy
  permits;
- findings can be materialized repeatedly without reparsing;
- session cold and warm lanes return equivalent results;
- a new source revision cannot accidentally reuse an old session;
- filters return the same logical matches as an explicit traversal;
- memory and latency are measured separately for tokens, outline events, full
  events, and tree materialization;
- imports are checked against the actual root export map so planned APIs cannot
  enter production code.

For experimental adoption, pin a revision or exact version, keep a corpus of
real and pathological documents, and record the parser version with stored
diagnostics or indexes. Public claims should state the maturity line and
should not promise MediaWiki equivalence or round-trip serialization.

## Sources and freshness

Reference scope: experimental 0.0.0 source, with public identity at [JSR `@okikio/wikitext`](https://jsr.io/@okikio/wikitext). This dated reference does not establish current publication or implementation status. At that reference scope, `stringify()`, `parseChunked()`, lazy tree building and edit-stable sessions were unimplemented or unverified. Inspect current exports and tests before relying on those capabilities.
