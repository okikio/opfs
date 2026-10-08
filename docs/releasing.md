# Publish a tested package release

Deno owns repository commands. Bumpy 1.18.1 owns authored bump files, dependency propagation, version selection, and
changelog rendering. Mise can install the declared runtimes; running package tests or preparing a release does not
require Mise.

```sh
deno task release:plan
deno task release:version
# Review and commit the versioned source before preparation.
deno task release:prepare
deno task release:registry both
deno task release:publish both
```

Run `release:plan` before `release:version`. The plan identifies every affected package, its current and next version,
and dependency propagation. Versioning consumes bump files, writes each package changelog, and synchronizes npm and Deno
versions. It does not commit, tag, push, or publish. The original authored stories and full Bumpy plan are retained
under ignored `.tmp/releases/version-plan.json`.

Review and commit the versioned source before publication. Readiness checks can run against a dirty checkout, but the
immutable publishing revision must contain the actual source, manifests, lockfiles, generated modules, release notes,
and task definitions. Record that revision with the candidate. Never tag a clean old commit while uploading uncommitted
changes.

## Write release notes that teach

A bump file tells a consumer what changed, why it matters, and how to use or migrate it. Use a complete example for a
changed API. Explain a failure scenario, resource owner, or compatibility constraint when it affects adoption. Use
diagrams, tables, and before/after output when they make the change clearer. The explanatory quality of esbuild's
changelogs is the standard; a list of commit subjects is insufficient.

Create bump files through the pinned tool, then expand their Markdown bodies:

```sh
deno task bumpy add --packages '@okikio/rdf:patch' --name pending-read-abort --message 'Stop pending source reads when shape inspection is cancelled.'
deno task release:plan
```

Use the actual package name for this repository. Keep one story per consumer behavior. The formatter preserves authored
paragraphs, code blocks, and diagrams. Breaking changes need explicit migration instructions. Performance claims need
the workload, runtime, input size, units, baseline, variability, and correctness evidence. Do not promise every
specification in a standards family because one profile passed.

For these pre-1.0 packages, compatible repairs are patch releases; new capabilities and intentional programming-model
replacements use a minor increment with an explicit migration note. The selected versions must be free on every
requested registry. No tool is permitted to overwrite an immutable version or force-move a public release tag.

## Freeze and inspect the actual artifacts

`release:prepare` captures the clean Git revision and creates an owned clone with independent Git objects. It checks out
that exact revision, copies installed dependency bytes without hard links, and rebases workspace aliases into the clone.
An alias outside the copied dependencies or committed workspace rejects preparation instead of borrowing another mutable
checkout. Maintained source symlinks are also rejected; use ordinary committed package inputs.

Every source gate, archive build and artifact check runs in the clone. Downloaded Deno source and registry metadata seed
an owned `DENO_DIR`; compiler caches, semantic databases and global mutable cache files are not shared. Missing
downloads can still require network access on a cold runner. Copying installed dependencies and downloaded source uses
additional disk space and startup time, rather than silently changing the release inputs through another checkout.

On Unix, maintained files and production/task directories are made read-only where task outputs permit it. This prevents
accidental edits, not hostile changes by another process running as the same user. Source and revision checks run after
each gate and before output copies on every platform. An A→B→A edit in the original checkout cannot influence the
archive because the builder reads the clone. An original edit or branch change that remains prevents a new preparation
receipt.

Exact archives, artifact inventory receipts and generated reports are copied into the original task-owned output
directories. Copied archives are hashed again. `.tmp/releases/prepared.json` binds their SHA-256 identities to the
immutable revision, source hash, and independently named gate-evidence receipt. Evidence records each completed task,
exit code, start/end time and source hash; upload rejects changed or missing evidence as well as changed source or
archive bytes. Snapshot cleanup is awaited before issuing the receipt, with independent gate and cleanup failures
retained together. Previously prepared registry receipts remain distinct from each new preparation attempt.

Inspect package names, versions, exports, declarations, license notices, optional integrations, and package contents.
Use the clean consumer tests against those exact archives in Deno, Node, Bun, and the applicable browser/Worker
contexts.

OPFS uses its dnt ESM compiler and preserves Drizzle as an optional peer. Its package output must be a descendant of
`.release/` or `.tmp/`; `RELEASE_DIR` cannot delete an arbitrary directory. The workspace package family uses Deno's ESM
packing path and resolves development `workspace:` dependencies to concrete versions in npm artifacts. Development
source keeps workspace references.

The direct OPFS npm archive installs the official `@types/deno` 2.7.0 declarations under the `deno-types` npm alias
because the public `driver/deno` leaf accepts native `Deno.FsFile` values. Its declaration starts with a type reference
to that alias, so an editor or TypeScript consumer can resolve the signature even with `types: []`. The alias stays
outside `node_modules/@types`: ordinary automatic ambient discovery does not load the Deno namespace into root or Node
consumers. dnt's semantic build separately uses a development-only `@types/deno` dependency. This is declaration data;
JavaScript still calls the actual Deno runtime. The archive has no runtime Deno shim. Root and Node imports do not
traverse the Deno declaration leaf. The clean artifact check verifies those separate declaration graphs with strict
TypeScript 7.0.2 and 5.9.3, library checking enabled, default ambient discovery and explicit `types: []`.

The Node driver is a separate host leaf. A TypeScript Node application supplies `@types/node` and selects
`"types": ["node"]` in its compiler options. TypeScript 6 and later default to an empty ambient type selection even when
declarations are installed. The artifact matrix checks that configured Node consumer separately from portable
root/memory consumers and native Deno consumers; importing the portable root requires neither host declaration set. See
[TypeScript's ambient selection change](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html#types-now-defaults-to-).

Publish the package dependency graph in topological order. Check each dependency is available on the selected registry
before publishing a dependent. `@okikio/rdf` precedes SPARQL, vocab, and triplestore; SPARQL precedes the two engine
adapters. The triplestore borrows its filesystem and has no direct OPFS package dependency.

```text
bump stories -> Bumpy plan -> synchronized versions and changelogs
                                |
                     immutable source revision
                                |
                     source gates and exact archives
                                |
                JSR receipt      +      npm receipt
                                |
                   fresh public consumer behavior
```

Source tests prove source behavior. Archive consumers prove packaging. Public installs prove publication. Retain these
distinct proof levels.

## JSR constraints

JSR publishes ESM TypeScript source and generates npm compatibility artifacts. Direct npm packages built here are a
separate distribution path; `@jsr/okikio__...` compatibility names are not the direct npm package names.

Before upload, `deno publish --dry-run` must pass without `--allow-slow-types` or `--no-check`. Public exports need
explicit, portable types. Exclude tests, benchmarks, downloaded suites, reports, caches, temporary fixtures, and release
credentials from the publish set. Confirm imports resolve inside each package or through declared JSR/npm dependencies;
an undeclared workspace alias is not a public dependency.

[JSR limits](https://jsr.io/docs/quotas-and-limits) require each source file, total uncompressed package, and uploaded
gzip archive to be under 20 MB. The default scope quotas are 100 packages, 20 package creations per rolling week, and
1,000 publishing attempts per rolling week. Those defaults do not establish this account's remaining quota. Check scope
usage before a release; repeated failed upload attempts are not a testing strategy.

[JSR publishing](https://jsr.io/docs/publishing-packages) supports GitHub OIDC for a package linked to the correct
repository. Repository linkage, package ownership, current source revision, and the exact publishing workflow are part
of authentication. Registry version immutability means repair by publishing a new version, not overwriting an old one.

## Publish, resume, and verify

Use `both`, `jsr`, or `npm` explicitly. Read-only registry checks distinguish a missing exact version from
authentication failures, network failures, and malformed responses. A successful upload is independently checked in
registry metadata before its receipt is written.

Retain the candidate archives and `.tmp/releases/` receipts after any failure. Retry only the failed registry with the
same source and artifact identities. Do not rerun preparation and replace an already approved archive during a partial
release. Existing versions must match retained release evidence; a matching version string alone cannot prove matching
bytes.

The publishing workflow accepts `prepared_run` to select a retained preparation artifact from another run in the same
repository. Supply its exact source `revision` and the remaining registry `target`. This skips preparation and restores
the archives and receipts; the upload command still checks source, revision, and archive identities. Verification
controls come from the workflow's current commit under ignored `.tmp/release-controls/`, while publication uses the
original immutable source checkout. This permits a consumer-check repair after one registry has accepted a release
without rebuilding the archive or moving its release tag.

A JSR upload can succeed while a previously cached missing-version API response remains visible. Registry management
checks use a fresh query URL to avoid reusing that cached response. A missing JSR receipt still requires independent
published-source verification. Do not infer matching source from an upload message alone.

For npm, use existing user authentication locally or trusted publishing in the configured GitHub workflow. For JSR, use
the package-linked OIDC workflow or Deno's documented interactive authorization. Keep tokens out of arguments, source
manifests, archives, and logs. The Deno release adapter uses Bumpy's public publishing pipeline with custom commands; it
disables automatic Git tags and GitHub release creation so source references cannot silently point to the wrong commit.

After publication, run `deno task release:consumer both` against exact public versions. The command creates owned fresh
consumers and caches. It checks direct npm, native JSR, and JSR npm compatibility separately; `jsr` selects both JSR
distribution routes and `jsr-npm` checks only the compatibility route. Runtime executables are selected before entering
the fresh project, so a repository-local tool selection does not disappear when the working directory changes. Then use
a fresh project and exact public versions. Import every public subpath, type-check the public types, and run meaningful
read/write, parse/query, or persistence behavior. For npm, compare the downloaded tarball to the prepared archive. For
JSR, verify the published source/dependency graph and package version. Run the changelog examples from the installed
packages. Record actual registry and consumer results before calling a release complete.

Immediate native JSR consumer checks set `--minimum-dependency-age=0` only in their owned child processes and select the
exact reviewed package versions. Deno's dependency-age policy can otherwise reject a just-published release before
checking its code. This release check does not change an application's dependency-age policy.

The upload workflow checks the actual checkout revision before npm publication and supplies that revision to npm's
provenance source dependency. The workflow commit can contain newer verification controls; it must not be mistaken for
the source commit that produced the retained archive.

## Standards and resource evidence

Consult the maintained standards matrix and the source-bound conformance report. Official manifests, negative syntax
cases, graph-isomorphism oracles, canonical writer byte fixtures, actual engine/provider interoperability, and lifecycle
regressions cover distinct behaviors. Profile updates require a fresh report; a green count from stale source is not
release evidence.

A performance measurement must name the consumer workload and its correctness oracle. Keep primitive and end-to-end
comparisons. Record latency/throughput, CPU time, peak versus sampled/retained memory, logical versus physical bytes,
request counts, startup, and cancellation where they apply. Network metrics do not apply to a local parser; process peak
RSS does not prove a leak or a parser-only memory footprint. Define regression tolerances from repeated same-machine
baselines and scenario requirements, not an arbitrary universal percentage.

Release preparation rejects Unix UID 0 before creating a snapshot. Run it as an ordinary account, including in
containers. Root bypasses file permissions and could accidentally replace and restore source bytes between identity
checks. Source permissions guard ordinary tool mistakes; they do not isolate a hostile process running as the same user,
which can change its own permissions.

On Unix, preparation protects each maintained file and every ancestor directory through the snapshot root. This also
rejects atomic replacement of source files. The owned `.tmp`, `.release`, and `node_modules` directories remain writable
for task outputs and cold dependency installation.

Maintainer release preparation also refuses Windows because this task cannot establish its physical source-write guard
there. Prepare on an ordinary Unix account or the Unix CI runner. This restriction applies to preparing a publishing
receipt; it does not change package consumers, library runtime support, or edit-capable release planning/versioning.

Generated gate output stays below the already writable `.tmp` namespace while snapshot root and maintained source
ancestors remain readonly. Playwright screenshots, traces and runner artifacts use `.tmp/reports/browser/artifacts`;
OPFS browser benchmarks use `.tmp/reports/browser-bench/artifacts`. OPFS coverage samples and `lcov.info` use
`.tmp/reports/coverage`. Clean tasks can delete and recreate these leaves without gaining write permission to maintained
source directories. Their ignored output bytes are retained as evidence rather than included in source identity.

OPFS quality has two canonical phases. Ordinary `deno task quality` runs
`deno task deps:ci && deno task quality:source`, preserving the full previous sequence. The first command runs real
`deno ci`: Deno removes and recreates the root `node_modules` entry even when its contents are writable. Release
preparation therefore runs that dependency phase once in the owned clone before making its root readonly. It records the
actual command status, raw stdout/stderr, and source hash/revision before and after installation. It checks the original
checkout too. A failed install or a retained source/revision change refuses preparation before any immutable source
gate.

After installation, preparation removes write permissions from every maintained file and source ancestor through the
clone root. It invokes the committed `quality:source` task, which owns the complete quality remainder, followed by the
existing runtime, browser, provider, Linux, benchmark and package gates. Source gates never thaw the root or repeat
destructive dependency installation. No environment flag can replace installation proof with a claimed success. The
installation phase has a distinct permission boundary: maintained inputs are identity-checked there; physical readonly
protection begins before source gates. Same-owner hostile actions remain outside the ordinary-tool guard.

Dependency logs are streamed into a unique `.tmp/releases/snapshot-<revision>-<attempt>/dependencies/` directory. Their
exact hashes and paths are retained in gate evidence and checked before upload. The publish workflow carries those raw
files into resumed jobs. Capture and SHA-256 verification use streams and a fixed 64 KiB hashing buffer, so a large
dependency log is not loaded as one large in-memory result. Cold preparation can download and install the full locked
graph, and Deno may discard the initial independently copied dependency tree; this costs disk space and installation
time. A failing phase still retains its raw diagnostic evidence and awaits owned snapshot cleanup. SPARQL's `deps` task
checks its dependency firewall and does not run `deno ci`, so its canonical verification DAG stays inside the protected
source phase.

A dependency log write failure stops the directly owned task CLI and waits for its reported status and both raw streams.
Logging, stop and close failures remain independent errors and refuse a prepared receipt. Stopping `deno task` does not
prove that every spawned install descendant stopped; a descendant can retain a pipe. The bounded outer
aggregate/container watchdog remains the final process boundary. Preparation does not claim process-group or daemon-wide
ownership.

Raw dependency output is copied as bytes through explicitly owned stream readers and file writes. A short file write
retains the unwritten suffix before the next read; a zero-byte or invalid write refuses preparation instead of losing
output or looping forever. This preserves binary diagnostics and split UTF-8 bytes as well as ordinary console text.
Reader cancellation, lock release, and file close failures remain independent evidence failures. Successful console
output alone cannot prove useful capture: behavioral controls compare the retained bytes through three-byte file writes
and require write rejection or zero progress to block every source gate and prepared receipt.
