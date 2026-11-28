# CLI audit

Use this reference for review, diagnosis, migration planning, or before a large
CLI refactor. The goal is to reconstruct the **executable contract** rather than
review files independently.

## Build one contract inventory

Start with a table like this and fill it from source/tests, not memory:

| Surface | Owner | Source of truth | Derived/generated surfaces | Executable proof |
|---|---|---|---|---|
| Commands/aliases | parser/registry | | help, completion, manual, docs | |
| Config fields | source adapters/resolver/schema | | explain/docs | |
| Defaults | documented/runtime owner | | help/config explain | |
| Stable results | result contract | | JSON/JSONL/files | |
| Diagnostics | LogTape/diagnostic owner | | stderr/log files/support bundle | |
| Failures/exits | public error mapper | | shell automation | |
| Signals/cleanup | composition root | | subprocess/resources | |
| Durable runs | workflow/control plane | | inspect/retry/cancel/resume | |
| Installation | package/build owner | | PATH/completion/man/config dirs | |

Do not assume every file in `commands/` or `config/` is active. Trace reachable
imports from the executable entrypoint.

## Compare five truths

For each material behavior classify:

1. **required**: current task/product contract requires it;
2. **documented**: user-facing docs or handoff claim it;
3. **implemented**: source appears to implement it;
4. **reachable**: active entrypoint/registry can execute it;
5. **verified**: a concrete check proves the behavior.

This catches common misleading states:

```text
documented + implemented + not registered
implemented + reachable + not packaged
schema exists + runtime handler still accepts old shape
help generated + execution registry uses another command tree
```

Report each state accurately. Do not turn “implemented but unverified” into
“done.”

## Trace public values end to end

For every changed flag/argument/config/env field, record:

```text
public spelling
 -> parser term or source adapter
 -> raw/sparse source type
 -> normalization/coercion
 -> precedence/merge
 -> final schema field
 -> handler request field
 -> downstream consumer
 -> help/config explain/docs
 -> tests
```

Pay special attention to renamed fields. Search old and new names through
exports, docs, environment variables, persisted config, completion/man output,
fixtures, and generated files. Unless compatibility is explicitly required,
finish the replacement and remove stale consumers rather than leaving aliases
indefinitely.

## Defaults and absence audit

Classify each default:

- parser/help convenience;
- source-specific default;
- product/runtime default;
- schema default;
- environment/provider default;
- display-only documented example.

Check that absent CLI input does not become a high-precedence authored value.
For Zod, inspect `.default()`, `.prefault()`, transforms/refinements, and nested
shape composition. Test `undefined`, `null`, `false`, `0`, empty string, and
empty arrays according to the actual field contract.

## Configuration audit

Compare:

- discovery paths and c12 configuration;
- extension/environment layers;
- dynamic config factories and evaluation count;
- array/object/union merge semantics;
- append/prepend/replace/delete/reset operations;
- provenance and shadowed-value reporting;
- runtime schema defaults and transforms;
- configuration explanation against the resolver's actual decisions.

A generic deep merge is not evidence of correct application semantics.

## Result and diagnostic audit

Capture stdout and stderr separately for:

- success;
- invalid usage/config;
- provider/network failure;
- cancellation;
- quiet/silent/JSON/JSONL modes;
- redirected streams and TTY/non-TTY contexts.

If LogTape is selected, inspect category routing, sink inheritance/override,
formatters, redaction, rate controls, testing, bootstrap failures, flush/reset,
and duplicate records. Stable results should not accidentally acquire diagnostic
prefixes or global sink redaction.

## Lifecycle audit

Trace root signal creation to every active resource:

```text
OS signal
 -> AbortController
 -> handler
 -> HTTP/subprocess/browser/worker/queue
 -> cleanup
 -> logger flush
 -> exit code
```

Also inspect partial initialization. If resource 3 fails after resources 1 and 2
were acquired, both earlier resources must be released. A cleanup error must not
hide the primary failure.

## Generated and installed surface audit

Compare command model against:

- root/subcommand help;
- shell completion;
- manuals;
- README/docs examples;
- packaged executable/bin mapping;
- compiled assets;
- package inclusion/exclusion;
- version strings and release metadata.

Then run the installed/packed/compiled command from outside the source tree.

## Failure signatures

| Finding | Likely cause | Proof |
|---|---|---|
| help lists command that cannot run | generated and runtime registries diverged | installed subprocess |
| config explain shows wrong winner | precedence/provenance path diverged | three-source fixture |
| result duplicated | handler plus root both emit/log | exact stdout + LogTape test sink |
| SIGINT hangs | signal not propagated or cleanup unbounded | subprocess interrupt test |
| package works only in monorepo | undeclared workspace/import dependency | clean install/consumer |
| old option still accepted after replacement | compatibility path not removed | grep + negative invocation |
| no-arg command hangs in CI | prompt without TTY/noninteractive policy | redirected stdin subprocess |

## Audit verdict

Return:

- source-of-truth map;
- confirmed working surfaces;
- unreachable/partial/stale surfaces;
- lifecycle/security/data-loss risks;
- exact correction scope including removals;
- checks run with results;
- checks blocked by environment;
- final status: verified, implemented-unverified, partial, or missing.

Do not mix audit findings with fixes unless the request authorizes implementation.
