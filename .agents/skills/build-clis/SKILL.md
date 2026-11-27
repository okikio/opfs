---
name: build-clis
description: Design, implement, refactor, review, diagnose, test, package, or release command-line applications. Use for command grammar, flags, configuration, environment sources, results and diagnostics, prompts, errors, cancellation, completion, manuals, installed artifacts, or CLI libraries, especially with Optique, LogTape, c12, defu, Standard Schema, Zod, Deno, and focused UnJS packages. Do not use for a shell one-liner or incidental script with no CLI product contract.
---

# Build command-line applications

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



## Select the complete task

Read [applying standards](../../guides/applying-standards.md) before domain work.
Select companions by the contracts being changed, with one discovery pass,
plan, and verdict. For repository work, use the shared quality contract when installed
for naming, schemas, tests, documentation, validation, and completion. Apply
rules by purpose; test-runner imports and trivial private fixtures are not
public runtime APIs. If a companion is absent, use the bundled compact defaults
and inspect local instructions rather than inventing unavailable guidance.

The shared quality contract owns request authority and repository completion.
`deno-software` owns Deno manifests, tasks, permissions, compilation, and
publication. `explore-ecosystems` owns dependency topology. `build-libraries`
owns reusable programming models extracted from or consumed by the CLI. This
skill owns the CLI's public language and operational contract.

## Evidence preflight

Before changing a public CLI surface, inspect:

- nearest manifests, lockfiles, executable entrypoints, and command registry;
- tasks, permission sets, generated commands, and installed entrypoints;
- parsers, source contexts, schemas, normalization, and defaults;
- configuration discovery, precedence, provenance, and dynamic factories;
- result and diagnostic routing, renderers, redaction, and sink lifecycle;
- signal ownership, subprocesses, workers, browsers, cleanup, and exit mapping;
- help, completion, manuals, docs, examples, package contents, and acceptance
  tests.

Separate intended architecture, observed implementation, documented behavior,
and behavior actually executed. A guidebook is not proof that the repository
implements its contract.

## Public-surface trace

Classify each public term as an early control, source-bearing configuration, or
domain request input. These roles can overlap: a diagnostic or output control
may be read early for bootstrap behavior and still participate in final source
precedence. Help, version, and completion bootstrap must work before project
configuration is valid. Terms that are source-bearing traverse configuration
precedence; purely early controls and domain inputs do not automatically do so.

Trace each applicable flag, argument, environment variable, config field,
output, or error through:

```text
public name
  -> parser term
  -> sparse source value
  -> schema validation
  -> precedence and normalization
  -> handler request
  -> downstream consumer
  -> help, completion, man, and docs
  -> executable tests
```

If an arrow is missing, treat it as a defect or unresolved contract. Do not
invent the connection.

## Keep parsing, resolution, and execution separate

A parser interprets one supplied representation. A resolver decides which independently supplied value wins. Execution owns live resources, effects, cancellation, and disposal.

```text
argv or other representation -> parser -> sparse values
config/env/programmatic layers -> resolver -> runtime request
runtime request -> execution -> live resources and effects
```

Do not make a parser load environment variables, config files, prompts, secret stores, or runtime resources merely because those values eventually affect the same command. Do not encode missing, deferred, or pending control state as a fake domain value.

## Core rules

1. Keep handlers portable where reuse or testing justifies it. Inject process,
   terminal, filesystem, clock, environment, signal, and network capabilities.
2. Prevent structurally invalid command forms in the parser where practical.
   Validate merged-source and domain semantics in runtime schemas.
3. Preserve sparse source patches. Apply defaults after precedence resolution.
4. Give every configuration source one owner and define precedence, object,
   array, union, and operation semantics explicitly.
5. Route stable results and operational diagnostics separately. Apply any
   route-specific structured redaction policy before serialization. Durable
   artifacts belong to their storage owner.
6. Make prompting automation-safe. A non-interactive process must never hang.
7. Install cancellation at the composition root, propagate one signal tree,
   bound cleanup, and map signals to stable outcomes.
8. Give public error rendering one owner and failures stable exit classes.
9. Verify the installed or compiled artifact, not only in-process functions.
10. Preserve authored Markdown layout. Never run a broad formatter over CLI
    guidebooks, tables, or manuals unless the user explicitly requests it.

## LogTape and formatter policy

When the repository already uses LogTape, preserve it as the structured
observability transport. Libraries emit records; the executable configures
routes, sinks, filters, formatters, and redaction. Keep a project formatter when
it communicates the domain better than `@logtape/pretty`; ecosystem conformity
is not a reason to replace a working compact formatter.

Use `@optique/logtape` for logging grammar and configuration where its contract
matches the CLI. Audit `@logtape/redaction` against real fields before enabling
it broadly. Preserve successful records, use rate controls and lazy expensive
properties for noisy hot paths, and use `@logtape/testing` for logger behavior.
Keep result/diagnostic writers runtime-neutral when the CLI's reusable core can
run outside Deno.

## Production stack doctrine

When a CLI uses Optique, c12, defu, LogTape, and Zod together, assign one owner
per responsibility:

| Responsibility | Owner | Failure to reject |
|---|---|---|
| Token grammar, choices, aliases, suggestions, completion, and manuals | Optique | Handwritten help or post-parse boolean reconciliation |
| Help-only default visibility | Optique document metadata | Parser defaults that materialize sparse source values |
| Project config discovery, formats, `extends`, env branches, and factories | c12 | Strict runtime validation before loader metadata is consumed |
| Recursive merge mechanics | defu behind an app merger | Public `defu(cli, env, file)` with accidental array concatenation |
| Runtime defaults, transforms, and external data contracts | Zod or another schema adapter | Defaults on sparse authoring or CLI patch schemas |
| Results, diagnostics, bootstrap errors, redaction, and sink lifecycle | LogTape at the executable composition root | `console.*`, duplicate loggers, or library-owned sink setup |

Optique is the CLI grammar owner only when the repository deliberately selects it. Verify the installed stable package line and its exports before using version-specific features. Do not make Optique a universal dependency for reusable libraries or for a project that deliberately owns its own parser. For example, a native-parser project can keep Optique as a compatibility adapter, reference implementation, or conformance oracle instead of its runtime parser.

When the installed Optique line provides them, use native features such as `negatableFlag()` for tri-state Boolean overrides, `choice()` for schema-backed enumerations, `deferredValue()` only for handler-time fallback functions, and `runProgram()` hooks for per-command resources such as one resolved config snapshot and logger. Do not use `deferredValue()` as a replacement for ordinary schema defaults.

The defaulting rule is strict: authored config, environment, and CLI patches
stay sparse; documented defaults can appear in help; executable defaults apply
once in the complete runtime schema. Zod `.default()` is for already-valid
output defaults, `.prefault()` is for fallbacks that must pass through
transforms, and `.catch()` is error recovery rather than normal configuration.
`@optique/zod` adapts one CLI value to Zod validation; it does not transfer
multi-source precedence or runtime-default ownership to Optique.

Record provenance while resolving source layers. Do not reconstruct it from the
final value: an explicit CLI value can equal the inherited config value and must
still remain the winner. Version and redact the provenance envelope before
rendering it or passing it through LogTape.

Load dynamic project configuration once per invocation. If Optique source
contexts need a c12 snapshot and the handler also needs final config, thread
that snapshot through `runProgram()` hooks or an equivalent composition-root
resource. Do not let handlers call the full resolver again.

## Reference routing

- [audit.md](references/audit.md): repository audit, observed-versus-promised
  behavior, and end-to-end tracing.
- [architecture.md](references/architecture.md): portable core, adapters,
  capability contracts, and composition choices.
- [commands.md](references/commands.md): command grammar, Optique, schemas,
  help, completion, manuals, aliases, and deprecation.
- [optique.md](references/optique.md): complete Optique package map, typed
  grammar, source contexts, schema, prompt, logging, time, Git, discovery,
  completion, manual, and runner integration patterns.
- [five-library-stack.md](references/five-library-stack.md): load when Optique,
  c12, defu, LogTape, and Zod interact; includes source-flow maps,
  wrong/right examples, default taxonomy, one-snapshot execution, and test
  matrix.
- [defaults-provenance.md](references/defaults-provenance.md): detailed
  three-schema model, `@optique/zod`, `.default()` versus `.prefault()`, nested
  defaults, source resolution, field decisions, provenance envelopes, and
  implementation tests.
- [config.md](references/config.md): c12/defu, authored and runtime shapes,
  precedence, arrays, atomic unions, operations, and provenance.
- [c12-defu.md](references/c12-defu.md): detailed c12, defu, and jiti loading
  lifecycle, merge algebra, dynamic factories, extension layers, provenance,
  mutation, version lines, tests, and failure diagnosis.
- [output.md](references/output.md): LogTape results, diagnostics, artifacts,
  redaction, renderers, sinks, and lifecycle.
- [logtape.md](references/logtape.md): complete LogTape category, sink, filter,
  formatter, context, redaction, testing, bootstrap, and disposal manual.
- [interaction.md](references/interaction.md): no-argument behavior, prompts,
  streams, secrets, TTYs, paging, progress, risk, and recovery.
- [lifecycle.md](references/lifecycle.md): cancellation, resources,
  checkpoints, reconciliation, exit status, and error ownership.
- [cli-testing.md](references/cli-testing.md): layered, subprocess, generated-surface,
  cancellation, packaging, and clean-machine verification.
- [benchmarking.md](references/benchmarking.md): correctness-gated mitata and
  installed-artifact benchmarks for parsing, config loading, merging, Zod,
  provenance, LogTape, startup, memory, and regression reporting.
- [distribution.md](references/distribution.md): manifests, compiled assets,
  package contents, installation, upgrade, and uninstall.
- [ecosystems.md](references/ecosystems.md): capability map for Optique,
  LogTape, c12/defu, schema tools, prompts, Temporal, and UnJS companions.
- [unjs.md](references/unjs.md): focused UnJS capability map, ownership
  rules, package combinations, exclusions, and integration sequences.
- [unjs-runtime-config.md](references/unjs-runtime-config.md): load for jiti,
  c12, defu, destr, confbox, pkg-types, pathe, or ufo implementation.
- [unjs-fetch-state.md](references/unjs-fetch-state.md): load for ofetch,
  unstorage, ohash, or Hookable implementation and version lines.
- [unjs-build-release.md](references/unjs-build-release.md): load for unbuild,
  nypm, Magicast, giget, changelogen, automd, rc9, or std-env implementation.
- [integration.md](references/integration.md): worked end-to-end sequences that
  join parsing, source resolution, logging, execution, recovery, and release.
- [casebook.md](references/casebook.md): load for anonymized CLI trace
  examples and portable policy maps covering command-language governance,
  human versus machine output, dangerous-operation plans, standard streams,
  secrets, paging, consentful config edits, telemetry, root program resources,
  sparse adapters, config/provenance, browser/Common Crawl/WARC/domains flows,
  stage and artifact transitions, lifecycle/concurrency, field-extension checklists,
  failure signatures, and behavior-to-test matrices.

## Completion gate

Do not call CLI work complete until the real invocation path has been exercised
for success, invalid input, operational failure, and cancellation as applicable;
stdout, stderr, exit status, and artifacts match their contracts; generated
surfaces agree; and the packaged or compiled entrypoint runs in a clean context.
Report blocked checks separately from failed checks. If the change makes a
performance claim, run a named representative benchmark against a recorded
baseline and report absolute change, relative change, variability, and semantic
oracles.

## Detailed guides

- [cli-guidelines-audit-and-expansion.md](../../guides/cli-guidelines-audit-and-expansion.md): For a CLI product audit spanning language, human/automation behavior, and installed artifacts.
- [engineering-standards.md](../../guides/engineering-standards.md): For detailed engineering conventions when more depth is needed.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
