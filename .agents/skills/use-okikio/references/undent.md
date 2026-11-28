# `@okikio/undent`

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Evidence and version line](#evidence-and-version-line)
- [Capability model](#capability-model)
- [Choose the API by intent](#choose-the-api-by-intent)
- [Indent detection and trimming](#indent-detection-and-trimming)
- [Interpolation and alignment](#interpolation-and-alignment)
- [Explicit indentation anchors](#explicit-indentation-anchors)
- [Line-ending ownership](#line-ending-ownership)
- [Unicode and terminal columns](#unicode-and-terminal-columns)
- [Configured instances](#configured-instances)
- [Integration patterns](#integration-patterns)
- [Incorrect patterns](#incorrect-patterns)
- [Failure signatures](#failure-signatures)
- [Verification](#verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for readable multiline literals, generated source, SQL or
GraphQL snippets, CLI help, snapshots, nested code generation, interpolation
alignment, line-ending preservation, or terminal-width-sensitive output.

Do not load it merely because a repository depends on `@okikio/undent`.

## Evidence and version line

The reviewed source is `@okikio/undent` `0.3.3`. It exposes the root module and
an opt-in `@okikio/undent/unicode` entry point. Verify the installed version and
export map before copying an exact import or relying on implementation details.

The package solves source indentation and interpolation layout. It is not a
general code formatter, terminal table engine, escaping system, SQL builder, or
security trust transition.

## Capability model

The root API separates five decisions that shallow usage often conflates:

1. which indentation is structural;
2. which blank wrapper lines are removed;
3. whether source line endings are preserved or normalized;
4. whether interpolated multiline values are aligned;
5. how the insertion column is measured.

The important exports in the reviewed version are:

| Capability | Export |
|---|---|
| Default tagged-template processor | `undent` |
| Alias for the default processor | `dedent` |
| Classic outdent-compatible policy | `outdent` |
| Build an independent configured tag | `createUndent()` |
| Process a runtime string | `undent.string()` or `dedentString()` |
| Align an interpolation without dedenting it | `align()` |
| Dedent and then align an interpolation | `embed()` |
| Set an explicit indentation baseline | `undent.indent` or `indent` |
| Recognize an alignment wrapper | `isAligned()` |
| Resolve configuration | `resolveOptions()` |
| Low-level line operations | `splitLines()`, `rejoinLines()`, `alignText()` |
| Raw insertion-column measurement | `columnOffset()` |
| Visual terminal measurement | `createUnicodeColumnOffset()` and related `./unicode` exports |

Prefer the high-level tag, factory, and wrapper functions. Low-level exports
are useful for integration or conformance work, but reassembling the algorithm
from them creates more surface for semantic drift.

## Choose the API by intent

### A readable static literal

```ts
import { undent } from "@okikio/undent";

const query = undent`
  SELECT account_id, sum(amount) AS total
  FROM ledger_entries
  WHERE posted_at >= {start:DateTime64}
  GROUP BY account_id
`;
```

This strips source-code indentation. It does not validate or parameterize SQL.

### A runtime-loaded string

```ts
const source = await Deno.readTextFile("template.sql");
const normalizedIndent = undent.string(source);
```

Use `.string()` rather than pretending a dynamic value is a template segment.

### A multiline value that is already left-aligned

```ts
import { align, undent } from "@okikio/undent";

const items = "- inspect\n- plan\n- verify";

const result = undent`
  phases:
    ${align(items)}
`;
```

`align()` stringifies the value and pads later lines to the insertion column.
It does not remove indentation already present inside the value.

### A snippet with baked-in indentation

```ts
import { embed, undent } from "@okikio/undent";

const fragment = `
    SELECT id
    FROM users
`;

const result = undent`
  query:
    ${embed(fragment)}
`;
```

`embed()` first applies the package's string dedent behavior and then aligns the
result. This is the correct distinction when snippets originate in separately
indented constants or files.

## Indent detection and trimming

`UndentOptions.strategy` controls the structural baseline:

- `"common"` scans content lines and strips the smallest shared indentation;
- `"first"` uses the first content line as the reference and matches the
  package's documented classic `outdent` behavior.

The default is `"common"`. Do not select `"first"` only because it sounds
faster: it changes semantics when later lines are less indented.

`trim` accepts one policy for both ends or separate leading and trailing
policies. Each side supports:

- `"all"`: remove all edge blank lines;
- `"one"`: remove at most one edge blank line;
- `"none"`: preserve wrapper lines.

```ts
const preserveLeading = undent.with({
  trim: { leading: "none", trailing: "all" },
});
```

Whitespace-sensitive formats need exact-string tests for the selected policy.
A snapshot that visually hides the first or last blank line is insufficient.

## Interpolation and alignment

Alignment is opt-in by wrapper, or global per configured instance through
`alignValues: true`.

```ts
const generator = undent.with({ alignValues: true });

generator`
  command:
    ${"first line\nsecond line"}
`;
```

Prefer explicit `align()` or `embed()` when only selected values need layout
treatment. Global alignment is useful for a dedicated generator, but can alter
unrelated interpolations and should not be enabled casually on a shared helper.

Interpolation is stringification, not syntax-aware composition. Values still
need the correct escaping or parameterization for their destination:

- SQL values belong in driver parameters;
- HTML values belong behind the renderer's escaping contract;
- shell arguments belong in argument arrays rather than generated command text;
- source identifiers require language-specific validation.

Internal caches used for repeated embedded snippets are bounded performance
details. They neither sanitize content nor guarantee a cache hit.

## Explicit indentation anchors

Use `${undent.indent}` as the first interpolation on its own line when a code
generator needs a deliberate baseline instead of inferred common indentation.

```ts
function emitFunction(name: string): string {
  return undent`
    ${undent.indent}
    export function ${name}() {
      return true;
    }
  `;
}
```

Content at the anchor column becomes column zero; deeper content preserves its
relative offset. The anchor is a layout instruction, not emitted text.

Use it when nesting depth in the implementation must not change generated
output. Avoid it when normal common-indent detection already states the intent.

## Line-ending ownership

The default `newline: null` preserves `LF`, `CRLF`, and lone `CR` sequences in
template segments. Set `newline: "\n"` only when the output contract requires
normalization.

```ts
const portableGeneratedText = undent.with({ newline: "\n" });
```

Newlines inside interpolated values are not rewritten by the template-segment
normalization option. Normalize dynamic snippets separately if the whole output
must use one convention.

This distinction matters for golden files, generated source, protocol payloads,
and repositories that preserve platform-native endings.

## Unicode and terminal columns

The root `columnOffset()` counts raw JavaScript string units after the final
newline. That is deterministic for source layout but not equivalent to display
columns for tabs, combining marks, CJK characters, or emoji.

The `./unicode` entry point supplies terminal-oriented measurement:

```ts
import { undent } from "@okikio/undent";
import {
  createUnicodeColumnOffset,
} from "@okikio/undent/unicode";

const terminalText = undent.with({
  alignValues: true,
  columnOffset: createUnicodeColumnOffset({
    tabWidth: 4,
    ambiguous: "narrow",
  }),
});
```

The reviewed Unicode options are:

- `tabWidth: false | positive integer`; `false` treats a tab as one column,
  while an integer advances to tab stops;
- `ambiguous: "narrow" | "wide"` for East Asian ambiguous-width code points;
- `widthOf(grapheme, state)` to override individual grapheme widths and return
  `undefined` for the default behavior.

`visualColumnWidth()` walks grapheme clusters and uses best-effort terminal
rules. Renderers can still disagree. The target terminal, font, locale, and
tab policy own the final visual result, so include real display fixtures where
column alignment is user-visible.

## Configured instances

`.with()` derives a new immutable instance from the current instance's resolved
settings; `createUndent()` begins from package defaults.

```ts
const base = undent.with({ newline: "\n" });
const exactFixture = base.with({ trim: "none" });

const classic = createUndent({
  strategy: "first",
  trim: "one",
});
```

Use dedicated instances for distinct output contracts rather than scattering
per-call policy choices. Good names describe the destination, such as
`generatedSource`, `terminalHelp`, or `snapshotText`.

`dedent` is an alias of `undent`. `outdent` is not an alias: in the reviewed
version it is preconfigured with `strategy: "first"` and `trim: "one"`.

## Integration patterns

### Generated source

- use an explicit anchor if implementation nesting must not affect output;
- normalize newlines only when the generated-artifact contract says so;
- use the target language's formatter after generation when canonical syntax
  layout is required;
- compile or parse the generated artifact in verification.

### CLI help and diagnostics

- use `embed()` for separately authored blocks;
- use Unicode column measurement only for terminal-column alignment;
- keep stable machine output independent of decorative alignment;
- verify narrow widths, redirected output, no-color mode, and Unicode samples.

### SQL, GraphQL, and configuration snippets

- use `undent` for readable static structure;
- keep values parameterized;
- treat indentation cleanup and query safety as separate concerns;
- execute representative syntax through the real parser or database in tests.

### Snapshots

- select trim and newline semantics explicitly;
- compare exact strings including invisible edges;
- avoid a project-wide helper whose implicit policy makes fixtures ambiguous.

## Incorrect patterns

Do not:

- use `align()` when the value first needs dedenting;
- claim `embed()` escapes or validates the embedded language;
- assume default column measurement matches terminal width;
- normalize template-segment newlines and claim interpolation newlines changed;
- use `outdent` as if it were a name-only alias;
- depend on undocumented cache sizes or eviction order;
- convert every one-line literal into an `undent` template;
- format generated code visually without parsing, compiling, or executing it.

## Failure signatures

| Symptom | Likely cause | Next inspection |
|---|---|---|
| Second interpolation line jumps to column zero | Value was not wrapped and `alignValues` is false | Inspect `align()`, `embed()`, or configured instance ownership |
| Embedded block remains over-indented | Used `align()` for a snippet with baked-in indent | Replace with `embed()` and add exact output test |
| Significant leading blank line disappears | Default trim policy removed it | Set per-side trim explicitly |
| Mixed CRLF/LF output remains | Only template segments were normalized | Inspect interpolated values and whole-artifact policy |
| CJK or emoji causes visual drift | Raw string-unit column measurement | Use the Unicode entry point with target policy |
| Tabs align differently across terminals | Tab stops or renderer differ | Pin `tabWidth` and verify on supported terminals |
| Generated SQL is injectable | Layout helper was mistaken for query construction | Restore driver parameters or a query AST |
| Refactor changes generated indentation | Inferred baseline moved with source nesting | Introduce an explicit anchor where appropriate |

## Verification

Use table-driven exact-string tests covering:

- empty strings and blank-only input;
- common versus first-line strategy;
- all, one, and no trimming on each edge;
- nested `align()` and `embed()` interpolation;
- explicit anchors at multiple source nesting levels;
- `LF`, `CRLF`, and lone `CR` preservation and normalization;
- dynamic interpolations containing their own line endings;
- tabs, emoji, CJK, combining marks, zero-width marks, and ambiguous-width text;
- custom `widthOf()` and invalid width/tab configurations;
- generated output parsed, compiled, or executed by the destination system.

Verify behavior, not just importability. A strong check asserts the exact output
and then passes that output through the consumer whose contract it must satisfy.

## Sources and freshness

Reference scope: reviewed 0.3.3 source, with public identity at [JSR `@okikio/undent`](https://jsr.io/@okikio/undent). This dated reference is not a claim that 0.3.3 is the latest published version. Resolve the installed artifact and verify its export map, options, Unicode tables and cache behavior before copying examples. An API absent from that artifact remains unverified.
