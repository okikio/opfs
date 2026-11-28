# Generated artifacts

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Ownership model](#ownership-model)
- [The generator contract](#the-generator-contract)
- [External-source acquisition](#external-source-acquisition)
- [Transforming authored files](#transforming-authored-files)
- [Generated Markdown](#generated-markdown)
- [Atomic writes and crash recovery](#atomic-writes-and-crash-recovery)
- [Review and CI design](#review-and-ci-design)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Executable verification](#executable-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference when code, schemas, clients, Unicode tables, documentation
sections, manifests, lock-derived files, fixtures, completion scripts, or other
artifacts are produced from another source. Also load it when a task says
"regenerate", "sync", "update the snapshot", or "fix drift". Do not treat a
file as generated merely because it looks repetitive; establish the producer
and source first.

## Outcome

Produce a generator for which all of the following statements are true:

- one named input is authoritative for every output field;
- check mode observes drift without mutating the worktree;
- write mode changes only owned regions and converges in one pass;
- identical source bytes, tool versions, options, and platform policy yield
  byte-identical output;
- mutable remote names are resolved to immutable identities and verified;
- malformed, incomplete, or surprising input fails before the destination is
  replaced;
- the artifact records enough provenance to reproduce or audit the update;
- CI and reviewers can distinguish authored changes from regeneration noise.

Generation is a small compiler pipeline, not a convenient file-copy command:

```text
locate source
  -> acquire exact bytes
  -> authenticate identity and integrity
  -> parse into an internal model
  -> validate semantics and invariants
  -> render deterministically
  -> compare with current output
  -> check or atomic replace
  -> validate the consumer
```

## Ownership model

Classify every relevant file before writing code.

| Class | Authority | May humans edit it? | Required check |
|---|---|---:|---|
| Authored source | repository author | yes | normal validation |
| Generated source | named generator input | no, except through input/generator | drift plus consumer tests |
| Mixed authored/generated | author outside bounded markers | only outside owned regions | marker integrity and minimal diff |
| Build output | source plus build configuration | no | clean rebuild/package check |
| Release artifact | immutable revision plus release inputs | no | digest/provenance/consumer check |
| Snapshot/fixture | test owner and update command | only by explicit review | semantic test plus snapshot diff |
| Vendored source | upstream revision plus local patch policy | only through vendor workflow | license, digest, patches, build |

Record the classification near the task, manifest, or file header. A generated
header should name the generator and source, but must not include a wall-clock
timestamp unless time is part of the product contract; timestamps destroy
reproducibility without proving freshness.

Mixed ownership is a risky ownership split. Prefer a separate generated file imported
by an authored file. If the output must share a file with authored prose, use
unique, non-nesting start/end markers and reject missing, duplicated, reversed,
or overlapping markers. Never replace text between a pair of loose regex
matches without proving that the pair identifies exactly one owned region.

## The generator contract

### Check and write are distinct modes

The safe default is check mode. Mutation requires an explicit `--write`,
`--update`, or equivalent option. Both modes run the same acquisition, parse,
validation, and render functions; only the final action differs.

```ts
type Mode = "check" | "write";

const source = await acquirePinnedSource(signal);
const model = parseAndValidate(source.bytes);
const next = render(model); // stable sort, stable newline, no current time
const current = await readText(output);

if (next === current) Deno.exit(0);
if (mode === "check") {
  reportSemanticDrift(current, next, source.provenance);
  Deno.exit(1);
}

await atomicReplace(output, next);
```

Do not implement check mode by running write mode and asking Git whether the
tree changed. That mutates user files, may trigger formatters/watchers, loses
the original failure state, and is unsafe in a dirty worktree.

Required properties:

- the mode and target paths are visible in `--help`;
- read, write, network, environment, and subprocess permissions are narrower
  in check mode than in write mode;
- every input is explicit: file, environment name, URL, tool version, locale,
  timezone, and feature option;
- output uses a fixed encoding, newline policy, ordering, numeric rendering,
  and path normalization;
- the second check after a write is clean;
- a second write produces no byte change;
- failures leave the old output usable.

### Semantic validation precedes rendering

Parsing successfully is not enough. Check domain invariants such as unique
identifiers, sorted non-overlapping ranges, referential integrity, version
compatibility, required exports, bounded sizes, and expected record counts.
Prefer a typed intermediate model that cannot represent an unchecked row.

For data updates, compare semantic sets as well as rendered text. A different
range compression or property order may be textually different but semantically
equal; an equal record count may still hide a replacement. Reports should show
missing/extra keys and representative samples, not only "generated file differs".

The attached Undent Unicode generator demonstrates the stronger pattern: it
resolves the Unicode version from `latest/ucd/ReadMe.txt`, downloads both the
mutable latest and matching versioned `EastAsianWidth.txt`, compares SHA-256,
parses only relevant properties, checks range drift, validates the target module,
and separates check from `--write`. Reuse the method, not its package-specific
constants.

## External-source acquisition

Treat every network source as untrusted input and every mutable alias as a
discovery pointer.

1. Fetch the small identity document or registry metadata with a timeout and
   bounded response size.
2. Parse and validate the advertised version/ref.
3. Construct or discover an immutable URL: exact version, tag, commit, digest,
   or registry integrity.
4. Fetch the immutable object.
5. If a mutable and immutable object are both available, compare their bytes
   or digests before trusting the mutable response.
6. Store identity, URL, digest, generator revision, schema version, and relevant
   options in a manifest or generated comment.
7. Parse from bytes already verified; do not refetch during rendering.

`latest`, a branch name, a floating template registry entry, or a package range
is not provenance. For Git/template acquisition with Giget 3.3.0, prefer an
exact tag or commit and record the resolved provider, source, subdirectory, and
archive digest. `--offline` proves cache availability, not that the cache is the
requested revision. `--force-clean` is destructive and requires destination
classification and authorization before use. Authentication headers must never
be emitted in generated manifests or error logs.

Support failure injection for timeout, non-2xx response, oversized response,
redirect to an unexpected host, digest mismatch, unsupported upstream version,
malformed rows, duplicated keys, empty source, and truncated transfer. A stale
cache may be used only when the product defines a stale/offline policy and the
output records which source was used.

## Transforming authored files

Use the narrowest transformation mechanism that preserves ownership.

| Input | Preferred mutation | Avoid |
|---|---|---|
| JSON with no comments | parse, validate, update owned keys, stable serialize | global text replacement |
| JSONC/TOML/YAML/package manifest | format-aware editor or bounded structured patch | dropping comments/unknown keys |
| static-ish JS/TS config | Magicast or a precise AST transformation with fallback | evaluating config to recover syntax |
| arbitrary program | codemod with syntax/type guards and fixtures | pretending it is JSON |
| Markdown | explicit markers with a pure section generator | repository-wide formatting |
| binary/media | content-addressed replace plus metadata validation | in-place partial mutation |

Magicast 0.5.3 provides `loadFile`, `writeFile`, proxy-like access to imports,
exports, object literals, and function-call arguments, and a `core` entrypoint
without filesystem helpers. It is designed for static-ish JavaScript; dynamic
spread expressions, computed values, branches, and arbitrary calls can throw or
be outside its model. Detect supported shapes, preserve the original source,
and return a manual patch instruction when the shape is unsupported.

```ts
import { loadFile, writeFile } from "magicast";

const module = await loadFile("build.config.ts");
const exported = module.exports.default;
const config = exported.$type === "function-call"
  ? exported.$args[0]
  : exported;

if (!config || typeof config !== "object") {
  throw new Error("Unsupported build config shape; update entries manually");
}

config.entries ??= [];
if (!config.entries.includes("./src/worker")) {
  config.entries.push("./src/worker");
}
await writeFile(module, "build.config.ts");
```

Never load an executable JS/TS configuration simply to edit it. Runtime loading
executes user code and converts syntax/comments into values that cannot be
round-tripped. An AST tool is not automatically safe either: require a bounded
input grammar and test comments, quote style, wrappers such as `defineConfig`,
imports, spreads, unsupported expressions, and idempotence.

## Generated Markdown

Generated Markdown must remain reviewable. Automd 0.4.3 recognizes bounded
comment directives and supports built-in/custom generators, pure transformation,
output, and watch workflows. It is appropriate for badges, contributor lists,
typed references, fetched snippets, or other explicitly owned sections. It is
not authority for prose around those markers, and it does not justify formatting
the entire file.

```md
<!-- automd:fetch url="gh:owner/repo/v1.2.3/snippets/install.md" -->

The generated section lives here.

<!-- /automd -->
```

Pin fetched content. Run an observation-only diff/check in CI. Inspect the
actual 0.4.3 CLI/help and configured generators before copying commands because
the marker language and custom-generator API are versioned surfaces. A custom
generator should accept parsed options and repository context, return text, and
have tests independent of file writing.

Do not:

- generate prose that encodes decisions no machine source owns;
- nest marker regions;
- permit a remote snippet to escape its marker;
- rewrite code fences, lists, tables, or wrapping outside the owned region;
- silently regenerate during install, tests, or documentation viewing;
- accept a generated table because its row count stayed constant.

## Atomic writes and crash recovery

Render and validate the complete next artifact before touching the destination.
For a single file, write a temporary sibling, flush when durability matters,
apply intended permissions, then rename on the same filesystem. For a generated
directory, build in a fresh staging directory, validate its manifest and
consumers, then swap or replace according to a documented recovery protocol.

Atomic rename prevents partial bytes but does not make a multi-file update
transactional. For several outputs, use a manifest-last protocol:

1. write content-addressed or versioned files;
2. verify all of them;
3. atomically replace the manifest/pointer last;
4. garbage-collect old generations separately.

If files must be replaced in place, record a journal and test interruption after
every step. Never delete the old generated directory before the new one passes
validation; the Undent npm build can safely clear its ignored `npm/` directory
because it is disposable build output, while committed source generation needs
stronger preservation.

## Review and CI design

A reviewable generator change normally contains:

- the source/model change;
- generator implementation change if required;
- generated diff;
- provenance update;
- generator unit/property/failure tests;
- target-consumer verification;
- an explanation of surprising additions, removals, or reorderings.

CI should run the repository's true check command with only required permissions.
For a committed artifact:

```sh
deno task generate:check
deno task test:generated-consumer
git diff --exit-code -- path/to/generated
```

The last command is a defense in depth, not the implementation of check mode.
Do not run `deno fmt` or Prettier across Markdown merely to make a generated
section pass. Scope code formatting to generated code or render already-formatted
bytes. In dirty worktrees, compare only owned paths and refuse write mode when
an output contains unrelated user edits unless an explicit merge is supported.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Check rewrites files | write path reused for observation | mode branch and permissions |
| Second write changes output | nondeterministic order, time, locale, random ID, absolute path | byte diff and complete input inventory |
| CI passes but clone fails | undeclared local tool/cache/input | clean clone with empty caches |
| Latest and versioned digests differ | alias advanced mid-run, mirror error, compromised response | identity fetch and immutable URL |
| Comments disappear from config | value serialization replaced syntax | structured/AST editor |
| Generated section consumes following prose | marker missing/duplicated or greedy parser | marker cardinality and span tests |
| Partially written source after failure | direct destination write | staging/rename protocol |
| Generator reports no drift but consumer fails | textual comparison without semantic validation | output schema and real consumer test |
| Huge unrelated Markdown diff | global formatter or whole-file renderer | owned-region diff and formatter scope |
| Offline run uses wrong template | cache key omitted revision or subdir | cache identity and recorded provenance |

## Deliberate exclusions

- Do not add a generator when a small stable file is clearer to author and test.
- Do not fetch mutable remote content during ordinary library import, package
  install, help generation, or completion.
- Do not make the generated file a second editable source of truth.
- Do not use a snapshot update to approve a behavioral change without reading
  the semantic diff.
- Do not call an output reproducible if the toolchain, locale, platform inputs,
  or remote bytes are unrecorded.
- Do not adopt Automd for authored prose, Magicast for arbitrary dynamic code,
  or Giget when a registry/package artifact already supplies stronger integrity.

## Executable verification

Run the applicable subset and record exact commands/results:

1. check mode against the committed state;
2. copy the repository or fixture, run write, then check;
3. hash output, run write again, and compare the hash;
4. generate under a different temporary absolute path and compare bytes;
5. randomize source enumeration order and assert stable output;
6. deny write permission in check mode and confirm it still works;
7. inject malformed input, timeout, digest mismatch, and interrupted replacement;
8. prove unsupported AST/config shapes remain unchanged with an actionable error;
9. run the compiler/importer/package/docs consumer of the generated artifact;
10. inspect `git diff --word-diff` or a semantic report for owned paths only.

For a remote source, retain the immutable input or at least its digest and
identity metadata. For release generation, also test from a clean checkout of
the tagged commit so untracked local files cannot satisfy the generator.

## Sources and freshness

- Attached `undent.zip`, observed source: `scripts/sync_unicode_east_asian_width.ts`
  and `scripts/build_npm.ts`; verified in the retained archive on 2026-07-17.
- Automd 0.4.3 published README, declarations, and package manifest; current
  source record `automd-0-4-3`, verified 2026-07-17.
- Magicast 0.5.3 published README, exports, and package manifest; current source
  record `magicast-0-5-3`, verified 2026-07-17. High-level helpers are explicitly
  experimental and require source/test inspection at the installed version.
- Giget 3.3.0 published README and package manifest; source record
  `giget-3-3-0`, verified 2026-07-17.
- Attached production CLI guidebook v1.1, normative generator, generated-doc,
  packaging, permission, and release requirements; verified 2026-07-13.

Recheck installed exports and CLI help before copying an API. The versioned
records above describe the pinned artifacts, not all future releases.
